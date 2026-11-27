const API = "https://api.binance.us/api/v3/klines";
const SECS = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200, "1d": 86400, "1w": 604800 };
export const MAX = 20000;

const symbolOf = (coin) => (/^[A-Z0-9]{2,12}$/.test(coin) ? `${coin}USDT` : null);

export async function candles(coin, interval, total = 1000, fetchImpl = fetch) {
  if (!SECS[interval]) throw new Error("unsupported timeframe");
  const symbol = symbolOf(coin);
  if (!symbol) throw new Error(`${coin} has no long price history`);
  const want = Math.max(50, Math.min(MAX, total)), step = SECS[interval] * 1000, now = Date.now();
  const start = now - (want + 2) * step, starts = [];
  for (let t = start; t < now; t += 1000 * step) starts.push(t);
  const parts = await Promise.all(starts.map(async (t) => {
    const r = await fetchImpl(`${API}?${new URLSearchParams({ symbol, interval, startTime: String(t), endTime: String(Math.min(now, t + 1000 * step - 1)), limit: "1000" })}`);
    if (r.status === 400) throw new Error(`${coin} has no long price history`);
    if (!r.ok) throw new Error(`price data request failed (${r.status})`);
    return r.json();
  }));
  const seen = new Set(), rows = [];
  for (const r of parts.flat()) { const k = Number(r[0]); if (!seen.has(k)) { seen.add(k); rows.push(r); } }
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  const out = rows.filter((r) => Number(r[6]) < now).slice(-want).map((r) => ({ t: Math.floor(Number(r[0]) / 1000), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), tb: Number(r[9]), nt: Number(r[8]) }));
  if (!out.length) throw new Error(`${coin} has no long price history`);
  if (out.some((x) => !Number.isFinite(x.t) || ![x.o, x.h, x.l, x.c, x.v].every((v) => Number.isFinite(v) && v >= 0))) throw new Error("price data has invalid candles");
  return out;
}
