import * as U from "./lib/uniswap.js";
import { bytesToHex } from "./lib/evmtx.js";
import { formatUnits as fu, EXEC_GAS } from "./lib/evmwallet.js";

const formatUnits = (v, d) => fu(v, d, Math.min(d, 8));

const FRESH_S = 60;
const LOOKS_PINNED = ["ETH", "WETH", "USDC", "USDT", "DAI", "WBTC"];

function amountOf(text, decimals) {
  const t = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("enter an amount like 0.05");
  const [i, f = ""] = t.split(".");
  if (f.length > decimals) throw new Error(`at most ${decimals} decimals`);
  const v = BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (v <= 0n) throw new Error("enter an amount above zero");
  return v;
}

function slipOf(sel) {
  const v = Number(sel.value);
  return [50, 100, 300].includes(v) ? v : 100;
}

export function initEvmSwap(ctx) {
  const $ = ctx.$;
  const names = new Map();

  async function info(c, t) {
    if (t === U.ETH) return { address: U.ETH, symbol: c.chain.symbol, decimals: 18, balance: (await c.status()).bal, pinned: true };
    const m = await c.token(t);
    names.set(`${c.id}:${t}`, m.symbol);
    return { address: m.address, symbol: m.symbol, decimals: m.decimals, balance: await c.tokenBalance(t), pinned: t === U.UNI[c.id].usdc };
  }

  async function choices(c) {
    const out = [[U.ETH, c.chain.symbol]];
    const u = U.UNI[c.id].usdc;
    if (u) out.push([u, "USDC"]);
    for (const a of await ctx.tokens()) if (a !== u && a !== U.UNI[c.id].weth) {
      const n = names.get(`${c.id}:${a}`);
      out.push([a, `${n ? n + " " : ""}${a.slice(0, 6)}…${a.slice(-4)} (unverified)`]);
    }
    return out;
  }

  function fill(sel, items, prefer) {
    const prev = sel.value || prefer;
    sel.textContent = "";
    for (const [v, t] of items) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o); }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  const paint = async () => {
    const c = ctx.chain();
    if (!c || !U.supported(c.id)) { ctx.hide("e-sw", true); return; }
    const items = await choices(c);
    if (c !== ctx.chain()) return;
    if (items.length < 2) { ctx.hide("e-sw", true); return; }
    fill($("es-in"), items, U.ETH);
    fill($("es-out"), items, items[1][0]);
    if ($("es-in").value === $("es-out").value) $("es-out").value = items.find(([v]) => v !== $("es-in").value)[0];
  };
  ctx.onChain(() => { paint().catch(() => {}); });
  $("es-flip").addEventListener("click", () => { const a = $("es-in").value; $("es-in").value = $("es-out").value; $("es-out").value = a; });

  const sources = (c) => [c.rpc, c.check];
  const caller = (src) => async (to, data) => await src.ethCall(to, bytesToHex(data));

  async function simulate(c, calls, tout, min) {
    const runs = await Promise.all(sources(c).map(async (src) => {
      try { return U.decodeSim(await src.call("eth_call", U.simParams(c.account, calls, tout))); } catch { return null; }
    }));
    if (runs.some((r) => !r)) throw new Error("a test run of this swap did not get an answer from both network sources. Nothing was signed; try again in a moment");
    for (const r of runs) {
      if (!r.ok) throw new Error("a test run of this swap fails right now: the price may have moved past your limit, or one of the tokens blocks or taxes transfers. Nothing was signed");
      if (r.after - r.before < min) throw new Error("a test run of this swap delivers less than the minimum to your account, so the token takes a fee on transfer or the price moved. Nothing was signed");
    }
    const gas = runs.reduce((m, r) => (r.gas > m ? r.gas : m), 0n);
    const got = runs.reduce((m, r) => (r.after - r.before < m ? r.after - r.before : m), runs[0].after - runs[0].before);
    return { gas, got };
  }

  $("es-go").addEventListener("click", () => ctx.guard(async () => {
    $("es-st").textContent = "";
    const c = ctx.chain();
    if (!c) throw new Error("open a network first");
    if (!U.supported(c.id)) throw new Error("swaps are not available on this network");
    if (!c.check) throw new Error("swaps need a second network source, and this network has none. Nothing was signed");
    const s = await c.status();
    if (s.state !== "ready") throw new Error("set up this network first");
    const tin = $("es-in").value, tout = $("es-out").value;
    if (tin === tout) throw new Error("pick two different tokens");
    const cfg = U.UNI[c.id];
    if ((tin === U.ETH && tout === cfg.weth) || (tout === U.ETH && tin === cfg.weth)) throw new Error("ETH and WETH are the same coin; wrapping and unwrapping is not a swap");
    const [a, b] = await Promise.all([info(c, tin), info(c, tout)]);
    const amount = amountOf($("es-amt").value, a.decimals);
    if (a.balance === null || a.balance < amount) throw new Error(`not enough ${a.symbol}: the account holds ${a.balance === null ? "an unknown amount" : formatUnits(a.balance, a.decimals)}`);
    const slip = slipOf($("es-slip"));
    $("es-st").textContent = "Getting a price from Uniswap and testing the swap…";
    let best, min, calls, test, deadline;
    try {
      for (const src of sources(c)) await U.checkContracts(c.id, (x) => src.code(x), caller(src));
      const quotes = await Promise.all(sources(c).map((src) => U.quoteAll(c.id, tin, tout, amount, caller(src))));
      best = U.pickBest(...quotes);
      min = U.minOut(best.out, slip);
      deadline = BigInt(await c.clock()) + BigInt(U.DEADLINE_S);
      calls = U.swapCalls({ chainId: c.id, account: c.account, tokenIn: tin, tokenOut: tout, amountIn: amount, amountOutMin: min, route: best.route, deadline });
      test = await simulate(c, calls, tout, min);
    } finally { $("es-st").textContent = ""; }
    const quotedAt = Date.now();
    const inner = (test.gas * 13n) / 10n + 30000n;
    const top = await c.topupPlan(tin === U.ETH ? amount : 0n);
    const sym = (t) => t === cfg.weth ? (tin === U.ETH || tout === U.ETH ? c.chain.symbol : "WETH") : t === tin ? a.symbol : t === tout ? b.symbol : `${t.slice(0, 6)}…`;
    const rows = [
      ["You pay", `${formatUnits(amount, a.decimals)} ${a.symbol}`],
      ["You receive, about", `${formatUnits(best.out, b.decimals)} ${b.symbol}`],
      ["At least", `${formatUnits(min, b.decimals)} ${b.symbol}`],
      ["Route", `Uniswap: ${U.routeText(best.route, sym)}`],
    ];
    if (!a.pinned) rows.push([`${a.symbol} contract`, a.address, true]);
    if (!b.pinned) rows.push([`${b.symbol} contract`, b.address, true]);
    rows.push(["Network fee", await ctx.feeText(EXEC_GAS + inner)]);
    const notes = [
      { text: "Signed with one quantum-resistant one-time key. The wallet builds the swap itself and tested it on both network sources just now: the tokens come back to this account, and if less than the minimum would arrive, the whole swap is undone." },
    ];
    if (tin !== U.ETH) notes.push({ text: `This lets Uniswap's router take exactly ${formatUnits(amount, a.decimals)} ${a.symbol} for this swap and sets that permission back to zero in the same transaction.` });
    for (const t of [a, b]) if (!t.pinned) {
      if (LOOKS_PINNED.includes(t.symbol.toUpperCase()) || t.symbol.toUpperCase() === c.chain.symbol.toUpperCase()) notes.push({ text: `This token calls itself ${t.symbol} but it is not the ${t.symbol} this wallet knows. Anyone can create a token with any name. Do not swap unless you are sure of the contract address.`, warn: true });
      else notes.push({ text: `${t.symbol} is a token you added. Anyone can create a token with any name, and some tokens take a fee or can't be sold later. Check the contract address.`, warn: true });
    }
    if (top) notes.push({ text: `Your gas key is running low, so this transaction also moves ${formatUnits(top, 18)} ETH from your account to it for future network fees.` });
    if (!(await ctx.ask({ ...ctx.tag(), title: `Swap ${formatUnits(amount, a.decimals)} ${a.symbol} for ${b.symbol}`, rows, notes }, "Swap"))) return;
    if (ctx.chain() !== c) throw new Error("the network changed. Nothing was signed");
    if (Date.now() - quotedAt > FRESH_S * 1000) throw new Error("this price is more than a minute old. Nothing was signed; review the swap again");
    const now = await info(c, tin);
    if (now.balance === null || now.balance < amount + (tin === U.ETH ? top : 0n)) throw new Error("the balance changed after you confirmed. Nothing was signed");
    $("es-st").textContent = "Testing the swap again…";
    try { await simulate(c, calls, tout, min); } finally { $("es-st").textContent = ""; }
    if (top) calls.push({ to: c.feeAddress, value: top, data: new Uint8Array(0) });
    ctx.log(`swap ${formatUnits(amount, a.decimals)} ${a.symbol} for at least ${formatUnits(min, b.decimals)} ${b.symbol} on Uniswap`);
    const res = await c.execute(calls, (h) => ctx.last("Swap sent.", h), false, {
      maxInner: inner + 30000n, inner,
      settled: async () => BigInt(await c.clock()) > deadline,
      settledText: "The swap's time limit has passed, so it can never go through now",
    });
    ctx.last("Swap confirmed.", res.hash);
    ctx.ok("swap done");
    $("es-amt").value = "";
    await ctx.refreshMain();
  }));
}
