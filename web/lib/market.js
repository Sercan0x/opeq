import { parseKlines } from "./bot.js";

const SPOT = "https://api.binance.com/api/v3/klines";
const FAPI = "https://fapi.binance.com";
const SECS = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const HIST_PERIOD = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };

async function json(url, fetchImpl) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`price data request failed (${r.status})`);
  return r.json();
}

export async function candles(symbol, interval, total = 1000, fetchImpl = fetch) {
  if (!SECS[interval]) throw new Error("unsupported timeframe");
  const want = Math.max(50, Math.min(3000, total));
  let end = null, rows = [];
  while (rows.length < want) {
    const lim = Math.min(1000, want - rows.length);
    const q = new URLSearchParams({ symbol, interval, limit: String(lim), ...(end ? { endTime: String(end) } : {}) });
    const part = await json(`${SPOT}?${q}`, fetchImpl);
    if (!Array.isArray(part) || !part.length) break;
    rows = [...part, ...rows];
    end = Number(part[0][0]) - 1;
    if (part.length < lim) break;
  }
  const now = Date.now();
  const closed = rows.filter((r) => Number(r[6]) < now);
  return parseKlines(closed);
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
  const start = C[0].t * 1000;
  if (need.funding) {
    const all = [];
    let from = start - 8 * 3600 * 1000;
    for (let i = 0; i < 4; i++) {
      const part = await json(`${FAPI}/fapi/v1/fundingRate?${new URLSearchParams({ symbol, startTime: String(from), limit: "1000" })}`, fetchImpl);
      if (!Array.isArray(part) || !part.length) break;
      all.push(...part);
      if (part.length < 1000) break;
      from = Number(part[part.length - 1].fundingTime) + 1;
    }
    stepAlign(C, all.map((x) => ({ t: Number(x.fundingTime), v: Number(x.fundingRate) * 100 })), "fr", interval);
  }
  if (need.oi || need.ls) {
    const period = HIST_PERIOD[interval];
    if (need.oi) {
      const oi = await json(`${FAPI}/futures/data/openInterestHist?${new URLSearchParams({ symbol, period, limit: "500" })}`, fetchImpl);
      stepAlign(C, (Array.isArray(oi) ? oi : []).map((x) => ({ t: Number(x.timestamp), v: Number(x.sumOpenInterestValue) })), "oi", interval);
    }
    if (need.ls) {
      const ls = await json(`${FAPI}/futures/data/globalLongShortAccountRatio?${new URLSearchParams({ symbol, period, limit: "500" })}`, fetchImpl);
      const rows = Array.isArray(ls) ? ls : [];
      stepAlign(C, rows.map((x) => ({ t: Number(x.timestamp), v: Number(x.longShortRatio) })), "ls", interval);
      stepAlign(C, rows.map((x) => ({ t: Number(x.timestamp), v: Number(x.longAccount) * 100 })), "lsl", interval);
    }
  }
  return C;
}

export function marketNeeds(rule, asset = undefined) {
  const need = { funding: false, oi: false, ls: false };
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.ind && x.asset !== asset) return;
    if (x.ind === "funding") need.funding = true;
    if (x.ind === "oi") need.oi = true;
    if (x.ind === "longshort") need.ls = true;
    Object.values(x).forEach(walk);
  };
  walk(rule.entry); walk(rule.exit);
  return need;
}
