import { validateRule, series, backtest, parseKlines, liqDistancePct, FEE_PCT, SLIP_PCT, touch, freshState } from "./web/lib/bot.js";

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const refuses = (rule, re, n) => { try { validateRule(rule); ok(false, n + " (accepted)"); } catch (e) { ok(re.test(e.message), `${n} (${e.message})`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const mk = (closes) => closes.map((c, i) => ({ t: 1700000000 + i * 3600, o: c, h: c * 1.01, l: c * 0.99, c, v: 100 + (i % 5) * 10 }));
const up = mk(Array.from({ length: 60 }, (_, i) => 100 + i));
ok(near(series(up, { ind: "sma", period: 5 })[10], 108), "SMA of a straight line is its middle value");
ok(series(up, { ind: "rsi", period: 14 })[30] === 100, "RSI of a series that only rises is 100");
const zig = mk(Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 4)));
const r = series(zig, { ind: "rsi", period: 14 }).slice(20);
ok(r.every((v) => v > 0 && v < 100) && Math.max(...r) > 60 && Math.min(...r) < 40, "RSI swings inside 0-100 on a wave");

const any = { left: { ind: "price" }, op: ">", right: 0 };
const base = { name: "t", coins: ["SOL"], timeframe: "1h", leverage: 10, marginUsd: 100, long: { entry: any }, stopLossPct: 2 };
ok(validateRule(base), "a simple long rule validates");
refuses({ ...base, long: undefined }, /long side, a short side/, "a rule needs at least one side");
refuses({ ...base, leverage: 126 }, /leverage/, "leverage above 125 is refused");
refuses({ ...base, leverage: 2.5 }, /whole number/, "leverage must be a whole number");
refuses({ ...base, stopLossPct: undefined }, /stop loss/, "a rule without a stop loss is refused");
refuses({ ...base, coins: [] }, /coins/, "a rule needs at least one coin");
refuses({ ...base, coins: ["SOL", "SOL"] }, /different/, "the same coin twice is refused");
refuses({ ...base, coins: ["A", "B", "C", "D", "E", "F"] }, /coins/, "more than 5 coins is refused");
refuses({ ...base, pair: "SOL/USDC" }, /unknown rule field "pair"/, "the old spot field is refused");
refuses({ ...base, long: { entry: { atLeast: 3, of: [any, any] } } }, /atLeast/, "atLeast cannot ask for more conditions than it has");
ok(validateRule({ ...base, coins: ["SOL", "ETH", "BTC"], long: { entry: { atLeast: 2, of: [any, any, any] } }, short: { entry: any, exit: any } }), "a two-sided, three-coin rule with atLeast validates");

const bar = (t, o, h, l, c, fs = 0) => ({ t: 1700000000 + t * 3600, o, h, l, c, v: 1, fs });
const flat = (n, p = 100) => Array.from({ length: n }, (_, i) => bar(i, p, p, p, p));
const run = (rule, bars) => backtest(rule, { [rule.coins[0]]: bars }, 1000, 1, bars.length);
const closeOf = (res) => res.log.find((x) => x.kind === "close");
const fee = (notional) => (notional * FEE_PCT) / 100;
const S = SLIP_PCT / 100;
const fill = (p, side, opening) => p * (1 + (opening ? side : -side) * S);
const pnlOf = (side, inRaw, outRaw, margin, lev) => { const e = fill(inRaw, side, true), x = fill(outRaw, side, false), q = (margin * lev) / e; return side * q * (x - e) - fee(q * x) - fee(margin * lev); };

{
  const rule = { ...base, leverage: 10, stopLossPct: 5, takeProfitPct: 1 };
  const bars = [...flat(2), bar(2, 100, 101.5, 99.9, 101)];
  const res = run(rule, bars), c = closeOf(res);
  ok(c && c.why === "take profit" && near(c.price, fill(100.05 * 1.01, 1, false)), "a 10x long hits a 1% take profit, filled with slippage");
  ok(c && near(c.pnl, pnlOf(1, 100, 100.05 * 1.01, 100, 10), 1e-6) && c.pnl > 8 && c.pnl < 10, `a 1% move at 10x on 100 dollars makes about 10 dollars minus fees and slippage (${c && c.pnl.toFixed(4)})`);
}
{
  const rule = { ...base, long: undefined, short: { entry: any }, leverage: 5, stopLossPct: 3, takeProfitPct: 2 };
  const bars = [...flat(2), bar(2, 100, 100.2, 97.5, 98)];
  const c = closeOf(run(rule, bars));
  ok(c && c.side === "short" && c.why === "take profit" && c.pnl > 8.5, "a short profits when the price falls");
}
{
  const rule = { ...base, leverage: 50, stopLossPct: 10 };
  const bars = [...flat(2), bar(2, 100, 100, 97, 99)];
  const res = run(rule, bars), c = closeOf(res);
  ok(near(liqDistancePct(50), 1.5), "50x liquidates after a 1.5% move against the position (2% margin minus 0.5% maintenance)");
  ok(c && c.liquidated && c.why === "liquidated" && near(c.pnl, -100 - fee(5000)), "a 3% drop liquidates a 50x long and loses the whole margin plus the opening fee");
  ok(res.liquidations === 1 && near(res.equity, 1000 - 100 - fee(5000)), "after liquidation the rest of the balance is untouched");
}
{
  const rule = { ...base, leverage: 10, stopLossPct: 2 };
  const bars = [...flat(2), bar(2, 100, 100, 97, 99)];
  const c = closeOf(run(rule, bars));
  ok(c && c.why === "stop loss" && near(c.price, fill(100.05 * 0.98, 1, false)) && !c.liquidated, "at 10x a 2% stop fires before liquidation (9.5% away)");
  ok(c && near(c.pnl, pnlOf(1, 100, 100.05 * 0.98, 100, 10)) && c.pnl < -20 && c.pnl > -22, `a 2% stop at 10x loses about 20% of the margin plus costs (${c && c.pnl.toFixed(3)})`);
}
{
  const rule = { ...base, leverage: 10, stopLossPct: 2, takeProfitPct: 2 };
  const c = closeOf(run(rule, [...flat(2), bar(2, 100, 103, 97, 100)]));
  ok(c && c.why === "stop loss", "when one candle touches both stop and take profit, the stop is assumed first");
}
{
  const rule = { ...base, leverage: 10, stopLossPct: 2 };
  const c = closeOf(run(rule, [...flat(2), bar(2, 95, 96, 94, 95)]));
  ok(c && c.why === "stop loss, opened beyond it" && near(c.price, fill(95, 1, false)), "a gap past the stop closes at the open");
  const c50 = closeOf(run({ ...rule, leverage: 50, stopLossPct: 1 }, [...flat(2), bar(2, 95, 96, 94, 95)]));
  ok(c50 && c50.liquidated, "a gap past the liquidation price liquidates even with a closer stop");
}
{
  const rule = { ...base, leverage: 10, stopLossPct: 10 };
  const bars = [...flat(2), bar(2, 100, 100, 100, 100, 0.0001), bar(3, 100, 100, 100, 100, 0.0001)];
  const res = run(rule, bars);
  const q = 1000 / fill(100, 1, true);
  ok(near(res.funding, -2 * q * 100 * 0.0001) && near(res.equity, 1000 - fee(1000) + res.funding + q * (100 - fill(100, 1, true))), "a long pays positive funding on its notional each candle");
  const resS = run({ ...rule, long: undefined, short: { entry: any } }, bars);
  ok(resS.funding > 0.19 && resS.funding < 0.21, "a short receives positive funding");
}
{
  const upTrend = { left: { ind: "price" }, op: ">", right: { ind: "price", out: "open" } }, downTrend = { left: { ind: "price" }, op: "<", right: { ind: "price", out: "open" } };
  const rule = { ...base, leverage: 2, stopLossPct: 20, long: { entry: upTrend }, short: { entry: downTrend } };
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 100, 101), bar(2, 101, 101, 99, 99), bar(3, 99, 99, 99, 99)];
  const res = run(rule, bars);
  const kinds = res.log.map((x) => `${x.kind}:${x.side}${x.why ? ":" + x.why : ""}`);
  ok(kinds.join(" ") === "open:long close:long:opposite signal open:short", `an opposite signal closes the long and opens a short on the same candle (${kinds.join(" ")})`);
}
{
  const rule = { ...base, leverage: 10, stopLossPct: 2 };
  const res = run(rule, [...flat(2), bar(2, 100, 100, 97, 99), bar(3, 99, 99, 99, 99)]);
  const ev = res.log.map((x) => `${x.kind}@${(x.t - 1700000000) / 3600}`);
  ok(ev.join(" ") === "open@1 close@2 open@3", `after a stop the agent waits for the next candle before re-entering (${ev.join(" ")})`);
}
{
  const rule = { ...base, coins: ["SOL", "ETH"], marginUsd: 400, leverage: 3, stopLossPct: 20 };
  const data = { SOL: flat(4, 100), ETH: flat(4, 2000) };
  const res = backtest(rule, data, 1000, 1, 4);
  const opens = res.log.filter((x) => x.kind === "open");
  ok(opens.length === 2 && opens.map((x) => x.coin).join() === "SOL,ETH" && near(res.equity, 1000 - fee(1200) * 2 - 1200 * S / (1 + S) * 2, 1e-6), "two coins open their own positions from one shared balance");
  const res3 = backtest({ ...rule, coins: ["SOL", "ETH", "BTC"], marginUsd: 400 }, { SOL: flat(4, 100), ETH: flat(4, 2000), BTC: flat(4, 60000) }, 1000, 1, 4);
  const m = res3.log.filter((x) => x.kind === "open").map((x) => x.margin);
  ok(m.length === 3 && near(m[0], 400) && near(m[1], 400) && m[2] < 200 && m[2] > 190, "the third coin only gets what is left of the balance");
}
{
  const s = freshState(base, 1000);
  s.pos.SOL = { side: 1, entry: 100, qty: 10, margin: 100, lev: 10, openFee: 0.45, funding: 0, t: 0 };
  const ev = touch({ ...base, stopLossPct: 2, takeProfitPct: 3 }, s, "SOL", 97.9, 1);
  ok(ev && ev.why === "stop loss" && near(ev.price, fill(98, 1, false)) && s.pos.SOL === null, "a live price tick past the stop closes the position at the stop");
}
{
  const a = { left: { ind: "price" }, op: ">", right: 0 }, no = { left: { ind: "price" }, op: "<", right: 0 };
  const two = run({ ...base, long: { entry: { atLeast: 2, of: [a, no, a] } } }, flat(3)), three = run({ ...base, long: { entry: { atLeast: 3, of: [a, no, a] } } }, flat(3));
  ok(two.log.some((x) => x.kind === "open") && !three.log.some((x) => x.kind === "open"), "atLeast 2 of 3 fires when two hold, atLeast 3 of 3 does not");
}
{
  const rule = { ...base, leverage: 2, stopLossPct: 50 };
  const bars = Array.from({ length: 24 * 70 }, (_, i) => { const p = 100 + i * 0.01; return { t: Date.UTC(2026, 0, 1) / 1000 + i * 3600, o: p, h: p, l: p, c: p, v: 1, fs: 0 }; });
  const res = backtest(rule, { SOL: bars }, 1000, 1, bars.length);
  ok(res.months.map((m) => m.month).join() === "2026-01,2026-02,2026-03" && res.allMonthsUp && res.monthsUp === 3, `monthly returns are split by calendar month (${res.months.map((m) => `${m.month} ${m.pct.toFixed(2)}%`).join(", ")})`);
}
ok(parseKlines([[1700000000000, "1", "2", "0.5", "1.5", "10"]])[0].c === 1.5, "Binance style rows parse");

console.log(`\n${pass} passed, ${fail} failed`);
