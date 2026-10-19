import { AMMS } from "./amms.js";
import { SYSTEM, b58encode, eq, findPda, pubkey, u32 } from "./solana.js";
import * as T from "./tokens.js";

export const JUP = pubkey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const TABLE = pubkey("FqmZkMZWoA3Z5c5epD9M1PSDts44iBojrqGyxE6xcJEq");
const API = "https://lite-api.jup.ag/swap/v1";
const COMPUTE = pubkey("ComputeBudget111111111111111111111111111111");
const SHARED = "c1209b3341d69c81";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const BASE = new Set([JUP, SYSTEM, T.TOKEN, T.TOKEN22, T.ATA_PROG, COMPUTE].map(b58encode).concat(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]));
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

export async function quote(inMint, outMint, amount, slippageBps, maxAccounts = 28, direct = true, exclude = []) {
  const u = new URL(`${API}/quote`);
  u.search = new URLSearchParams({
    inputMint: b58encode(inMint), outputMint: b58encode(outMint), amount: amount.toString(), slippageBps: String(slippageBps),
    maxAccounts: String(maxAccounts), swapMode: "ExactIn", dexes: [...new Set(AMMS.values())].filter((l) => !exclude.includes(l)).join(","), onlyDirectRoutes: direct ? "true" : "false",
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
    body: JSON.stringify({ quoteResponse: q, userPublicKey: b58encode(ctx.wallet), wrapAndUnwrapSol: true, useSharedAccounts: true, dynamicComputeUnitLimit: false }),
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
        || !metaIs(metas[4], SYSTEM, false, false) || !(eq(tp, T.TOKEN) || eq(tp, T.TOKEN22)) || !metaIs(metas[1], T.ata(wallet, metas[3][0], tp), false, true)
        || !(eq(metas[3][0], inMint) || eq(metas[3][0], outMint) || eq(metas[3][0], T.WSOL))) {
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
  if (tag !== SHARED || metas.length < 13) throw new Error("this swap route lets pools act for the wallet directly, which this wallet does not allow");
  const authority = findPda([new TextEncoder().encode("authority"), new Uint8Array([data[8]])], JUP).key;
  const role = metaIs(metas[1], authority, false, false) && metaIs(metas[2], wallet, true, false) && metaIs(metas[3], inAta, false, true)
    && metaIs(metas[4], T.ata(authority, inMint, inProg), false, true) && metaIs(metas[5], T.ata(authority, outMint, outProg), false, true)
    && metaIs(metas[6], outAta, false, true) && eq(metas[7][0], inMint) && eq(metas[8][0], outMint) && eq(metas[9][0], JUP);
  if (!role) throw new Error("the swap would take from or pay into an account that is not this wallet's");
  let extraWallet = false;
  const own = new Set((await rpc.tokenAccounts(wallet)).map((t) => t.account));
  for (const k of [wsol, T.ata(wallet, inMint, T.TOKEN), T.ata(wallet, inMint, T.TOKEN22), T.ata(wallet, outMint, T.TOKEN), T.ata(wallet, outMint, T.TOKEN22)]) own.add(b58encode(k));
  metas.forEach(([k], i) => {
    if (eq(k, wallet) && i !== 2) extraWallet = true;
    if ((eq(k, inAta) && i !== 3) || (eq(k, outAta) && i !== 6)) throw new Error("the swap passes the wallet's token account to a pool, refusing to sign");
    if (i > 12 && own.has(b58encode(k))) throw new Error("the swap passes another of the wallet's token accounts to a pool, refusing to sign");
  });
  for (const [, ms] of [...ix.setup, ix.swap, ...ix.cleanup]) {
    for (const [k, s] of ms) if (s && !eq(k, wallet)) throw new Error("the swap asks for a signature other than this wallet's");
  }
  const keys = [...new Map(metas.map((m) => [b58encode(m[0]), m[0]])).values()];
  const exe = await rpc.executables(keys);
  const venues = new Set();
  for (const k of keys) {
    const id = b58encode(k);
    if (exe.get(id) && !BASE.has(id) && !AMMS.has(id)) throw new Error(`the route uses a program this wallet does not know (${id.slice(0, 6)}…), refusing to sign`);
    if (exe.get(id) && !BASE.has(id)) venues.add(id);
  }
  ix.pump = venues.has(PUMP_AMM);
  if (extraWallet && !(venues.size === 1 && venues.has(PUMP_AMM))) {
    const e = new Error("the swap passes the wallet itself to a pool, refusing to sign");
    e.venues = [...venues].filter((v) => v !== PUMP_AMM).map((v) => AMMS.get(v));
    throw e;
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
  const exclude = [...(cache.bad || [])];
  for (const max of [28, 28, 28, 20]) {
    let q;
    try { q = await quote(ctx.inMint, ctx.outMint, amount, slip, max, true, exclude); }
    catch (e) { if (/no routes/i.test(e.message)) return exclude.length ? { noRoute: true, reason: last } : { noRoute: true }; throw e; }
    const ix = await instructions(q, ctx);
    try { await check(rpc, q, ctx, ix); }
    catch (e) { if (!e.venues || !e.venues.length) throw e; exclude.push(...e.venues); last = e; continue; }
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
    if ((await session.execSize([...setup, ...main], tables)) <= TX_LIMIT) return { q, ctx, ix, txs: [[...setup, ...main]], tables, rent };
    const creates = setup.filter((i) => eq(i[0], T.ATA_PROG)), wrap = setup.filter((i) => !eq(i[0], T.ATA_PROG));
    const main2 = [...wrap, ...main];
    if (creates.length && (await session.execSize(main2, tables)) <= TX_LIMIT && (await session.execSize(creates, tables)) <= TX_LIMIT) return { q, ctx, ix, txs: [creates, main2], tables, rent };
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

const amountOf = (a) => (a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n);
const lamportsOf = (a) => (a ? a.lamports : 0n);

export async function balanceGuard(rpc, ctx, min, allowance, tx) {
  const { wallet, inMint, outMint, inProg, outProg, amount } = ctx;
  const inAta = T.ata(wallet, inMint, inProg), outAta = T.ata(wallet, outMint, outProg), wsol = T.ata(wallet, T.WSOL, T.TOKEN);
  const inTx = new Set(tx.flatMap(([p, ms]) => [b58encode(p), ...ms.map((m) => b58encode(m[0]))]));
  const held = (await rpc.tokenAccounts(wallet)).map((t) => pubkey(t.account)).filter((k) => inTx.has(b58encode(k)));
  const addrs = [...new Map([wallet, wsol, inAta, outAta, ...held].filter((k) => inTx.has(b58encode(k)) || eq(k, wallet)).map((k) => [b58encode(k), k])).values()];
  const fromSol = eq(inMint, T.WSOL), toSol = eq(outMint, T.WSOL);
  return async (signed) => {
    const pre = await rpc.snapshot(addrs);
    const sim = await rpc.simulate(signed, addrs);
    if (sim.err) { const e = new Error(`the swap failed in simulation, so the wallet stopped it and retires its key: ${JSON.stringify(sim.err).slice(0, 120)}`); e.logs = sim.logs; throw e; }
    const bad = (why) => { throw new Error(`simulation shows ${why}, so the wallet stopped this swap and retires its key`); };
    const at = (k) => addrs.findIndex((x) => eq(x, k));
    const d = (k) => {
      const i = at(k);
      if (i < 0) return 0n;
      return eq(k, wallet) ? lamportsOf(sim.accounts[i]) - lamportsOf(pre[i]) : amountOf(sim.accounts[i]) - amountOf(pre[i]);
    };
    const solNet = d(wallet) + d(wsol);
    if (fromSol) { if (solNet < -(amount + allowance)) bad("more SOL leaving the wallet than you approved"); }
    else {
      if (d(inAta) < -amount) bad("more of the input token leaving the wallet than you approved");
      if (d(wallet) < -allowance) bad("SOL leaving the wallet that you did not approve");
    }
    if (toSol) { if (solNet + (fromSol ? amount : 0n) < min - allowance) bad("less SOL arriving than the minimum you approved"); }
    else if (d(outAta) < min) bad("less of the output token arriving than the minimum you approved");
    addrs.forEach((k, i) => {
      if (eq(k, wallet)) return;
      const a = pre[i], b = sim.accounts[i];
      const solSide = eq(k, wsol) && (fromSol || toSol);
      const io = eq(k, inAta) || eq(k, outAta) || solSide;
      if (a && b && a.data.length >= 165 && b.data.length >= 165) {
        const fixed = (x) => [...x.data.slice(0, 64), ...x.data.slice(72, 165)].join(",");
        const fixedNative = (x) => [...x.data.slice(0, 64), ...x.data.slice(72, 109), ...x.data.slice(121, 165)].join(",");
        if ((solSide ? fixedNative(a) !== fixedNative(b) : fixed(a) !== fixed(b))) bad("a change to who controls one of your token accounts");
      }
      if (io) { if (a && !b && !solSide) bad("one of your token accounts being closed"); return; }
      if (!a) return;
      if (!b || b.lamports !== a.lamports || b.data.join(",") !== a.data.join(",")) bad("a change to a token account this swap should not touch");
    });
  };
}

export async function secondLeg(rpc, session, to, amount, approvedMin, cache) {
  const fresh = await quote(T.WSOL, pubkey(to), amount, 100, 28, true);
  const out = BigInt(fresh.outAmount);
  if (out <= approvedMin) throw new Error("the price moved after the first swap, so the second one was not signed. You now hold SOL instead");
  const bps = Number(((out - approvedMin) * 10000n) / out);
  const leg = await buildLeg(rpc, session, SOL_MINT, to, amount, Math.max(1, Math.min(bps, 5000)), cache);
  if (leg.noRoute || minOut(leg.q) < approvedMin) throw new Error("the price moved after the first swap, so the second one was not signed. You now hold SOL instead");
  return leg;
}
