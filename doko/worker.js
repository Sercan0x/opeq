import { validateRule, backtest, step, TIMEFRAMES, assetsOf, MAX_ASSETS, MAX_COINS, MAX_LEVERAGE, FEE_PCT, SLIP_PCT, freshState, cachesFor, equityOf, pricesAt, touch, levels, liqDistancePct } from "./lib/bot.js";
import { REGISTRY, MTF_SECONDS, describe, series } from "./lib/indicators.js";
import { marketNeeds } from "./lib/market.js";
import * as bybit from "./lib/market_bybit.js";
import * as hl from "./lib/market_hl.js";
import { optimize } from "./lib/optimize.js";
import { discover } from "./lib/discover.js";
import { explain } from "./lib/dokoexplain.js";

const START = 1000;
const MAX_AGENTS = 10;
const MAX_RUNNING = 5;
const ACCESS_TTL = 86400;
const REFRESH_TTL = 60 * 86400;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const COOKIE = "doko_acct";
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const hexId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s) => b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const pct = (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const when = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const spotFetch = (u, ...rest) => fetch(u, ...rest);
const UNAVAILABLE = ["takerbuy", "cvd", "oi", "longshort"];
async function loadCandles(symbol, interval, total, f) { try { return await hl.candles(symbol, interval, total, f); } catch (x) { try { return await bybit.candles(symbol, interval, total, f); } catch { throw x; } } }
async function withMarketData(C, symbol, interval, need, f) { try { return await hl.withMarketData(C, symbol, interval, need, f); } catch (x) { try { return await bybit.withMarketData(C, symbol, interval, need, f); } catch { throw x; } } }
const INDICATORS = describe().split("\n").filter((l) => !UNAVAILABLE.some((n) => l.startsWith(`- ${n} [`))).join("\n").replace(/Binance account long\/short ratio/g, "Account long/short ratio").replace(/; Binance keeps only the last 30 days, so backtests that use it are short/g, "; history can be shorter than the price history").replace(/SOL perpetual funding rate in percent per 8 hours/g, "perpetual funding rate on Hyperliquid in percent per 8 hours").replace(/history goes back about a year/g, "history starts in May 2023, so earlier candles have no value");

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
function oauthError(code, desc, status = 400) { return json({ error: code, error_description: desc }, status); }

const RULE_FORMAT = `A DOKO agent trades perpetual futures with paper money: it can go long, short, or both, with leverage. Its rule is JSON with these fields:
- name: 1 to 60 characters
- coins: 1 to ${MAX_COINS} Hyperliquid perpetual tickers it trades, such as ["SOL"] or ["BTC", "ETH", "SOL"]. The same rule runs on each coin separately, each with its own position, all from one shared balance of ${START} paper dollars.
- timeframe: one of ${Object.keys(TIMEFRAMES).join(", ")}
- leverage: whole number 1 to ${MAX_LEVERAGE}, chosen by the user
- marginUsd: margin per trade in dollars, 1 to 100000. Position size is marginUsd times leverage.
- long: {"entry": condition, "exit": condition (optional)} to go long
- short: {"entry": condition, "exit": condition (optional)} to go short
  At least one of long or short. With both, an opposite signal closes the position and opens the other side.
- stopLossPct: required, price move against the position in percent (0.05 to 50). At 20x a 1% stop loses about 20% of the margin.
- takeProfitPct: optional, price move in favour in percent (0.05 to 500)
- maxTradesPerDay: optional, 1 to 48 new positions a day across all coins
No other fields.

How a trade is simulated: signals are read on closed candles and the position opens at that close. Stop loss, take profit and liquidation fire inside a candle at their level (live, from the order book stream; in backtests, from the candle high and low, assuming the worse one first). Liquidation happens after a price move of (100 / leverage - 0.5)% against the position, for example 1.5% at 50x and 0.3% at 125x, and loses the whole margin. Costs: ${FEE_PCT}% fee and ${SLIP_PCT}% slippage per side on the position size, and hourly funding while a position is open (longs pay when funding is positive, shorts receive it). Funding history starts in May 2023.

A condition is one of:
- {"all": [conditions]} or {"any": [conditions]} (1 to 8 items), or {"not": condition}
- {"atLeast": n, "of": [conditions]}: true when at least n of 2 to 8 conditions hold
- a comparison {"left": X, "op": "<" | "<=" | ">" | ">=", "right": Y}, where X and Y are a number or an indicator, and at least one is an indicator
- a cross {"cross": "above" | "below", "a": indicator, "b": X}
At most 32 conditions in total, nested at most 4 deep.

An indicator is {"ind": name, ...settings, "out": output, "tf": timeframe, "asset": coin}. Leave a setting out to use its default. "out" picks one output (default: the first). "tf" computes the indicator on a longer timeframe than the rule's (one of ${Object.keys(MTF_SECONDS).join(", ")}, a multiple of the rule's timeframe); its value only updates when that longer candle closes. Candle patterns use {"ind": "pattern", "name": ...} and give 1 or 0.
Without "asset" an indicator reads the coin being traded. "asset" reads another coin's candles instead, lined up candle by candle: any Hyperliquid perpetual ticker such as BTC, ETH, HYPE, DOGE or kPEPE (k means a thousand units). A rule can watch up to ${MAX_ASSETS} other coins. Example BTC filter: {"left":{"ind":"rsi","asset":"BTC","tf":"4h"},"op":"<","right":30}.

Example: {"name":"SOL and ETH 4h trend, both ways","coins":["SOL","ETH"],"timeframe":"4h","leverage":5,"marginUsd":200,"long":{"entry":{"all":[{"cross":"above","a":{"ind":"ema","period":20},"b":{"ind":"ema","period":50}},{"left":{"ind":"price","asset":"BTC","tf":"1d"},"op":">","right":{"ind":"sma","period":50,"asset":"BTC","tf":"1d"}}]}},"short":{"entry":{"all":[{"cross":"below","a":{"ind":"ema","period":20},"b":{"ind":"ema","period":50}},{"left":{"ind":"adx"},"op":">","right":20}]}},"stopLossPct":4,"takeProfitPct":12}

Prices come from Hyperliquid perpetual candles. Open interest, long/short ratio and taker volume indicators are not available.

Indicators:
${INDICATORS}`;

const INSTRUCTIONS = `DOKO by OPEQ lets the user build AI trading agents for perpetual futures on Hyperliquid coins, run with paper money (1,000 paper dollars each). An agent can go long, short or both, with leverage from 1x to 125x that the user chooses. Once approved it runs as fixed math on closed candles, with no AI in the loop; stops, take profits and liquidations are watched live from the order book stream, even when the user is away.
Talk with the user in their language. Before writing a rule, call rule_format once. Ask the user for the leverage if they have not said it. Use backtest and search_settings to show how a rule would have done, including liquidations, and discover_strategies to search many random rules when the user wants new ideas, and say plainly that past results are no promise and that high leverage can wipe the margin in a small move. Never promise profits.
Changing anything is two steps: propose_agent or propose_change returns a summary; show it to the user, and call apply_proposal only after the user says yes in this conversation.
If the user asks for something rules cannot express (news, sentiment, order book data), say so. Nothing here touches a wallet or real money.`;

function warmup(rule) {
  let need = 50;
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.ind && REGISTRY[x.ind]) {
      const spec = REGISTRY[x.ind];
      let biggest = 1;
      for (const k of Object.keys(spec.p)) { const v = x[k] !== undefined ? x[k] : spec.p[k].def; if (spec.p[k].int && v > biggest) biggest = v; }
      const mult = x.tf ? MTF_SECONDS[x.tf] / MTF_SECONDS[rule.timeframe] : 1;
      need = Math.max(need, Math.ceil(biggest * 3 * mult + 2 * mult));
    }
    Object.values(x).forEach(walk);
  };
  for (const side of [rule.long, rule.short]) if (side) { walk(side.entry); walk(side.exit); }
  return Math.min(need, 2500);
}
function align(C, A) {
  const by = new Map(A.map((a) => [a.t, a]));
  let last = null;
  return C.map((c) => {
    const a = by.get(c.t);
    if (a) { last = a; return a; }
    if (last) return { t: c.t, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, tb: NaN, nt: 0 };
    return { t: c.t, o: NaN, h: NaN, l: NaN, c: NaN, v: NaN, tb: NaN, nt: NaN };
  });
}
const CB_PRODUCTS = { SOL: "SOL-USD", BTC: "BTC-USD", ETH: "ETH-USD" };
const CB_START = Date.UTC(2021, 5, 17) / 1000;
const HOUR = 3600, PAGE = 300;
const hourNow = () => Math.floor(Date.now() / 1000 / HOUR) * HOUR;
const iso = (s) => new Date(s * 1000).toISOString();

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function cbPage(product, start, end) {
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?${new URLSearchParams({ granularity: String(HOUR), start: iso(start), end: iso(end - HOUR) })}`;
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch(url, { headers: { "user-agent": "opeq-doko", accept: "application/json" } });
    if (r.status !== 429) break;
    await pause(1500 * (attempt + 1));
  }
  if (!r.ok) throw new Error(`coinbase ${r.status} ${(await r.text()).slice(0, 120)}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

export async function backfill(env, pagesPerProduct = 2) {
  const first = Number(env.CB_START) || CB_START, out = {};
  for (const product of Object.values(CB_PRODUCTS)) {
    const st = await env.DB.prepare("SELECT next FROM cb_state WHERE product = ?").bind(product).first();
    let next = st ? st.next : first, pages = 0;
    const closedEnd = hourNow();
    while (pages < pagesPerProduct && next < closedEnd) {
      const end = Math.min(next + PAGE * HOUR, closedEnd);
      let rows;
      try { rows = await cbPage(product, next, end); } catch (x) { await env.DB.prepare("INSERT OR REPLACE INTO cb_err (product, at, msg) VALUES (?, ?, ?)").bind(product, now(), String(x.message).slice(0, 300)).run(); out.stopped = true; break; }
      pages++;
      await pause(250);
      const keep = rows.filter((r) => Number(r[0]) >= next && Number(r[0]) + HOUR <= closedEnd && [1, 2, 3, 4, 5].every((k) => Number.isFinite(Number(r[k]))));
      for (let i = 0; i < keep.length; i += 100) {
        await env.DB.batch(keep.slice(i, i + 100).map((r) => env.DB.prepare("INSERT OR REPLACE INTO cb_candles (product, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(product, Number(r[0]), Number(r[3]), Number(r[2]), Number(r[1]), Number(r[4]), Number(r[5]))));
      }
      next = end >= closedEnd ? Math.max(first, closedEnd - 3 * HOUR) : end;
    }
    await env.DB.prepare("INSERT INTO cb_state (product, next, updated) VALUES (?, ?, ?) ON CONFLICT(product) DO UPDATE SET next = MAX(next, excluded.next), updated = excluded.updated").bind(product, next, now()).run();
    out[product] = { pages, done: next >= hourNow() - 4 * HOUR, progressPct: Math.min(100, Math.round(((next - first) / (hourNow() - first)) * 100)) };
    if (out.stopped) break;
  }
  return out;
}

function bucketOf(t, secs) { return secs === 604800 ? Math.floor((t - 345600) / secs) : Math.floor(t / secs); }
export function hoursTo(rows, tf) {
  const filled = [];
  for (const r of rows) {
    const prev = filled[filled.length - 1];
    if (prev) for (let t = prev.t + HOUR; t < r.t; t += HOUR) filled.push({ t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
    filled.push({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
  }
  const secs = TIMEFRAMES[tf];
  if (secs === HOUR) return filled.map((c) => ({ ...c, tb: NaN, nt: NaN }));
  const out = [];
  let cur = null, b = null;
  for (const c of filled) {
    const k = bucketOf(c.t, secs);
    if (k !== b) { if (cur) out.push(cur); cur = { t: secs === 604800 ? k * secs + 345600 : k * secs, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, tb: NaN, nt: NaN, n: 1 }; b = k; }
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; cur.n++; }
  }
  if (cur) out.push(cur);
  const full = secs / HOUR;
  return out.filter((c, i) => (i === 0 ? c.n === full : true) && c.t + secs <= hourNow()).map(({ n, ...c }) => c);
}

async function deepCandles(env, coin, tf, n) {
  const product = CB_PRODUCTS[coin];
  if (!product) throw new ToolError(`Long history beyond 5000 candles is kept for SOL, BTC and ETH only, not ${coin}. Use 5000 candles or fewer for rules that watch ${coin}.`);
  const st = await env.DB.prepare("SELECT next FROM cb_state WHERE product = ?").bind(product).first();
  const first = Number(env.CB_START) || CB_START;
  if (!st || st.next < hourNow() - 6 * HOUR) {
    const pct = st ? Math.round(((st.next - first) / (hourNow() - first)) * 100) : 0;
    throw new ToolError(`DOKO is still loading the long ${coin} history (${pct}% done). Try again in a little while, or use 5000 candles or fewer.`);
  }
  const per = TIMEFRAMES[tf] / HOUR, hours = Math.min((n + 2) * per, 80000);
  const { results } = await env.DB.prepare("SELECT t, o, h, l, c, v FROM cb_candles WHERE product = ? AND t >= ? ORDER BY t").bind(product, hourNow() - hours * HOUR).all();
  if (!results.length) throw new ToolError(`No stored history for ${coin} yet.`);
  return hoursTo(results, tf).slice(-n);
}

async function loadAll(env, rule, n) {
  const tf = rule.timeframe, deep = n > 5000;
  if (deep && TIMEFRAMES[tf] < HOUR) throw new ToolError("More than 5000 candles works on 1h or longer timeframes. Use 5000 candles or fewer on 5m, 15m and 30m.");
  const get = async (coin) => {
    try { return deep ? await deepCandles(env, coin, tf, n) : await loadCandles(coin, tf, n, spotFetch); }
    catch (x) { if (x instanceof ToolError) throw x; throw new ToolError(`No price data for ${coin}: ${x.message}. Pick a coin listed on Hyperliquid.`); }
  };
  const raw = {};
  await Promise.all(rule.coins.map(async (c) => { raw[c] = await get(c); }));
  const main = raw[rule.coins[0]];
  const data = { [rule.coins[0]]: main };
  for (const c of rule.coins.slice(1)) data[c] = align(main, raw[c]);
  const extra = {};
  const assets = assetsOf(rule).filter((a) => !rule.coins.includes(a));
  await Promise.all(assets.map(async (a) => { extra[a] = align(main, await get(a)); }));
  await Promise.all(rule.coins.map((c) => withMarketData(data[c], c, tf, { ...marketNeeds(rule), fs: true }, spotFetch).catch(() => data[c])));
  await Promise.all(assets.map((a) => (marketNeeds(rule, a).funding ? hl.withMarketData(extra[a], a, tf, { funding: true }, spotFetch) : null)));
  for (const c of rule.coins) {
    const own = {};
    for (const a of assetsOf(rule)) own[a] = rule.coins.includes(a) ? data[a] : extra[a];
    data[c].assets = own;
  }
  return data;
}

function freshPaper(rule) { return { ...freshState(rule, START), lastT: null, log: [], equity: START, wins: 0, closed: 0, liqs: 0, curve: [] }; }
const ruleOf = (d) => (d.cur >= 0 && d.versions[d.cur] ? d.versions[d.cur].rule : null);
function plog(p, text) { p.log.unshift({ t: Date.now(), text }); p.log = p.log.slice(0, 200); }
function sample(arr, n) { if (arr.length <= n) return arr; const out = []; for (let i = 0; i < n; i++) out.push(arr[Math.round((i / (n - 1)) * (arr.length - 1))]); return out; }
const fmtPx = (v) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(5));
function describeEvent(e) {
  if (e.kind === "open") return `Opened ${e.side} ${e.coin} ${e.lev}x at ${fmtPx(e.price)} with ${usd(e.margin)} margin`;
  return `Closed ${e.side} ${e.coin} at ${fmtPx(e.price)}: ${e.why}, ${e.pnl >= 0 ? "+" : ""}${usd(e.pnl)}${e.funding ? ` (funding ${e.funding >= 0 ? "+" : ""}${usd(e.funding)})` : ""}`;
}
function record(p, e) {
  plog(p, describeEvent(e));
  if (e.kind === "close") { p.closed = (p.closed || 0) + 1; if (e.pnl > 0) p.wins = (p.wins || 0) + 1; if (e.liquidated) p.liqs = (p.liqs || 0) + 1; }
}
function positionsOf(rule, p) {
  if (!p || !p.pos) return [];
  return Object.entries(p.pos).filter(([, x]) => x).map(([coin, x]) => {
    const L = levels(rule, x);
    return { coin, side: x.side > 0 ? "long" : "short", leverage: x.lev, entry: x.entry, margin: +x.margin.toFixed(2), stop: +L.stop.toPrecision(6), liquidation: +L.liq.toPrecision(6), takeProfit: Number.isFinite(L.take) ? +L.take.toPrecision(6) : null, funding: +x.funding.toFixed(2) };
  });
}

function summary(row) {
  const d = JSON.parse(row.data), r = ruleOf(d), p = d.paper;
  const ran = !!(p && p.lastT);
  return {
    id: row.id, name: row.name, running: !!row.running,
    status: !r ? "no rules" : row.running ? "trading" : ran ? "paused" : "not started",
    coins: r ? r.coins : [], timeframe: r ? r.timeframe : null, leverage: r ? r.leverage : null, sides: r ? [r.long ? "long" : null, r.short ? "short" : null].filter(Boolean) : [], version: r ? d.cur + 1 : 0,
    paper: p ? { balance: +p.equity.toFixed(2), resultPct: +((p.equity / START - 1) * 100).toFixed(2), closedTrades: p.closed || 0, wins: p.wins || 0, liquidations: p.liqs || 0, winRatePct: p.closed ? Math.round((p.wins / p.closed) * 100) : null, positions: r ? positionsOf(r, p) : [], started: ran } : null,
    backtest: d.bt || null,
  };
}
function detail(row) {
  const d = JSON.parse(row.data), r = ruleOf(d), s = summary(row);
  return {
    ...s,
    rules: r ? Object.fromEntries(explain(r)) : null,
    rule: r,
    versions: d.versions.map((v, i) => ({ version: i + 1, name: v.rule.name, at: new Date(v.at).toISOString(), current: i === d.cur })),
    recent: d.paper ? d.paper.log.slice(0, 30).map((l) => ({ at: new Date(l.t).toISOString(), text: l.text })) : [],
    curve: d.paper ? d.paper.curve : [],
  };
}

async function accountFromCookie(request, env) {
  const m = /(?:^|;\s*)doko_acct=([0-9a-f]{12})\.([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get("cookie") || "");
  if (!m) return null;
  const row = await env.DB.prepare("SELECT secret FROM accounts WHERE id = ?").bind(m[1]).first();
  if (!row || row.secret !== (await sha(m[2]))) return null;
  return m[1];
}
function cookieFor(id, secret, secure) {
  return `${COOKIE}=${id}.${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;
}

function siteCors(request, env) {
  const origin = request.headers.get("origin");
  const allowed = (env.SITE_ORIGINS || "https://opeq.io,https://www.opeq.io").split(",");
  if (!origin || !allowed.includes(origin)) return null;
  return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", vary: "Origin" };
}

function metadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: ["doko"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}
function okRedirect(u) {
  if (typeof u !== "string" || u.length > 500) return false;
  let x; try { x = new URL(u); } catch { return false; }
  if (x.hash) return false;
  if (x.protocol === "https:") return true;
  return x.protocol === "http:" && (x.hostname === "localhost" || x.hostname === "127.0.0.1");
}
const TRUSTED_HOSTS = ["claude.ai", "claude.com", "localhost", "127.0.0.1"];

async function register(request, env) {
  if (env.CONNECT_LIMIT) { const { success } = await env.CONNECT_LIMIT.limit({ key: `reg:${request.headers.get("cf-connecting-ip") || "x"}` }); if (!success) return oauthError("slow_down", "too many registrations", 429); }
  let body; try { body = await request.json(); } catch { return oauthError("invalid_client_metadata", "body must be JSON"); }
  const uris = body && body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every(okRedirect)) return oauthError("invalid_redirect_uri", "redirect_uris must be 1 to 5 https URLs (or http on localhost)");
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") return oauthError("invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported");
  const name = String(body.client_name || "MCP client").replace(/[\u0000-\u001f]/g, "").slice(0, 60);
  const id = rand(18);
  await env.DB.prepare("INSERT INTO clients (id, name, redirects, created) VALUES (?, ?, ?, ?)").bind(id, name, JSON.stringify(uris), now()).run();
  return json({ client_id: id, client_id_issued_at: now(), client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
}

function page(title, body, extraFormAction = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/consent.css"></head><body><main class="cs">${body}</main></body></html>`;
}
function pageHeaders(formTo = "") {
  return { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin", "content-security-policy": `default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'${formTo ? ` ${formTo}` : ""}; frame-ancestors 'none'; base-uri 'none'` };
}
const CONSENT_CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b11;color:#e6ebf2;font:15px/1.6 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;padding:16px}.cs{width:100%;max-width:460px;padding:28px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:#0d1520}.tag{margin:0 0 10px;font:11.5px "Cascadia Mono",ui-monospace,Consolas,monospace;letter-spacing:.12em;color:#ffc94a}h1{margin:0 0 12px;font-size:24px;line-height:1.2;color:#fff}p{margin:0 0 14px;color:#b4bdc9}ul{margin:0 0 18px;padding-left:18px;color:#b4bdc9}li{margin:4px 0}.host{font-family:"Cascadia Mono",ui-monospace,Consolas,monospace;color:#fff}.warn{padding:10px 12px;border:1px solid rgba(255,122,110,.5);border-radius:8px;color:#ff7a6e}.row{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;font-size:14px;font-weight:500;padding:11px 18px;border-radius:6px;cursor:pointer;border:1px solid rgba(255,255,255,.16);background:transparent;color:#fff}button.go{background:#fff;color:#070b11;border-color:#fff}button:focus-visible{outline:2px solid #3ad0ff;outline-offset:2px}`;

async function authorizeGet(url, env, request) {
  const q = url.searchParams;
  if (q.get("response_type") !== "code") return oauthError("unsupported_response_type", "response_type must be code");
  const client = await env.DB.prepare("SELECT id, name, redirects FROM clients WHERE id = ?").bind(q.get("client_id") || "").first();
  if (!client) return oauthError("invalid_client", "unknown client_id");
  const redirect = q.get("redirect_uri") || "";
  if (!JSON.parse(client.redirects).includes(redirect)) return oauthError("invalid_request", "redirect_uri is not registered for this client");
  const challenge = q.get("code_challenge") || "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || q.get("code_challenge_method") !== "S256") return oauthError("invalid_request", "PKCE with S256 is required");
  const id = rand(24), state = (q.get("state") || "").slice(0, 500);
  await env.DB.prepare("INSERT INTO pending (id, data, expires) VALUES (?, ?, ?)").bind(id, JSON.stringify({ client: client.id, redirect, challenge, state }), now() + 600).run();
  const host = new URL(redirect).hostname;
  const trusted = TRUSTED_HOSTS.includes(host);
  const known = !!(await accountFromCookie(request, env));
  const body = `<p class="tag">DOKO BY OPEQ</p><h1>Connect DOKO to ${esc(client.name)}?</h1>
<p>It will be able to create trading agents for you, test them on real SOL prices and run them with paper money.</p>
<ul><li>No wallet access and no real funds.</li><li>Your agents are kept on DOKO and you can see them at opeq.io.</li><li>${known ? "This adds the connection to the DOKO account already used in this browser." : "This creates a DOKO account tied to this browser."}</li></ul>
<p>After you allow it, you go back to <span class="host">${esc(host)}</span>.</p>
${trusted ? "" : `<p class="warn">That is not a Claude address. Only allow this if you started the connection yourself.</p>`}
<form method="post" action="/oauth/authorize"><input type="hidden" name="pending" value="${esc(id)}"><div class="row"><button class="go" name="decision" value="allow" type="submit">Allow</button><button name="decision" value="deny" type="submit">Cancel</button></div></form>`;
  return new Response(page("Connect DOKO", body), { headers: pageHeaders(new URL(redirect).origin) });
}

async function authorizePost(request, env, base) {
  const origin = request.headers.get("origin"), fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== new URL(base).origin && !((origin === null || origin === "null") && fetchSite === "same-origin")) return oauthError("invalid_request", "cross-site request refused", 403);
  const form = await request.formData();
  const pid = String(form.get("pending") || "");
  const row = await env.DB.prepare("SELECT data, expires FROM pending WHERE id = ?").bind(pid).first();
  if (!row) return oauthError("invalid_request", "this sign-in link expired, start again from Claude");
  await env.DB.prepare("DELETE FROM pending WHERE id = ?").bind(pid).run();
  if (row.expires < now()) return oauthError("invalid_request", "this sign-in link expired, start again from Claude");
  const p = JSON.parse(row.data);
  const back = new URL(p.redirect);
  if (p.state) back.searchParams.set("state", p.state);
  back.searchParams.set("iss", base);
  if (form.get("decision") !== "allow") { back.searchParams.set("error", "access_denied"); return new Response(null, { status: 302, headers: { location: back.toString(), "cache-control": "no-store" } }); }
  const headers = { "cache-control": "no-store" };
  let account = await accountFromCookie(request, env);
  if (!account) {
    if (env.CONNECT_LIMIT) { const { success } = await env.CONNECT_LIMIT.limit({ key: `acct:${request.headers.get("cf-connecting-ip") || "x"}` }); if (!success) return oauthError("slow_down", "too many new accounts from this network, try again in a minute", 429); }
    account = hexId();
    const secret = rand(32);
    await env.DB.prepare("INSERT INTO accounts (id, secret, created) VALUES (?, ?, ?)").bind(account, await sha(secret), now()).run();
    headers["set-cookie"] = cookieFor(account, secret, base.startsWith("https:"));
  }
  const code = rand(32);
  await env.DB.prepare("INSERT INTO codes (hash, client, account, redirect, challenge, expires) VALUES (?, ?, ?, ?, ?, ?)").bind(await sha(code), p.client, account, p.redirect, p.challenge, now() + 300).run();
  back.searchParams.set("code", code);
  headers.location = back.toString();
  return new Response(null, { status: 302, headers });
}

async function issue(env, client, account) {
  const access = rand(32), refresh = rand(32);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tokens (hash, kind, client, account, expires) VALUES (?, 'access', ?, ?, ?)").bind(await sha(access), client, account, now() + ACCESS_TTL),
    env.DB.prepare("INSERT INTO tokens (hash, kind, client, account, expires) VALUES (?, 'refresh', ?, ?, ?)").bind(await sha(refresh), client, account, now() + REFRESH_TTL),
  ]);
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: "doko" });
}
async function readForm(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) { try { return await request.json(); } catch { return {}; } }
  const f = await request.formData();
  return Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));
}
async function token(request, env) {
  const f = await readForm(request);
  if (f.grant_type === "authorization_code") {
    const h = await sha(String(f.code || ""));
    const row = await env.DB.prepare("SELECT client, account, redirect, challenge, expires FROM codes WHERE hash = ?").bind(h).first();
    if (!row) return oauthError("invalid_grant", "unknown or used code");
    await env.DB.prepare("DELETE FROM codes WHERE hash = ?").bind(h).run();
    if (row.expires < now()) return oauthError("invalid_grant", "code expired");
    if (row.client !== f.client_id) return oauthError("invalid_grant", "code was issued to another client");
    if (row.redirect !== f.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(String(f.code_verifier || "")) || (await sha(f.code_verifier)) !== row.challenge) return oauthError("invalid_grant", "PKCE check failed");
    return issue(env, row.client, row.account);
  }
  if (f.grant_type === "refresh_token") {
    const h = await sha(String(f.refresh_token || ""));
    const row = await env.DB.prepare("SELECT client, account, expires FROM tokens WHERE hash = ? AND kind = 'refresh'").bind(h).first();
    if (!row || row.expires < now()) return oauthError("invalid_grant", "refresh token expired or unknown");
    if (f.client_id && f.client_id !== row.client) return oauthError("invalid_grant", "refresh token was issued to another client");
    await env.DB.prepare("DELETE FROM tokens WHERE hash = ?").bind(h).run();
    return issue(env, row.client, row.account);
  }
  return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}
async function revoke(request, env) {
  const f = await readForm(request);
  if (f.token) await env.DB.prepare("DELETE FROM tokens WHERE hash = ?").bind(await sha(String(f.token))).run();
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

class ToolError extends Error {}
const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const AGENT = { type: "string", description: "Agent id from list_agents" };
const RULE = { type: "object", description: "A DOKO rule object, see rule_format" };
const CANDLES = { type: "integer", minimum: 300, maximum: 20000, description: "How many candles of history to test on (default 3000). Up to 5000 come from Hyperliquid (1h about 7 months, 4h about 2 years, 1d back to 2020). From 5001 to 20000, on 1h or longer timeframes, the whole test uses Coinbase hourly candles that DOKO stores (SOL, BTC and ETH from June 2021), with longer timeframes built from them; other coins in the rule must then be BTC or ETH." };

const TOOLS = [
  { name: "rule_format", description: "How to write a DOKO rule, with every indicator and its settings. Call this once before writing or changing a rule.", inputSchema: S({}), annotations: { readOnlyHint: true } },
  { name: "list_agents", description: "The user's agents with status, paper balance, win rate and last backtest.", inputSchema: S({}), annotations: { readOnlyHint: true } },
  { name: "get_agent", description: "One agent in full: its rules in plain words, versions, paper trading results and recent trades.", inputSchema: S({ agent_id: AGENT }, ["agent_id"]), annotations: { readOnlyHint: true } },
  { name: "market", description: "Current price of a coin's perpetual and a few readings (24h change, RSI, trend, funding) to talk about the market.", inputSchema: S({ coin: { type: "string", description: "Ticker such as SOL, BTC, ETH (default SOL)" } }), annotations: { readOnlyHint: true } },
  { name: "backtest", description: "Test a rule (or an agent's current rule) on real past perpetual prices with 1,000 paper dollars, with fees, slippage, hourly funding and liquidations. Returns the result, monthly returns and liquidations next to simply holding the coins. Past results are no promise.", inputSchema: S({ agent_id: AGENT, rule: RULE, candles: CANDLES }), annotations: { readOnlyHint: true } },
  { name: "search_settings", description: "Try up to 400 combinations of the rule's numbers on the first 65% of the history and check the best five on the last 35% it never saw. Use it to show whether a rule only fits the past.", inputSchema: S({ agent_id: AGENT, rule: RULE, candles: CANDLES }), annotations: { readOnlyHint: true } },
  { name: "discover_strategies", description: "Search for new strategies by generating many random rules (2 to 4 conditions from all indicators, other coins as filters, random stops and take profits) and testing them: each is scored on the first 65% of the history, the best 20 are checked on the last 35% it never saw, and only rules that made money in both parts come back. Call it again with another seed to search a new batch. With thousands of tries some winners are luck, so treat survivors as candidates for paper trading, not proof.", inputSchema: S({ coins: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, description: "Coins to trade, default [\"SOL\"]" }, timeframe: { type: "string", enum: Object.keys(TIMEFRAMES) }, leverage: { type: "integer", minimum: 1, maximum: 125 }, marginUsd: { type: "number", minimum: 1, maximum: 1000 }, sides: { type: "string", enum: ["long", "short", "both"] }, watch: { type: "array", items: { type: "string" }, maxItems: 3, description: "Other coins the rules may use as filters, default [\"BTC\", \"ETH\"]" }, candles: CANDLES, tries: { type: "integer", minimum: 100, maximum: 2000, description: "How many random rules to test (default 1000)" }, seed: { type: "integer", minimum: 1, description: "Batch number; a new seed gives new rules" } }, ["timeframe", "leverage"]), annotations: { readOnlyHint: true } },
  { name: "propose_agent", description: "Check a rule for a new agent and get a summary to show the user. Nothing is created until the user agrees and you call apply_proposal.", inputSchema: S({ rule: RULE }, ["rule"]) },
  { name: "propose_change", description: "Check a new version of an agent's rule and get a summary to show the user. Nothing changes until the user agrees and you call apply_proposal.", inputSchema: S({ agent_id: AGENT, rule: RULE }, ["agent_id", "rule"]) },
  { name: "apply_proposal", description: "Create the agent or save the new version from a proposal. Only call this after the user said yes to that exact proposal. A new version restarts paper trading from 1,000 dollars.", inputSchema: S({ proposal_id: { type: "string" } }, ["proposal_id"]) },
  { name: "start_trading", description: "Start paper trading for an agent. It runs every minute on our side and acts on closed candles, even when the user is away.", inputSchema: S({ agent_id: AGENT }, ["agent_id"]) },
  { name: "pause_trading", description: "Pause paper trading for an agent. Open positions are closed at the current price when it pauses.", inputSchema: S({ agent_id: AGENT }, ["agent_id"]) },
  { name: "reset_paper", description: "Reset an agent's paper money to 1,000 dollars and clear its trades. Ask the user first.", inputSchema: S({ agent_id: AGENT }, ["agent_id"]), annotations: { destructiveHint: true } },
  { name: "revert_version", description: "Go back to an earlier version of an agent's rule. Paper trading restarts from 1,000 dollars. Ask the user first.", inputSchema: S({ agent_id: AGENT, version: { type: "integer", minimum: 1 } }, ["agent_id", "version"]), annotations: { destructiveHint: true } },
  { name: "rename_agent", description: "Rename an agent.", inputSchema: S({ agent_id: AGENT, name: { type: "string", minLength: 1, maxLength: 60 } }, ["agent_id", "name"]) },
  { name: "delete_agent", description: "Delete an agent for good. Ask the user first, then pass the agent's exact name as confirm_name.", inputSchema: S({ agent_id: AGENT, confirm_name: { type: "string" } }, ["agent_id", "confirm_name"]), annotations: { destructiveHint: true } },
  { name: "dashboard", description: "Where the user can see their agents as cards with charts.", inputSchema: S({}), annotations: { readOnlyHint: true } },
];

async function loadAgent(env, account, id) {
  const row = await env.DB.prepare("SELECT id, name, running, data, ver FROM agents_v2 WHERE id = ? AND account = ?").bind(String(id || ""), account).first();
  if (!row) throw new ToolError("No agent with that id. Call list_agents to see the user's agents.");
  return row;
}
async function saveAgent(env, row, d, extra = {}) {
  const name = extra.name !== undefined ? extra.name : row.name;
  const running = extra.running !== undefined ? (extra.running ? 1 : 0) : row.running;
  const r = await env.DB.prepare("UPDATE agents_v2 SET name = ?, running = ?, data = ?, updated = ?, ver = ver + 1 WHERE id = ? AND ver = ?").bind(name, running, JSON.stringify(d), now(), row.id, row.ver).run();
  if (!r.meta || r.meta.changes !== 1) throw new ToolError("The agent changed at the same moment (a trade just happened). Call the tool again.");
  await poke(env);
}
async function poke(env) {
  if (!env.WATCHER) return;
  try { await env.WATCHER.get(env.WATCHER.idFromName("main")).fetch("https://watcher/refresh"); } catch {}
}
function checkRule(rule) {
  if (!rule || typeof rule !== "object") throw new ToolError("Pass the rule as an object. Call rule_format to see the format.");
  try { validateRule(rule); } catch (x) { throw new ToolError(`The rule does not pass the checks: ${x.message}. Fix it and try again.`); }
  const used = JSON.stringify([rule.long || null, rule.short || null]);
  for (const n of UNAVAILABLE) if (used.includes(`"ind":"${n}"`)) throw new ToolError(`The ${n} indicator is not available in DOKO yet. Use a different volume indicator.`);
  return rule;
}
async function ruleFor(env, account, args) {
  if (args.rule) return { rule: checkRule(args.rule), row: null };
  if (!args.agent_id) throw new ToolError("Pass agent_id or rule.");
  const row = await loadAgent(env, account, args.agent_id);
  const rule = ruleOf(JSON.parse(row.data));
  if (!rule) throw new ToolError("This agent has no rules yet.");
  return { rule, row };
}
const finiteNum = (v, d) => (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 100000 ? v : d);
const candlesArg = (v) => Math.max(300, Math.min(20000, Number.isInteger(v) ? v : 3000));

async function callTool(name, args, env, account, base) {
  args = args && typeof args === "object" ? args : {};
  if (name === "rule_format") return RULE_FORMAT;
  if (name === "list_agents") {
    const { results } = await env.DB.prepare("SELECT id, name, running, data FROM agents_v2 WHERE account = ? ORDER BY created").bind(account).all();
    return { agents: results.map(summary), limits: { maxAgents: MAX_AGENTS, maxTradingAtOnce: MAX_RUNNING }, dashboard: `${env.SITE_PAGE || "https://opeq.io/doko"}` };
  }
  if (name === "get_agent") return detail(await loadAgent(env, account, args.agent_id));
  if (name === "market") {
    const coin = typeof args.coin === "string" && /^k?[A-Z0-9]{2,12}$/.test(args.coin) ? args.coin : "SOL";
    let C1, C4;
    try { [C1, C4] = await Promise.all([loadCandles(coin, "1h", 300, spotFetch), loadCandles(coin, "4h", 300, spotFetch)]); } catch (x) { throw new ToolError(`No Hyperliquid market for ${coin}.`); }
    await hl.withMarketData(C1, coin, "1h", { funding: true }, spotFetch).catch(() => null);
    const last = C1[C1.length - 1], day = C1[C1.length - 25];
    const rsi = series(C1, { ind: "rsi", period: 14 }, "1h"), st = series(C4, { ind: "supertrend", out: "dir" }, "4h");
    return { coin, price: last.c, at: when(last.t), change24hPct: +((last.c / day.c - 1) * 100).toFixed(2), rsi14_1h: +rsi[rsi.length - 1].toFixed(1), supertrend_4h: st[st.length - 1] > 0 ? "up" : "down", fundingPer8hPct: Number.isFinite(last.fr) ? +last.fr.toFixed(4) : null };
  }
  if (name === "backtest") {
    const { rule, row } = await ruleFor(env, account, args);
    const w = warmup(rule), data = await loadAll(env, rule, candlesArg(args.candles) + w), main = data[rule.coins[0]];
    const from = Math.min(w, main.length - 10);
    const r = backtest(rule, data, START, from);
    const closes = r.log.filter((e) => e.kind === "close");
    const out = {
      rule: rule.name, coins: rule.coins, leverage: rule.leverage, period: `${when(main[from].t).slice(0, 10)} to ${when(main[main.length - 1].t).slice(0, 10)}`, candles: main.length - from,
      agentPct: +r.returnPct.toFixed(2), holdingPct: Object.fromEntries(Object.entries(r.holdByCoin).map(([k, v]) => [k, Number.isFinite(v) ? +v.toFixed(2) : null])),
      trades: r.trades, wins: r.wins, longs: r.longs, shorts: r.shorts, liquidations: r.liquidations, worstDropPct: +r.maxDrawdownPct.toFixed(2), endBalance: +r.equity.toFixed(2),
      feesPaid: +r.fees.toFixed(2), fundingNet: +r.funding.toFixed(2),
      months: r.months.slice(-24).map((m) => `${m.month} ${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(1)}%`), monthsUp: `${r.monthsUp} of ${r.months.length}`,
      lastTrades: closes.slice(-10).map((e) => `${when(e.t)} ${describeEvent(e)}`), openNow: r.open, equity: sample(r.curve.map((q) => +q.equity.toFixed(2)), 30),
    };
    if (row && !args.rule) { const d = JSON.parse(row.data); d.bt = { returnPct: out.agentPct, holdPct: out.holdingPct, trades: r.trades, wins: r.wins, liquidations: r.liquidations, maxDrawdownPct: out.worstDropPct, period: out.period, at: new Date().toISOString() }; try { await saveAgent(env, row, d); } catch {} }
    if (marketNeeds(rule).funding) out.note = "This rule reads funding, whose history starts in May 2023, so earlier candles have no value there.";
    return out;
  }
  if (name === "search_settings") {
    const { rule } = await ruleFor(env, account, args);
    const data = await loadAll(env, rule, candlesArg(args.candles) + warmup(rule));
    const r = optimize(rule, data);
    return {
      tried: r.runs, knobs: r.knobs.map((k) => k.label), splitPct: Math.round(r.split * 100),
      current: { searchPartPct: +r.current.train.returnPct.toFixed(2), checkPartPct: +r.current.test.returnPct.toFixed(2), checkLiquidations: r.current.test.liquidations },
      best: r.best.map((b) => ({ settings: Object.fromEntries(b.vals.map((v, i) => [r.knobs[i].label, v])), searchPartPct: +b.train.returnPct.toFixed(2), searchTrades: b.train.trades, checkPartPct: +b.test.returnPct.toFixed(2), checkTrades: b.test.trades, checkLiquidations: b.test.liquidations, rule: b.rule })),
      howToRead: "A setting that wins the search part but loses the check part only fits the past. To use one, pass its rule to propose_change.",
    };
  }
  if (name === "discover_strategies") {
    const coins = Array.isArray(args.coins) && args.coins.length ? args.coins : ["SOL"];
    const watch = (Array.isArray(args.watch) ? args.watch : ["BTC", "ETH"]).filter((a) => typeof a === "string" && /^k?[A-Z0-9]{2,12}$/.test(a) && !coins.includes(a)).slice(0, 3);
    if (!coins.every((c) => typeof c === "string" && /^k?[A-Z0-9]{2,12}$/.test(c)) || new Set(coins).size !== coins.length || coins.length > MAX_COINS) throw new ToolError(`coins must be 1 to ${MAX_COINS} different tickers.`);
    if (!TIMEFRAMES[args.timeframe]) throw new ToolError(`timeframe must be one of ${Object.keys(TIMEFRAMES).join(", ")}.`);
    if (!Number.isInteger(args.leverage) || args.leverage < 1 || args.leverage > MAX_LEVERAGE) throw new ToolError(`leverage must be a whole number from 1 to ${MAX_LEVERAGE}.`);
    const probe = { name: "probe", coins, timeframe: args.timeframe, leverage: args.leverage, marginUsd: 100, long: { entry: { all: [{ left: { ind: "price" }, op: ">", right: 0 }, ...watch.map((a) => ({ left: { ind: "price", asset: a }, op: ">", right: 0 }))] } }, stopLossPct: 1 };
    const n = Number.isInteger(args.candles) ? candlesArg(args.candles) : 5000;
    const data = await loadAll(env, probe, n);
    const seed = Number.isInteger(args.seed) && args.seed > 0 ? args.seed : 1 + Math.floor(Math.random() * 1e6);
    let r;
    try { r = discover(data, { coins, timeframe: args.timeframe, leverage: args.leverage, marginUsd: finiteNum(args.marginUsd, 100), sides: ["long", "short", "both"].includes(args.sides) ? args.sides : "both", tries: Math.max(100, Math.min(2000, Number.isInteger(args.tries) ? args.tries : 1000)), seed, watch, unavailable: UNAVAILABLE }); }
    catch (x) { throw new ToolError(`The search could not run: ${x.message}.`); }
    return {
      ...r,
      survivors: r.survivors.map((x) => ({ ...x, rules: Object.fromEntries(explain(x.rule)) })),
      howToRead: `Tried ${r.built} random rules, ${r.enoughTrades} made at least 10 trades in the search part, the best ${r.testedOnCheck} were checked on the part they never saw, and ${r.survivorsCount} made money in both. Many tries mean some survivors are luck: prefer ones with many trades in both parts and few liquidations, then run search_settings on a survivor or watch it with paper money. To use one, pass its rule (rename it first) to propose_agent.`,
    };
  }
  if (name === "propose_agent" || name === "propose_change") {
    const rule = checkRule(args.rule);
    let agent = null;
    if (name === "propose_change") agent = (await loadAgent(env, account, args.agent_id)).id;
    else { const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents_v2 WHERE account = ?").bind(account).first(); if (c.n >= MAX_AGENTS) throw new ToolError(`The user already has ${MAX_AGENTS} agents, the most allowed. Delete one first.`); }
    const id = `p_${rand(9)}`;
    await env.DB.prepare("INSERT INTO proposals (id, account, agent, rule, expires) VALUES (?, ?, ?, ?, ?)").bind(id, account, agent, JSON.stringify(rule), now() + 3600).run();
    return { proposal_id: id, kind: agent ? "new version" : "new agent", name: rule.name, rules: Object.fromEntries(explain(rule)), next: "Show these rules to the user in plain words and ask if they want it. Call apply_proposal only after they say yes. The proposal expires in an hour." };
  }
  if (name === "apply_proposal") {
    const p = await env.DB.prepare("SELECT agent, rule, expires FROM proposals WHERE id = ? AND account = ?").bind(String(args.proposal_id || ""), account).first();
    if (!p || p.expires < now()) throw new ToolError("No such proposal, or it expired. Propose again.");
    await env.DB.prepare("DELETE FROM proposals WHERE id = ?").bind(String(args.proposal_id)).run();
    const rule = checkRule(JSON.parse(p.rule));
    if (!p.agent) {
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents_v2 WHERE account = ?").bind(account).first();
      if (c.n >= MAX_AGENTS) throw new ToolError(`The user already has ${MAX_AGENTS} agents.`);
      const id = hexId(), d = { versions: [{ rule, at: Date.now() }], cur: 0, paper: freshPaper(rule), bt: null };
      await env.DB.prepare("INSERT INTO agents_v2 (id, account, name, running, data, created, updated) VALUES (?, ?, ?, 0, ?, ?, ?)").bind(id, account, rule.name.slice(0, 60), JSON.stringify(d), now(), now()).run();
      return { created: id, name: rule.name, next: "Offer a backtest, then start_trading when the user wants it to run." };
    }
    const row = await loadAgent(env, account, p.agent), d = JSON.parse(row.data);
    d.versions.push({ rule, at: Date.now() }); d.versions = d.versions.slice(-20); d.cur = d.versions.length - 1;
    d.paper = freshPaper(rule); d.bt = null;
    if (row.running) plog(d.paper, `Switched to version ${d.cur + 1} and started again from 1,000 dollars.`);
    await saveAgent(env, row, d);
    return { updated: row.id, version: d.cur + 1, trading: !!row.running, note: "Paper trading restarted from 1,000 dollars with the new version." };
  }
  if (name === "start_trading") {
    const row = await loadAgent(env, account, args.agent_id), d = JSON.parse(row.data);
    if (!ruleOf(d)) throw new ToolError("This agent has no rules yet.");
    if (row.running) return { trading: true, note: "Already trading." };
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents_v2 WHERE account = ? AND running = 1").bind(account).first();
    if (c.n >= MAX_RUNNING) throw new ToolError(`At most ${MAX_RUNNING} agents can trade at once. Pause one first.`);
    if (!d.paper || !d.paper.pos || Array.isArray(d.paper.pos) || ruleOf(d).coins.some((c) => !(c in d.paper.pos))) d.paper = freshPaper(ruleOf(d));
    await saveAgent(env, row, d, { running: true });
    return { trading: true, note: `It waits for the next ${ruleOf(d).timeframe} candle to close, then acts on every closed candle.` };
  }
  if (name === "pause_trading") {
    const row = await loadAgent(env, account, args.agent_id), d = JSON.parse(row.data), rule = ruleOf(d);
    const p = d.paper;
    if (p && p.pos && rule) {
      const open = Object.entries(p.pos).filter(([, x]) => x);
      if (open.length) {
        const data = await loadAll(env, rule, warmup(rule) + 5).catch(() => null);
        for (const [coin] of open) {
          const C = data && data[coin], px = C && C[C.length - 1].c;
          if (!Number.isFinite(px)) continue;
          const box = { cash: p.cash, pos: p.pos[coin] };
          const ev = closePositionNow(box, px, "paused");
          p.cash = box.cash; p.pos[coin] = null; ev.coin = coin; record(p, ev);
        }
        p.equity = p.cash + Object.values(p.pos).reduce((a, x) => a + (x ? x.margin : 0), 0);
      }
    }
    if (p && row.running) plog(p, "Paused.");
    if (p) p.lastT = null;
    await saveAgent(env, row, d, { running: false });
    return { trading: false };
  }
  if (name === "reset_paper") {
    const row = await loadAgent(env, account, args.agent_id), d = JSON.parse(row.data);
    d.paper = freshPaper(ruleOf(d) || { coins: [] });
    await saveAgent(env, row, d);
    return { reset: true, balance: START };
  }
  if (name === "revert_version") {
    const row = await loadAgent(env, account, args.agent_id), d = JSON.parse(row.data);
    const i = Number(args.version) - 1;
    if (!Number.isInteger(i) || !d.versions[i]) throw new ToolError(`This agent has versions 1 to ${d.versions.length}.`);
    d.cur = i; d.paper = freshPaper(d.versions[i].rule); d.bt = null;
    await saveAgent(env, row, d);
    return { version: i + 1, name: d.versions[i].rule.name };
  }
  if (name === "rename_agent") {
    const row = await loadAgent(env, account, args.agent_id);
    const nm = String(args.name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
    if (!nm) throw new ToolError("The name cannot be empty.");
    await saveAgent(env, row, JSON.parse(row.data), { name: nm });
    return { renamed: nm };
  }
  if (name === "delete_agent") {
    const row = await loadAgent(env, account, args.agent_id);
    if (args.confirm_name !== row.name) throw new ToolError(`confirm_name must be exactly "${row.name}".`);
    await env.DB.prepare("DELETE FROM agents_v2 WHERE id = ? AND account = ?").bind(row.id, account).run();
    await poke(env);
    return { deleted: row.id };
  }
  if (name === "dashboard") return { url: env.SITE_PAGE || "https://opeq.io/doko", note: "It shows the agents in the browser the user connected DOKO from." };
  throw new ToolError(`Unknown tool ${name}`);
}

async function mcp(request, env, base) {
  const auth = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(request.headers.get("authorization") || "");
  let account = null;
  if (auth) {
    const row = await env.DB.prepare("SELECT account, expires FROM tokens WHERE hash = ? AND kind = 'access'").bind(await sha(auth[1])).first();
    if (row && row.expires >= now()) account = row.account;
  }
  if (!account) return json({ error: "invalid_token" }, 401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  let msg; try { msg = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const batch = Array.isArray(msg), list = batch ? msg : [msg];
  const out = [];
  for (const m of list) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { out.push({ jsonrpc: "2.0", id: m && m.id !== undefined ? m.id : null, error: { code: -32600, message: "Invalid request" } }); continue; }
    if (m.id === undefined) continue;
    const reply = (result) => out.push({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") {
      const asked = m.params && m.params.protocolVersion;
      reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "doko", title: "DOKO by OPEQ", version: "1.0.0" }, instructions: INSTRUCTIONS });
    } else if (m.method === "ping") reply({});
    else if (m.method === "tools/list") reply({ tools: TOOLS });
    else if (m.method === "tools/call") {
      const name = m.params && m.params.name;
      if (!TOOLS.some((t) => t.name === name)) { out.push({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } }); continue; }
      if (env.TOOL_LIMIT) { const { success } = await env.TOOL_LIMIT.limit({ key: account }); if (!success) { reply({ content: [{ type: "text", text: "Too many DOKO calls in a minute. Wait a moment and try again." }], isError: true }); continue; } }
      try {
        const r = await callTool(name, m.params.arguments, env, account, base);
        reply(typeof r === "string" ? { content: [{ type: "text", text: r }] } : { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], structuredContent: r });
      } catch (x) {
        reply({ content: [{ type: "text", text: x instanceof ToolError ? x.message : `DOKO could not finish this: ${x && x.message ? x.message : "unknown error"}` }], isError: true });
      }
    } else out.push({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(batch ? out : out[0]);
}

async function siteApi(request, env, path) {
  const cors = siteCors(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
  const h = cors || {};
  const account = await accountFromCookie(request, env);
  if (path === "/api/me") {
    if (!account) return json({ connected: false }, 200, h);
    const { results } = await env.DB.prepare("SELECT id, name, running, data FROM agents_v2 WHERE account = ? ORDER BY created").bind(account).all();
    return json({ connected: true, agents: results.map((r) => ({ ...summary(r), spark: sample((JSON.parse(r.data).paper || { curve: [] }).curve.map((q) => q.e), 60) })) }, 200, h);
  }
  if (path === "/api/agent") {
    if (!account) return json({ error: "not connected" }, 401, h);
    const row = await env.DB.prepare("SELECT id, name, running, data FROM agents_v2 WHERE id = ? AND account = ?").bind(new URL(request.url).searchParams.get("id") || "", account).first();
    if (!row) return json({ error: "not found" }, 404, h);
    return json(detail(row), 200, h);
  }
  if (path === "/api/disconnect" && request.method === "POST") {
    if (!cors) return json({ error: "forbidden" }, 403);
    const res = json({ ok: true }, 200, h);
    res.headers.append("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`);
    return res;
  }
  return json({ error: "not found" }, 404, h);
}

export async function tickAll(env) {
  const { results } = await env.DB.prepare("SELECT id, name, running, data, ver FROM agents_v2 WHERE running = 1 LIMIT 500").all();
  let written = 0;
  for (const row of results) {
    const d = JSON.parse(row.data), rule = ruleOf(d);
    if (!rule) continue;
    if (!d.paper || !d.paper.pos || Array.isArray(d.paper.pos)) d.paper = freshPaper(rule);
    const p = d.paper;
    let changed = false;
    try {
      const data = await loadAll(env, rule, warmup(rule) + 5), main = data[rule.coins[0]];
      if (!main.length) continue;
      const gets = cachesFor(rule, data), lastI = main.length - 1;
      if (p.lastT == null) { p.lastT = main[lastI].t; plog(p, `Started. Waiting for the next ${rule.timeframe} candle to close.`); changed = true; }
      for (let i = 1; i < main.length; i++) {
        if (main[i].t <= p.lastT) continue;
        const r = step(rule, { cash: p.cash, pos: p.pos, trades: p.trades, day: p.day }, data, i, gets);
        Object.assign(p, { cash: r.state.cash, pos: r.state.pos, trades: r.state.trades, day: r.state.day, lastT: main[i].t });
        for (const e of r.events) record(p, e);
        p.curve = [...(p.curve || []), { t: main[i].t * 1000, e: +equityOf(p, pricesAt(rule, data, i)).toFixed(2) }].slice(-720);
        changed = true;
      }
      const eq = equityOf(p, pricesAt(rule, data, lastI));
      if (changed || Math.abs(eq - p.equity) > 0.005) { p.equity = eq; p.checked = Date.now(); delete p.lastErr; changed = true; }
    } catch (x) {
      if (!p.lastErr || Date.now() - p.lastErr > 3600000) { plog(p, `Could not load prices: ${x.message}`); p.lastErr = Date.now(); changed = true; }
    }
    if (!changed) continue;
    const res = await env.DB.prepare("UPDATE agents_v2 SET data = ?, updated = ?, ver = ver + 1 WHERE id = ? AND ver = ? AND running = 1").bind(JSON.stringify(d), now(), row.id, row.ver).run();
    if (res.meta && res.meta.changes === 1) written++;
  }
  return { running: results.length, written };
}

export function closePositionNow(box, price, why) {
  const x = box.pos, adj = price * (1 - (x.side * SLIP_PCT) / 100), fee = (x.qty * adj * FEE_PCT) / 100;
  let pnl = x.side * x.qty * (adj - x.entry) - fee;
  const liquidated = pnl <= -x.margin;
  if (liquidated) pnl = -x.margin;
  box.cash += x.margin + pnl; box.pos = null;
  return { t: now(), kind: "close", side: x.side > 0 ? "long" : "short", price: adj, why: liquidated ? "liquidated" : why, pnl: pnl - x.openFee + x.funding, fees: fee + x.openFee, funding: x.funding, liquidated };
}

export class Watcher {
  constructor(state, env) { this.state = state; this.env = env; this.ws = null; this.subscribed = new Set(); this.watch = new Map(); this.busy = new Set(); this.lastMsg = 0; this.lastPing = 0; this.connecting = null; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/tick") { const r = await tickAll(this.env); await this.reload(); return json(r); }
    if (path === "/refresh") { await this.reload(); return json({ ok: true }); }
    if (path === "/status") { await this.reload(); return json({ connected: !!this.ws, coins: [...this.subscribed], positions: this.watch.size, lastMessageAgoMs: this.lastMsg ? Date.now() - this.lastMsg : null }); }
    return json({ error: "not found" }, 404);
  }
  async alarm() { await this.reload(); }
  async reload() {
    const { results } = await this.env.DB.prepare("SELECT id, data FROM agents_v2 WHERE running = 1").all();
    const watch = new Map();
    for (const row of results) {
      const d = JSON.parse(row.data), rule = ruleOf(d), p = d.paper;
      if (!rule || !p || !p.pos || Array.isArray(p.pos)) continue;
      for (const [coin, x] of Object.entries(p.pos)) if (x) { const L = levels(rule, x); watch.set(`${row.id}|${coin}`, { id: row.id, coin, side: x.side, t: x.t, adverse: L.adverse, take: L.take }); }
    }
    this.watch = watch;
    const coins = new Set([...watch.values()].map((w) => w.coin));
    if (coins.size) await this.ensureSocket();
    if (this.ws) {
      for (const c of coins) if (!this.subscribed.has(c)) { this.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "bbo", coin: c } })); this.subscribed.add(c); }
      for (const c of [...this.subscribed]) if (!coins.has(c)) { this.ws.send(JSON.stringify({ method: "unsubscribe", subscription: { type: "bbo", coin: c } })); this.subscribed.delete(c); }
      if (Date.now() - this.lastPing > 30000) { this.ws.send(JSON.stringify({ method: "ping" })); this.lastPing = Date.now(); }
      if (!coins.size) { try { this.ws.close(1000, "idle"); } catch {} this.ws = null; this.subscribed = new Set(); }
    }
    if (coins.size) await this.state.storage.setAlarm(Date.now() + 30000);
  }
  async ensureSocket() {
    if (this.ws && Date.now() - this.lastMsg < 90000) return;
    if (this.ws) { try { this.ws.close(1000, "stale"); } catch {} this.ws = null; }
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const resp = await fetch("https://api.hyperliquid.xyz/ws", { headers: { Upgrade: "websocket" } });
        const ws = resp.webSocket;
        if (!ws) return;
        ws.accept();
        ws.addEventListener("message", (e) => this.onMessage(e.data));
        ws.addEventListener("close", () => { if (this.ws === ws) { this.ws = null; this.subscribed = new Set(); } });
        ws.addEventListener("error", () => { if (this.ws === ws) { this.ws = null; this.subscribed = new Set(); } });
        this.ws = ws; this.subscribed = new Set(); this.lastMsg = Date.now();
      } finally { this.connecting = null; }
    })();
    return this.connecting;
  }
  onMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    this.lastMsg = Date.now();
    if (m.channel !== "bbo" || !m.data || !Array.isArray(m.data.bbo)) return;
    const coin = m.data.coin, bid = Number(m.data.bbo[0] && m.data.bbo[0].px), ask = Number(m.data.bbo[1] && m.data.bbo[1].px);
    for (const [key, w] of this.watch) {
      if (w.coin !== coin || this.busy.has(key)) continue;
      const px = w.side > 0 ? bid : ask;
      if (!Number.isFinite(px)) continue;
      if (w.side * (px - w.adverse) <= 0 || w.side * (px - w.take) >= 0) { this.busy.add(key); this.state.waitUntil ? this.state.waitUntil(this.closeLive(key, w, px)) : this.closeLive(key, w, px); }
    }
  }
  async closeLive(key, w, px) {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await this.env.DB.prepare("SELECT data, ver FROM agents_v2 WHERE id = ? AND running = 1").bind(w.id).first();
        if (!row) break;
        const d = JSON.parse(row.data), rule = ruleOf(d), p = d.paper;
        if (!rule || !p || !p.pos || !p.pos[w.coin] || p.pos[w.coin].t !== w.t) break;
        const e = touch(rule, p, w.coin, px, now());
        if (!e) break;
        e.why = `${e.why} (live)`;
        record(p, e);
        p.equity = p.cash + Object.values(p.pos).reduce((a, x) => a + (x ? x.margin : 0), 0);
        const res = await this.env.DB.prepare("UPDATE agents_v2 SET data = ?, updated = ?, ver = ver + 1 WHERE id = ? AND ver = ?").bind(JSON.stringify(d), now(), w.id, row.ver).run();
        if (res.meta && res.meta.changes === 1) break;
      }
    } finally { this.watch.delete(key); this.busy.delete(key); }
  }
}

async function cleanup(env) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending WHERE expires < ?").bind(t),
    env.DB.prepare("DELETE FROM codes WHERE expires < ?").bind(t),
    env.DB.prepare("DELETE FROM tokens WHERE expires < ?").bind(t),
    env.DB.prepare("DELETE FROM proposals WHERE expires < ?").bind(t),
  ]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), base = env.BASE || url.origin, path = url.pathname;
    try {
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return json(metadata(base), 200, { "access-control-allow-origin": "*" });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["doko"], bearer_methods_supported: ["header"], resource_name: "DOKO by OPEQ" }, 200, { "access-control-allow-origin": "*" });
      if (path === "/consent.css") return new Response(CONSENT_CSS, { headers: { "content-type": "text/css", "cache-control": "public, max-age=3600" } });
      if (path === "/oauth/register" && request.method === "POST") return register(request, env);
      if (path === "/oauth/authorize" && request.method === "GET") return authorizeGet(url, env, request);
      if (path === "/oauth/authorize" && request.method === "POST") return authorizePost(request, env, base);
      if (path === "/oauth/token" && request.method === "POST") return token(request, env);
      if (path === "/oauth/revoke" && request.method === "POST") return revoke(request, env);
      if (path === "/mcp") return mcp(request, env, base);
      if (path.startsWith("/api/")) return siteApi(request, env, path);
      if (path === "/") return Response.redirect(env.SITE_PAGE || "https://opeq.io/doko", 302);
      return new Response("Not found", { status: 404 });
    } catch (x) {
      return json({ error: "server_error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (env.WATCHER) { try { await env.WATCHER.get(env.WATCHER.idFromName("main")).fetch("https://watcher/tick"); } catch {} } else await tickAll(env);
      try { await backfill(env); } catch {}
      if (new Date(event.scheduledTime).getUTCMinutes() === 0) await cleanup(env);
    })());
  },
};
