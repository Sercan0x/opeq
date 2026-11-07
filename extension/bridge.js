import * as R from "./lib/relay.js";
import { pubkey, b58encode } from "./lib/solana.js";
import * as T from "./lib/tokens.js";
import { formatUnits, EXEC_GAS } from "./lib/evmwallet.js";
import { balRow, held } from "./balrow.js";

const CU_BRIDGE = 400000;
const SOL_KEEP = 2000000n;
const ERC20_DEPOSIT_GAS = 150000n;
const POLL_MS = 4000, POLL_MAX = 75, CLEAR_MS = 20000;
const NAME = { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 4663: "Robinhood Chain", [R.SOLANA_ID]: "Solana" };


const solCard = { gen: 0 }, evmCard = { gen: 0 };
export function stopEvm() { evmCard.gen++; }
export function stopSol() { solCard.gen++; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fill(sel, items, keep) {
  const prev = keep ?? sel.value;
  sel.textContent = "";
  for (const [v, t] of items) { const o = el("option", "", t); o.value = String(v); sel.append(o); }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function amountOf(text, decimals) {
  const t = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("enter an amount like 0.05");
  const [i, f = ""] = t.split(".");
  if (f.length > decimals) throw new Error(`at most ${decimals} decimals`);
  const v = BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (v <= 0n) throw new Error("enter an amount above zero");
  return v;
}

const fmt = (v, d) => formatUnits(v, d, Math.min(d, 8));

function feeConfig(NET) {
  const b = NET.bridge || {};
  return b.feeBps > 0 && /^0x[0-9a-f]{40}$/.test(b.feeTo || "") ? { bps: b.feeBps, recipient: b.feeTo } : null;
}

async function prepare(ctx, from, to, kind, amount, user, slippageBps) {
  const dest = await ctx.myAddress(to);
  const req = R.request({ from, to, kind, amount, user, recipient: dest.address, slippageBps, appFee: feeConfig(ctx.NET) });
  const q = await R.quote(req, { api: (ctx.NET.bridge && ctx.NET.bridge.api) || R.API });
  const c = R.check(q, req, Math.floor(Date.now() / 1000));
  return { req, q, c, dest };
}

function reviewRows(from, to, kind, p) {
  const a = R.ASSETS[from][kind], b = R.ASSETS[to][kind];
  const rows = [
    ["You send", `${fmt(p.c.amount, a.decimals)} ${a.symbol} on ${NAME[from]}`],
    ["You receive, about", `${fmt(p.c.expected, b.decimals)} ${b.symbol} on ${NAME[to]}`],
    ["At least", `${fmt(p.c.min, b.decimals)} ${b.symbol}`],
    [`Your address on ${NAME[to]}`, p.dest.address, true],
  ];
  if (p.c.feeUsd !== null) rows.push(["Relay fee", `about $${p.c.feeUsd.toFixed(2)}`]);
  if (p.c.appFee > 0n) rows.push(["OPEQ fee", `${fmt(p.c.appFee, a.decimals)} ${a.symbol}`]);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (p.c.seconds) rows.push(["Time", `about ${p.c.seconds < 60 ? plural(p.c.seconds, "second") : plural(Math.round(p.c.seconds / 60), "minute")}`]);
  return rows;
}

function reviewNotes(ctx, from, to, p) {
  const notes = [
    { text: "Signed with one quantum-resistant one-time key." },
    { text: `Bridged by Relay. The funds go into Relay's deposit contract and arrive at your own OPEQ address on ${NAME[to]}. Until Relay delivers, usually within seconds, you rely on Relay, and that step is not quantum-resistant. If the bridge does not complete, Relay has committed to refund your own address on ${NAME[from]} or ${NAME[to]}.`, warn: true },
  ];
  const f = feeConfig(ctx.NET);
  if (f) notes.push({ text: `Includes an OPEQ fee of ${(f.bps / 100).toFixed(2)}%.` });
  if (p.dest.note) notes.push({ text: p.dest.note, warn: true });
  return notes;
}

function follow(ctx, card, requestId, from, to, stEl, okEl) {
  if (!requestId) return;
  const gen = card.gen, who = ctx.owner();
  const live = () => card.gen === gen && ctx.owner() === who;
  const say = (t) => { if (live()) stEl.textContent = t; };
  const ref = `Relay request ${requestId.length > 20 ? `${requestId.slice(0, 10)}…${requestId.slice(-6)}` : requestId}`;
  const settle = (t) => {
    say(t);
    if (live()) ctx.done();
    setTimeout(() => {
      if (!live() || stEl.textContent !== t) return;
      stEl.textContent = "";
      if (okEl && okEl.textContent.startsWith("deposit sent to Relay")) okEl.textContent = "";
    }, CLEAR_MS);
  };
  (async () => {
    say(`Bridge: waiting for Relay to see the deposit. ${ref}`);
    for (let i = 0; i < POLL_MAX; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!live()) return;
      let s;
      try { s = await R.status(requestId, { api: (ctx.NET.bridge && ctx.NET.bridge.api) || R.API }); } catch { continue; }
      if (s.status === "success") { settle(`Bridge done: the funds arrived on ${NAME[to]}.`); return; }
      if (s.status === "refund") { settle(`Bridge refunded: Relay sent the funds back to your own address on ${NAME[from]} or ${NAME[to]}.`); return; }
      if (s.status === "failure") { say(`Bridge failed on Relay's side. Relay has committed to refund failed bridges; look up the request on relay.link if nothing arrives. ${ref}`); return; }
      const word = { waiting: "waiting for Relay to see the deposit", pending: `sending on ${NAME[to]}`, submitted: `sending on ${NAME[to]}`, delayed: "delayed at Relay, still in progress" }[s.status] || `Relay reports "${s.status}"`;
      say(`Bridge: ${word}. ${ref}`);
    }
    say(`Bridge: still in progress. Look up the request on relay.link. ${ref}`);
  })();
}

const sent = (e) => !!(e && (e.sent || e.broadcast || e.pending || e.maybeLanded || e.hash));

function slipOf(sel) {
  const v = Number(sel.value);
  return [50, 100, 300].includes(v) ? v : 100;
}

export function initSol(ctx) {

  const $ = ctx.$;
  const from = R.SOLANA_ID;
  const paint = () => {
    fill($("b-to"), R.destinations(from).map((id) => [id, NAME[id]]));
    const to = Number($("b-to").value);
    fill($("b-kind"), R.kinds(from, to).map((k) => [k, k === "native" ? `SOL to ${R.ASSETS[to].native.symbol}` : "USDC to USDC"]));
  };
  paint();
  $("b-to").addEventListener("change", paint);
  balRow($("b-amt"), () => {
    if (!ctx.owner()) return null;
    const kind = $("b-kind").value, asset = R.ASSETS[from][kind];
    return asset ? held(ctx.held(asset), asset.decimals, asset.symbol, kind === "native" ? ctx.reserve : 0n) : null;
  }, [$("b-to"), $("b-kind")]);
  $("b-go").addEventListener("click", () => ctx.guard(async () => {
    solCard.gen++;
    $("b-st").textContent = "";
    const s = ctx.session(), rpc = ctx.rpc();
    const to = Number($("b-to").value), kind = $("b-kind").value;
    const asset = R.ASSETS[from][kind];
    const amount = amountOf($("b-amt").value, asset.decimals);
    const wallet = s.wallet;
    let mint = null, spend = 0n;
    if (kind === "native") {
      const bal = BigInt(await rpc.balance(wallet));
      if (bal < amount + SOL_KEEP) throw new Error(`not enough SOL: the wallet holds ${fmt(bal, 9)} and keeps ${fmt(SOL_KEEP, 9)} for fees`);
      spend = amount;
    } else {
      mint = pubkey(asset.address);
      const acc = await rpc.account(T.ata(wallet, mint, T.TOKEN));
      const have = acc && acc.data && acc.data.length >= 72 ? new DataView(acc.data.buffer, acc.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n;
      if (have < amount) throw new Error(`not enough USDC: the wallet holds ${fmt(have, 6)}`);
    }
    $("b-st").textContent = "Getting a quote from Relay…";
    let p, ix;
    try {
      p = await prepare(ctx, from, to, kind, amount, b58encode(wallet), slipOf($("b-slip")));
      ix = R.solanaIx(wallet, mint, amount, p.c.orderId, T.TOKEN);
      if (!R.matchesApi(p.q, from, ix)) throw new Error("Relay's deposit instruction differs from the one this wallet builds. Nothing was signed");
    } finally { $("b-st").textContent = ""; }
    const plan = await ctx.planTopup([ix], [], spend);
    const rows = [...reviewRows(from, to, kind, p), ["Network fee", await ctx.fee(CU_BRIDGE)]];
    const notes = [...reviewNotes(ctx, from, to, p), ...(plan.note ? [{ text: plan.note.trim() }] : [])];
    if (!(await ctx.ask({ ...ctx.tag(), title: `Bridge ${fmt(amount, asset.decimals)} ${asset.symbol} to ${NAME[to]}`, rows, notes }, "Bridge"))) return;
    ctx.log(`bridge ${fmt(amount, asset.decimals)} ${asset.symbol} to ${NAME[to]}: Relay request ${p.c.requestId}`);
    let sig;
    try { sig = await ctx.run("bridging, grinding the signature", [ix], plan, { cu: CU_BRIDGE, spend }); }
    catch (e) { if (sent(e)) follow(ctx, solCard, p.c.requestId, from, to, $("b-st"), $("b-ok")); throw e; }
    ctx.log(`bridge deposit to Relay: ${sig}`, "ok");
    ctx.ok(`deposit sent to Relay: ${sig.slice(0, 12)}…`);
    $("b-amt").value = "";
    follow(ctx, solCard, p.c.requestId, from, to, $("b-st"), $("b-ok"));
  }));
}

export function initEvm(ctx) {

  const $ = ctx.$;
  const paint = () => {
    const c = ctx.chain();
    if (!c) return;
    const from = c.id;
    fill($("eb-to"), R.destinations(from).map((id) => [id, NAME[id]]));
    const to = Number($("eb-to").value);
    fill($("eb-kind"), R.kinds(from, to).map((k) => [k, k === "native" ? `ETH to ${R.ASSETS[to].native.symbol}` : "USDC to USDC"]));
  };
  const bal = balRow($("eb-amt"), async () => {
    const c = ctx.chain();
    if (!c || !ctx.owner()) return null;
    const kind = $("eb-kind").value, asset = R.ASSETS[c.id] && R.ASSETS[c.id][kind];
    if (!asset) return null;
    const amount = kind === "native" ? (await c.status()).bal : await c.tokenBalance(asset.address);
    return c === ctx.chain() ? held(amount, asset.decimals, asset.symbol) : null;
  }, [$("eb-to"), $("eb-kind")]);
  ctx.onChain(() => { paint(); bal(); });
  $("eb-to").addEventListener("change", paint);
  $("eb-go").addEventListener("click", () => ctx.guard(async () => {
    evmCard.gen++;
    $("eb-st").textContent = "";
    const c = ctx.chain();
    const from = c.id, to = Number($("eb-to").value), kind = $("eb-kind").value;
    if (!R.kinds(from, to).includes(kind)) throw new Error("pick where to bridge");
    const asset = R.ASSETS[from][kind];
    const amount = amountOf($("eb-amt").value, asset.decimals);
    const s = await c.status();
    if (s.state !== "ready") throw new Error("set up this network first");
    if (kind === "native") { if (s.bal < amount) throw new Error(`not enough ETH: the account holds ${fmt(s.bal, 18)}`); }
    else { const t = await c.token(asset.address); if (t.balance < amount) throw new Error(`not enough USDC: the account holds ${fmt(t.balance, 6)}`); }
    $("eb-st").textContent = "Getting a quote from Relay…";
    let p, calls;
    try {
      p = await prepare(ctx, from, to, kind, amount, c.account, slipOf($("eb-slip")));
      calls = R.evmCalls(c.account, asset.address, amount, p.c.orderId);
      if (!R.matchesApi(p.q, from, calls)) throw new Error("Relay's deposit differs from the one this wallet builds. Nothing was signed");
    } finally { $("eb-st").textContent = ""; }
    const inner = kind === "native" ? await c.callsGas(calls) : (await c.callsGas([calls[0]])) + ERC20_DEPOSIT_GAS;
    const top = await c.topupPlan(kind === "native" ? amount : 0n);
    if (top) calls.push({ to: c.feeAddress, value: top, data: new Uint8Array(0) });
    const rows = [...reviewRows(from, to, kind, p), ["Network fee", await ctx.feeText(EXEC_GAS + inner)]];
    const notes = reviewNotes(ctx, from, to, p);
    if (kind === "usdc") notes.push({ text: `This also lets Relay's deposit contract take exactly ${fmt(amount, 6)} USDC, in the same transaction.` });
    if (top) notes.push({ text: `Your gas key is running low, so this transaction also moves ${formatUnits(top, 18, 8)} ETH from your account to it for future network fees.` });
    if (!(await ctx.ask({ ...ctx.tag(), title: `Bridge ${fmt(amount, asset.decimals)} ${asset.symbol} to ${NAME[to]}`, rows, notes }, "Bridge"))) return;
    if (ctx.chain() !== c) throw new Error("the network changed. Nothing was signed");
    if (Math.floor(Date.now() / 1000) > p.c.deadline - 60) throw new Error("the quote expired. Nothing was signed; review the bridge again");
    const now = await c.status();
    const left = kind === "native" ? now.bal : (await c.token(asset.address)).balance;
    if (left < amount + (kind === "native" ? top : 0n) || (kind !== "native" && top && now.bal < top)) throw new Error("the balance changed after you confirmed. Nothing was signed");
    ctx.log(`bridge ${fmt(amount, asset.decimals)} ${asset.symbol} from ${NAME[from]} to ${NAME[to]}: Relay request ${p.c.requestId}`);
    let res;
    try { res = await c.execute(calls, (h) => ctx.last("Bridge deposit sent.", h), false, { maxInner: (inner * 12n) / 10n + 20000n, inner }); }
    catch (e) { if (sent(e)) follow(ctx, evmCard, p.c.requestId, from, to, $("eb-st"), $("e-ok")); throw e; }
    ctx.last("Bridge deposit confirmed.", res.hash);
    ctx.ok("deposit sent to Relay");
    $("eb-amt").value = "";
    follow(ctx, evmCard, p.c.requestId, from, to, $("eb-st"), $("e-ok"));
    await ctx.refreshMain();
  }));
}
