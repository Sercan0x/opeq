const nan = (n) => new Array(n).fill(NaN);
const ok = (v) => typeof v === "number" && !Number.isNaN(v);

export function sma(x, p) {
  const o = nan(x.length); let s = 0, c = 0;
  for (let i = 0; i < x.length; i++) {
    if (ok(x[i])) { s += x[i]; c++; } else { s = 0; c = 0; continue; }
    if (c > p) { s -= x[i - p]; c = p; }
    if (c === p) o[i] = s / p;
  }
  return o;
}
function seeded(x, p, alpha) {
  const o = nan(x.length); let start = x.findIndex(ok);
  if (start < 0) return o;
  let s = 0, c = 0, e = NaN;
  for (let i = start; i < x.length; i++) {
    if (!ok(x[i])) { e = NaN; s = 0; c = 0; continue; }
    if (Number.isNaN(e)) { s += x[i]; c++; if (c === p) { e = s / p; o[i] = e; } continue; }
    e = alpha * x[i] + (1 - alpha) * e; o[i] = e;
  }
  return o;
}
export const ema = (x, p) => seeded(x, p, 2 / (p + 1));
export const rma = (x, p) => seeded(x, p, 1 / p);
export function wma(x, p) {
  const o = nan(x.length), d = (p * (p + 1)) / 2;
  for (let i = p - 1; i < x.length; i++) { let s = 0, bad = false; for (let k = 0; k < p; k++) { const v = x[i - k]; if (!ok(v)) { bad = true; break; } s += v * (p - k); } if (!bad) o[i] = s / d; }
  return o;
}
export function stdev(x, p) {
  const m = sma(x, p), o = nan(x.length);
  for (let i = p - 1; i < x.length; i++) { if (!ok(m[i])) continue; let v = 0; for (let k = i - p + 1; k <= i; k++) v += (x[k] - m[i]) ** 2; o[i] = Math.sqrt(v / p); }
  return o;
}
export function highest(x, p) { const o = nan(x.length); for (let i = p - 1; i < x.length; i++) { let m = -Infinity; for (let k = i - p + 1; k <= i; k++) m = Math.max(m, x[k]); o[i] = m; } return o; }
export function lowest(x, p) { const o = nan(x.length); for (let i = p - 1; i < x.length; i++) { let m = Infinity; for (let k = i - p + 1; k <= i; k++) m = Math.min(m, x[k]); o[i] = m; } return o; }
const zip = (a, b, f) => a.map((v, i) => (ok(v) && ok(b[i]) ? f(v, b[i]) : NaN));
const shift = (x, n) => x.map((_, i) => (i - n >= 0 ? x[i - n] : NaN));
const sum = (x, p) => sma(x, p).map((v) => v * p);
function linreg(x, p) {
  const slope = nan(x.length), value = nan(x.length), r2 = nan(x.length);
  const sx = (p * (p - 1)) / 2, sxx = ((p - 1) * p * (2 * p - 1)) / 6, den = p * sxx - sx * sx;
  for (let i = p - 1; i < x.length; i++) {
    let sy = 0, sxy = 0, syy = 0, bad = false;
    for (let k = 0; k < p; k++) { const y = x[i - p + 1 + k]; if (!ok(y)) { bad = true; break; } sy += y; sxy += k * y; syy += y * y; }
    if (bad) continue;
    const b = (p * sxy - sx * sy) / den, a = (sy - b * sx) / p;
    slope[i] = b; value[i] = a + b * (p - 1);
    const vy = p * syy - sy * sy; r2[i] = vy === 0 ? 1 : ((p * sxy - sx * sy) ** 2) / (den * vy);
  }
  return { slope, value, r2 };
}
const trueRange = (C) => C.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - C[i - 1].c), Math.abs(c.l - C[i - 1].c))));
const col = (C, k) => C.map((c) => (ok(c[k]) ? c[k] : NaN));
const typical = (C) => C.map((c) => (c.h + c.l + c.c) / 3);

function rsiOf(x, p) {
  const up = x.map((v, i) => (i && ok(v) && ok(x[i - 1]) ? Math.max(v - x[i - 1], 0) : i ? NaN : NaN));
  const dn = x.map((v, i) => (i && ok(v) && ok(x[i - 1]) ? Math.max(x[i - 1] - v, 0) : NaN));
  const g = rma(up, p), l = rma(dn, p);
  return zip(g, l, (a, b) => (b === 0 ? (a === 0 ? 50 : 100) : 100 - 100 / (1 + a / b)));
}
function stochOf(x, hi, lo, p) {
  const H = highest(hi, p), L = lowest(lo, p);
  return x.map((v, i) => (ok(H[i]) && ok(L[i]) ? (H[i] === L[i] ? 50 : ((v - L[i]) / (H[i] - L[i])) * 100) : NaN));
}
function dmi(C, p) {
  const pdm = C.map((c, i) => { if (!i) return NaN; const u = c.h - C[i - 1].h, d = C[i - 1].l - c.l; return u > d && u > 0 ? u : 0; });
  const mdm = C.map((c, i) => { if (!i) return NaN; const u = c.h - C[i - 1].h, d = C[i - 1].l - c.l; return d > u && d > 0 ? d : 0; });
  const tr = trueRange(C).map((v, i) => (i ? v : NaN));
  const atr = rma(tr, p), pdi = zip(rma(pdm, p), atr, (a, b) => (b ? (100 * a) / b : 0)), mdi = zip(rma(mdm, p), atr, (a, b) => (b ? (100 * a) / b : 0));
  const dx = zip(pdi, mdi, (a, b) => (a + b ? (100 * Math.abs(a - b)) / (a + b) : 0));
  return { adx: rma(dx, p), plus: pdi, minus: mdi };
}
function psar(C, step, max) {
  const o = nan(C.length); if (C.length < 2) return o;
  let up = C[1].c >= C[0].c, sar = up ? C[0].l : C[0].h, ep = up ? C[1].h : C[1].l, af = step;
  for (let i = 1; i < C.length; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, C[i - 1].l, i > 1 ? C[i - 2].l : C[i - 1].l);
      if (C[i].l < sar) { up = false; sar = ep; ep = C[i].l; af = step; }
      else if (C[i].h > ep) { ep = C[i].h; af = Math.min(af + step, max); }
    } else {
      sar = Math.max(sar, C[i - 1].h, i > 1 ? C[i - 2].h : C[i - 1].h);
      if (C[i].h > sar) { up = true; sar = ep; ep = C[i].h; af = step; }
      else if (C[i].l < ep) { ep = C[i].l; af = Math.min(af + step, max); }
    }
    o[i] = sar;
  }
  return o;
}
function supertrend(C, p, m) {
  const atr = rma(trueRange(C), p), line = nan(C.length), dir = nan(C.length);
  let fu = NaN, fl = NaN, d = 1;
  for (let i = 0; i < C.length; i++) {
    if (!ok(atr[i])) continue;
    const mid = (C[i].h + C[i].l) / 2, bu = mid + m * atr[i], bl = mid - m * atr[i];
    const pc = i ? C[i - 1].c : C[i].c;
    fu = !ok(fu) || bu < fu || pc > fu ? bu : fu;
    fl = !ok(fl) || bl > fl || pc < fl ? bl : fl;
    if (d === 1 && C[i].c < fl) d = -1; else if (d === -1 && C[i].c > fu) d = 1;
    dir[i] = d; line[i] = d === 1 ? fl : fu;
  }
  return { line, dir };
}
function kama(x, p, f, s) {
  const o = nan(x.length), fa = 2 / (f + 1), sa = 2 / (s + 1);
  for (let i = p; i < x.length; i++) {
    let vol = 0; for (let k = i - p + 1; k <= i; k++) vol += Math.abs(x[k] - x[k - 1]);
    const er = vol ? Math.abs(x[i] - x[i - p]) / vol : 0, sc = (er * (fa - sa) + sa) ** 2;
    const prev = ok(o[i - 1]) ? o[i - 1] : x[i - 1];
    o[i] = prev + sc * (x[i] - prev);
  }
  return o;
}
function alma(x, p, off, sig) {
  const m = off * (p - 1), s = p / sig, w = Array.from({ length: p }, (_, k) => Math.exp(-((k - m) ** 2) / (2 * s * s))), ws = w.reduce((a, b) => a + b, 0), o = nan(x.length);
  for (let i = p - 1; i < x.length; i++) { let t = 0; for (let k = 0; k < p; k++) t += w[k] * x[i - p + 1 + k]; o[i] = t / ws; }
  return o;
}
function mcginley(x, p) {
  const o = nan(x.length); const e = ema(x, p); let md = NaN;
  for (let i = 0; i < x.length; i++) { if (!ok(md)) { if (ok(e[i])) md = e[i]; o[i] = md; continue; } md = md + (x[i] - md) / (p * (x[i] / md) ** 4); o[i] = md; }
  return o;
}
function fisher(C, p) {
  const hl = C.map((c) => (c.h + c.l) / 2), H = highest(hl, p), L = lowest(hl, p), f = nan(C.length), t = nan(C.length);
  let v = 0, fp = 0;
  for (let i = 0; i < C.length; i++) {
    if (!ok(H[i])) continue;
    const r = H[i] === L[i] ? 0 : 2 * ((hl[i] - L[i]) / (H[i] - L[i]) - 0.5);
    v = Math.max(-0.999, Math.min(0.999, 0.66 * r + 0.67 * v));
    const fi = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * fp;
    t[i] = fp; f[i] = fi; fp = fi;
  }
  return { fisher: f, trigger: t };
}
function connors(x, rp, sp, pp) {
  const r = rsiOf(x, rp), streak = nan(x.length); let s = 0;
  for (let i = 1; i < x.length; i++) { s = x[i] > x[i - 1] ? (s > 0 ? s + 1 : 1) : x[i] < x[i - 1] ? (s < 0 ? s - 1 : -1) : 0; streak[i] = s; }
  const sr = rsiOf(streak, sp), roc1 = x.map((v, i) => (i ? (v / x[i - 1] - 1) : NaN)), rank = nan(x.length);
  for (let i = pp; i < x.length; i++) { let c = 0; for (let k = i - pp; k < i; k++) if (roc1[k] < roc1[i]) c++; rank[i] = (c / pp) * 100; }
  return x.map((_, i) => (ok(r[i]) && ok(sr[i]) && ok(rank[i]) ? (r[i] + sr[i] + rank[i]) / 3 : NaN));
}
function klinger(C, f, s, g) {
  const tp = typical(C), vf = nan(C.length); let trend = 1, cm = 0, prevDm = 0;
  for (let i = 1; i < C.length; i++) {
    const t = tp[i] > tp[i - 1] ? 1 : -1, dm = C[i].h - C[i].l;
    cm = t === trend ? cm + dm : prevDm + dm; trend = t; prevDm = dm;
    vf[i] = cm ? C[i].v * Math.abs(2 * (dm / cm) - 1) * t * 100 : 0;
  }
  const kvo = zip(ema(vf, f), ema(vf, s), (a, b) => a - b);
  return { kvo, signal: ema(kvo, g) };
}
function nvi(C) { const o = nan(C.length); let v = 1000; o[0] = v; for (let i = 1; i < C.length; i++) { if (C[i].v < C[i - 1].v) v *= C[i].c / C[i - 1].c; o[i] = v; } return o; }
function heikin(C) {
  const ho = nan(C.length), hc = C.map((c) => (c.o + c.h + c.l + c.c) / 4);
  for (let i = 0; i < C.length; i++) ho[i] = i ? (ho[i - 1] + hc[i - 1]) / 2 : (C[0].o + C[0].c) / 2;
  return hc.map((v, i) => (v > ho[i] ? 1 : v < ho[i] ? -1 : 0));
}
const body = (c) => Math.abs(c.c - c.o), range = (c) => c.h - c.l;
function pattern(C, kind) {
  return C.map((c, i) => {
    const p = C[i - 1], q = C[i - 2], r = range(c) || 1e-12;
    switch (kind) {
      case "bullEngulfing": return p && p.c < p.o && c.c > c.o && c.c >= p.o && c.o <= p.c && body(c) > body(p) ? 1 : 0;
      case "bearEngulfing": return p && p.c > p.o && c.c < c.o && c.o >= p.c && c.c <= p.o && body(c) > body(p) ? 1 : 0;
      case "hammer": return body(c) / r < 0.35 && (Math.min(c.o, c.c) - c.l) >= 2 * body(c) && (c.h - Math.max(c.o, c.c)) <= 0.25 * r ? 1 : 0;
      case "shootingStar": return body(c) / r < 0.35 && (c.h - Math.max(c.o, c.c)) >= 2 * body(c) && (Math.min(c.o, c.c) - c.l) <= 0.25 * r ? 1 : 0;
      case "doji": return body(c) / r < 0.1 ? 1 : 0;
      case "insideBar": return p && c.h < p.h && c.l > p.l ? 1 : 0;
      case "outsideBar": return p && c.h > p.h && c.l < p.l ? 1 : 0;
      case "threeWhiteSoldiers": return p && q && [q, p, c].every((x) => x.c > x.o && body(x) / (range(x) || 1e-12) > 0.5) && c.c > p.c && p.c > q.c ? 1 : 0;
      case "threeBlackCrows": return p && q && [q, p, c].every((x) => x.c < x.o && body(x) / (range(x) || 1e-12) > 0.5) && c.c < p.c && p.c < q.c ? 1 : 0;
    }
    return 0;
  }).map((v, i) => (i < 2 && (kind === "threeWhiteSoldiers" || kind === "threeBlackCrows") ? 0 : v));
}
const PATTERNS = ["bullEngulfing", "bearEngulfing", "hammer", "shootingStar", "doji", "insideBar", "outsideBar", "threeWhiteSoldiers", "threeBlackCrows"];

const P = (lo, hi, def, int = true) => ({ lo, hi, def, int });
const per = P(2, 200, 14);
const close = (C) => col(C, "c");

export const REGISTRY = {
  price: { g: "price", d: "candle value", p: {}, out: ["close", "open", "high", "low", "hl2", "hlc3"], f: (C) => ({ close: close(C), open: col(C, "o"), high: col(C, "h"), low: col(C, "l"), hl2: C.map((c) => (c.h + c.l) / 2), hlc3: typical(C) }) },
  change: { g: "momentum", d: "percent change over n candles", p: { period: per }, out: ["pct"], f: (C, p) => ({ pct: close(C).map((v, i, x) => (i >= p.period ? (v / x[i - p.period] - 1) * 100 : NaN)) }) },
  sma: { g: "average", d: "simple moving average of the close", p: { period: per }, out: ["value"], f: (C, p) => ({ value: sma(close(C), p.period) }) },
  ema: { g: "average", d: "exponential moving average", p: { period: per }, out: ["value"], f: (C, p) => ({ value: ema(close(C), p.period) }) },
  wma: { g: "average", d: "weighted moving average", p: { period: per }, out: ["value"], f: (C, p) => ({ value: wma(close(C), p.period) }) },
  rma: { g: "average", d: "Wilder's smoothed average", p: { period: per }, out: ["value"], f: (C, p) => ({ value: rma(close(C), p.period) }) },
  dema: { g: "average", d: "double EMA", p: { period: per }, out: ["value"], f: (C, p) => { const e = ema(close(C), p.period), ee = ema(e, p.period); return { value: zip(e, ee, (a, b) => 2 * a - b) }; } },
  tema: { g: "average", d: "triple EMA", p: { period: per }, out: ["value"], f: (C, p) => { const e = ema(close(C), p.period), e2 = ema(e, p.period), e3 = ema(e2, p.period); return { value: e.map((v, i) => (ok(v) && ok(e2[i]) && ok(e3[i]) ? 3 * v - 3 * e2[i] + e3[i] : NaN)) }; } },
  hma: { g: "average", d: "Hull moving average", p: { period: P(4, 200, 20) }, out: ["value"], f: (C, p) => { const x = close(C), a = wma(x, Math.floor(p.period / 2)), b = wma(x, p.period); return { value: wma(zip(a, b, (u, v) => 2 * u - v), Math.round(Math.sqrt(p.period))) }; } },
  zlema: { g: "average", d: "zero-lag EMA", p: { period: per }, out: ["value"], f: (C, p) => { const x = close(C), lag = Math.floor((p.period - 1) / 2); return { value: ema(x.map((v, i) => (i >= lag ? 2 * v - x[i - lag] : NaN)), p.period) }; } },
  vwma: { g: "average", d: "volume-weighted moving average", p: { period: per }, out: ["value"], f: (C, p) => ({ value: zip(sum(C.map((c) => c.c * c.v), p.period), sum(col(C, "v"), p.period), (a, b) => (b ? a / b : NaN)) }) },
  kama: { g: "average", d: "Kaufman adaptive moving average", p: { period: P(2, 100, 10), fast: P(2, 30, 2), slow: P(5, 100, 30) }, out: ["value"], f: (C, p) => ({ value: kama(close(C), p.period, p.fast, p.slow) }) },
  alma: { g: "average", d: "Arnaud Legoux moving average", p: { period: P(2, 200, 9), offset: P(0, 1, 0.85, false), sigma: P(1, 10, 6, false) }, out: ["value"], f: (C, p) => ({ value: alma(close(C), p.period, p.offset, p.sigma) }) },
  mcginley: { g: "average", d: "McGinley dynamic", p: { period: per }, out: ["value"], f: (C, p) => ({ value: mcginley(close(C), p.period) }) },
  linreg: { g: "trend", d: "linear regression of the close: fitted value, slope per candle, R squared 0-1", p: { period: per }, out: ["value", "slope", "r2"], f: (C, p) => linreg(close(C), p.period) },
  rsi: { g: "momentum", d: "relative strength index 0-100", p: { period: per }, out: ["value"], f: (C, p) => ({ value: rsiOf(close(C), p.period) }) },
  stoch: { g: "momentum", d: "stochastic oscillator 0-100", p: { period: per, smooth: P(1, 20, 3), signal: P(1, 20, 3) }, out: ["k", "d"], f: (C, p) => { const k = sma(stochOf(close(C), col(C, "h"), col(C, "l"), p.period), p.smooth); return { k, d: sma(k, p.signal) }; } },
  stochrsi: { g: "momentum", d: "stochastic RSI 0-100", p: { period: per, stochPeriod: per, smooth: P(1, 20, 3), signal: P(1, 20, 3) }, out: ["k", "d"], f: (C, p) => { const r = rsiOf(close(C), p.period); const k = sma(stochOf(r, r, r, p.stochPeriod), p.smooth); return { k, d: sma(k, p.signal) }; } },
  willr: { g: "momentum", d: "Williams %R, -100 to 0", p: { period: per }, out: ["value"], f: (C, p) => ({ value: stochOf(close(C), col(C, "h"), col(C, "l"), p.period).map((v) => v - 100) }) },
  cci: { g: "momentum", d: "commodity channel index", p: { period: P(2, 200, 20) }, out: ["value"], f: (C, p) => { const tp = typical(C), m = sma(tp, p.period), o = nan(C.length); for (let i = p.period - 1; i < C.length; i++) { let md = 0; for (let k = i - p.period + 1; k <= i; k++) md += Math.abs(tp[k] - m[i]); md /= p.period; o[i] = md ? (tp[i] - m[i]) / (0.015 * md) : 0; } return { value: o }; } },
  roc: { g: "momentum", d: "rate of change in percent", p: { period: per }, out: ["value"], f: (C, p) => ({ value: close(C).map((v, i, x) => (i >= p.period ? (v / x[i - p.period] - 1) * 100 : NaN)) }) },
  mom: { g: "momentum", d: "momentum: close minus close n candles ago", p: { period: per }, out: ["value"], f: (C, p) => ({ value: close(C).map((v, i, x) => (i >= p.period ? v - x[i - p.period] : NaN)) }) },
  mfi: { g: "volume", d: "money flow index 0-100", p: { period: per }, out: ["value"], f: (C, p) => { const tp = typical(C), pos = tp.map((v, i) => (i && v > tp[i - 1] ? v * C[i].v : 0)), neg = tp.map((v, i) => (i && v < tp[i - 1] ? v * C[i].v : 0)); return { value: zip(sum(pos, p.period), sum(neg, p.period), (a, b) => (b === 0 ? 100 : 100 - 100 / (1 + a / b))) }; } },
  cmo: { g: "momentum", d: "Chande momentum oscillator -100 to 100", p: { period: per }, out: ["value"], f: (C, p) => { const x = close(C), u = x.map((v, i) => (i ? Math.max(v - x[i - 1], 0) : 0)), d = x.map((v, i) => (i ? Math.max(x[i - 1] - v, 0) : 0)); return { value: zip(sum(u, p.period), sum(d, p.period), (a, b) => (a + b ? (100 * (a - b)) / (a + b) : 0)) }; } },
  tsi: { g: "momentum", d: "true strength index", p: { long: P(2, 100, 25), short: P(2, 50, 13), signal: P(2, 50, 7) }, out: ["value", "signal"], f: (C, p) => { const x = close(C), m = x.map((v, i) => (i ? v - x[i - 1] : NaN)), a = m.map(Math.abs); const v = zip(ema(ema(m, p.long), p.short), ema(ema(a, p.long), p.short), (u, w) => (w ? (100 * u) / w : 0)); return { value: v, signal: ema(v, p.signal) }; } },
  uo: { g: "momentum", d: "ultimate oscillator 0-100", p: { short: P(2, 50, 7), mid: P(3, 100, 14), long: P(4, 200, 28) }, out: ["value"], f: (C, p) => { const bp = C.map((c, i) => (i ? c.c - Math.min(c.l, C[i - 1].c) : NaN)), tr = trueRange(C).map((v, i) => (i ? v : NaN)); const a = (n) => zip(sum(bp, n), sum(tr, n), (u, w) => (w ? u / w : 0)); const s = a(p.short), m = a(p.mid), l = a(p.long); return { value: s.map((v, i) => (ok(v) && ok(m[i]) && ok(l[i]) ? (100 * (4 * v + 2 * m[i] + l[i])) / 7 : NaN)) }; } },
  ao: { g: "momentum", d: "awesome oscillator", p: { fast: P(2, 50, 5), slow: P(3, 100, 34) }, out: ["value"], f: (C, p) => { const hl = C.map((c) => (c.h + c.l) / 2); return { value: zip(sma(hl, p.fast), sma(hl, p.slow), (a, b) => a - b) }; } },
  ppo: { g: "momentum", d: "percentage price oscillator", p: { fast: P(2, 100, 12), slow: P(3, 200, 26), signal: P(2, 50, 9) }, out: ["line", "signal", "hist"], f: (C, p) => { const x = close(C), line = zip(ema(x, p.fast), ema(x, p.slow), (a, b) => (b ? ((a - b) / b) * 100 : 0)), s = ema(line, p.signal); return { line, signal: s, hist: zip(line, s, (a, b) => a - b) }; } },
  macd: { g: "momentum", d: "MACD", p: { fast: P(2, 100, 12), slow: P(3, 200, 26), signal: P(2, 50, 9) }, out: ["line", "signal", "hist"], f: (C, p) => { const x = close(C), line = zip(ema(x, p.fast), ema(x, p.slow), (a, b) => a - b), s = ema(line, p.signal); return { line, signal: s, hist: zip(line, s, (a, b) => a - b) }; } },
  trix: { g: "momentum", d: "TRIX: rate of change of a triple EMA, percent", p: { period: per }, out: ["value"], f: (C, p) => { const e = ema(ema(ema(close(C), p.period), p.period), p.period); return { value: e.map((v, i) => (i && ok(v) && ok(e[i - 1]) ? (v / e[i - 1] - 1) * 100 : NaN)) }; } },
  fisher: { g: "momentum", d: "Fisher transform", p: { period: P(2, 100, 10) }, out: ["fisher", "trigger"], f: (C, p) => fisher(C, p.period) },
  crsi: { g: "momentum", d: "Connors RSI 0-100", p: { rsi: P(2, 50, 3), streak: P(2, 50, 2), rank: P(10, 200, 100) }, out: ["value"], f: (C, p) => ({ value: connors(close(C), p.rsi, p.streak, p.rank) }) },
  dpo: { g: "momentum", d: "detrended price oscillator (no look-ahead)", p: { period: P(2, 200, 20) }, out: ["value"], f: (C, p) => ({ value: zip(close(C), shift(sma(close(C), p.period), Math.floor(p.period / 2) + 1), (a, b) => a - b) }) },
  coppock: { g: "momentum", d: "Coppock curve", p: { long: P(2, 100, 14), short: P(2, 100, 11), wma: P(2, 50, 10) }, out: ["value"], f: (C, p) => { const x = close(C), r = (n) => x.map((v, i) => (i >= n ? (v / x[i - n] - 1) * 100 : NaN)); return { value: wma(zip(r(p.long), r(p.short), (a, b) => a + b), p.wma) }; } },
  bop: { g: "momentum", d: "balance of power -1 to 1", p: { period: per }, out: ["value"], f: (C, p) => ({ value: sma(C.map((c) => (c.h - c.l ? (c.c - c.o) / (c.h - c.l) : 0)), p.period) }) },
  adx: { g: "trend", d: "average directional index with +DI and -DI", p: { period: per }, out: ["adx", "plus", "minus"], f: (C, p) => dmi(C, p.period) },
  aroon: { g: "trend", d: "Aroon up/down 0-100 and oscillator", p: { period: P(2, 200, 25) }, out: ["up", "down", "osc"], f: (C, p) => { const n = p.period, up = nan(C.length), dn = nan(C.length); for (let i = n; i < C.length; i++) { let hi = i - n, lo = i - n; for (let k = i - n; k <= i; k++) { if (C[k].h >= C[hi].h) hi = k; if (C[k].l <= C[lo].l) lo = k; } up[i] = (100 * (n - (i - hi))) / n; dn[i] = (100 * (n - (i - lo))) / n; } return { up, down: dn, osc: zip(up, dn, (a, b) => a - b) }; } },
  vortex: { g: "trend", d: "vortex indicator", p: { period: per }, out: ["plus", "minus"], f: (C, p) => { const vp = C.map((c, i) => (i ? Math.abs(c.h - C[i - 1].l) : NaN)), vm = C.map((c, i) => (i ? Math.abs(c.l - C[i - 1].h) : NaN)), tr = sum(trueRange(C).map((v, i) => (i ? v : NaN)), p.period); return { plus: zip(sum(vp, p.period), tr, (a, b) => (b ? a / b : NaN)), minus: zip(sum(vm, p.period), tr, (a, b) => (b ? a / b : NaN)) }; } },
  chop: { g: "trend", d: "choppiness index 0-100: high means sideways", p: { period: per }, out: ["value"], f: (C, p) => { const t = sum(trueRange(C), p.period), H = highest(col(C, "h"), p.period), L = lowest(col(C, "l"), p.period); return { value: t.map((v, i) => (ok(v) && H[i] > L[i] ? (100 * Math.log10(v / (H[i] - L[i]))) / Math.log10(p.period) : NaN)) }; } },
  psar: { g: "trend", d: "parabolic SAR", p: { step: P(0.001, 0.2, 0.02, false), max: P(0.01, 1, 0.2, false) }, out: ["value"], f: (C, p) => ({ value: psar(C, p.step, p.max) }) },
  supertrend: { g: "trend", d: "SuperTrend line and direction (1 up, -1 down)", p: { period: P(2, 100, 10), mult: P(0.5, 10, 3, false) }, out: ["line", "dir"], f: (C, p) => supertrend(C, p.period, p.mult) },
  ichimoku: { g: "trend", d: "Ichimoku: tenkan, kijun, and cloud spans as they stand now (spans projected from kijun candles ago)", p: { tenkan: P(2, 100, 9), kijun: P(3, 200, 26), senkou: P(4, 200, 52) }, out: ["tenkan", "kijun", "spanA", "spanB"], f: (C, p) => { const mid = (n) => zip(highest(col(C, "h"), n), lowest(col(C, "l"), n), (a, b) => (a + b) / 2); const t = mid(p.tenkan), k = mid(p.kijun), sb = mid(p.senkou); return { tenkan: t, kijun: k, spanA: shift(zip(t, k, (a, b) => (a + b) / 2), p.kijun), spanB: shift(sb, p.kijun) }; } },
  atr: { g: "volatility", d: "average true range", p: { period: per }, out: ["value"], f: (C, p) => ({ value: rma(trueRange(C), p.period) }) },
  natr: { g: "volatility", d: "ATR as percent of the close", p: { period: per }, out: ["value"], f: (C, p) => ({ value: zip(rma(trueRange(C), p.period), close(C), (a, b) => (100 * a) / b) }) },
  bb: { g: "volatility", d: "Bollinger bands; width in percent of the middle; pctb is where the close sits, 0 at lower, 1 at upper", p: { period: P(2, 200, 20), stddev: P(0.5, 5, 2, false) }, out: ["upper", "middle", "lower", "width", "pctb"], f: (C, p) => { const x = close(C), m = sma(x, p.period), s = stdev(x, p.period), u = zip(m, s, (a, b) => a + p.stddev * b), l = zip(m, s, (a, b) => a - p.stddev * b); return { upper: u, middle: m, lower: l, width: m.map((v, i) => (ok(v) && v ? ((u[i] - l[i]) / v) * 100 : NaN)), pctb: x.map((v, i) => (ok(u[i]) && u[i] > l[i] ? (v - l[i]) / (u[i] - l[i]) : NaN)) }; } },
  keltner: { g: "volatility", d: "Keltner channel", p: { period: P(2, 200, 20), mult: P(0.5, 10, 2, false) }, out: ["upper", "middle", "lower"], f: (C, p) => { const m = ema(close(C), p.period), a = rma(trueRange(C), p.period); return { upper: zip(m, a, (u, v) => u + p.mult * v), middle: m, lower: zip(m, a, (u, v) => u - p.mult * v) }; } },
  donchian: { g: "volatility", d: "Donchian channel of the previous n candles (excludes the current one)", p: { period: P(2, 200, 20) }, out: ["upper", "middle", "lower"], f: (C, p) => { const u = shift(highest(col(C, "h"), p.period), 1), l = shift(lowest(col(C, "l"), p.period), 1); return { upper: u, middle: zip(u, l, (a, b) => (a + b) / 2), lower: l }; } },
  stdev: { g: "volatility", d: "standard deviation of the close", p: { period: per }, out: ["value"], f: (C, p) => ({ value: stdev(close(C), p.period) }) },
  hv: { g: "volatility", d: "historical volatility: stdev of log returns in percent per candle", p: { period: per }, out: ["value"], f: (C, p) => ({ value: stdev(close(C).map((v, i, x) => (i ? Math.log(v / x[i - 1]) : NaN)), p.period).map((v) => v * 100) }) },
  ulcer: { g: "volatility", d: "ulcer index: depth of drawdowns in percent", p: { period: per }, out: ["value"], f: (C, p) => { const x = close(C), H = highest(x, p.period), dd = x.map((v, i) => (ok(H[i]) ? ((v - H[i]) / H[i]) * 100 : NaN)); return { value: sma(dd.map((v) => v * v), p.period).map(Math.sqrt) }; } },
  mass: { g: "volatility", d: "mass index", p: { period: P(2, 100, 25), ema: P(2, 50, 9) }, out: ["value"], f: (C, p) => { const r = C.map(range), e1 = ema(r, p.ema), e2 = ema(e1, p.ema); return { value: sum(zip(e1, e2, (a, b) => (b ? a / b : NaN)), p.period) }; } },
  squeeze: { g: "volatility", d: "1 when the Bollinger bands sit inside the Keltner channel (volatility squeeze), else 0", p: { period: P(2, 200, 20), bbStddev: P(0.5, 5, 2, false), kcMult: P(0.5, 10, 1.5, false) }, out: ["on"], f: (C, p) => { const x = close(C), m = sma(x, p.period), s = stdev(x, p.period), e = ema(x, p.period), a = rma(trueRange(C), p.period); return { on: x.map((_, i) => (ok(m[i]) && ok(a[i]) && ok(e[i]) ? (m[i] + p.bbStddev * s[i] < e[i] + p.kcMult * a[i] && m[i] - p.bbStddev * s[i] > e[i] - p.kcMult * a[i] ? 1 : 0) : NaN)) }; } },
  chandelier: { g: "volatility", d: "Chandelier exit stop levels for long and short positions", p: { period: P(2, 100, 22), mult: P(0.5, 10, 3, false) }, out: ["long", "short"], f: (C, p) => { const a = rma(trueRange(C), p.period); return { long: zip(highest(col(C, "h"), p.period), a, (u, v) => u - p.mult * v), short: zip(lowest(col(C, "l"), p.period), a, (u, v) => u + p.mult * v) }; } },
  volume: { g: "volume", d: "this candle's volume divided by the average of the previous n", p: { period: per }, out: ["ratio"], f: (C, p) => { const v = col(C, "v"), m = shift(sma(v, p.period), 1); return { ratio: zip(v, m, (a, b) => (b ? a / b : NaN)) }; } },
  obv: { g: "volume", d: "on-balance volume and its change over n candles", p: { period: per }, out: ["value", "change"], f: (C, p) => { const o = nan(C.length); let s = 0; o[0] = 0; for (let i = 1; i < C.length; i++) { s += C[i].c > C[i - 1].c ? C[i].v : C[i].c < C[i - 1].c ? -C[i].v : 0; o[i] = s; } return { value: o, change: o.map((v, i) => (i >= p.period ? v - o[i - p.period] : NaN)) }; } },
  ad: { g: "volume", d: "accumulation/distribution line and its change over n candles", p: { period: per }, out: ["value", "change"], f: (C, p) => { const o = nan(C.length); let s = 0; for (let i = 0; i < C.length; i++) { const c = C[i], r = c.h - c.l; s += r ? (((c.c - c.l) - (c.h - c.c)) / r) * c.v : 0; o[i] = s; } return { value: o, change: o.map((v, i) => (i >= p.period ? v - o[i - p.period] : NaN)) }; } },
  cmf: { g: "volume", d: "Chaikin money flow -1 to 1", p: { period: P(2, 200, 20) }, out: ["value"], f: (C, p) => { const mf = C.map((c) => { const r = c.h - c.l; return r ? (((c.c - c.l) - (c.h - c.c)) / r) * c.v : 0; }); return { value: zip(sum(mf, p.period), sum(col(C, "v"), p.period), (a, b) => (b ? a / b : 0)) }; } },
  force: { g: "volume", d: "force index (EMA of price change times volume)", p: { period: per }, out: ["value"], f: (C, p) => ({ value: ema(C.map((c, i) => (i ? (c.c - C[i - 1].c) * c.v : NaN)), p.period) }) },
  eom: { g: "volume", d: "ease of movement", p: { period: per }, out: ["value"], f: (C, p) => ({ value: sma(C.map((c, i) => { if (!i) return NaN; const dm = (c.h + c.l) / 2 - (C[i - 1].h + C[i - 1].l) / 2, br = c.v && c.h > c.l ? c.v / 1e6 / (c.h - c.l) : 0; return br ? dm / br : 0; }), p.period) }) },
  pvt: { g: "volume", d: "price volume trend and its change over n candles", p: { period: per }, out: ["value", "change"], f: (C, p) => { const o = nan(C.length); let s = 0; o[0] = 0; for (let i = 1; i < C.length; i++) { s += ((C[i].c - C[i - 1].c) / C[i - 1].c) * C[i].v; o[i] = s; } return { value: o, change: o.map((v, i) => (i >= p.period ? v - o[i - p.period] : NaN)) }; } },
  nvi: { g: "volume", d: "negative volume index and its EMA", p: { period: P(2, 255, 255) }, out: ["value", "signal"], f: (C, p) => { const v = nvi(C); return { value: v, signal: ema(v, p.period) }; } },
  klinger: { g: "volume", d: "Klinger volume oscillator", p: { fast: P(2, 100, 34), slow: P(3, 200, 55), signal: P(2, 50, 13) }, out: ["kvo", "signal"], f: (C, p) => klinger(C, p.fast, p.slow, p.signal) },
  vwap: { g: "volume", d: "rolling volume-weighted average price over n candles", p: { period: per }, out: ["value"], f: (C, p) => { const tp = typical(C); return { value: zip(sum(tp.map((v, i) => v * C[i].v), p.period), sum(col(C, "v"), p.period), (a, b) => (b ? a / b : NaN)) }; } },
  takerbuy: { g: "volume", d: "share of volume bought by takers (market buyers), 0-1, averaged over n candles", p: { period: P(1, 200, 1) }, out: ["ratio"], f: (C, p) => ({ ratio: zip(sum(C.map((c) => (ok(c.tb) ? c.tb : NaN)), p.period), sum(col(C, "v"), p.period), (a, b) => (b ? a / b : NaN)) }) },
  cvd: { g: "volume", d: "cumulative volume delta over n candles (taker buys minus taker sells)", p: { period: per }, out: ["value"], f: (C, p) => ({ value: sum(C.map((c) => (ok(c.tb) ? 2 * c.tb - c.v : NaN)), p.period) }) },
  funding: { g: "market", d: "SOL perpetual funding rate in percent per 8 hours (positive: longs pay shorts), averaged over n candles; history goes back about a year", p: { period: P(1, 200, 1) }, out: ["rate"], f: (C, p) => ({ rate: sma(col(C, "fr"), p.period) }) },
  oi: { g: "market", d: "SOL perpetual open interest in dollars and its percent change over n candles; Binance keeps only the last 30 days, so backtests that use it are short", p: { period: per }, out: ["change", "value"], f: (C, p) => { const v = col(C, "oi"); return { change: v.map((x, i) => (i >= p.period && ok(x) && ok(v[i - p.period]) && v[i - p.period] ? (x / v[i - p.period] - 1) * 100 : NaN)), value: v }; } },
  longshort: { g: "market", d: "Binance account long/short ratio for SOL perpetuals and the percent of accounts that are long; Binance keeps only the last 30 days, so backtests that use it are short", p: {}, out: ["ratio", "longPct"], f: (C) => ({ ratio: col(C, "ls"), longPct: col(C, "lsl") }) },
  zscore: { g: "statistics", d: "z-score of the close against its n-candle mean", p: { period: P(2, 200, 20) }, out: ["value"], f: (C, p) => { const x = close(C), m = sma(x, p.period), s = stdev(x, p.period); return { value: x.map((v, i) => (ok(s[i]) && s[i] ? (v - m[i]) / s[i] : NaN)) }; } },
  rank: { g: "statistics", d: "percentile rank of the close among the previous n closes, 0-100", p: { period: per }, out: ["value"], f: (C, p) => { const x = close(C), o = nan(C.length); for (let i = p.period; i < x.length; i++) { let c = 0; for (let k = i - p.period; k < i; k++) if (x[k] < x[i]) c++; o[i] = (100 * c) / p.period; } return { value: o }; } },
  highest: { g: "statistics", d: "highest high of the previous n candles (excludes the current one)", p: { period: per }, out: ["value"], f: (C, p) => ({ value: shift(highest(col(C, "h"), p.period), 1) }) },
  lowest: { g: "statistics", d: "lowest low of the previous n candles (excludes the current one)", p: { period: per }, out: ["value"], f: (C, p) => ({ value: shift(lowest(col(C, "l"), p.period), 1) }) },
  drawdown: { g: "statistics", d: "percent below the highest close of the last n candles (0 or negative)", p: { period: per }, out: ["value"], f: (C, p) => { const x = close(C), H = highest(x, p.period); return { value: x.map((v, i) => (ok(H[i]) ? ((v - H[i]) / H[i]) * 100 : NaN)) }; } },
  heikin: { g: "candles", d: "Heikin Ashi candle direction: 1 up, -1 down", p: {}, out: ["dir"], f: (C) => ({ dir: heikin(C) }) },
  pattern: { g: "candles", d: `candle pattern on this candle: 1 if present, else 0 (name one of ${PATTERNS.join(", ")})`, p: {}, names: PATTERNS, out: ["value"], f: (C, p) => ({ value: pattern(C, p.name) }) },
};

export const MTF_SECONDS = { "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "8h": 28800, "12h": 43200, "1d": 86400, "1w": 604800 };

export function resample(C, base, tf) {
  const bs = MTF_SECONDS[base], ts = MTF_SECONDS[tf];
  if (!bs || !ts || ts < bs || ts % bs) throw new Error(`timeframe ${tf} cannot be built from ${base} candles`);
  if (ts === bs) return { candles: C, map: C.map((_, i) => i) };
  const out = [], map = nan(C.length), per = ts / bs, bucket = (t) => (tf === "1w" ? Math.floor((t - 345600) / ts) : Math.floor(t / ts));
  let cur = null, curB = null;
  for (let i = 0; i < C.length; i++) {
    const c = C[i], b = bucket(c.t);
    if (b !== curB) { if (cur) out.push(cur); cur = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, tb: c.tb, n: 1 }; curB = b; }
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; cur.tb = ok(cur.tb) && ok(c.tb) ? cur.tb + c.tb : NaN; cur.n++; }
    for (const k of ["fr", "oi", "ls", "lsl"]) cur[k] = ok(c[k]) ? c[k] : NaN;
    const doneIdx = cur.n === per ? out.length : out.length - 1;
    map[i] = doneIdx;
  }
  if (cur) out.push(cur);
  return { candles: out, map };
}

export function series(C, ref, base) {
  const spec = REGISTRY[ref.ind];
  if (!spec) throw new Error(`unknown indicator "${ref.ind}"`);
  const params = {};
  for (const [k, s] of Object.entries(spec.p)) params[k] = ref[k] ?? s.def;
  if (spec.names) params.name = ref.name;
  const which = ref.out || spec.out[0];
  if (!ref.tf || ref.tf === base) return spec.f(C, params)[which];
  const { candles, map } = resample(C, base, ref.tf);
  const v = spec.f(candles, params)[which];
  return map.map((j) => (j >= 0 && Number.isInteger(j) ? v[j] : NaN));
}

export function describe() {
  return Object.entries(REGISTRY).map(([k, s]) => {
    const ps = Object.entries(s.p).map(([n, d]) => `${n} ${d.lo}-${d.hi}${d.int ? "" : " (decimal)"}, default ${d.def}`);
    if (s.names) ps.push(`name: ${s.names.join(" | ")}`);
    return `- ${k} [${s.g}]: ${s.d}. Settings: ${ps.length ? ps.join("; ") : "none"}. Outputs: ${s.out.join(", ")} (first is default).`;
  }).join("\n");
}
