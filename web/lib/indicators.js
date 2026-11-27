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
  for (let i = 0; i < x.length; i++) { if (!ok(md)) { if (ok(e[i])) md = e[i]; o[i] = md; continue; } if (!(md > 0) || !ok(x[i])) { md = ok(e[i]) ? e[i] : NaN; o[i] = md; continue; } const ratio = Math.min(2, Math.max(0.5, x[i] / md)); md = md + (x[i] - md) / Math.max(1, p * ratio ** 4); o[i] = md; }
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
      case "morningStar": return p && q && q.c < q.o && body(q) / (range(q) || 1e-12) > 0.5 && body(p) < 0.3 * body(q) && c.c > c.o && c.c > (q.o + q.c) / 2 ? 1 : 0;
      case "eveningStar": return p && q && q.c > q.o && body(q) / (range(q) || 1e-12) > 0.5 && body(p) < 0.3 * body(q) && c.c < c.o && c.c < (q.o + q.c) / 2 ? 1 : 0;
      case "bullHarami": return p && p.c < p.o && c.c > c.o && Math.max(c.o, c.c) < p.o && Math.min(c.o, c.c) > p.c ? 1 : 0;
      case "bearHarami": return p && p.c > p.o && c.c < c.o && Math.max(c.o, c.c) < p.c && Math.min(c.o, c.c) > p.o ? 1 : 0;
      case "piercing": return p && p.c < p.o && c.c > c.o && c.o < p.c && c.c > (p.o + p.c) / 2 && c.c < p.o ? 1 : 0;
      case "darkCloud": return p && p.c > p.o && c.c < c.o && c.o > p.c && c.c < (p.o + p.c) / 2 && c.c > p.o ? 1 : 0;
      case "bullMarubozu": return c.c > c.o && body(c) / r > 0.95 ? 1 : 0;
      case "bearMarubozu": return c.c < c.o && body(c) / r > 0.95 ? 1 : 0;
      case "spinningTop": return body(c) / r < 0.3 && (c.h - Math.max(c.o, c.c)) > body(c) && (Math.min(c.o, c.c) - c.l) > body(c) ? 1 : 0;
      case "tweezerBottom": return p && p.c < p.o && c.c > c.o && Math.abs(c.l - p.l) <= 0.001 * c.l ? 1 : 0;
      case "tweezerTop": return p && p.c > p.o && c.c < c.o && Math.abs(c.h - p.h) <= 0.001 * c.h ? 1 : 0;
      case "bullPinBar": return (Math.min(c.o, c.c) - c.l) >= 0.66 * r && body(c) / r < 0.25 ? 1 : 0;
      case "bearPinBar": return (c.h - Math.max(c.o, c.c)) >= 0.66 * r && body(c) / r < 0.25 ? 1 : 0;
      case "dragonflyDoji": return body(c) / r < 0.1 && (c.h - Math.max(c.o, c.c)) / r < 0.1 && (Math.min(c.o, c.c) - c.l) / r > 0.6 ? 1 : 0;
      case "gravestoneDoji": return body(c) / r < 0.1 && (Math.min(c.o, c.c) - c.l) / r < 0.1 && (c.h - Math.max(c.o, c.c)) / r > 0.6 ? 1 : 0;
      case "gapUp": return p && c.l > p.h ? 1 : 0;
      case "gapDown": return p && c.h < p.l ? 1 : 0;
      case "threeInsideUp": return p && q && q.c < q.o && p.c > p.o && Math.max(p.o, p.c) < q.o && Math.min(p.o, p.c) > q.c && c.c > q.o ? 1 : 0;
      case "threeInsideDown": return p && q && q.c > q.o && p.c < p.o && Math.max(p.o, p.c) < q.c && Math.min(p.o, p.c) > q.o && c.c < q.o ? 1 : 0;
      case "nr7": { if (i < 6) return 0; for (let k = i - 6; k < i; k++) if (range(C[k]) <= range(c)) return 0; return 1; }
    }
    return 0;
  }).map((v, i) => (i < 2 && ["threeWhiteSoldiers", "threeBlackCrows", "morningStar", "eveningStar", "threeInsideUp", "threeInsideDown"].includes(kind) ? 0 : v));
}
const PATTERNS = ["bullEngulfing", "bearEngulfing", "hammer", "shootingStar", "doji", "insideBar", "outsideBar", "threeWhiteSoldiers", "threeBlackCrows", "morningStar", "eveningStar", "bullHarami", "bearHarami", "piercing", "darkCloud", "bullMarubozu", "bearMarubozu", "spinningTop", "tweezerBottom", "tweezerTop", "bullPinBar", "bearPinBar", "dragonflyDoji", "gravestoneDoji", "gapUp", "gapDown", "threeInsideUp", "threeInsideDown", "nr7"];

function rets(C) { return C.map((c, i) => (i && C[i - 1].c > 0 ? Math.log(c.c / C[i - 1].c) : NaN)); }
function windowed(x, p, f) {
  const o = nan(x.length);
  for (let i = p - 1; i < x.length; i++) { const w = x.slice(i - p + 1, i + 1); if (w.every(ok)) o[i] = f(w); }
  return o;
}
const mean = (w) => w.reduce((a, b) => a + b, 0) / w.length;
function moments(w) { const m = mean(w); let v = 0, s = 0, k = 0; for (const x of w) { const d = x - m; v += d * d; s += d * d * d; k += d * d * d * d; } const n = w.length; v /= n; return { m, v, s: v ? s / n / v ** 1.5 : 0, k: v ? k / n / (v * v) - 3 : 0 }; }
function t3(x, p, vf) {
  const gd = (y) => { const e1 = ema(y, p), e2 = ema(e1, p); return zip(e1, e2, (a, b) => a * (1 + vf) - b * vf); };
  return gd(gd(gd(x)));
}
function vidya(x, p, cp) {
  const u = x.map((v, i) => (i ? Math.max(v - x[i - 1], 0) : 0)), d = x.map((v, i) => (i ? Math.max(x[i - 1] - v, 0) : 0));
  const su = sum(u, cp), sd = sum(d, cp), a = 2 / (p + 1), o = nan(x.length);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (!ok(su[i])) continue;
    const k = su[i] + sd[i] ? Math.abs(su[i] - sd[i]) / (su[i] + sd[i]) : 0;
    prev = ok(prev) ? a * k * x[i] + (1 - a * k) * prev : x[i];
    o[i] = prev;
  }
  return o;
}
function frama(C, p) {
  const n = p % 2 ? p + 1 : p, h = col(C, "h"), l = col(C, "l"), x = close(C), o = nan(C.length);
  let prev = NaN;
  for (let i = n - 1; i < C.length; i++) {
    const half = n / 2;
    const hl = (a, b) => { let hi = -Infinity, lo = Infinity; for (let k = a; k <= b; k++) { hi = Math.max(hi, h[k]); lo = Math.min(lo, l[k]); } return hi - lo; };
    const n1 = hl(i - n + 1, i - half) / half, n2 = hl(i - half + 1, i) / half, n3 = hl(i - n + 1, i) / n;
    let a = 1;
    if (n1 > 0 && n2 > 0 && n3 > 0) { const dim = (Math.log(n1 + n2) - Math.log(n3)) / Math.log(2); a = Math.min(1, Math.max(0.01, Math.exp(-4.6 * (dim - 1)))); }
    prev = ok(prev) ? a * x[i] + (1 - a) * prev : x[i];
    o[i] = prev;
  }
  return o;
}
function laguerre(x, g) {
  const f = nan(x.length), rsi = nan(x.length);
  let l0 = NaN, l1 = NaN, l2 = NaN, l3 = NaN;
  for (let i = 0; i < x.length; i++) {
    if (!ok(x[i])) continue;
    if (!ok(l0)) { l0 = l1 = l2 = l3 = x[i]; continue; }
    const p0 = l0, p1 = l1, p2 = l2;
    l0 = (1 - g) * x[i] + g * p0;
    l1 = -g * l0 + p0 + g * p1;
    l2 = -g * l1 + p1 + g * p2;
    l3 = -g * l2 + p2 + g * l3;
    f[i] = (l0 + 2 * l1 + 2 * l2 + l3) / 6;
    let cu = 0, cd = 0;
    for (const [a, b] of [[l0, l1], [l1, l2], [l2, l3]]) { if (a >= b) cu += a - b; else cd += b - a; }
    rsi[i] = cu + cd ? (100 * cu) / (cu + cd) : 50;
  }
  return { f, rsi };
}
function supersmoother(x, p) {
  const a = Math.exp((-1.414 * Math.PI) / p), b = 2 * a * Math.cos((1.414 * Math.PI) / p), c2 = b, c3 = -a * a, c1 = 1 - c2 - c3, o = nan(x.length);
  for (let i = 0; i < x.length; i++) {
    if (i < 2) { o[i] = x[i]; continue; }
    o[i] = (c1 * (x[i] + x[i - 1])) / 2 + c2 * (ok(o[i - 1]) ? o[i - 1] : x[i - 1]) + c3 * (ok(o[i - 2]) ? o[i - 2] : x[i - 2]);
  }
  return o;
}
function mama(x, fast, slow) {
  const n = x.length, sm = nan(n), dt = nan(n), i1 = nan(n), q1 = nan(n), I2 = nan(n), Q2 = nan(n), re = nan(n), im = nan(n), per = nan(n), sp = nan(n), ph = nan(n), M = nan(n), F = nan(n);
  const z = (a, i) => (i >= 0 && ok(a[i]) ? a[i] : 0);
  for (let i = 0; i < n; i++) {
    if (i < 6) { M[i] = x[i]; F[i] = x[i]; per[i] = 0; sp[i] = 0; ph[i] = 0; I2[i] = 0; Q2[i] = 0; re[i] = 0; im[i] = 0; sm[i] = x[i]; dt[i] = 0; i1[i] = 0; q1[i] = 0; continue; }
    const adj = 0.075 * z(per, i - 1) + 0.54;
    sm[i] = (4 * x[i] + 3 * x[i - 1] + 2 * x[i - 2] + x[i - 3]) / 10;
    const ht = (a) => (0.0962 * z(a, i) + 0.5769 * z(a, i - 2) - 0.5769 * z(a, i - 4) - 0.0962 * z(a, i - 6)) * adj;
    dt[i] = ht(sm);
    q1[i] = ht(dt); i1[i] = z(dt, i - 3);
    const jI = ht(i1), jQ = ht(q1);
    let i2 = i1[i] - jQ, q2 = q1[i] + jI;
    i2 = 0.2 * i2 + 0.8 * z(I2, i - 1); q2 = 0.2 * q2 + 0.8 * z(Q2, i - 1);
    I2[i] = i2; Q2[i] = q2;
    let r = i2 * z(I2, i - 1) + q2 * z(Q2, i - 1), m = i2 * z(Q2, i - 1) - q2 * z(I2, i - 1);
    r = 0.2 * r + 0.8 * z(re, i - 1); m = 0.2 * m + 0.8 * z(im, i - 1);
    re[i] = r; im[i] = m;
    let P = z(per, i - 1);
    if (m !== 0 && r !== 0) P = (2 * Math.PI) / Math.atan(m / r);
    const pp = z(per, i - 1);
    if (pp) { P = Math.min(P, 1.5 * pp); P = Math.max(P, 0.67 * pp); }
    P = Math.min(50, Math.max(6, P));
    P = 0.2 * P + 0.8 * pp;
    per[i] = P; sp[i] = 0.33 * P + 0.67 * z(sp, i - 1);
    ph[i] = i1[i] !== 0 ? (Math.atan(q1[i] / i1[i]) * 180) / Math.PI : z(ph, i - 1);
    let dp = z(ph, i - 1) - ph[i]; if (dp < 1) dp = 1;
    const al = Math.max(slow, Math.min(fast, fast / dp));
    M[i] = al * x[i] + (1 - al) * z(M, i - 1);
    F[i] = 0.5 * al * M[i] + (1 - 0.5 * al) * z(F, i - 1);
  }
  const warm = (a) => a.map((v, i) => (i < 50 ? NaN : v));
  return { value: warm(M), fama: warm(F), period: warm(sp) };
}
function stc(x, fast, slow, cyc) {
  const m = zip(ema(x, fast), ema(x, slow), (a, b) => a - b);
  const pass = (y) => { const L = lowest(y, cyc), H = highest(y, cyc), o = nan(y.length); let prev = NaN; for (let i = 0; i < y.length; i++) { if (!ok(L[i]) || !ok(H[i]) || !ok(y[i])) continue; const st = H[i] > L[i] ? ((y[i] - L[i]) / (H[i] - L[i])) * 100 : ok(prev) ? prev : 50; prev = ok(prev) ? prev + 0.5 * (st - prev) : st; o[i] = prev; } return o; };
  return pass(pass(m));
}
function qqe(x, rp, sf, qf) {
  const r = ema(rsiOf(x, rp), sf), atrR = r.map((v, i) => (i && ok(v) && ok(r[i - 1]) ? Math.abs(v - r[i - 1]) : NaN));
  const dar = ema(ema(atrR, 2 * rp - 1), 2 * rp - 1).map((v) => v * qf), line = nan(x.length);
  let tr = NaN;
  for (let i = 1; i < x.length; i++) {
    if (!ok(r[i]) || !ok(dar[i])) continue;
    const up = r[i] - dar[i], dn = r[i] + dar[i], prev = ok(tr) ? tr : up, pr = r[i - 1];
    if (r[i] > prev && pr > prev) tr = Math.max(prev, up);
    else if (r[i] < prev && pr < prev) tr = Math.min(prev, dn);
    else tr = r[i] > prev ? up : dn;
    line[i] = tr;
  }
  return { value: r, line };
}
function hurst(x, p) {
  return windowed(x, p, (w) => {
    const m = mean(w); let c = 0, mx = -Infinity, mn = Infinity, v = 0;
    for (const r of w) { c += r - m; mx = Math.max(mx, c); mn = Math.min(mn, c); v += (r - m) ** 2; }
    const s = Math.sqrt(v / w.length);
    return s > 0 && mx > mn ? Math.log((mx - mn) / s) / Math.log(w.length) : NaN;
  });
}
function entropy(x, p, bins) {
  return windowed(x, p, (w) => {
    const lo = Math.min(...w), hi = Math.max(...w);
    if (hi === lo) return 0;
    const cnt = new Array(bins).fill(0);
    for (const v of w) cnt[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins))]++;
    let e = 0; for (const c of cnt) if (c) { const q = c / w.length; e -= q * Math.log(q); }
    return e / Math.log(bins);
  });
}
function corr(a, b, p) {
  const o = nan(a.length);
  for (let i = p - 1; i < a.length; i++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, bad = false;
    for (let k = i - p + 1; k <= i; k++) { const u = a[k], v = b[k]; if (!ok(u) || !ok(v)) { bad = true; break; } sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v; }
    if (bad) continue;
    const cv = sab - (sa * sb) / p, va = saa - (sa * sa) / p, vb = sbb - (sb * sb) / p;
    o[i] = va > 0 && vb > 0 ? cv / Math.sqrt(va * vb) : 0;
  }
  return o;
}
function volEst(C, p, kind) {
  const per = C.map((c, i) => {
    if (!(c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)) return NaN;
    const hl = Math.log(c.h / c.l), co = Math.log(c.c / c.o), ho = Math.log(c.h / c.o), lo = Math.log(c.l / c.o), hc = Math.log(c.h / c.c), lc = Math.log(c.l / c.c);
    if (kind === "parkinson") return (hl * hl) / (4 * Math.log(2));
    if (kind === "gk") return 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
    if (kind === "rs") return ho * hc + lo * lc;
    return NaN;
  });
  if (kind !== "yz") return sma(per, p).map((v) => (ok(v) && v >= 0 ? Math.sqrt(v) * 100 : NaN));
  const on = C.map((c, i) => (i && C[i - 1].c > 0 ? Math.log(c.o / C[i - 1].c) : NaN)), oc = C.map((c) => Math.log(c.c / c.o)), rs = rsRaw(C, p);
  const k = 0.34 / (1.34 + (p + 1) / (p - 1)), vo = stdev(on, p).map((v) => v * v), vc = stdev(oc, p).map((v) => v * v);
  return vo.map((v, i) => (ok(v) && ok(vc[i]) && ok(rs[i]) ? Math.sqrt(Math.max(0, v + k * vc[i] + (1 - k) * rs[i])) * 100 : NaN));
}
function rsRaw(C, p) { return sma(C.map((c) => (c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0 ? Math.log(c.h / c.o) * Math.log(c.h / c.c) + Math.log(c.l / c.o) * Math.log(c.l / c.c) : NaN)), p); }
function fractals(C) {
  const n = C.length, up = nan(n), dn = nan(n), newUp = new Array(n).fill(0), newDn = new Array(n).fill(0);
  let lu = NaN, ld = NaN;
  for (let i = 0; i < n; i++) {
    const j = i - 2;
    if (j >= 2) {
      const h = C[j].h, l = C[j].l;
      if (h > C[j - 1].h && h > C[j - 2].h && h > C[j + 1].h && h > C[j + 2].h) { lu = h; newUp[i] = 1; }
      if (l < C[j - 1].l && l < C[j - 2].l && l < C[j + 1].l && l < C[j + 2].l) { ld = l; newDn[i] = 1; }
    }
    up[i] = lu; dn[i] = ld;
  }
  return { lastUp: up, lastDown: dn, newUp, newDown: newDn };
}
function zigzag(C, pct) {
  const n = C.length, hi = nan(n), lo = nan(n), dir = nan(n);
  let d = 0, hx = NaN, lx = NaN, lastHi = NaN, lastLo = NaN;
  for (let i = 0; i < n; i++) {
    const c = C[i];
    if (d >= 0) {
      hx = ok(hx) ? Math.max(hx, c.h) : c.h;
      if (d === 0) lx = ok(lx) ? Math.min(lx, c.l) : c.l;
      if (c.l <= hx * (1 - pct / 100)) { lastHi = hx; d = -1; lx = c.l; }
      else if (d === 0 && c.h >= lx * (1 + pct / 100)) { lastLo = lx; d = 1; hx = c.h; }
    } else {
      lx = Math.min(lx, c.l);
      if (c.h >= lx * (1 + pct / 100)) { lastLo = lx; d = 1; hx = c.h; }
    }
    hi[i] = lastHi; lo[i] = lastLo; dir[i] = d === 0 ? NaN : d;
  }
  return { lastHigh: hi, lastLow: lo, dir };
}
function pivots(C) {
  const n = C.length, out = { p: nan(n), r1: nan(n), s1: nan(n), r2: nan(n), s2: nan(n), r3: nan(n), s3: nan(n) };
  let day = null, cur = null, prev = null;
  for (let i = 0; i < n; i++) {
    const d = Math.floor(C[i].t / 86400);
    if (d !== day) { if (cur && day !== null && d === day + 1) prev = cur; else if (cur) prev = null; cur = { h: C[i].h, l: C[i].l, c: C[i].c }; day = d; }
    else { cur.h = Math.max(cur.h, C[i].h); cur.l = Math.min(cur.l, C[i].l); cur.c = C[i].c; }
    if (!prev) continue;
    const P = (prev.h + prev.l + prev.c) / 3, R = prev.h - prev.l;
    out.p[i] = P; out.r1[i] = 2 * P - prev.l; out.s1[i] = 2 * P - prev.h; out.r2[i] = P + R; out.s2[i] = P - R; out.r3[i] = prev.h + 2 * (P - prev.l); out.s3[i] = prev.l - 2 * (prev.h - P);
  }
  return out;
}
function rwi(C, p) {
  const atr = (k, i) => { let s = 0; for (let j = i - k + 1; j <= i; j++) s += j ? Math.max(C[j].h - C[j].l, Math.abs(C[j].h - C[j - 1].c), Math.abs(C[j].l - C[j - 1].c)) : C[j].h - C[j].l; return s / k; };
  const hi = nan(C.length), lo = nan(C.length);
  for (let i = p + 1; i < C.length; i++) {
    let a = 0, b = 0;
    for (let k = 2; k <= p; k++) { const t = atr(k, i) * Math.sqrt(k); if (t > 0) { a = Math.max(a, (C[i].h - C[i - k].l) / t); b = Math.max(b, (C[i - k].h - C[i].l) / t); } }
    hi[i] = a; lo[i] = b;
  }
  return { high: hi, low: lo };
}

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
  t3: { g: "average", d: "Tillson T3 moving average (six EMAs blended with a volume factor)", p: { period: P(2, 100, 5), vfactor: P(0, 1, 0.7, false) }, out: ["value"], f: (C, p) => ({ value: t3(close(C), p.period, p.vfactor) }) },
  trima: { g: "average", d: "triangular moving average", p: { period: per }, out: ["value"], f: (C, p) => ({ value: sma(sma(close(C), Math.ceil((p.period + 1) / 2)), Math.floor(p.period / 2) + 1) }) },
  vidya: { g: "average", d: "Chande VIDYA: an EMA that speeds up when momentum is strong", p: { period: per, cmo: P(2, 50, 9) }, out: ["value"], f: (C, p) => ({ value: vidya(close(C), p.period, p.cmo) }) },
  frama: { g: "average", d: "Ehlers fractal adaptive moving average", p: { period: P(4, 200, 16) }, out: ["value"], f: (C, p) => ({ value: frama(C, p.period) }) },
  laguerre: { g: "average", d: "Ehlers Laguerre filter (gamma 0-1, higher is smoother)", p: { gamma: P(0.1, 0.95, 0.8, false) }, out: ["value"], f: (C, p) => ({ value: laguerre(close(C), p.gamma).f }) },
  supersmoother: { g: "average", d: "Ehlers two-pole super smoother filter", p: { period: P(3, 200, 10) }, out: ["value"], f: (C, p) => ({ value: supersmoother(close(C), p.period) }) },
  mama: { g: "average", d: "Ehlers MESA adaptive moving average with FAMA and the measured dominant cycle length in candles", p: { fast: P(0.05, 0.9, 0.5, false), slow: P(0.01, 0.5, 0.05, false) }, out: ["value", "fama", "period"], f: (C, p) => mama(close(C), p.fast, p.slow) },
  alligator: { g: "trend", d: "Williams Alligator jaw, teeth and lips (smoothed medians, no forward shift)", p: { jaw: P(2, 100, 13), teeth: P(2, 100, 8), lips: P(2, 100, 5) }, out: ["jaw", "teeth", "lips"], f: (C, p) => { const m = C.map((c) => (c.h + c.l) / 2); return { jaw: rma(m, p.jaw), teeth: rma(m, p.teeth), lips: rma(m, p.lips) }; } },
  envelope: { g: "volatility", d: "moving average envelope, a band a fixed percent above and below the SMA", p: { period: P(2, 200, 20), pct: P(0.1, 50, 2.5, false) }, out: ["upper", "lower"], f: (C, p) => { const m = sma(close(C), p.period); return { upper: m.map((v) => v * (1 + p.pct / 100)), lower: m.map((v) => v * (1 - p.pct / 100)) }; } },
  starc: { g: "volatility", d: "STARC bands: SMA plus and minus a multiple of ATR", p: { period: P(2, 200, 6), atr: P(2, 100, 15), mult: P(0.5, 10, 2, false) }, out: ["upper", "lower"], f: (C, p) => { const m = sma(close(C), p.period), a = rma(trueRange(C), p.atr); return { upper: zip(m, a, (u, v) => u + p.mult * v), lower: zip(m, a, (u, v) => u - p.mult * v) }; } },
  kst: { g: "momentum", d: "Know Sure Thing: weighted sum of four smoothed rates of change, with signal", p: { signal: P(2, 50, 9) }, out: ["value", "signal"], f: (C, p) => { const x = close(C), r = (n, s) => sma(x.map((v, i) => (i >= n ? (v / x[i - n] - 1) * 100 : NaN)), s); const a = r(10, 10), b = r(15, 10), c = r(20, 10), d = r(30, 15); const v = a.map((u, i) => (ok(u) && ok(b[i]) && ok(c[i]) && ok(d[i]) ? u + 2 * b[i] + 3 * c[i] + 4 * d[i] : NaN)); return { value: v, signal: sma(v, p.signal) }; } },
  rvgi: { g: "momentum", d: "relative vigor index: where closes sit against opens, with signal", p: { period: P(2, 100, 10) }, out: ["value", "signal"], f: (C, p) => { const sw = (f) => C.map((c, i) => (i >= 3 ? (f(C[i]) + 2 * f(C[i - 1]) + 2 * f(C[i - 2]) + f(C[i - 3])) / 6 : NaN)); const v = zip(sum(sw((c) => c.c - c.o), p.period), sum(sw((c) => c.h - c.l), p.period), (a, b) => (b ? a / b : 0)); return { value: v, signal: v.map((u, i) => (i >= 3 && ok(u) && ok(v[i - 3]) ? (u + 2 * v[i - 1] + 2 * v[i - 2] + v[i - 3]) / 6 : NaN)) }; } },
  smi: { g: "momentum", d: "stochastic momentum index -100 to 100, with signal", p: { period: P(2, 100, 10), smooth1: P(1, 20, 3), smooth2: P(1, 20, 3), signal: P(1, 20, 3) }, out: ["value", "signal"], f: (C, p) => { const H = highest(col(C, "h"), p.period), L = lowest(col(C, "l"), p.period), m = C.map((c, i) => (ok(H[i]) ? c.c - (H[i] + L[i]) / 2 : NaN)), d = zip(H, L, (a, b) => a - b); const v = zip(ema(ema(m, p.smooth1), p.smooth2), ema(ema(d, p.smooth1), p.smooth2), (a, b) => (b ? (200 * a) / b : 0)); return { value: v, signal: ema(v, p.signal) }; } },
  elderray: { g: "momentum", d: "Elder ray: bull power (high minus EMA) and bear power (low minus EMA)", p: { period: P(2, 100, 13) }, out: ["bull", "bear"], f: (C, p) => { const e = ema(close(C), p.period); return { bull: zip(col(C, "h"), e, (a, b) => a - b), bear: zip(col(C, "l"), e, (a, b) => a - b) }; } },
  qstick: { g: "momentum", d: "Qstick: average of close minus open", p: { period: per }, out: ["value"], f: (C, p) => ({ value: sma(C.map((c) => c.c - c.o), p.period) }) },
  pgo: { g: "momentum", d: "pretty good oscillator: distance from the SMA in ATRs", p: { period: per }, out: ["value"], f: (C, p) => ({ value: zip(zip(close(C), sma(close(C), p.period), (a, b) => a - b), ema(trueRange(C), p.period), (a, b) => (b ? a / b : 0)) }) },
  cfo: { g: "momentum", d: "Chande forecast oscillator: percent gap between the close and its linear regression forecast", p: { period: per }, out: ["value"], f: (C, p) => ({ value: zip(close(C), linreg(close(C), p.period).value, (a, b) => (a ? ((a - b) / a) * 100 : 0)) }) },
  apo: { g: "momentum", d: "absolute price oscillator: fast EMA minus slow EMA", p: { fast: P(2, 100, 12), slow: P(3, 200, 26) }, out: ["value"], f: (C, p) => ({ value: zip(ema(close(C), p.fast), ema(close(C), p.slow), (a, b) => a - b) }) },
  stc: { g: "momentum", d: "Schaff trend cycle 0-100", p: { fast: P(2, 100, 23), slow: P(3, 200, 50), cycle: P(2, 100, 10) }, out: ["value"], f: (C, p) => ({ value: stc(close(C), p.fast, p.slow, p.cycle) }) },
  laguerrersi: { g: "momentum", d: "Ehlers Laguerre RSI 0-100 (gamma 0-1, higher is smoother)", p: { gamma: P(0.1, 0.95, 0.5, false) }, out: ["value"], f: (C, p) => ({ value: laguerre(close(C), p.gamma).rsi }) },
  demarker: { g: "momentum", d: "DeMarker 0-1", p: { period: per }, out: ["value"], f: (C, p) => { const mx = C.map((c, i) => (i ? Math.max(c.h - C[i - 1].h, 0) : NaN)), mn = C.map((c, i) => (i ? Math.max(C[i - 1].l - c.l, 0) : NaN)); return { value: zip(sma(mx, p.period), sma(mn, p.period), (a, b) => (a + b ? a / (a + b) : 0.5)) }; } },
  rmi: { g: "momentum", d: "relative momentum index 0-100: RSI measured over a longer step", p: { period: per, momentum: P(1, 50, 5) }, out: ["value"], f: (C, p) => { const x = close(C), m = p.momentum, u = x.map((v, i) => (i >= m ? Math.max(v - x[i - m], 0) : NaN)), d = x.map((v, i) => (i >= m ? Math.max(x[i - m] - v, 0) : NaN)); return { value: zip(rma(u, p.period), rma(d, p.period), (a, b) => (b === 0 ? (a === 0 ? 50 : 100) : 100 - 100 / (1 + a / b))) }; } },
  psy: { g: "momentum", d: "psychological line: percent of the last n candles that closed up", p: { period: P(2, 200, 12) }, out: ["value"], f: (C, p) => ({ value: sma(C.map((c, i) => (i ? (c.c > C[i - 1].c ? 100 : 0) : NaN)), p.period) }) },
  disparity: { g: "momentum", d: "disparity index: percent distance of the close from its SMA", p: { period: per }, out: ["value"], f: (C, p) => ({ value: zip(close(C), sma(close(C), p.period), (a, b) => (b ? (a / b - 1) * 100 : 0)) }) },
  imi: { g: "momentum", d: "intraday momentum index 0-100: up candle bodies against all bodies", p: { period: per }, out: ["value"], f: (C, p) => ({ value: zip(sum(C.map((c) => Math.max(c.c - c.o, 0)), p.period), sum(C.map((c) => Math.abs(c.c - c.o)), p.period), (a, b) => (b ? (100 * a) / b : 50)) }) },
  rvix: { g: "volatility", d: "relative volatility index 0-100: like RSI but on standard deviation", p: { period: per, stdev: P(2, 50, 10) }, out: ["value"], f: (C, p) => { const x = close(C), s = stdev(x, p.stdev), u = x.map((v, i) => (i && ok(s[i]) ? (v > x[i - 1] ? s[i] : 0) : NaN)), d = x.map((v, i) => (i && ok(s[i]) ? (v < x[i - 1] ? s[i] : 0) : NaN)); return { value: zip(rma(u, p.period), rma(d, p.period), (a, b) => (a + b ? (100 * a) / (a + b) : 50)) }; } },
  iftrsi: { g: "momentum", d: "inverse Fisher transform of RSI, -1 to 1", p: { period: P(2, 100, 5), smooth: P(1, 50, 9) }, out: ["value"], f: (C, p) => ({ value: wma(rsiOf(close(C), p.period).map((v) => 0.1 * (v - 50)), p.smooth).map((v) => (ok(v) ? (Math.exp(2 * v) - 1) / (Math.exp(2 * v) + 1) : NaN)) }) },
  er: { g: "trend", d: "Kaufman efficiency ratio 0-1: net move over total path, 1 is a clean trend", p: { period: P(2, 200, 10) }, out: ["value"], f: (C, p) => { const x = close(C), path = sum(x.map((v, i) => (i ? Math.abs(v - x[i - 1]) : NaN)), p.period); return { value: x.map((v, i) => (i >= p.period && ok(path[i]) ? (path[i] ? Math.abs(v - x[i - p.period]) / path[i] : 0) : NaN)) }; } },
  vhf: { g: "trend", d: "vertical horizontal filter: high means trending, low means ranging", p: { period: P(2, 200, 28) }, out: ["value"], f: (C, p) => { const x = close(C), H = highest(x, p.period), L = lowest(x, p.period), path = sum(x.map((v, i) => (i ? Math.abs(v - x[i - 1]) : NaN)), p.period); return { value: H.map((h, i) => (ok(path[i]) && path[i] ? (h - L[i]) / path[i] : NaN)) }; } },
  rwi: { g: "trend", d: "random walk index: how far the move goes beyond a random walk, for highs and lows", p: { period: P(3, 50, 14) }, out: ["high", "low"], f: (C, p) => rwi(C, p.period) },
  tii: { g: "trend", d: "trend intensity index 0-100: share of recent closes above their SMA", p: { period: P(4, 200, 30) }, out: ["value"], f: (C, p) => { const x = close(C), m = sma(x, p.period), dev = zip(x, m, (a, b) => a - b), h = Math.floor(p.period / 2); return { value: zip(sum(dev.map((v) => (ok(v) ? Math.max(v, 0) : NaN)), h), sum(dev.map((v) => (ok(v) ? Math.abs(v) : NaN)), h), (a, b) => (b ? (100 * a) / b : 50)) }; } },
  pfe: { g: "trend", d: "polarized fractal efficiency -100 to 100: how straight the recent path is, signed", p: { period: P(2, 100, 10), smooth: P(1, 50, 5) }, out: ["value"], f: (C, p) => { const x = close(C), n = p.period, raw = x.map((v, i) => { if (i < n) return NaN; let path = 0; for (let k = i - n + 1; k <= i; k++) path += Math.sqrt((x[k] - x[k - 1]) ** 2 + 1); const r = (100 * Math.sqrt((v - x[i - n]) ** 2 + n * n)) / path; return v >= x[i - n] ? r : -r; }); return { value: ema(raw, p.smooth) }; } },
  cog: { g: "momentum", d: "Ehlers center of gravity oscillator", p: { period: P(2, 100, 10) }, out: ["value"], f: (C, p) => { const x = C.map((c) => (c.h + c.l) / 2), o = nan(C.length); for (let i = p.period - 1; i < x.length; i++) { let num = 0, den = 0; for (let k = 0; k < p.period; k++) { num += (k + 1) * x[i - k]; den += x[i - k]; } o[i] = den ? -num / den : NaN; } return { value: o }; } },
  wavetrend: { g: "momentum", d: "WaveTrend oscillator (wt1 and its signal wt2)", p: { channel: P(2, 100, 10), average: P(2, 100, 21) }, out: ["wt1", "wt2"], f: (C, p) => { const ap = typical(C), esa = ema(ap, p.channel), d = ema(zip(ap, esa, (a, b) => Math.abs(a - b)), p.channel), ci = ap.map((v, i) => (ok(esa[i]) && ok(d[i]) && d[i] ? (v - esa[i]) / (0.015 * d[i]) : NaN)), w1 = ema(ci, p.average); return { wt1: w1, wt2: sma(w1, 4) }; } },
  qqe: { g: "momentum", d: "QQE: smoothed RSI and its volatility trailing line", p: { rsi: P(2, 100, 14), smooth: P(1, 50, 5), factor: P(1, 10, 4.236, false) }, out: ["value", "line"], f: (C, p) => qqe(close(C), p.rsi, p.smooth, p.factor) },
  ac: { g: "momentum", d: "Bill Williams accelerator oscillator (AO minus its 5-candle average)", p: {}, out: ["value"], f: (C) => { const m = C.map((c) => (c.h + c.l) / 2), ao = zip(sma(m, 5), sma(m, 34), (a, b) => a - b); return { value: zip(ao, sma(ao, 5), (a, b) => a - b) }; } },
  bwmfi: { g: "volume", d: "Bill Williams market facilitation index: range per unit of volume, scaled by a million", p: {}, out: ["value"], f: (C) => ({ value: C.map((c) => (c.v ? ((c.h - c.l) / c.v) * 1e6 : NaN)) }) },
  impulse: { g: "trend", d: "Elder impulse: 1 when the EMA and MACD histogram both rise, -1 when both fall, else 0", p: { period: P(2, 100, 13) }, out: ["value"], f: (C, p) => { const x = close(C), e = ema(x, p.period), m = zip(ema(x, 12), ema(x, 26), (a, b) => a - b), h = zip(m, ema(m, 9), (a, b) => a - b); return { value: x.map((_, i) => (i && ok(e[i]) && ok(e[i - 1]) && ok(h[i]) && ok(h[i - 1]) ? (e[i] > e[i - 1] && h[i] > h[i - 1] ? 1 : e[i] < e[i - 1] && h[i] < h[i - 1] ? -1 : 0) : NaN)) }; } },
  ssl: { g: "trend", d: "SSL channel direction: 1 after a close above the SMA of highs, -1 after a close below the SMA of lows", p: { period: P(2, 200, 10) }, out: ["dir"], f: (C, p) => { const H = sma(col(C, "h"), p.period), L = sma(col(C, "l"), p.period), o = nan(C.length); let d = NaN; for (let i = 0; i < C.length; i++) { if (!ok(H[i])) continue; if (C[i].c > H[i]) d = 1; else if (C[i].c < L[i]) d = -1; o[i] = ok(d) ? d : 0; } return { dir: o }; } },
  gannhilo: { g: "trend", d: "Gann HiLo activator: line and direction (1 up, -1 down)", p: { period: P(2, 200, 3) }, out: ["line", "dir"], f: (C, p) => { const H = shift(sma(col(C, "h"), p.period), 1), L = shift(sma(col(C, "l"), p.period), 1), line = nan(C.length), dir = nan(C.length); let d = 0; for (let i = 0; i < C.length; i++) { if (!ok(H[i])) continue; if (C[i].c > H[i]) d = 1; else if (C[i].c < L[i]) d = -1; dir[i] = d; line[i] = d === 1 ? L[i] : H[i]; } return { line, dir }; } },
  fractal: { g: "structure", d: "Williams fractals, confirmed two candles later: last up and down fractal prices, and 1 on the candle that confirms a new one", p: {}, out: ["lastUp", "lastDown", "newUp", "newDown"], f: (C) => fractals(C) },
  zigzag: { g: "structure", d: "ZigZag swings confirmed after a reversal of pct percent: last confirmed swing high, last swing low, and current leg (1 up, -1 down)", p: { pct: P(0.5, 50, 5, false) }, out: ["lastHigh", "lastLow", "dir"], f: (C, p) => zigzag(C, p.pct) },
  pivot: { g: "structure", d: "classic daily floor pivots from the previous UTC day: pivot, R1-R3, S1-S3", p: {}, out: ["p", "r1", "s1", "r2", "s2", "r3", "s3"], f: (C) => pivots(C) },
  fib: { g: "structure", d: "Fibonacci retracement levels of the previous n candles' high-low range, measured down from the high", p: { period: P(5, 500, 100) }, out: ["f236", "f382", "f500", "f618", "f786"], f: (C, p) => { const H = shift(highest(col(C, "h"), p.period), 1), L = shift(lowest(col(C, "l"), p.period), 1), lv = (q) => zip(H, L, (a, b) => a - (a - b) * q); return { f236: lv(0.236), f382: lv(0.382), f500: lv(0.5), f618: lv(0.618), f786: lv(0.786) }; } },
  since: { g: "structure", d: "candles since the highest high and since the lowest low of the last n candles", p: { period: P(2, 500, 50) }, out: ["high", "low"], f: (C, p) => { const n = p.period, hi = nan(C.length), lo = nan(C.length); for (let i = n - 1; i < C.length; i++) { let a = i, b = i; for (let k = i - n + 1; k <= i; k++) { if (C[k].h >= C[a].h) a = k; if (C[k].l <= C[b].l) b = k; } hi[i] = i - a; lo[i] = i - b; } return { high: hi, low: lo }; } },
  hurst: { g: "statistics", d: "rolling Hurst exponent of returns: above 0.5 trending, below 0.5 mean reverting", p: { period: P(20, 500, 100) }, out: ["value"], f: (C, p) => ({ value: hurst(rets(C), p.period) }) },
  entropy: { g: "statistics", d: "Shannon entropy of recent returns 0-1: high means random, low means orderly", p: { period: P(10, 500, 50), bins: P(2, 20, 10) }, out: ["value"], f: (C, p) => ({ value: entropy(rets(C), p.period, p.bins) }) },
  autocorr: { g: "statistics", d: "autocorrelation of returns at a lag, -1 to 1: positive means moves continue, negative means they reverse", p: { period: P(10, 500, 50), lag: P(1, 20, 1) }, out: ["value"], f: (C, p) => { const r = rets(C); return { value: corr(r, shift(r, p.lag), p.period) }; } },
  skew: { g: "statistics", d: "skewness of recent returns", p: { period: P(10, 500, 50) }, out: ["value"], f: (C, p) => ({ value: windowed(rets(C), p.period, (w) => moments(w).s) }) },
  kurtosis: { g: "statistics", d: "excess kurtosis of recent returns (fat tails above 0)", p: { period: P(10, 500, 50) }, out: ["value"], f: (C, p) => ({ value: windowed(rets(C), p.period, (w) => moments(w).k) }) },
  sharpe: { g: "statistics", d: "rolling return-to-risk: mean return over its standard deviation for the last n candles", p: { period: P(10, 500, 50) }, out: ["value"], f: (C, p) => ({ value: windowed(rets(C), p.period, (w) => { const m = moments(w); return m.v ? m.m / Math.sqrt(m.v) : 0; }) }) },
  pvcorr: { g: "statistics", d: "correlation between price and volume over n candles, -1 to 1", p: { period: P(5, 500, 20) }, out: ["value"], f: (C, p) => ({ value: corr(close(C), col(C, "v"), p.period) }) },
  vixfix: { g: "volatility", d: "Williams VIX fix: percent drop of the low from the highest close, a fear gauge", p: { period: P(2, 200, 22) }, out: ["value"], f: (C, p) => { const H = highest(close(C), p.period); return { value: C.map((c, i) => (ok(H[i]) && H[i] ? ((H[i] - c.l) / H[i]) * 100 : NaN)) }; } },
  parkinson: { g: "volatility", d: "Parkinson volatility from highs and lows, percent per candle", p: { period: per }, out: ["value"], f: (C, p) => ({ value: volEst(C, p.period, "parkinson") }) },
  garmanklass: { g: "volatility", d: "Garman-Klass volatility from open, high, low and close, percent per candle", p: { period: per }, out: ["value"], f: (C, p) => ({ value: volEst(C, p.period, "gk") }) },
  rogerssatchell: { g: "volatility", d: "Rogers-Satchell volatility (handles trends), percent per candle", p: { period: per }, out: ["value"], f: (C, p) => ({ value: volEst(C, p.period, "rs") }) },
  yangzhang: { g: "volatility", d: "Yang-Zhang volatility including overnight gaps, percent per candle", p: { period: P(3, 200, 14) }, out: ["value"], f: (C, p) => ({ value: volEst(C, p.period, "yz") }) },
  chaikinvol: { g: "volatility", d: "Chaikin volatility: percent change of the smoothed high-low range", p: { period: P(2, 100, 10) }, out: ["value"], f: (C, p) => { const e = ema(C.map(range), p.period); return { value: e.map((v, i) => (i >= p.period && ok(v) && ok(e[i - p.period]) && e[i - p.period] ? (v / e[i - p.period] - 1) * 100 : NaN)) }; } },
  pvo: { g: "volume", d: "percentage volume oscillator", p: { fast: P(2, 100, 12), slow: P(3, 200, 26), signal: P(2, 50, 9) }, out: ["line", "signal", "hist"], f: (C, p) => { const v = col(C, "v"), line = zip(ema(v, p.fast), ema(v, p.slow), (a, b) => (b ? ((a - b) / b) * 100 : 0)), s = ema(line, p.signal); return { line, signal: s, hist: zip(line, s, (a, b) => a - b) }; } },
  pvi: { g: "volume", d: "positive volume index and its EMA", p: { period: P(2, 255, 255) }, out: ["value", "signal"], f: (C, p) => { const o = nan(C.length); let v = 1000; o[0] = v; for (let i = 1; i < C.length; i++) { if (C[i].v > C[i - 1].v) v *= C[i].c / C[i - 1].c; o[i] = v; } return { value: o, signal: ema(o, p.period) }; } },
  twiggs: { g: "volume", d: "Twiggs money flow -1 to 1", p: { period: P(2, 200, 21) }, out: ["value"], f: (C, p) => { const ad = C.map((c, i) => { if (!i) return NaN; const th = Math.max(c.h, C[i - 1].c), tl = Math.min(c.l, C[i - 1].c); return th > tl ? (((c.c - tl) - (th - c.c)) / (th - tl)) * c.v : 0; }); return { value: zip(rma(ad, p.period), rma(col(C, "v").map((v, i) => (i ? v : NaN)), p.period), (a, b) => (b ? a / b : 0)) }; } },
  chaikinosc: { g: "volume", d: "Chaikin oscillator: fast minus slow EMA of the accumulation/distribution line", p: { fast: P(2, 50, 3), slow: P(3, 100, 10) }, out: ["value"], f: (C, p) => { const ad = []; let s = 0; for (const c of C) { const r = c.h - c.l; s += r ? (((c.c - c.l) - (c.h - c.c)) / r) * c.v : 0; ad.push(s); } return { value: zip(ema(ad, p.fast), ema(ad, p.slow), (a, b) => a - b) }; } },
  vroc: { g: "volume", d: "volume rate of change in percent", p: { period: per }, out: ["value"], f: (C, p) => { const v = col(C, "v"); return { value: v.map((x, i) => (i >= p.period && v[i - p.period] ? (x / v[i - p.period] - 1) * 100 : NaN)) }; } },
  trades: { g: "volume", d: "number of trades in this candle against the average of the previous n, and the average trade size in SOL", p: { period: per }, out: ["ratio", "size"], f: (C, p) => { const n = col(C, "nt"), m = shift(sma(n, p.period), 1); return { ratio: zip(n, m, (a, b) => (b ? a / b : NaN)), size: C.map((c) => (ok(c.nt) && c.nt ? c.v / c.nt : NaN)) }; } },
  time: { g: "calendar", d: "when the candle opened, in UTC: hour 0-23 and weekday 0-6 (0 is Monday)", p: {}, out: ["hour", "weekday"], f: (C) => ({ hour: C.map((c) => new Date(c.t * 1000).getUTCHours()), weekday: C.map((c) => (new Date(c.t * 1000).getUTCDay() + 6) % 7) }) },
  heikin: { g: "candles", d: "Heikin Ashi candle direction: 1 up, -1 down", p: {}, out: ["dir"], f: (C) => ({ dir: heikin(C) }) },
  pattern: { g: "candles", d: `candle pattern on this candle: 1 if present, else 0 (name one of ${PATTERNS.join(", ")})`, p: {}, names: PATTERNS, out: ["value"], f: (C, p) => ({ value: pattern(C, p.name) }) },
};

export const MTF_SECONDS = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "8h": 28800, "12h": 43200, "1d": 86400, "1w": 604800 };

export function resample(C, base, tf) {
  const bs = own(MTF_SECONDS, base) ? MTF_SECONDS[base] : 0, ts = own(MTF_SECONDS, tf) ? MTF_SECONDS[tf] : 0;
  if (!bs || !ts || ts < bs || ts % bs) throw new Error(`timeframe ${tf} cannot be built from ${base} candles`);
  if (ts === bs) return { candles: C, map: C.map((_, i) => i) };
  const out = [], map = nan(C.length), per = ts / bs, bucket = (t) => (tf === "1w" ? Math.floor((t - 345600) / ts) : Math.floor(t / ts));
  let cur = null, curB = null;
  for (let i = 0; i < C.length; i++) {
    const c = C[i], b = bucket(c.t);
    if (b !== curB) { if (cur) out.push(cur); cur = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, tb: c.tb, nt: c.nt, n: 1 }; curB = b; }
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; cur.tb = ok(cur.tb) && ok(c.tb) ? cur.tb + c.tb : NaN; cur.nt = ok(cur.nt) && ok(c.nt) ? cur.nt + c.nt : NaN; cur.n++; }
    for (const k of ["fr", "oi", "ls", "lsl"]) cur[k] = ok(c[k]) ? c[k] : NaN;
    const doneIdx = cur.n === per ? out.length : out.length - 1;
    map[i] = doneIdx;
  }
  if (cur) out.push(cur);
  return { candles: out, map };
}

const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
export function series(C0, ref, base) {
  const C = ref.asset ? C0.assets && own(C0.assets, ref.asset) ? C0.assets[ref.asset] : null : C0;
  if (!C) throw new Error(`no price data loaded for ${ref.asset}`);
  const spec = own(REGISTRY, ref.ind) ? REGISTRY[ref.ind] : null;
  if (!spec) throw new Error("unknown indicator");
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
