import { REGISTRY, MTF_SECONDS } from "./indicators.js";
import { backtest, cachesFor, validateRule, TIMEFRAMES } from "./bot.js";

const SKIP = new Set(["price", "pattern", "funding", "oi", "longshort", "takerbuy", "cvd", "trades", "rwi"]);
const PRICE_LEVEL = { sma: 0, ema: 0, wma: 0, rma: 0, dema: 0, tema: 0, hma: 0, zlema: 0, vwma: 0, kama: 0, alma: 0, mcginley: 0, t3: 0, trima: 0, vidya: 0, frama: 0, laguerre: 0, supersmoother: 0, vwap: 0, highest: 0, lowest: 0, psar: 0, alligator: 0, envelope: 0, starc: 0, keltner: 0, donchian: 0, chandelier: 0, ichimoku: 0, pivot: 0, fib: 0, linreg: ["value"], supertrend: ["line"], bb: ["upper", "middle", "lower"], mama: ["value", "fama"], gannhilo: ["line"], fractal: ["lastUp", "lastDown"], zigzag: ["lastHigh", "lastLow"] };
const DRIFT = { obv: ["value", "change"], ad: ["value", "change"], pvt: ["value", "change"], nvi: 0, pvi: 0, atr: 0, stdev: 0, mom: 0, apo: 0, macd: 0, elderray: 0, qstick: 0, ao: 0, ac: 0, force: 0, eom: 0, klinger: 0, chaikinosc: 0, bwmfi: 0, linreg: ["slope"], volume: [], cog: 0 };
const inSet = (set, ref) => { const spec = REGISTRY[ref.ind], out = ref.out || spec.out[0], v = set[ref.ind]; return v !== undefined && (v === 0 || (Array.isArray(v) && v.includes(out))); };
const PERIOD_KEYS = ["period", "fast", "slow", "long", "short", "mid"];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const finite = (v) => typeof v === "number" && Number.isFinite(v);

function longerFrames(tf) {
  const base = MTF_SECONDS[tf];
  return Object.entries(MTF_SECONDS).filter(([, s]) => s > base && s % base === 0 && s / base <= 24).map(([k]) => k);
}

function randomRef(r, tf, watch, unavailable) {
  const names = Object.keys(REGISTRY).filter((k) => !SKIP.has(k) && !unavailable.includes(k));
  const ind = pick(r, names), spec = REGISTRY[ind];
  const ref = { ind };
  if (spec.out.length > 1 && r() < 0.6) { const o = pick(r, spec.out); if (o !== spec.out[0]) ref.out = o; }
  for (const k of PERIOD_KEYS) {
    const d = spec.p[k];
    if (!d || !d.int || r() < 0.5) continue;
    const v = Math.round(d.def * pick(r, [0.5, 0.75, 1.5, 2]));
    if (v >= d.lo && v <= d.hi && v !== d.def) ref[k] = v;
  }
  if ("fast" in ref || "slow" in ref) { const f = ref.fast ?? spec.p.fast.def, s = ref.slow ?? spec.p.slow.def; if (f >= s) { delete ref.fast; delete ref.slow; } }
  if (ind === "uo") { delete ref.short; delete ref.mid; delete ref.long; }
  const lf = longerFrames(tf);
  if (lf.length && r() < 0.35) ref.tf = pick(r, lf);
  if (watch.length && r() < 0.25) ref.asset = pick(r, watch);
  return ref;
}

export function quantiles(values, qs) {
  const v = values.filter(finite).sort((a, b) => a - b);
  if (v.length < 30) return null;
  return qs.map((q) => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))]);
}

export function profile(seriesValues, closes, from, to) {
  const vals = [], ratios = [];
  for (let i = from; i < to; i++) { const x = seriesValues[i]; if (!finite(x)) continue; vals.push(x); if (finite(closes[i]) && closes[i] > 0) ratios.push(x / closes[i]); }
  if (vals.length < 30) return null;
  const distinct = new Set(vals.map((x) => Math.round(x * 1e6) / 1e6));
  if (distinct.size <= 8) return { kind: "levels", levels: [...distinct].sort((a, b) => a - b) };
  return { kind: "scale", q: quantiles(vals, [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]) };
}
function classify(ref, prof) {
  if (!prof) return null;
  if (inSet(PRICE_LEVEL, ref)) return prof.kind === "levels" ? null : { kind: "price" };
  if (prof.kind === "levels") return prof;
  if (inSet(DRIFT, ref)) return null;
  return prof;
}

function makeCondition(r, ctx) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ref = pick(r, ctx.pool);
    const prof = ctx.profileOf(ref);
    if (!prof) continue;
    if (prof.kind === "levels") {
      if (prof.levels.length < 2) continue;
      const v = pick(r, prof.levels);
      const op = v === prof.levels[0] ? "<=" : v === prof.levels[prof.levels.length - 1] ? ">=" : pick(r, ["<=", ">="]);
      const c = { left: ref, op, right: v };
      if (ctx.fires(c)) return c;
      continue;
    }
    if (prof.kind === "price") {
      const priceRef = ref.asset ? { ind: "price", asset: ref.asset } : { ind: "price" };
      if (ref.tf) priceRef.tf = ref.tf;
      if (r() < 0.3) {
        const other = { ...ref };
        const spec = REGISTRY[ref.ind];
        const key = PERIOD_KEYS.find((k) => spec.p[k] && spec.p[k].int);
        if (key) {
          const d = spec.p[key], cur = ref[key] ?? d.def, v = Math.round(cur * pick(r, [2, 3]));
          if (v <= d.hi && v !== cur) { other[key] = v; const po = ctx.profileOf(other); if (po && po.kind === "price") return { cross: pick(r, ["above", "below"]), a: ref, b: other }; }
        }
      }
      return { left: priceRef, op: pick(r, [">", "<"]), right: ref };
    }
    if (!prof.q) continue;
    const lowSide = r() < 0.5;
    const th = lowSide ? pick(r, prof.q.slice(0, 3)) : pick(r, prof.q.slice(3));
    if (!finite(th)) continue;
    const round = (x) => (Math.abs(x) >= 100 ? Math.round(x) : Math.abs(x) >= 1 ? Math.round(x * 100) / 100 : Number(x.toPrecision(3)));
    const c = { left: ref, op: lowSide ? "<" : ">", right: round(th) };
    if (ctx.fires(c)) return c;
  }
  return null;
}

function makeSide(r, ctx) {
  const n = 2 + Math.floor(r() * 3), conds = [];
  for (let i = 0; i < n * 2 && conds.length < n; i++) { const c = makeCondition(r, ctx); if (c && !conds.some((x) => JSON.stringify(x) === JSON.stringify(c))) conds.push(c); }
  if (conds.length < 2) return null;
  const side = { entry: { all: conds } };
  if (r() < 0.35) { const ex = makeCondition(r, ctx); if (ex) side.exit = ex; }
  return side;
}

export function warmupOf(rule) {
  let need = 50;
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.ind && REGISTRY[x.ind]) {
      const spec = REGISTRY[x.ind];
      let big = 1;
      for (const k of Object.keys(spec.p)) { const v = x[k] !== undefined ? x[k] : spec.p[k].def; if (spec.p[k].int && v > big) big = v; }
      const mult = x.tf ? MTF_SECONDS[x.tf] / MTF_SECONDS[rule.timeframe] : 1;
      need = Math.max(need, Math.ceil(big * 3 * mult + 2 * mult));
    }
    Object.values(x).forEach(walk);
  };
  for (const s of [rule.long, rule.short]) if (s) { walk(s.entry); walk(s.exit); }
  return need;
}

const slim = (b) => ({ returnPct: +b.returnPct.toFixed(2), trades: b.trades, longs: b.longs, shorts: b.shorts, winRatePct: b.trades ? Math.round((b.wins / b.trades) * 100) : null, liquidations: b.liquidations, worstDropPct: +b.maxDrawdownPct.toFixed(2), monthsUp: `${b.monthsUp} of ${b.months.length}` });

export function discover(data, opts) {
  const { coins, timeframe, leverage, marginUsd = 100, sides = "both", tries = 1000, seed = 1, watch = [], unavailable = [], split = 0.65, minTrades = 10, keep = 20, startCash = 1000, poolSize = 60 } = opts;
  if (!TIMEFRAMES[timeframe]) throw new Error("unknown timeframe");
  const main = data[coins[0]], len = main.length, cut = Math.floor(len * split);
  if (cut < 200 || len - cut < 100) throw new Error("not enough history: use more candles");
  const r = rng(seed);
  const probe = { name: "probe", coins, timeframe, leverage, marginUsd, long: { entry: { left: { ind: "price" }, op: ">", right: 0 } }, stopLossPct: 1 };
  const gets = cachesFor(probe, data);
  const closes = main.map((c) => c.c), profiles = new Map();
  const ctx = {
    tf: timeframe, watch, unavailable, pool: [],
    fires(c) {
      const v = gets[coins[0]](c.left), t = c.right;
      let n = 0, yes = 0;
      for (let i = 300; i < cut; i++) { const x = v[i]; if (!finite(x)) continue; n++; if (c.op === "<" ? x < t : c.op === "<=" ? x <= t : c.op === ">" ? x > t : x >= t) yes++; }
      return n > 100 && yes / n >= 0.03 && yes / n <= 0.7;
    },
    profileOf(ref) {
      const k = JSON.stringify(ref);
      if (!profiles.has(k)) { let p = null; try { p = classify(ref, profile(gets[coins[0]](ref), closes, 300, cut)); } catch {} profiles.set(k, p); }
      return profiles.get(k);
    },
  };
  for (let i = 0; i < poolSize * 3 && ctx.pool.length < poolSize; i++) { const ref = randomRef(r, timeframe, watch, unavailable); if (ctx.profileOf(ref)) ctx.pool.push(ref); }
  const stops = [0.5, 1, 1.5, 2, 3, 4, 6, 8].filter((s) => s < Math.max(0.3, 100 / leverage - 0.5) * 0.9 || leverage <= 5);
  const tried = [], seen = new Set();
  let built = 0, valid = 0;
  for (let n = 0; n < tries; n++) {
    const rule = { name: `Found ${seed}-${n + 1}`, coins, timeframe, leverage, marginUsd };
    if (sides !== "short") { const s = makeSide(r, ctx); if (s) rule.long = s; }
    if (sides !== "long") { const s = makeSide(r, ctx); if (s) rule.short = s; }
    if (!rule.long && !rule.short) continue;
    rule.stopLossPct = pick(r, stops.length ? stops : [0.2]);
    if (r() < 0.7) rule.takeProfitPct = Math.round(rule.stopLossPct * pick(r, [1, 1.5, 2, 3, 4]) * 100) / 100;
    built++;
    const key = JSON.stringify([rule.long, rule.short, rule.stopLossPct, rule.takeProfitPct]);
    if (seen.has(key)) continue;
    seen.add(key);
    try { validateRule(rule); } catch { continue; }
    valid++;
    const from = Math.min(Math.max(warmupOf(rule), 300), cut - 50);
    const tr = backtest(rule, data, startCash, from, cut, gets);
    if (tr.trades >= minTrades && (sides !== "both" || (rule.long && rule.short && tr.longs >= 3 && tr.shorts >= 3))) tried.push({ rule, train: tr });
  }
  tried.sort((a, b) => b.train.returnPct - a.train.returnPct);
  const top = tried.slice(0, keep).map((x) => ({ ...x, test: backtest(x.rule, data, startCash, cut, len, gets) }));
  const survivors = top.filter((x) => x.train.returnPct > 0 && x.test.returnPct > 0);
  return {
    seed, built, valid, enoughTrades: tried.length, testedOnCheck: top.length, survivorsCount: survivors.length,
    searchPart: `${new Date(main[300].t * 1000).toISOString().slice(0, 10)} to ${new Date(main[cut - 1].t * 1000).toISOString().slice(0, 10)}`,
    checkPart: `${new Date(main[cut].t * 1000).toISOString().slice(0, 10)} to ${new Date(main[len - 1].t * 1000).toISOString().slice(0, 10)}`,
    survivors: survivors.map((x) => ({ rule: x.rule, search: slim(x.train), check: slim(x.test) })),
    bestThatFailed: top.filter((x) => !(x.train.returnPct > 0 && x.test.returnPct > 0)).slice(0, 3).map((x) => ({ search: slim(x.train), check: slim(x.test) })),
  };
}
