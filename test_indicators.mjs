import { REGISTRY, series, resample, describe } from "./web/lib/indicators.js";
import { validateRule, backtest, parseKlines } from "./web/lib/bot.js";

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const fin = (v) => typeof v === "number" && Number.isFinite(v);

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
function walk(n, start = 100, t0 = 1700000000 - (1700000000 % 86400)) {
  const C = []; let p = start;
  for (let i = 0; i < n; i++) {
    const o = p, c = Math.max(1, o * (1 + (rnd() - 0.5) * 0.04)), h = Math.max(o, c) * (1 + rnd() * 0.01), l = Math.min(o, c) * (1 - rnd() * 0.01), v = 100 + rnd() * 900;
    C.push({ t: t0 + i * 3600, o, h, l, c, v, tb: v * rnd(), nt: 20 + Math.floor(rnd() * 200), fr: (rnd() - 0.4) * 0.02, oi: 5e8 * (1 + rnd() * 0.1), ls: 1 + rnd() * 3, lsl: 50 + rnd() * 30 }); p = c;
  }
  return C;
}
const line = (n, a = 100, b = 1) => Array.from({ length: n }, (_, i) => { const c = a + b * i; return { t: 1700000000 + i * 3600, o: c - b / 2, h: c + Math.abs(b), l: c - Math.abs(b) - b / 2, c, v: 100 + i, tb: 60 + i * 0.6 }; });

const W = walk(400);
const refsFor = (k, s) => {
  const base = { ind: k };
  if (s.names) base.name = s.names[0];
  return s.out.map((o) => ({ ...base, out: o }));
};
let looks = [], nanOnly = [];
for (const [k, s] of Object.entries(REGISTRY)) {
  for (const ref of refsFor(k, s)) {
    for (const tf of [undefined, "4h", "1d"]) {
      const r = tf ? { ...ref, tf } : ref;
      const full = series(W, r, "1h");
      if (!full.some(fin) && !tf) nanOnly.push(`${k}.${ref.out}`);
      for (const cut of [120, 237, 399]) {
        const part = series(W.slice(0, cut), r, "1h");
        for (let i = 0; i < cut; i++) {
          const a = full[i], b = part[i];
          if (!(Number.isNaN(a) && Number.isNaN(b)) && !near(a, b, 1e-7 * Math.max(1, Math.abs(a)))) { looks.push(`${k}.${ref.out}${tf ? "@" + tf : ""} at ${i}/${cut}`); break; }
        }
      }
    }
  }
}
ok(looks.length === 0, `no indicator output looks ahead (${Object.keys(REGISTRY).length} indicators, every output, on 1h, 4h and 1d)${looks.length ? ": " + looks.slice(0, 6).join(", ") : ""}`);
ok(nanOnly.length === 0, `every output produces values on 400 candles${nanOnly.length ? ": " + nanOnly.join(", ") : ""}`);

const wil = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28].map((c, i) => ({ t: i * 86400, o: c, h: c, l: c, c, v: 1 }));
const hand = 100 - 100 / (1 + 3.34 / 1.40);
ok(near(series(wil, { ind: "rsi", period: 14 }, "1d")[14], hand, 1e-6) && near(hand, 70.53, 0.08), `RSI on Wilder's textbook closes matches the hand calculation (${hand.toFixed(2)}; the published table shows 70.53, a second-decimal difference)`);

const L = line(300);
const at = (r, i = 290) => series(L, r, "1h")[i];
ok(near(at({ ind: "linreg", period: 20, out: "slope" }), 1, 1e-9) && near(at({ ind: "linreg", period: 20, out: "r2" }), 1, 1e-9) && near(at({ ind: "linreg", period: 20 }), L[290].c, 1e-9), "linear regression of a straight line: slope 1, R² 1, value on the line");
ok(near(at({ ind: "dema", period: 10 }), L[290].c, 1e-6) && near(at({ ind: "tema", period: 10 }), L[290].c, 1e-6), "DEMA and TEMA have no lag on a straight line");
ok(near(at({ ind: "hma", period: 16 }), L[290].c - 2 / 3, 1e-6), "Hull MA lags a straight line by exactly 2/3 candle at period 16, as its formula gives");
ok(near(at({ ind: "sma", period: 21 }), L[280].c, 1e-9) && near(at({ ind: "wma", period: 20 }), L[290].c - 19 / 3, 1e-9), "SMA and WMA lag a straight line by the textbook amount");
ok(at({ ind: "rsi", period: 14 }) === 100 && at({ ind: "mfi", period: 14 }) === 100, "RSI and MFI are 100 when price only rises");
ok(at({ ind: "aroon", period: 25, out: "up" }) === 100 && at({ ind: "aroon", period: 25, out: "down" }) === 0, "Aroon up 100, down 0 in a steady rise");
ok(at({ ind: "adx", period: 14 }) > 50 && at({ ind: "adx", period: 14, out: "plus" }) > at({ ind: "adx", period: 14, out: "minus" }), "ADX shows a strong trend with +DI above -DI");
ok(at({ ind: "supertrend", period: 10, mult: 3, out: "dir" }) === 1 && at({ ind: "psar" }) < L[290].c, "SuperTrend points up and the parabolic SAR sits below price");
ok(at({ ind: "rank", period: 50 }) === 100 && at({ ind: "drawdown", period: 50 }) === 0, "percentile rank 100 and no drawdown at a new high");
ok(L[290].h > at({ ind: "donchian", period: 20 }) && at({ ind: "highest", period: 20 }) < L[290].h, "Donchian and highest exclude the current candle, so a breakout is visible");
const zz = Array.from({ length: 300 }, (_, i) => { const c = 100 + (i % 2 ? 1 : -1); return { t: 1700000000 + i * 3600, o: 200 - c, h: 102, l: 98, c, v: 100, tb: 50 }; });
ok(series(zz, { ind: "chop", period: 14 }, "1h")[200] > 70 && series(L, { ind: "chop", period: 14 }, "1h")[200] < 40, "choppiness is high when price zigzags and low in a trend");
ok(near(series(zz, { ind: "cci", period: 20 }, "1h")[201] + series(zz, { ind: "cci", period: 20 }, "1h")[200], 0, 1e-6), "CCI is symmetric on a symmetric zigzag");
const wr = series(W, { ind: "willr", period: 14 }, "1h"), st = series(W, { ind: "stoch", period: 14, smooth: 1 }, "1h");
ok(W.every((_, i) => !fin(wr[i]) || near(wr[i], st[i] - 100, 1e-9)), "Williams %R equals the raw stochastic minus 100");
const up = series(W, { ind: "bb", period: 20, out: "upper" }, "1h"), lo = series(W, { ind: "bb", period: 20, out: "lower" }, "1h"), mid = series(W, { ind: "bb", period: 20, out: "middle" }, "1h");
ok(W.every((_, i) => !fin(mid[i]) || near((up[i] + lo[i]) / 2, mid[i], 1e-9)), "Bollinger bands are symmetric around the middle");
const ku = series(W, { ind: "keltner", out: "upper" }, "1h"), kl = series(W, { ind: "keltner", out: "lower" }, "1h"), km = series(W, { ind: "keltner", out: "middle" }, "1h");
ok(W.every((_, i) => !fin(km[i]) || near((ku[i] + kl[i]) / 2, km[i], 1e-9)), "Keltner channel is symmetric around its EMA");
const z = series(W, { ind: "zscore", period: 30 }, "1h").filter(fin);
ok(z.every((v) => Math.abs(v) < 6), "z-scores stay in a sane range");
const bounded = [["rsi", 0, 100], ["mfi", 0, 100], ["stoch", 0, 100], ["stochrsi", 0, 100], ["uo", 0, 100], ["crsi", 0, 100], ["chop", 0, 100], ["aroon", 0, 100], ["cmf", -1, 1], ["bop", -1, 1], ["cmo", -100, 100], ["willr", -100, 0], ["takerbuy", 0, 1], ["squeeze", 0, 1]];
ok(bounded.every(([k, a, b]) => series(W, { ind: k }, "1h").filter(fin).every((v) => v >= a - 1e-9 && v <= b + 1e-9)), "bounded oscillators stay inside their ranges");

const cdl = (o, h, l, c) => ({ t: 0, o, h, l, c, v: 1 });
const pat = (arr, name) => series(arr.map((c, i) => ({ ...c, t: i * 3600 })), { ind: "pattern", name }, "1h").at(-1);
ok(pat([cdl(10, 10.2, 8.9, 9), cdl(8.8, 10.6, 8.7, 10.5)], "bullEngulfing") === 1 && pat([cdl(9, 10.1, 8.9, 10), cdl(10.2, 10.3, 8.5, 8.7)], "bearEngulfing") === 1, "engulfing patterns are found");
ok(pat([cdl(10, 10, 10, 10), cdl(10, 10.1, 8, 10.05)], "hammer") === 1 && pat([cdl(10, 10, 10, 10), cdl(10, 12, 9.95, 9.98)], "shootingStar") === 1 && pat([cdl(10, 10, 10, 10), cdl(10, 11, 9, 10.01)], "doji") === 1, "hammer, shooting star and doji are found");
ok(pat([cdl(10, 10.2, 8.9, 9), cdl(8.8, 10.6, 8.7, 10.5)], "hammer") === 0, "a big engulfing candle is not a hammer");

const { candles: H4, map } = resample(W, "1h", "4h");
const first = W.findIndex((c) => c.t % 14400 === 0);
const b4 = H4.find((c) => c.t === W[first].t);
ok(b4 && b4.o === W[first].o && b4.c === W[first + 3].c && b4.h === Math.max(...W.slice(first, first + 4).map((c) => c.h)) && near(b4.v, W.slice(first, first + 4).reduce((a, c) => a + c.v, 0)), "4h candles are built correctly from 1h candles");
ok(H4[map[first + 2]] !== b4 && H4[map[first + 3]] === b4, "a 4h value is used only after its 4h candle has closed");
ok((() => { try { resample(W, "4h", "1h"); return false; } catch { return true; } })(), "a shorter timeframe cannot be built from longer candles");

const base = { name: "t", pair: "SOL/USDC", timeframe: "1h", stopLossPct: 3, orderUsd: 100 };
const bad = (entry, re, n) => { try { validateRule({ ...base, entry }); ok(false, n); } catch (e) { ok(re.test(e.message), `${n} (${e.message})`); } };
ok(validateRule({ ...base, entry: { all: [{ left: { ind: "rsi", period: 14, tf: "4h" }, op: "<", right: 40 }, { left: { ind: "supertrend", out: "dir" }, op: ">", right: 0 }, { left: { ind: "pattern", name: "hammer" }, op: ">=", right: 1 }] } }), "a rule mixing 4h RSI, SuperTrend and a candle pattern is valid");
bad({ left: { ind: "rsi", tf: "15m" }, op: "<", right: 30 }, /must be 1h or a longer/, "a timeframe shorter than the rule's is refused");
bad({ left: { ind: "rsi", tf: "3h" }, op: "<", right: 30 }, /tf must be one of/, "an unknown timeframe is refused");
bad({ left: { ind: "pattern", name: "dragon" }, op: ">", right: 0 }, /pattern name/, "an unknown candle pattern is refused");
bad({ left: { ind: "ppo", fast: 30, slow: 20 }, op: ">", right: 0 }, /fast must be below slow/, "PPO fast above slow is refused");
bad({ left: { ind: "uo", short: 20, mid: 10, long: 28 }, op: ">", right: 50 }, /short < mid < long/, "ultimate oscillator with mixed periods is refused");
bad({ left: { ind: "alma", offset: 3 }, op: ">", right: 0 }, /offset must be a number from 0 to 1/, "out-of-range decimal settings are refused");
const rows = W.map((c) => [c.t * 1000, c.o, c.h, c.l, c.c, c.v, 0, 0, 0, c.tb, 0, 0]);
ok(near(parseKlines(rows)[5].tb, W[5].tb), "taker buy volume is read from the price data");
const bt = backtest({ ...base, entry: { all: [{ left: { ind: "rsi", tf: "4h" }, op: "<", right: 45 }, { left: { ind: "cmf" }, op: ">", right: 0 }] }, exit: { left: { ind: "rsi" }, op: ">", right: 60 } }, W, 1000);
ok(fin(bt.equity), `a multi-timeframe backtest runs (${bt.trades} trades)`);
ok(describe().split("\n").length === Object.keys(REGISTRY).length, `the indicator guide for Claude lists all ${Object.keys(REGISTRY).length} indicators`);


const RW = walk(3000);
const hu = series(RW, { ind: "hurst", period: 200 }, "1h").filter(fin);
ok(hu.length > 2000 && Math.abs(hu.reduce((a, b) => a + b, 0) / hu.length - 0.55) < 0.12, `Hurst of a random walk sits near 0.5 (${(hu.reduce((a, b) => a + b, 0) / hu.length).toFixed(3)})`);
const ac1 = series(RW, { ind: "autocorr", period: 500 }, "1h").filter(fin);
ok(ac1.every((v) => Math.abs(v) < 0.25), "autocorrelation of random returns stays near 0");
const tm = series(RW, { ind: "time", out: "hour" }, "1h"), wd = series(RW, { ind: "time", out: "weekday" }, "1h");
ok(RW.every((c, i) => tm[i] === new Date(c.t * 1000).getUTCHours()) && wd[0] === (new Date(RW[0].t * 1000).getUTCDay() + 6) % 7 && Math.max(...wd) === 6 && Math.min(...wd) === 0, "time gives the UTC hour and weekday with Monday as 0");
const fr = (hs) => hs.map((h, i) => ({ t: 1700000000 + i * 3600, o: h - 1, h, l: h - 2, c: h - 1, v: 1 }));
const fx = series(fr([10, 11, 15, 12, 11, 10]), { ind: "fractal", out: "newUp" }, "1h"), fl = series(fr([10, 11, 15, 12, 11, 10]), { ind: "fractal", out: "lastUp" }, "1h");
ok(fx[3] === 0 && fx[4] === 1 && fl[4] === 15 && !fin(fl[3]), "an up fractal shows only once the two candles after it close");
const day = Array.from({ length: 48 }, (_, i) => ({ t: 1699920000 + i * 3600, o: 100, h: i < 24 ? 110 : 120, l: i < 24 ? 90 : 95, c: i < 24 ? 105 : 100, v: 1 }));
const pv = series(day, { ind: "pivot" }, "1h"), r1 = series(day, { ind: "pivot", out: "r1" }, "1h");
ok(!fin(pv[23]) && near(pv[24], (110 + 90 + 105) / 3) && near(r1[30], 2 * ((110 + 90 + 105) / 3) - 90), "daily pivots use only the previous finished day");
const gk = series(RW, { ind: "garmanklass", period: 50 }, "1h").filter(fin), pk = series(RW, { ind: "parkinson", period: 50 }, "1h").filter(fin), yz = series(RW, { ind: "yangzhang", period: 50 }, "1h").filter(fin);
ok(gk.length && pk.length && yz.length && [gk, pk, yz].every((a) => a.every((v) => v > 0 && v < 10)), "range-based volatility estimators give positive percent values");
ok(["laguerrersi", "stc", "imi", "psy", "tii", "rvix"].every((k) => series(RW, { ind: k }, "1h").filter(fin).every((v) => v >= -1e-9 && v <= 100 + 1e-9)) && ["demarker", "er", "entropy"].every((k) => series(RW, { ind: k }, "1h").filter(fin).every((v) => v >= -1e-9 && v <= 1 + 1e-9)), "new bounded indicators stay inside their ranges");
const mm = series(L, { ind: "mama" }, "1h"), ff = series(L, { ind: "mama", out: "fama" }, "1h");
ok(fin(mm[290]) && Math.abs(mm[290] - L[290].c) < 5 && mm[290] >= ff[290], "MAMA follows a rising line and stays above FAMA");
ok(validateRule({ name: "w", pair: "SOL/USDC", timeframe: "5m", entry: { left: { ind: "rsi", tf: "30m" }, op: "<", right: 30 }, stopLossPct: 1, orderUsd: 10 }) && validateRule({ name: "w", pair: "SOL/USDC", timeframe: "8h", entry: { left: { ind: "ema", tf: "1w" }, op: "<", right: { ind: "price" } }, stopLossPct: 5, orderUsd: 10 }), "new rule timeframes 5m and 8h validate, with 30m and 1w filters");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
