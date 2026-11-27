import { validateRule, series, signalAt, backtest, parseKlines } from "./web/lib/bot.js";

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const refuses = (rule, re, n) => { try { validateRule(rule); ok(false, n + " (accepted)"); } catch (e) { ok(re.test(e.message), `${n} (${e.message})`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const mk = (closes) => closes.map((c, i) => ({ t: 1700000000 + i * 3600, o: c, h: c * 1.01, l: c * 0.99, c, v: 100 + (i % 5) * 10 }));
const up = mk(Array.from({ length: 60 }, (_, i) => 100 + i));
ok(near(series(up, { ind: "sma", period: 5 })[10], 108), "SMA of a straight line is its middle value");
ok(series(up, { ind: "rsi", period: 14 })[30] === 100, "RSI of a series that only rises is 100");
const e = series(up, { ind: "ema", period: 10 });
ok(Number.isNaN(e[8]) && near(e[9], 104.5) && e[30] < 130 && e[30] > 120, "EMA starts at the SMA seed and lags a rising line");
const bbU = series(up, { ind: "bb", period: 20, stddev: 2, out: "upper" })[40], bbL = series(up, { ind: "bb", period: 20, stddev: 2, out: "lower" })[40];
ok(near((bbU + bbL) / 2, series(up, { ind: "sma", period: 20 })[40]), "Bollinger bands sit symmetric around the SMA");
const zig = mk(Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 4)));
const r = series(zig, { ind: "rsi", period: 14 }).slice(20);
ok(r.every((v) => v > 0 && v < 100) && Math.max(...r) > 60 && Math.min(...r) < 40, "RSI swings inside 0-100 on a wave");
const h = series(zig, { ind: "macd", fast: 12, slow: 26, signal: 9, out: "hist" });
ok(near(h[60], series(zig, { ind: "macd", fast: 12, slow: 26, signal: 9, out: "line" })[60] - series(zig, { ind: "macd", fast: 12, slow: 26, signal: 9, out: "signal" })[60]), "MACD histogram is line minus signal");

const base = { name: "test", pair: "SOL/USDC", timeframe: "1h", entry: { left: { ind: "rsi", period: 14 }, op: "<", right: 30 }, stopLossPct: 3, orderUsd: 100 };
ok(validateRule(base), "a simple RSI rule is valid");
refuses({ ...base, stopLossPct: undefined }, /stop loss/, "a rule without a stop loss is refused");
refuses({ ...base, leverage: 20 }, /unknown rule field "leverage"/, "leverage cannot be smuggled in");
refuses({ ...base, pair: "BTC/USDT" }, /pair/, "an unknown pair is refused");
refuses({ ...base, entry: { left: { ind: "rsi", period: 1 }, op: "<", right: 30 } }, /from 2 to 200/, "an RSI period of 1 is refused");
refuses({ ...base, entry: { left: { ind: "rsi", period: 14, foo: 1 }, op: "<", right: 30 } }, /no setting "foo"/, "unknown indicator settings are refused");
refuses({ ...base, entry: { left: 5, op: "<", right: 30 } }, /at least one indicator/, "a constant comparison is refused");
refuses({ ...base, entry: { left: { ind: "eval", period: 3 }, op: "<", right: 1 } }, /unknown indicator/, "unknown indicators are refused");
refuses({ ...base, entry: { left: { ind: "macd", fast: 26, slow: 12, signal: 9 }, op: ">", right: 0 } }, /fast must be below slow/, "MACD with fast above slow is refused");
let deep = base.entry; for (let i = 0; i < 6; i++) deep = { not: deep };
refuses({ ...base, entry: deep }, /nested too deeply/, "deeply nested rules are refused");
refuses({ ...base, entry: { any: Array.from({ length: 8 }, () => ({ all: [base.entry, base.entry, base.entry, base.entry] })) } }, /too many conditions/, "huge rules are refused");
refuses({ ...base, orderUsd: 0 }, /orderUsd/, "a zero order size is refused");

const cross = { ...base, entry: { cross: "above", a: { ind: "ema", period: 5 }, b: { ind: "ema", period: 20 } } };
const v = mk([...Array.from({ length: 40 }, (_, i) => 120 - i), ...Array.from({ length: 40 }, (_, i) => 81 + i * 2)]);
const crossBars = v.map((_, i) => signalAt(cross, v, i).entry).map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
ok(crossBars.length === 1 && crossBars[0] > 40 && crossBars[0] < 55, `an EMA cross fires once, shortly after the turn (bar ${crossBars})`);

const bt = backtest({ ...base, entry: { left: { ind: "rsi", period: 14 }, op: "<", right: 35 }, exit: { left: { ind: "rsi", period: 14 }, op: ">", right: 65 } }, zig, 1000);
ok(bt.trades > 0 && Number.isFinite(bt.equity), `a backtest on a wave trades (${bt.trades} trades, ${bt.returnPct.toFixed(1)}%)`);
const sl = backtest({ ...base, entry: { left: { ind: "price" }, op: ">", right: 0 }, stopLossPct: 2 }, mk(Array.from({ length: 30 }, (_, i) => 100 - i * 3)), 1000);
ok(sl.log.some((x) => x.why === "stop loss") && sl.log.filter((x) => x.kind === "sell").every((x) => x.pnl < 0), "the stop loss closes a losing position");
const capped = backtest({ ...base, entry: { left: { ind: "price" }, op: ">", right: 0 }, takeProfitPct: 0.5, stopLossPct: 0.5, maxTradesPerDay: 2 }, zig, 1000);
const perDay = {}; for (const x of capped.log.filter((x) => x.kind === "buy")) { const d = Math.floor(x.t / 86400); perDay[d] = (perDay[d] || 0) + 1; }
ok(Object.values(perDay).every((n) => n <= 2), "maxTradesPerDay caps the buys per day");
ok((() => { try { parseKlines([[2, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1]]); return false; } catch { return true; } })(), "out-of-order price data is refused");
ok((() => { try { parseKlines([[1, 1, 1, 1, "x", 1]]); return false; } catch { return true; } })(), "broken price data is refused");

if (process.argv[2] === "live") {
  const rows = await (await fetch("https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1h&limit=1000")).json();
  const candles = parseKlines(rows);
  const rule = { name: "RSI dip with trend", pair: "SOL/USDC", timeframe: "1h", entry: { all: [{ left: { ind: "rsi", period: 14 }, op: "<", right: 32 }, { left: { ind: "price" }, op: ">", right: { ind: "sma", period: 200 } }] }, exit: { left: { ind: "rsi", period: 14 }, op: ">", right: 60 }, takeProfitPct: 4, stopLossPct: 2.5, orderUsd: 200, maxTradesPerDay: 2 };
  const res = backtest(rule, candles, 1000);
  console.log(`live: ${candles.length} hourly SOL candles, ${res.trades} trades, ${res.wins} wins, strategy ${res.returnPct.toFixed(2)}% vs hold ${res.holdPct.toFixed(2)}%`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
