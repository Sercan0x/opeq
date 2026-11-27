const API = "https://api.hyperliquid.xyz/info";
const SECS = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const COIN = { SOLUSDT: "SOL" };

async function info(body, fetchImpl) {
  const r = await fetchImpl(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`price data request failed (${r.status})`);
  return r.json();
}

export async function candles(symbol, interval, total = 1000, fetchImpl = fetch) {
  if (!SECS[interval]) throw new Error("unsupported timeframe");
  const coin = COIN[symbol];
  if (!coin) throw new Error("unsupported market");
  const want = Math.max(50, Math.min(3000, total));
  const step = SECS[interval] * 1000, now = Date.now();
  const rows = await info({ type: "candleSnapshot", req: { coin, interval, startTime: now - (want + 3) * step, endTime: now } }, fetchImpl);
  if (!Array.isArray(rows)) throw new Error("price data is not a list");
  const out = rows.filter((r) => Number(r.T) < now).sort((a, b) => a.t - b.t).slice(-want).map((r) => ({ t: Math.floor(Number(r.t) / 1000), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v), tb: NaN }));
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

export async function withMarketData(C, symbol, interval, need, fetchImpl = fetch) {
  if (!C.length) return C;
  if (need.oi || need.ls) throw new Error("open interest and long/short history are not available");
  if (need.funding) {
    const coin = COIN[symbol], end = (C[C.length - 1].t + SECS[interval]) * 1000;
    let from = C[0].t * 1000 - 8 * 3600 * 1000;
    const all = [];
    for (let i = 0; i < 24 && from < end; i++) {
      const part = await info({ type: "fundingHistory", coin, startTime: from, endTime: end }, fetchImpl);
      if (!Array.isArray(part) || !part.length) break;
      all.push(...part);
      const last = Math.max(...part.map((x) => Number(x.time)));
      if (part.length < 500 || !Number.isFinite(last)) break;
      from = last + 1;
    }
    stepAlign(C, all.map((x) => ({ t: Number(x.time), v: Number(x.fundingRate) * 100 * 8 })), "fr", interval);
  }
  return C;
}
