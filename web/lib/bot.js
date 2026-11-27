import { REGISTRY, series as indSeries, MTF_SECONDS } from "./indicators.js";

export const TIMEFRAMES = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200, "1d": 86400, "1w": 604800 };
export const OPS = ["<", "<=", ">", ">="];
export const INDICATORS = Object.freeze(Object.keys(REGISTRY));
export const MAX_LEVERAGE = 125;
export const FEE_PCT = 0.045;
export const MAINT_PCT = 0.5;
export const SLIP_PCT = 0.05;
const MAX_NODES = 32, MAX_DEPTH = 4;

const num = (v) => typeof v === "number" && Number.isFinite(v);
let ruleTf = null, assetsSeen = null;
export const ASSET_RE = /^k?[A-Z0-9]{2,12}$/;
export const MAX_ASSETS = 3;
export const MAX_COINS = 5;

const sides = (rule) => [["long", rule.long], ["short", rule.short]].filter(([, s]) => s);
export function assetsOf(rule) {
  const out = new Set();
  const walk = (x) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } if (typeof x.asset === "string" && x.ind) out.add(x.asset); Object.values(x).forEach(walk); };
  for (const [, s] of sides(rule)) { walk(s.entry); walk(s.exit); }
  return [...out];
}
export const liqDistancePct = (lev) => Math.max(0, 100 / lev - MAINT_PCT);

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
  if ("atLeast" in c) {
    if (keys.sort().join() !== "atLeast,of" || !Array.isArray(c.of) || c.of.length < 2 || c.of.length > 8 || !Number.isInteger(c.atLeast) || c.atLeast < 1 || c.atLeast > c.of.length) throw new Error(`${path}: atLeast needs a whole number from 1 to the number of conditions in "of" (2 to 8 conditions)`);
    c.of.forEach((x, i) => checkCond(x, `${path}.of[${i}]`, depth + 1, count));
    return;
  }
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
  const allowed = ["name", "coins", "timeframe", "leverage", "marginUsd", "long", "short", "stopLossPct", "takeProfitPct", "maxTradesPerDay"];
  for (const k of Object.keys(rule)) if (!allowed.includes(k)) throw new Error(`unknown rule field "${k}"`);
  if (typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 60) throw new Error("name: 1 to 60 characters");
  if (!Array.isArray(rule.coins) || !rule.coins.length || rule.coins.length > MAX_COINS || !rule.coins.every((c) => typeof c === "string" && ASSET_RE.test(c)) || new Set(rule.coins).size !== rule.coins.length) throw new Error(`coins must be a list of 1 to ${MAX_COINS} different tickers such as ["SOL", "ETH"]`);
  if (!TIMEFRAMES[rule.timeframe]) throw new Error(`timeframe must be one of ${Object.keys(TIMEFRAMES).join(", ")}`);
  if (!Number.isInteger(rule.leverage) || rule.leverage < 1 || rule.leverage > MAX_LEVERAGE) throw new Error(`leverage must be a whole number from 1 to ${MAX_LEVERAGE}`);
  if (!num(rule.marginUsd) || rule.marginUsd < 1 || rule.marginUsd > 100000) throw new Error("marginUsd must be from 1 to 100000");
  if (!rule.long && !rule.short) throw new Error("the rule needs a long side, a short side, or both");
  ruleTf = rule.timeframe; assetsSeen = new Set();
  const count = { n: 0 };
  for (const [name, s] of sides(rule)) {
    if (typeof s !== "object" || Array.isArray(s)) throw new Error(`${name} must be an object with entry and optional exit`);
    for (const k of Object.keys(s)) if (k !== "entry" && k !== "exit") throw new Error(`${name}: unknown field "${k}"`);
    checkCond(s.entry, `${name}.entry`, 0, count);
    if (s.exit !== undefined) checkCond(s.exit, `${name}.exit`, 0, count);
  }
  const pct = (v, lo, hi, n) => { if (v !== undefined && (!num(v) || v < lo || v > hi)) throw new Error(`${n} must be from ${lo} to ${hi}`); };
  if (rule.stopLossPct === undefined) throw new Error("stopLossPct is required: every strategy needs a stop loss");
  pct(rule.stopLossPct, 0.05, 50, "stopLossPct"); pct(rule.takeProfitPct, 0.05, 500, "takeProfitPct");
  if (rule.maxTradesPerDay !== undefined && (!Number.isInteger(rule.maxTradesPerDay) || rule.maxTradesPerDay < 1 || rule.maxTradesPerDay > 48)) throw new Error("maxTradesPerDay must be 1 to 48");
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
  if (c.of) { let n = 0; for (const x of c.of) if (holds(x, get, i) && ++n >= c.atLeast) return true; return false; }
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
  const on = (s, k) => !!(s && s[k] && holds(s[k], get, i));
  return { long: on(rule.long, "entry"), short: on(rule.short, "entry"), exitLong: on(rule.long, "exit"), exitShort: on(rule.short, "exit") };
}

export function levels(rule, pos) {
  const d = pos.side;
  const stop = pos.entry * (1 - (d * rule.stopLossPct) / 100);
  const liq = pos.entry * (1 - (d * liqDistancePct(pos.lev)) / 100);
  const take = rule.takeProfitPct !== undefined ? pos.entry * (1 + (d * rule.takeProfitPct) / 100) : d > 0 ? Infinity : -Infinity;
  const stopFirst = d > 0 ? stop >= liq : stop <= liq;
  return { stop, liq, take, adverse: stopFirst ? stop : liq, adverseIsLiq: !stopFirst };
}

export function closePosition(s, price, why, t) {
  const p = s.pos;
  if (!why.startsWith("liquidated")) price = price * (1 - (p.side * SLIP_PCT) / 100);
  const notional = p.qty * price, fee = (notional * FEE_PCT) / 100;
  let pnl = p.side * p.qty * (price - p.entry) - fee;
  let liquidated = why.startsWith("liquidated");
  if (!liquidated && pnl <= -p.margin) { liquidated = true; why = "liquidated"; }
  if (liquidated) pnl = -p.margin;
  s.cash += p.margin + pnl;
  s.pos = null;
  return { t, kind: "close", side: p.side > 0 ? "long" : "short", price, why, pnl: pnl - p.openFee + p.funding, fees: (liquidated ? 0 : fee) + p.openFee, funding: p.funding, liquidated };
}

export function touch(rule, s, coin, price, t) {
  const p = s.pos[coin];
  if (!p) return null;
  const L = levels(rule, p), d = p.side;
  const box = { cash: s.cash, pos: p };
  let ev = null;
  if (d * (price - L.adverse) <= 0) ev = closePosition(box, L.adverse, L.adverseIsLiq ? "liquidated" : "stop loss", t);
  else if (d * (price - L.take) >= 0) ev = closePosition(box, L.take, "take profit", t);
  if (ev) { s.cash = box.cash; s.pos[coin] = null; ev.coin = coin; }
  return ev;
}

function openPosition(rule, s, side, price, t) {
  const fee = (rule.marginUsd * rule.leverage * FEE_PCT) / 100;
  let margin = rule.marginUsd;
  if (s.cash < margin + fee) margin = s.cash / (1 + (rule.leverage * FEE_PCT) / 100);
  if (margin < 1 || !Number.isFinite(price) || price <= 0) return null;
  price = price * (1 + (side * SLIP_PCT) / 100);
  const openFee = (margin * rule.leverage * FEE_PCT) / 100;
  s.cash -= margin + openFee;
  s.pos = { side, entry: price, qty: (margin * rule.leverage) / price, margin, lev: rule.leverage, openFee, funding: 0, t };
  return { t, kind: "open", side: side > 0 ? "long" : "short", price, margin, lev: rule.leverage, fee: openFee };
}

export function equityOf(s, prices) {
  let e = s.cash;
  for (const [coin, p] of Object.entries(s.pos)) if (p) { const px = Number.isFinite(prices[coin]) ? prices[coin] : p.entry; e += p.margin + p.side * p.qty * (px - p.entry); }
  return e;
}

function stepCoin(rule, s, coin, C, i, get, events) {
  const c = C[i];
  if (!Number.isFinite(c.c)) return;
  const box = { cash: s.cash, pos: s.pos[coin] ? { ...s.pos[coin] } : null };
  const mine = [];
  if (box.pos && Number.isFinite(c.fs) && c.fs !== 0) { const pay = box.pos.side * box.pos.qty * c.c * c.fs; box.cash -= pay; box.pos.funding -= pay; }
  if (box.pos) {
    const L = levels(rule, box.pos), d = box.pos.side;
    const worst = d > 0 ? c.l : c.h, best = d > 0 ? c.h : c.l;
    let ev = null;
    if (d * (c.o - L.adverse) <= 0) ev = closePosition(box, L.adverseIsLiq ? L.adverse : c.o, L.adverseIsLiq ? "liquidated" : "stop loss, opened beyond it", c.t);
    else if (d * (worst - L.adverse) <= 0) ev = closePosition(box, L.adverse, L.adverseIsLiq ? "liquidated" : "stop loss", c.t);
    else if (d * (c.o - L.take) >= 0) ev = closePosition(box, c.o, "take profit, opened beyond it", c.t);
    else if (d * (best - L.take) >= 0) ev = closePosition(box, L.take, "take profit", c.t);
    if (ev) mine.push(ev);
  }
  const sig = signalAt(rule, C, i, get);
  const want = sig.long && !sig.short ? 1 : sig.short && !sig.long ? -1 : 0;
  if (box.pos) {
    const d = box.pos.side;
    if (want === -d) mine.push(closePosition(box, c.c, "opposite signal", c.t));
    else if ((d > 0 && sig.exitLong) || (d < 0 && sig.exitShort)) mine.push(closePosition(box, c.c, "exit rule", c.t));
  }
  const closed = mine.some((e) => e.kind === "close"), reversed = mine.some((e) => e.why === "opposite signal");
  if (!box.pos && want !== 0 && (!closed || reversed) && (!rule.maxTradesPerDay || s.trades < rule.maxTradesPerDay)) {
    const ev = openPosition(rule, box, want, c.c, c.t);
    if (ev) { mine.push(ev); s.trades += 1; }
  }
  s.cash = box.cash; s.pos[coin] = box.pos;
  for (const e of mine) { e.coin = coin; events.push(e); }
}

export function step(rule, state, data, i, gets) {
  const first = data[rule.coins[0]][i], day = Math.floor(first.t / 86400);
  const s = { cash: state.cash, pos: { ...state.pos }, trades: state.day === day ? state.trades : 0, day };
  const events = [];
  for (const coin of rule.coins) stepCoin(rule, s, coin, data[coin], i, gets[coin], events);
  return { state: s, events };
}

export const pricesAt = (rule, data, i) => Object.fromEntries(rule.coins.map((k) => [k, data[k][i].c]));
export const freshState = (rule, cash = 1000) => ({ cash, pos: Object.fromEntries(rule.coins.map((k) => [k, null])), trades: 0, day: null });
export const cachesFor = (rule, data) => Object.fromEntries(rule.coins.map((k) => [k, makeCache(data[k], rule.timeframe)]));

export function backtest(rule, data, startCash = 1000, from = 1, to = data[rule.coins[0]].length, shared = null) {
  validateRule(rule);
  const gets = shared || cachesFor(rule, data);
  let state = freshState(rule, startCash);
  const log = [], curve = [];
  const begin = Math.max(1, from);
  for (let i = begin; i < to; i++) { const r = step(rule, state, data, i, gets); state = r.state; log.push(...r.events); curve.push({ t: data[rule.coins[0]][i].t, equity: equityOf(state, pricesAt(rule, data, i)) }); }
  const equity = equityOf(state, pricesAt(rule, data, to - 1));
  const hold = {};
  for (const k of rule.coins) { const C = data[k]; let a = begin - 1; while (a < to - 1 && !Number.isFinite(C[a].c)) a++; hold[k] = Number.isFinite(C[a].c) && Number.isFinite(C[to - 1].c) ? (C[to - 1].c / C[a].c - 1) * 100 : NaN; }
  const holds = Object.values(hold).filter(Number.isFinite);
  const closes = log.filter((e) => e.kind === "close");
  let peak = startCash, maxDd = 0; for (const p of curve) { peak = Math.max(peak, p.equity); maxDd = Math.min(maxDd, (p.equity / peak - 1) * 100); }
  const months = [];
  let prevEq = startCash, cur = null;
  for (const p of curve) {
    const m = new Date(p.t * 1000).toISOString().slice(0, 7);
    if (!cur || cur.month !== m) { if (cur) { months.push({ month: cur.month, pct: (cur.end / cur.start - 1) * 100 }); prevEq = cur.end; } cur = { month: m, start: prevEq, end: p.equity }; }
    else cur.end = p.equity;
  }
  if (cur) months.push({ month: cur.month, pct: (cur.end / cur.start - 1) * 100 });
  return {
    startCash, equity, returnPct: (equity / startCash - 1) * 100,
    months, monthsUp: months.filter((m) => m.pct > 0).length, allMonthsUp: months.length > 0 && months.every((m) => m.pct > 0),
    holdPct: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : NaN, holdByCoin: hold,
    trades: closes.length, wins: closes.filter((e) => e.pnl > 0).length,
    longs: closes.filter((e) => e.side === "long").length, shorts: closes.filter((e) => e.side === "short").length,
    liquidations: closes.filter((e) => e.liquidated).length,
    fees: closes.reduce((a, e) => a + e.fees, 0),
    funding: closes.reduce((a, e) => a + e.funding, 0) + Object.values(state.pos).reduce((a, p) => a + (p ? p.funding : 0), 0),
    open: Object.fromEntries(Object.entries(state.pos).filter(([, p]) => p).map(([k, p]) => [k, { side: p.side > 0 ? "long" : "short", entry: p.entry }])),
    maxDrawdownPct: maxDd, log, curve,
  };
}

export function parseKlines(rows) {
  if (!Array.isArray(rows)) throw new Error("price data is not a list");
  const out = rows.map((r) => ({ t: Math.floor(Number(r[0]) / 1000), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), tb: r.length > 9 ? Number(r[9]) : NaN }));
  if (out.some((x) => !Number.isFinite(x.t) || ![x.o, x.h, x.l, x.c, x.v].every((v) => Number.isFinite(v) && v >= 0))) throw new Error("price data has invalid candles");
  for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) throw new Error("price data is out of order");
  return out;
}
