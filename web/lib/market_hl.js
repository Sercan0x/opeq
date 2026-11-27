const API = "https://api.hyperliquid.xyz/info";
const SECS = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200, "1d": 86400, "1w": 604800 };
const COIN = { SOLUSDT: "SOL" };
const coinOf = (symbol) => COIN[symbol] || (/^k?[A-Z0-9]{2,12}$/.test(symbol) ? symbol : null);

async function info(body, fetchImpl) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetchImpl(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status !== 429) break;
    await new Promise((ok) => setTimeout(ok, 700 * (attempt + 1)));
  }
  if (!r.ok) throw new Error(r.status === 500 && body.req ? `no Hyperliquid market for ${body.req.coin}` : `price data request failed (${r.status})`);
  return r.json();
}

const candleCache = new Map();
export async function candles(symbol, interval, total = 1000, fetchImpl = fetch) {
  const size = Math.min(5000, total <= 500 ? 500 : Math.ceil(total / 1000) * 1000);
  const key = `${symbol}|${interval}|${size}`, hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 25000) return hit.rows.slice(-total).map((c) => ({ ...c }));
  const rows = await fetchCandles(symbol, interval, size, fetchImpl);
  if (candleCache.size > 80) candleCache.clear();
  candleCache.set(key, { at: Date.now(), rows });
  return rows.slice(-total).map((c) => ({ ...c }));
}
async function fetchCandles(symbol, interval, total, fetchImpl) {
  if (!SECS[interval]) throw new Error("unsupported timeframe");
  const coin = coinOf(symbol);
  if (!coin) throw new Error("unsupported market");
  const want = Math.max(50, Math.min(5000, total));
  const step = SECS[interval] * 1000, now = Date.now();
  const rows = await info({ type: "candleSnapshot", req: { coin, interval, startTime: now - (want + 3) * step, endTime: now } }, fetchImpl);
  if (!Array.isArray(rows)) throw new Error("price data is not a list");
  const out = rows.filter((r) => Number(r.T) < now).sort((a, b) => a.t - b.t).slice(-want).map((r) => ({ t: Math.floor(Number(r.t) / 1000), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v), tb: NaN, nt: Number(r.n) }));
  if (out.some((x) => !Number.isFinite(x.t) || ![x.o, x.h, x.l, x.c, x.v].every((v) => Number.isFinite(v) && v >= 0))) throw new Error("price data has invalid candles");
  for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) throw new Error("price data is out of order");
  return out;
}

function stepAlign(C, points, key, interval) {
  const step = SECS[interval] * 1000;
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  let j = -1;
  for (const c of C) {
    const close = c.t * 1000 + step;
    while (j + 1 < pts.length && pts[j + 1].t <= close) j++;
    c[key] = j >= 0 && close - pts[j].t <= 3 * 86400 * 1000 ? pts[j].v : NaN;
  }
}

const WINDOW = 480 * 3600 * 1000;
const fundingCache = new Map();
async function fundingWindow(coin, start, fetchImpl) {
  const key = `${coin}|${start}`, hit = fundingCache.get(key), done = start + WINDOW < Date.now() - 2 * 3600 * 1000;
  if (hit && (done || Date.now() - hit.at < 60000)) return hit.rows;
  const rows = await info({ type: "fundingHistory", coin, startTime: start, endTime: start + WINDOW - 1 }, fetchImpl);
  const list = Array.isArray(rows) ? rows : [];
  if (fundingCache.size > 500) fundingCache.clear();
  fundingCache.set(key, { at: Date.now(), rows: list });
  return list;
}

export async function withMarketData(C, symbol, interval, need, fetchImpl = fetch) {
  if (!C.length) return C;
  if (need.oi || need.ls) throw new Error("open interest and long/short history are not available");
  if (need.funding || need.fs) {
    const coin = coinOf(symbol), step = SECS[interval] * 1000, end = C[C.length - 1].t * 1000 + step, from = C[0].t * 1000 - 8 * 3600 * 1000;
    const first = Math.floor(from / WINDOW) * WINDOW, starts = [];
    for (let t = first; t < end && starts.length < 120; t += WINDOW) starts.push(t);
    const parts = await Promise.all(starts.map((t) => fundingWindow(coin, t, fetchImpl)));
    const seen = new Set(), all = [];
    for (const x of parts.flat()) { const k = Number(x.time); if (!seen.has(k)) { seen.add(k); all.push({ t: k, r: Number(x.fundingRate) }); } }
    all.sort((a, b) => a.t - b.t);
    if (need.funding) stepAlign(C, all.map((x) => ({ t: x.t, v: x.r * 100 * 8 })), "fr", interval);
    if (need.fs) {
      let j = 0;
      for (const c of C) {
        const a = c.t * 1000, b = a + step;
        while (j < all.length && all[j].t <= a) j++;
        let sum = 0, k = j;
        while (k < all.length && all[k].t <= b) { if (Number.isFinite(all[k].r)) sum += all[k].r; k++; }
        c.fs = sum;
      }
    }
  }
  return C;
}
