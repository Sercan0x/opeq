import * as U from "./lib/uniswap.js";
import { bytesToHex } from "./lib/evmtx.js";
import { formatUnits, EXEC_GAS } from "./lib/evmwallet.js";

const APPROVE_GAS = 60000n;
const SWAP_GAS = { 1: 230000n, 2: 340000n };
const UNWRAP_GAS = 40000n;

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
  const meta = new Map();

  async function info(c, t) {
    if (t === U.ETH) return { address: U.ETH, symbol: c.chain.symbol, decimals: 18, balance: (await c.status()).bal };
    const key = `${c.id}:${t}`;
    if (!meta.has(key)) { const m = await c.token(t); meta.set(key, { address: m.address, symbol: m.symbol, decimals: m.decimals }); }
    return { ...meta.get(key), balance: await c.tokenBalance(t) };
  }

  async function choices(c) {
    const out = [[U.ETH, c.chain.symbol]];
    const u = U.UNI[c.id] && U.UNI[c.id].usdc;
    if (u) out.push([u, "USDC"]);
    for (const a of await ctx.tokens()) if (a !== u) {
      const m = meta.get(`${c.id}:${a}`);
      out.push([a, m ? `${m.symbol} ${a.slice(0, 6)}…${a.slice(-4)} (unverified)` : `${a.slice(0, 6)}…${a.slice(-4)} (unverified)`]);
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
    if (!c) return;
    if (!U.supported(c.id)) { ctx.hide("e-sw", true); return; }
    const items = await choices(c);
    if (c !== ctx.chain()) return;
    fill($("es-in"), items, U.ETH);
    fill($("es-out"), items, items[1] ? items[1][0] : U.ETH);
    if ($("es-in").value === $("es-out").value && items.length > 1) $("es-out").value = items.find(([v]) => v !== $("es-in").value)[0];
  };
  ctx.onChain(() => { paint().catch(() => {}); });
  $("es-flip").addEventListener("click", () => { const a = $("es-in").value; $("es-in").value = $("es-out").value; $("es-out").value = a; });

  $("es-go").addEventListener("click", () => ctx.guard(async () => {
    $("es-st").textContent = "";
    const c = ctx.chain();
    if (!U.supported(c.id)) throw new Error("swaps are not available on this network");
    const s = await c.status();
    if (s.state !== "ready") throw new Error("set up this network first");
    const tin = $("es-in").value, tout = $("es-out").value;
    if (tin === tout) throw new Error("pick two different tokens");
    const [a, b] = await Promise.all([info(c, tin), info(c, tout)]);
    const amount = amountOf($("es-amt").value, a.decimals);
    if (a.balance === null || a.balance < amount) throw new Error(`not enough ${a.symbol}: the account holds ${a.balance === null ? "an unknown amount" : formatUnits(a.balance, a.decimals, a.decimals)}`);
    const slip = slipOf($("es-slip"));
    $("es-st").textContent = "Getting a price from Uniswap…";
    let best, expected, cfg = U.UNI[c.id];
    try {
      await U.checkContracts(c.id, (x) => c.rpc.code(x));
      if (c.check) await U.checkContracts(c.id, (x) => c.check.code(x));
      const call = (src) => async (to, data) => await src.ethCall(to, bytesToHex(data));
      best = await U.bestQuote(c.id, tin, tout, amount, call(c.rpc));
      expected = c.check ? await U.confirmQuote(c.id, best, amount, call(c.check)) : best.out;
    } finally { $("es-st").textContent = ""; }
    const min = U.minOut(expected, slip);
    const allowance = tin === U.ETH ? 0n : BigInt(await c.rpc.ethCall(tin, bytesToHex(U.allowanceData(c.account, cfg.router))));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + U.DEADLINE_S);
    const calls = U.swapCalls({ chainId: c.id, account: c.account, tokenIn: tin, tokenOut: tout, amountIn: amount, amountOutMin: min, route: best.route, deadline, allowance });
    const hops = best.route.fees.length;
    const inner = tin === U.ETH ? await c.callsGas(calls) : BigInt(calls.length - 1) * APPROVE_GAS + SWAP_GAS[hops] + (tout === U.ETH ? UNWRAP_GAS : 0n);
    const top = await c.topupPlan(tin === U.ETH ? amount : 0n);
    if (top) calls.push({ to: c.feeAddress, value: top, data: new Uint8Array(0) });
    const sym = (t) => t === cfg.weth ? (tin === U.ETH || tout === U.ETH ? c.chain.symbol : "WETH") : t === a.address || (tin !== U.ETH && t === tin) ? a.symbol : t === b.address || t === tout ? b.symbol : `${t.slice(0, 6)}…`;
    const rows = [
      ["You pay", `${formatUnits(amount, a.decimals, a.decimals)} ${a.symbol}`],
      ["You receive, about", `${formatUnits(expected, b.decimals, b.decimals)} ${b.symbol}`],
      ["At least", `${formatUnits(min, b.decimals, b.decimals)} ${b.symbol}`],
      ["Route", `Uniswap: ${U.routeText(best.route, sym)}`],
      ["Network fee", await ctx.feeText(EXEC_GAS + inner)],
    ];
    const notes = [
      { text: "Signed with one quantum-resistant one-time key. The wallet builds the swap itself: it goes to Uniswap's router, the tokens come back to this account, and if the pool would give less than the minimum the whole swap is undone." },
    ];
    if (tin !== U.ETH) notes.push({ text: `This lets Uniswap's router take exactly ${formatUnits(amount, a.decimals, a.decimals)} ${a.symbol} for this swap, and sets that permission back to zero in the same transaction.` });
    if (tin !== U.ETH && tin !== cfg.usdc || tout !== U.ETH && tout !== cfg.usdc) notes.push({ text: "One of these tokens is one you added. Token names can be copied by anyone; check the contract address.", warn: true });
    if (top) notes.push({ text: `Your gas key is running low, so this transaction also moves ${formatUnits(top, 18, 8)} ETH from your account to it for future network fees.` });
    if (!(await ctx.ask({ ...ctx.tag(), title: `Swap ${formatUnits(amount, a.decimals, a.decimals)} ${a.symbol} for ${b.symbol}`, rows, notes }, "Swap"))) return;
    if (ctx.chain() !== c) throw new Error("the network changed. Nothing was signed");
    if (BigInt(Math.floor(Date.now() / 1000)) > deadline - 60n) throw new Error("the price is too old. Nothing was signed; review the swap again");
    const now = await info(c, tin);
    if (now.balance === null || now.balance < amount) throw new Error("the balance changed after you confirmed. Nothing was signed");
    ctx.log(`swap ${formatUnits(amount, a.decimals, a.decimals)} ${a.symbol} for at least ${formatUnits(min, b.decimals, b.decimals)} ${b.symbol} on Uniswap`);
    const res = await c.execute(calls, (h) => ctx.last("Swap sent.", h), false, { maxInner: (inner * 13n) / 10n + 30000n, inner });
    ctx.last("Swap confirmed.", res.hash);
    ctx.ok("swap done");
    $("es-amt").value = "";
    await ctx.refreshMain();
  }));
}
