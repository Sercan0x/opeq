const API = "https://api.bybit.com/v5/market";
const SECS = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200, "1d": 86400, "1w": 604800 };
const KLINE = { "5m": "5", "15m": "15", "30m": "30", "1h": "60", "2h": "120", "4h": "240", "12h": "720", "1d": "D", "1w": "W" };
const PERIOD = { "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1d" };

async function get(path, params, fetchImpl) {
  const r = await fetchImpl(`${API}/${path}?${new URLSearchParams(params)}`);
  if (!r.ok) throw new Error(`price data request failed (${r.status})`);
  const j = await r.json();
  if (!j || j.retCode !== 0 || !j.result) throw new Error(`price data request failed (${j && j.retMsg ? j.retMsg : "bad answer"})`);
  return j.result;
}

const pair = (s) => (/USDT$/.test(s) ? s : `${s}USDT`);
export async function candles(symbol, interval, total = 1000, fetchImpl = fetch) {
  symbol = pair(symbol);
  if (!Object.prototype.hasOwnProperty.call(SECS, interval) || !Object.prototype.hasOwnProperty.call(KLINE, interval)) throw new Error("unsupported timeframe");
  const want = Math.max(50, Math.min(5000, total));
  const step = SECS[interval] * 1000;
  let end = null, rows = [];
  while (rows.length < want) {
    const lim = Math.min(1000, want - rows.length + 1);
    const res = await get("kline", { category: "spot", symbol, interval: KLINE[interval], limit: String(lim), ...(end ? { end: String(end) } : {}) }, fetchImpl);
    const part = Array.isArray(res.list) ? res.list : [];
    if (!part.length) break;
    const asc = part.slice().reverse();
    rows = [...asc.filter((r) => !rows.length || Number(r[0]) < Number(rows[0][0])), ...rows];
    end = Number(asc[0][0]) - 1;
    if (part.length < lim) break;
  }
  const now = Date.now();
  const out = rows.filter((r) => Number(r[0]) + step <= now).slice(-want).map((r) => ({ t: Math.floor(Number(r[0]) / 1000), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), tb: NaN }));
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

async function history(path, params, rowsOf, start, fetchImpl, pages = 12) {
  const all = [];
  let cursor = null, endTime = null;
  for (let i = 0; i < pages; i++) {
    const res = await get(path, { ...params, ...(cursor ? { cursor } : {}), ...(endTime ? { endTime: String(endTime) } : {}) }, fetchImpl);
    const rows = rowsOf(res);
    if (!rows.length) break;
    all.push(...rows);
    const oldest = Math.min(...rows.map((r) => r.t));
    if (oldest <= start) break;
    if (res.nextPageCursor) cursor = res.nextPageCursor; else endTime = oldest - 1;
  }
  return all;
}

export async function withMarketData(C, symbol, interval, need, fetchImpl = fetch) {
  symbol = pair(symbol);
  if (!C.length) return C;
  const start = C[0].t * 1000;
  if (need.funding) {
    const pts = await history("funding/history", { category: "linear", symbol, limit: "200" }, (r) => (r.list || []).map((x) => ({ t: Number(x.fundingRateTimestamp), v: Number(x.fundingRate) * 100 })), start - 8 * 3600 * 1000, fetchImpl, 10);
    stepAlign(C, pts, "fr", interval);
  }
  if (need.oi) {
    const pts = await history("open-interest", { category: "linear", symbol, intervalTime: PERIOD[interval], limit: "200" }, (r) => (r.list || []).map((x) => ({ t: Number(x.timestamp), v: Number(x.openInterest) })), start, fetchImpl, 15);
    stepAlign(C, pts, "oi", interval);
    for (const c of C) c.oi = Number.isFinite(c.oi) ? c.oi * c.c : NaN;
  }
  if (need.ls) {
    const pts = await history("account-ratio", { category: "linear", symbol, period: PERIOD[interval], limit: "500" }, (r) => (r.list || []).map((x) => ({ t: Number(x.timestamp), buy: Number(x.buyRatio), sell: Number(x.sellRatio) })), start, fetchImpl, 6);
    stepAlign(C, pts.map((p) => ({ t: p.t, v: p.sell ? p.buy / p.sell : NaN })), "ls", interval);
    stepAlign(C, pts.map((p) => ({ t: p.t, v: p.buy * 100 })), "lsl", interval);
  }
  return C;
}
