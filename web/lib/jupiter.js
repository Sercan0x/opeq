import { AMMS } from "./amms.js";
import { SYSTEM, b58encode, eq, pubkey, u32 } from "./solana.js";
import * as T from "./tokens.js";

export const JUP = pubkey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const TABLE = pubkey("FqmZkMZWoA3Z5c5epD9M1PSDts44iBojrqGyxE6xcJEq");
const API = "https://lite-api.jup.ag/swap/v1";
const COMPUTE = pubkey("ComputeBudget111111111111111111111111111111");
const ROUTE = "e517cb977ae3ad2a";
const SHARED = "c1209b3341d69c81";
const BASE = new Set([JUP, SYSTEM, T.TOKEN, T.TOKEN22, T.ATA_PROG, COMPUTE].map(b58encode).concat(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]));
const DEXES = [...new Set(AMMS.values())].join(",");
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const digits = (s) => typeof s === "string" && /^\d{1,20}$/.test(s);

async function getJson(url, init) {
  let res;
  for (let attempt = 0; ; attempt++) {
    try { res = await fetch(url, init); } catch { throw new Error("could not reach Jupiter for a swap price"); }
    if (res.status !== 429 || attempt >= 4) break;
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  if (res.status === 429) throw new Error("Jupiter is rate limiting right now, try again in a few seconds");
  let j;
  try { j = await res.json(); } catch { throw new Error(`Jupiter answered with an error (${res.status})`); }
  if (!res.ok || j.error) throw new Error(`Jupiter: ${String(j.error || j.message || res.status).slice(0, 140)}`);
  return j;
}

export async function quote(inMint, outMint, amount, slippageBps, maxAccounts = 28, direct = true) {
  const u = new URL(`${API}/quote`);
  u.search = new URLSearchParams({
    inputMint: b58encode(inMint), outputMint: b58encode(outMint), amount: amount.toString(), slippageBps: String(slippageBps),
    maxAccounts: String(maxAccounts), swapMode: "ExactIn", dexes: DEXES, onlyDirectRoutes: direct ? "true" : "false",
  }).toString();
  const q = await getJson(u.toString());
  if (q.inputMint !== b58encode(inMint) || q.outputMint !== b58encode(outMint) || q.inAmount !== amount.toString() || q.swapMode !== "ExactIn"
    || q.slippageBps !== slippageBps || !digits(q.outAmount) || !digits(q.otherAmountThreshold) || !Array.isArray(q.routePlan) || !q.routePlan.length
    || (q.platformFee && q.platformFee.amount && q.platformFee.amount !== "0")) throw new Error("Jupiter returned a quote that does not match the request");
  return q;
}

export function labels(q) {
  return [...new Set(q.routePlan.map((r) => String((r.swapInfo && r.swapInfo.label) || "?").slice(0, 24)))];
}

export const minOut = (q) => (BigInt(q.outAmount) * BigInt(10000 - q.slippageBps)) / 10000n;

function conv(ix) {
  if (!ix || typeof ix.programId !== "string" || !Array.isArray(ix.accounts) || typeof ix.data !== "string") throw new Error("Jupiter returned a malformed instruction");
  return [pubkey(ix.programId), ix.accounts.map((a) => [pubkey(a.pubkey), a.isSigner === true, a.isWritable === true]),
    Uint8Array.from(atob(ix.data), (c) => c.charCodeAt(0))];
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const metaIs = (m, key, s, w) => m && eq(m[0], key) && m[1] === s && m[2] === w;

export async function instructions(q, ctx) {
  const r = await getJson(`${API}/swap-instructions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: b58encode(ctx.wallet), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false }),
  });
  if (r.tokenLedgerInstruction || (Array.isArray(r.otherInstructions) && r.otherInstructions.length)) throw new Error("Jupiter asked for extra instructions this wallet does not sign");
  const setup = (r.setupInstructions || []).map(conv);
  const swap = conv(r.swapInstruction);
  const cleanup = r.cleanupInstruction ? [conv(r.cleanupInstruction)] : [];
  const alts = (r.addressLookupTableAddresses || []).slice(0, 4).map((a) => pubkey(a));
  if ((r.addressLookupTableAddresses || []).length > 4) throw new Error("this route needs too many lookup tables");
  return { setup, swap, cleanup, alts };
}

export async function check(rpc, q, ctx, ix) {
  const { wallet, inMint, outMint, inProg, outProg, amount } = ctx;
  const wsol = T.ata(wallet, T.WSOL, T.TOKEN);
  const inAta = T.ata(wallet, inMint, inProg), outAta = T.ata(wallet, outMint, outProg);
  const fromSol = eq(inMint, T.WSOL);
  let wrapped = 0n;
  for (const [prog, metas, data] of ix.setup) {
    if (eq(prog, T.ATA_PROG)) {
      const tp = metas[5] && metas[5][0];
      if (!same([...data], [1]) || metas.length !== 6 || !metaIs(metas[0], wallet, true, true) || !metaIs(metas[2], wallet, false, false)
        || !metaIs(metas[4], SYSTEM, false, false) || !(eq(tp, T.TOKEN) || eq(tp, T.TOKEN22)) || !metaIs(metas[1], T.ata(wallet, metas[3][0], tp), false, true)) {
        throw new Error("Jupiter's setup would create an account the wallet does not own");
      }
    } else if (eq(prog, SYSTEM)) {
      if (!fromSol || data.length !== 12 || !same([...data.slice(0, 4)], [...u32(2)]) || metas.length !== 2 || !metaIs(metas[0], wallet, true, true) || !metaIs(metas[1], wsol, false, true)) {
        throw new Error("Jupiter's setup would move SOL somewhere other than this wallet's own wrapped SOL account");
      }
      wrapped += new DataView(data.buffer, data.byteOffset + 4, 8).getBigUint64(0, true);
    } else if (eq(prog, T.TOKEN)) {
      if (!same([...data], [17]) || metas.length !== 1 || !metaIs(metas[0], wsol, false, true)) throw new Error("Jupiter's setup has an unexpected token instruction");
    } else throw new Error("Jupiter's setup calls a program this wallet does not allow");
  }
  if (wrapped !== (fromSol ? amount : 0n)) throw new Error("Jupiter's setup would wrap a different amount of SOL than the swap");
  for (const [prog, metas, data] of ix.cleanup) {
    if (!eq(prog, T.TOKEN) || !same([...data], [9]) || metas.length !== 3 || !metaIs(metas[0], wsol, false, true)
      || !metaIs(metas[1], wallet, false, true) || !metaIs(metas[2], wallet, true, false)) throw new Error("Jupiter's cleanup is not a plain unwrap back to this wallet");
  }
  const [prog, metas, data] = ix.swap;
  if (!eq(prog, JUP) || data.length < 27) throw new Error("the swap does not go through the Jupiter program");
  const tag = hex(data.slice(0, 8));
  const tail = new DataView(data.buffer, data.byteOffset + data.length - 19, 19);
  const tin = tail.getBigUint64(0, true), tout = tail.getBigUint64(8, true), slip = tail.getUint16(16, true), fee = tail.getUint8(18);
  if (tin !== amount || tout !== BigInt(q.outAmount) || slip !== q.slippageBps || fee !== 0) throw new Error("the signed swap amounts would differ from the quote shown");
  const role = tag === ROUTE
    ? metaIs(metas[1], wallet, true, false) && metaIs(metas[2], inAta, false, true) && metaIs(metas[3], outAta, false, true)
      && eq(metas[4][0], JUP) && eq(metas[5][0], outMint) && eq(metas[6][0], JUP)
    : tag === SHARED
      ? metaIs(metas[2], wallet, true, false) && metaIs(metas[3], inAta, false, true) && metaIs(metas[6], outAta, false, true)
        && eq(metas[7][0], inMint) && eq(metas[8][0], outMint) && eq(metas[9][0], JUP)
      : false;
  if (!role) throw new Error("the swap would take from or pay into an account that is not this wallet's");
  for (const [, ms] of [...ix.setup, ix.swap, ...ix.cleanup]) {
    for (const [k, s] of ms) if (s && !eq(k, wallet)) throw new Error("the swap asks for a signature other than this wallet's");
  }
  const keys = [...new Map(metas.map((m) => [b58encode(m[0]), m[0]])).values()];
  const exe = await rpc.executables(keys);
  for (const k of keys) {
    const id = b58encode(k);
    if (exe.get(id) && !BASE.has(id) && !AMMS.has(id)) throw new Error(`the route uses a program this wallet does not know (${id.slice(0, 6)}…), refusing to sign`);
  }
  return [...ix.setup, ix.swap, ...ix.cleanup];
}

export const SOL_MINT = b58encode(T.WSOL);
const TX_LIMIT = 1232;

export async function mintInfo(rpc, mint, cache) {
  if (mint === SOL_MINT) return { prog: T.TOKEN, decimals: 9 };
  if (cache.mints.has(mint)) return cache.mints.get(mint);
  const acc = await rpc.account(pubkey(mint));
  if (!acc || !(eq(acc.owner, T.TOKEN) || eq(acc.owner, T.TOKEN22)) || acc.data.length < 82 || acc.data[45] !== 1) throw new Error("that address is not a token mint");
  const info = { prog: acc.owner, decimals: acc.data[44] };
  cache.mints.set(mint, info);
  return info;
}

async function tablesFor(rpc, alts, cache) {
  if (!cache.table) cache.table = await rpc.lookupTable(TABLE);
  return [cache.table, ...(await Promise.all(alts.map((a) => rpc.lookupTable(a))))];
}

export async function buildLeg(rpc, session, from, to, amount, slip, cache) {
  const fi = await mintInfo(rpc, from, cache), ti = await mintInfo(rpc, to, cache);
  const ctx = { wallet: session.wallet, inMint: pubkey(from), outMint: pubkey(to), inProg: fi.prog, outProg: ti.prog, amount };
  let last = new Error("no swap route found");
  for (const max of [28, 20]) {
    let q;
    try { q = await quote(ctx.inMint, ctx.outMint, amount, slip, max, true); }
    catch (e) { if (/no routes/i.test(e.message)) return { noRoute: true }; throw e; }
    const ix = await instructions(q, ctx);
    await check(rpc, q, ctx, ix);
    if (!cache.ataRent) cache.ataRent = BigInt(await rpc.rent(165));
    const setup = [];
    let rent = 0n;
    for (const i of ix.setup) {
      if (eq(i[0], T.ATA_PROG)) {
        if (await rpc.account(i[1][1][0])) continue;
        if (!eq(i[1][3][0], T.WSOL) || !ix.cleanup.length) rent += cache.ataRent;
      }
      setup.push(i);
    }
    const main = [ix.swap, ...ix.cleanup];
    const tables = await tablesFor(rpc, ix.alts, cache);
    if ((await session.execSize([...setup, ...main], tables)) <= TX_LIMIT) return { q, txs: [[...setup, ...main]], tables, rent };
    if (setup.length && (await session.execSize(main, tables)) <= TX_LIMIT && (await session.execSize(setup, tables)) <= TX_LIMIT) return { q, txs: [setup, main], tables, rent };
    last = new Error("this swap route is too large for one quantum-safe transaction; try another token or a different amount");
  }
  throw last;
}

export async function swapPlan(rpc, session, from, to, amount, slip, cache) {
  if (from === to) throw new Error("choose two different tokens");
  const one = await buildLeg(rpc, session, from, to, amount, slip, cache);
  if (!one.noRoute) return { legs: [one], out: BigInt(one.q.outAmount), min: minOut(one.q), via: false };
  if (from === SOL_MINT || to === SOL_MINT) throw new Error(`no pool trades {${from}} directly for {${to}}`);
  const a = await buildLeg(rpc, session, from, SOL_MINT, amount, slip, cache);
  if (a.noRoute) throw new Error(`no pool trades {${from}} for SOL`);
  const b = await buildLeg(rpc, session, SOL_MINT, to, minOut(a.q), slip, cache);
  if (b.noRoute) throw new Error(`no pool trades SOL for {${to}}`);
  return { legs: [a, b], out: BigInt(b.q.outAmount), min: minOut(b.q), via: true };
}
