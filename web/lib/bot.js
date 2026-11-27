import { REGISTRY, series as indSeries, MTF_SECONDS } from "./indicators.js";

export const TIMEFRAMES = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200, "1d": 86400, "1w": 604800 };
export const PAIRS = { "SOL/USDC": { base: "SOL", quote: "USDC", feed: "SOLUSDT" } };
export const OPS = ["<", "<=", ">", ">="];
export const INDICATORS = Object.freeze(Object.keys(REGISTRY));
const MAX_NODES = 24, MAX_DEPTH = 4;

const num = (v) => typeof v === "number" && Number.isFinite(v);
let ruleTf = null;
let assetsSeen = null;
export const ASSET_RE = /^k?[A-Z0-9]{2,12}$/;
export const MAX_ASSETS = 3;
export function assetsOf(rule) {
  const out = new Set();
  const walk = (x) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } if (typeof x.asset === "string" && x.ind) out.add(x.asset); Object.values(x).forEach(walk); };
  walk(rule.entry); walk(rule.exit);
  return [...out];
}

function checkRef(r, path) {
  if (num(r)) return;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${path}: expected a number or an indicator`);
  const spec = REGISTRY[r.ind];
  if (!spec) throw new Error(`${path}: unknown indicator "${r.ind}"`);
  for (const k of Object.keys(r)) if (!["ind", "out", "tf", "asset"].includes(k) && !(k === "name" && spec.names) && !(k in spec.p)) throw new Error(`${path}: ${r.ind} has no setting "${k}"`);
  for (const [k, d] of Object.entries(spec.p)) {
    if (r[k] === undefined) continue;
    const v = r[k];
    if (!num(v) || v < d.lo || v > d.hi || (d.int && !Number.isInteger(v))) throw new Error(`${path}: ${r.ind}.${k} must be ${d.int ? "a whole number" : "a number"} from ${d.lo} to ${d.hi}`);
  }
  if (spec.names && !spec.names.includes(r.name)) throw new Error(`${path}: pattern name must be one of ${spec.names.join(", ")}`);
  const pick = (k) => (r[k] !== undefined ? r[k] : spec.p[k] && spec.p[k].def);
  if ("fast" in spec.p && "slow" in spec.p && pick("fast") >= pick("slow")) throw new Error(`${path}: ${r.ind} fast must be below slow`);
  if (r.ind === "uo" && !(pick("short") < pick("mid") && pick("mid") < pick("long"))) throw new Error(`${path}: uo needs short < mid < long`);
  if (r.out !== undefined && !spec.out.includes(r.out)) throw new Error(`${path}: ${r.ind} outputs ${spec.out.join(", ")}`);
  if (r.asset !== undefined && (typeof r.asset !== "string" || !ASSET_RE.test(r.asset))) throw new Error(`${path}: asset must be a coin ticker such as BTC, ETH or kPEPE`);
  if (r.asset === "SOL") throw new Error(`${path}: leave asset out for SOL itself`);
  if (r.asset !== undefined && assetsSeen) assetsSeen.add(r.asset);
  if (r.tf !== undefined) {
    if (!MTF_SECONDS[r.tf]) throw new Error(`${path}: tf must be one of ${Object.keys(MTF_SECONDS).join(", ")}`);
    if (ruleTf && (MTF_SECONDS[r.tf] < MTF_SECONDS[ruleTf] || MTF_SECONDS[r.tf] % MTF_SECONDS[ruleTf])) throw new Error(`${path}: tf ${r.tf} must be ${ruleTf} or a longer timeframe that is a multiple of it`);
  }
}

function checkCond(c, path, depth, count) {
  if (++count.n > MAX_NODES) throw new Error("the rule has too many conditions");
  if (depth > MAX_DEPTH) throw new Error("the rule is nested too deeply");
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${path}: expected a condition`);
  const keys = Object.keys(c);
  if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
    const list = c[keys[0]];
    if (!Array.isArray(list) || !list.length || list.length > 8) throw new Error(`${path}.${keys[0]}: expected 1 to 8 conditions`);
    list.forEach((x, i) => checkCond(x, `${path}.${keys[0]}[${i}]`, depth + 1, count));
    return;
  }
  if (keys.length === 1 && keys[0] === "not") { checkCond(c.not, `${path}.not`, depth + 1, count); return; }
  if ("cross" in c) {
    if (keys.sort().join() !== "a,b,cross" || (c.cross !== "above" && c.cross !== "below")) throw new Error(`${path}: a cross needs cross ("above" or "below"), a and b`);
    checkRef(c.a, `${path}.a`); checkRef(c.b, `${path}.b`);
    if (num(c.a)) throw new Error(`${path}.a: must be an indicator`);
    return;
  }
  if (keys.sort().join() !== "left,op,right" || !OPS.includes(c.op)) throw new Error(`${path}: a comparison needs left, op (${OPS.join(" ")}) and right`);
  checkRef(c.left, `${path}.left`); checkRef(c.right, `${path}.right`);
  if (num(c.left) && num(c.right)) throw new Error(`${path}: compare at least one indicator`);
}

export function validateRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("the rule must be an object");
  const allowed = ["name", "pair", "timeframe", "entry", "exit", "takeProfitPct", "stopLossPct", "orderUsd", "maxTradesPerDay"];
  for (const k of Object.keys(rule)) if (!allowed.includes(k)) throw new Error(`unknown rule field "${k}"`);
  if (typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 60) throw new Error("name: 1 to 60 characters");
  if (!PAIRS[rule.pair]) throw new Error(`pair must be one of ${Object.keys(PAIRS).join(", ")}`);
  if (!TIMEFRAMES[rule.timeframe]) throw new Error(`timeframe must be one of ${Object.keys(TIMEFRAMES).join(", ")}`);
  ruleTf = rule.timeframe;
  assetsSeen = new Set();
  const count = { n: 0 };
  checkCond(rule.entry, "entry", 0, count);
  if (rule.exit !== undefined) checkCond(rule.exit, "exit", 0, count);
  const pct = (v, lo, hi, n) => { if (v !== undefined && (!num(v) || v < lo || v > hi)) throw new Error(`${n} must be from ${lo} to ${hi}`); };
  pct(rule.takeProfitPct, 0.2, 100, "takeProfitPct"); pct(rule.stopLossPct, 0.2, 50, "stopLossPct");
  if (rule.stopLossPct === undefined) throw new Error("stopLossPct is required: every strategy needs a stop loss");
  if (!num(rule.orderUsd) || rule.orderUsd < 1 || rule.orderUsd > 100000) throw new Error("orderUsd must be from 1 to 100000");
  if (rule.maxTradesPerDay !== undefined && (!Number.isInteger(rule.maxTradesPerDay) || rule.maxTradesPerDay < 1 || rule.maxTradesPerDay > 24)) throw new Error("maxTradesPerDay must be 1 to 24");
  const nAssets = assetsSeen.size;
  ruleTf = null; assetsSeen = null;
  if (nAssets > MAX_ASSETS) throw new Error(`a rule can watch at most ${MAX_ASSETS} other coins`);
  return true;
}

export function series(candles, ref, base = "1h") { return indSeries(candles, ref, base); }

export function makeCache(candles, base) {
  const memo = new Map();
  return (ref) => {
    if (num(ref)) return null;
    const k = JSON.stringify(ref);
    if (!memo.has(k)) memo.set(k, indSeries(candles, ref, base));
    return memo.get(k);
  };
}
function valueAt(get, ref, i) { return num(ref) ? ref : get(ref)[i]; }
function holds(c, get, i) {
  if (c.all) return c.all.every((x) => holds(x, get, i));
  if (c.any) return c.any.some((x) => holds(x, get, i));
  if (c.not) return !holds(c.not, get, i);
  if (c.cross) {
    if (i < 1) return false;
    const a0 = valueAt(get, c.a, i - 1), a1 = valueAt(get, c.a, i), b0 = valueAt(get, c.b, i - 1), b1 = valueAt(get, c.b, i);
    if ([a0, a1, b0, b1].some(Number.isNaN)) return false;
    return c.cross === "above" ? a0 <= b0 && a1 > b1 : a0 >= b0 && a1 < b1;
  }
  const l = valueAt(get, c.left, i), r = valueAt(get, c.right, i);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  return c.op === "<" ? l < r : c.op === "<=" ? l <= r : c.op === ">" ? l > r : l >= r;
}

export function signalAt(rule, candles, i = candles.length - 1, get = makeCache(candles, rule.timeframe)) {
  return { entry: holds(rule.entry, get, i), exit: rule.exit ? holds(rule.exit, get, i) : false };
}

export function step(rule, state, candles, i, get, feePct = 0.3) {
  const c = candles[i], day = Math.floor(c.t / 86400);
  const s = { ...state, trades: state.day === day ? state.trades : 0, day };
  const sig = signalAt(rule, candles, i, get);
  const events = [];
  if (s.pos) {
    const stopAt = s.pos.entry * (1 - rule.stopLossPct / 100);
    const takeAt = rule.takeProfitPct !== undefined ? s.pos.entry * (1 + rule.takeProfitPct / 100) : Infinity;
    let why = null, price = c.c;
    if (c.o <= stopAt) { why = "stop loss, opened below it"; price = c.o; }
    else if (c.l <= stopAt) { why = "stop loss"; price = stopAt; }
    else if (c.o >= takeAt) { why = "take profit, opened above it"; price = c.o; }
    else if (c.h >= takeAt) { why = "take profit"; price = takeAt; }
    else if (sig.exit) { why = "exit rule"; price = c.c; }
    if (why) {
      const value = s.pos.qty * price * (1 - feePct / 100);
      s.cash += value; events.push({ t: c.t, kind: "sell", price, why, pnl: value - s.pos.cost });
      s.pos = null;
    }
  } else if (sig.entry && (!rule.maxTradesPerDay || s.trades < rule.maxTradesPerDay)) {
    const spend = Math.min(rule.orderUsd, s.cash);
    if (spend >= 1) {
      s.pos = { entry: c.c, qty: (spend * (1 - feePct / 100)) / c.c, cost: spend, t: c.t };
      s.cash -= spend; s.trades += 1; events.push({ t: c.t, kind: "buy", price: c.c, spend });
    }
  }
  return { state: s, events };
}

export function backtest(rule, candles, startCash = 1000, feePct = 0.3, from = 1, to = candles.length, shared = null) {
  validateRule(rule);
  const get = shared || makeCache(candles, rule.timeframe);
  let state = { cash: startCash, pos: null, trades: 0, day: null };
  const log = [], curve = [];
  for (let i = Math.max(1, from); i < to; i++) { const r = step(rule, state, candles, i, get, feePct); state = r.state; log.push(...r.events); curve.push({ t: candles[i].t, equity: state.cash + (state.pos ? state.pos.qty * candles[i].c : 0) }); }
  const last = candles[to - 1].c, first = candles[Math.max(1, from) - 1].c;
  const equity = state.cash + (state.pos ? state.pos.qty * last : 0);
  const sells = log.filter((e) => e.kind === "sell");
  const hold = (last / first - 1) * 100;
  let peak = startCash, maxDd = 0; for (const p of curve) { peak = Math.max(peak, p.equity); maxDd = Math.min(maxDd, (p.equity / peak - 1) * 100); }
  return { startCash, equity, returnPct: (equity / startCash - 1) * 100, holdPct: hold, trades: sells.length, wins: sells.filter((e) => e.pnl > 0).length, open: !!state.pos, maxDrawdownPct: maxDd, log, curve };
}

export function parseKlines(rows) {
  if (!Array.isArray(rows)) throw new Error("price data is not a list");
  const out = rows.map((r) => ({ t: Math.floor(Number(r[0]) / 1000), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), tb: r.length > 9 ? Number(r[9]) : NaN }));
  if (out.some((x) => !Number.isFinite(x.t) || ![x.o, x.h, x.l, x.c, x.v].every((v) => Number.isFinite(v) && v >= 0))) throw new Error("price data has invalid candles");
  for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) throw new Error("price data is out of order");
  return out;
}
