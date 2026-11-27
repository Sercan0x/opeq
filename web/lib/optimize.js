import { validateRule, backtest } from "./bot.js";
import { REGISTRY } from "./indicators.js";

const MAX_KNOBS = 4, MAX_RUNS = 400, MIN_TRADES = 3;
const DISCRETE = new Set(["supertrend:dir", "heikin:dir", "pattern:value", "squeeze:on"]);
const isDiscrete = (r) => r && typeof r === "object" && REGISTRY[r.ind] && DISCRETE.has(`${r.ind}:${r.out || REGISTRY[r.ind].out[0]}`);
const clone = (x) => JSON.parse(JSON.stringify(x));

const refName = (r) => { if (!r || typeof r !== "object") return String(r); const spec = REGISTRY[r.ind]; const ps = spec ? Object.keys(spec.p).filter((k) => r[k] !== undefined).map((k) => r[k]) : []; return `${r.ind.toUpperCase()}${ps.length ? `(${ps.join(", ")})` : ""}${r.out && spec && r.out !== spec.out[0] ? ` ${r.out}` : ""}${r.tf ? ` on ${r.tf}` : ""}`; };
const verb = (p) => (p === "entry" ? "buy if" : "sell if");

export function knobs(rule) {
  const out = [];
  const visitRef = (ref, path, label) => {
    if (!ref || typeof ref !== "object") return;
    const spec = REGISTRY[ref.ind];
    if (!spec) return;
    for (const [k, d] of Object.entries(spec.p)) {
      if (ref[k] === undefined || !["period", "fast", "slow", "mult", "stddev"].includes(k)) continue;
      out.push({ path: [...path, k], label: `${label === "entry" ? "buy" : "sell"} ${ref.ind.toUpperCase()} ${k}`, value: ref[k], lo: d.lo, hi: d.hi, int: d.int, kind: "setting" });
    }
  };
  const walk = (c, path) => {
    if (!c || typeof c !== "object") return;
    for (const g of ["all", "any"]) if (Array.isArray(c[g])) c[g].forEach((x, i) => walk(x, [...path, g, i]));
    if (c.not) walk(c.not, [...path, "not"]);
    if ("op" in c) {
      for (const side of ["left", "right"]) {
        const v = c[side];
        if (typeof v === "number") { const other = c[side === "left" ? "right" : "left"]; if (!isDiscrete(other)) out.push({ path: [...path, side], label: side === "right" ? `${verb(path[0])} ${refName(other)} ${c.op}` : `${verb(path[0])} level ${c.op} ${refName(other)}`, value: v, kind: "threshold" }); }
        else visitRef(v, [...path, side], path[0]);
      }
    }
    if ("cross" in c) { visitRef(c.a, [...path, "a"], path[0]); if (typeof c.b === "number") out.push({ path: [...path, "b"], label: `${verb(path[0])} ${refName(c.a)} crosses ${c.cross}`, value: c.b, kind: "threshold" }); else visitRef(c.b, [...path, "b"], path[0]); }
  };
  walk(rule.entry, ["entry"]);
  if (rule.exit) walk(rule.exit, ["exit"]);
  out.push({ path: ["stopLossPct"], label: "stop loss %", value: rule.stopLossPct, lo: 0.2, hi: 50, kind: "risk" });
  if (rule.takeProfitPct !== undefined) out.push({ path: ["takeProfitPct"], label: "take profit %", value: rule.takeProfitPct, lo: 0.2, hi: 100, kind: "risk" });
  const order = { threshold: 0, risk: 1, setting: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, MAX_KNOBS);
}

function choices(k) {
  const f = k.kind === "risk" ? [0.6, 0.8, 1, 1.25, 1.5] : k.kind === "setting" ? [0.6, 0.8, 1, 1.25, 1.5] : null;
  let vals;
  if (f) vals = f.map((m) => k.value * m);
  else { const step = Math.max(Math.abs(k.value) * 0.1, Math.abs(k.value) < 1 ? 0.05 : 1); vals = [-2, -1, 0, 1, 2].map((m) => k.value + m * step); }
  vals = vals.map((v) => (k.int ? Math.round(v) : Math.round(v * 1000) / 1000)).filter((v) => (k.lo === undefined || v >= k.lo) && (k.hi === undefined || v <= k.hi));
  return [...new Set(vals)];
}

function setPath(o, path, v) { let x = o; for (let i = 0; i < path.length - 1; i++) x = x[path[i]]; x[path[path.length - 1]] = v; }

export function optimize(rule, candles, { split = 0.65, startCash = 1000, onProgress } = {}) {
  validateRule(rule);
  const cut = Math.floor(candles.length * split);
  if (cut < 100 || candles.length - cut < 50) throw new Error("not enough price history to split into a search part and a check part");
  const ks = knobs(rule), opts = ks.map(choices);
  let grid = [[]];
  for (const o of opts) grid = grid.flatMap((g) => o.map((v) => [...g, v]));
  let seed = 1;
  if (grid.length > MAX_RUNS) {
    const picked = new Set([grid.findIndex((g) => g.every((v, i) => v === ks[i].value))].filter((i) => i >= 0));
    while (picked.size < MAX_RUNS) { seed = (seed * 48271) % 2147483647; picked.add(seed % grid.length); }
    grid = [...picked].map((i) => grid[i]);
  }
  const runs = [];
  grid.forEach((vals, n) => {
    const r = clone(rule);
    vals.forEach((v, i) => setPath(r, ks[i].path, v));
    try { validateRule(r); } catch { return; }
    const tr = backtest(r, candles, startCash, 0.3, 1, cut);
    if (tr.trades >= MIN_TRADES) runs.push({ rule: r, vals, train: tr });
    if (onProgress && n % 20 === 0) onProgress(n / grid.length);
  });
  runs.sort((a, b) => b.train.returnPct - a.train.returnPct);
  const top = runs.slice(0, 5).map((x) => ({ ...x, test: backtest(x.rule, candles, startCash, 0.3, cut, candles.length) }));
  const base = { train: backtest(rule, candles, startCash, 0.3, 1, cut), test: backtest(rule, candles, startCash, 0.3, cut, candles.length) };
  const slim = (b) => ({ returnPct: b.returnPct, holdPct: b.holdPct, trades: b.trades, wins: b.wins, maxDrawdownPct: b.maxDrawdownPct });
  return {
    knobs: ks.map((k, i) => ({ label: k.label, value: k.value, tried: opts[i] })),
    runs: grid.length, kept: runs.length, cut, split,
    current: { train: slim(base.train), test: slim(base.test) },
    best: top.map((x) => ({ rule: x.rule, vals: x.vals, train: slim(x.train), test: slim(x.test) })),
  };
}
