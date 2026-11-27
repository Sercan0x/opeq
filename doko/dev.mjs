import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8810);
const dbFile = process.argv[3] || ":memory:";
const db = new DatabaseSync(dbFile);
for (const s of readFileSync(join(here, "schema.sql"), "utf8").split(";").map((x) => x.trim()).filter(Boolean)) db.exec(s);

class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
}
const env = {
  DB: { prepare: (sql) => new Stmt(sql), batch: async (list) => { db.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } } },
  SITE_ORIGINS: "http://127.0.0.1:8798,http://localhost:8798",
  SITE_PAGE: "http://127.0.0.1:8798/lab/board/doko.html",
  CB_START: process.env.CB_START || "",
};
const worker = (await import(pathToFileURL(join(here, "worker.js")).href)).default;
const { tickAll, backfill } = await import(pathToFileURL(join(here, "worker.js")).href);

async function demo() {
  const B = `http://127.0.0.1:${port}`, CB = "http://127.0.0.1:8798/cb";
  const call = (path, init = {}) => worker.fetch(new Request(`${B}${path}`, init), env, { waitUntil() {} });
  const reg = await (await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB] }) })).json();
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const page = await (await call(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256" })}`)).text();
  const pending = /name="pending" value="([^"]+)"/.exec(page)[1];
  const r = await call("/oauth/authorize", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: B }, body: new URLSearchParams({ pending, decision: "allow" }) });
  const cookie = r.headers.getSetCookie()[0];
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  const tok = await (await call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: verifier }) })).json();
  let id = 0;
  const tool = async (name, args = {}) => { const x = await (await call("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) })).json(); return x.result.structuredContent; };
  const rules = [
    { name: "SOL RSI both ways 10x", coins: ["SOL"], timeframe: "1h", leverage: 10, marginUsd: 100, long: { entry: { all: [{ left: { ind: "rsi", period: 14 }, op: "<", right: 35 }, { left: { ind: "supertrend", out: "dir", tf: "4h" }, op: ">", right: 0 }] }, exit: { left: { ind: "rsi", period: 14 }, op: ">", right: 55 } }, short: { entry: { left: { ind: "rsi", period: 14 }, op: ">", right: 70 } }, stopLossPct: 3, takeProfitPct: 6 },
    { name: "BTC ETH SOL trend rider 5x", coins: ["BTC", "ETH", "SOL"], timeframe: "4h", leverage: 5, marginUsd: 200, long: { entry: { cross: "above", a: { ind: "ema", period: 9 }, b: { ind: "ema", period: 21 } } }, short: { entry: { cross: "below", a: { ind: "ema", period: 9 }, b: { ind: "ema", period: 21 } } }, stopLossPct: 5 },
    { name: "Aggro 50x scalper", coins: ["ETH", "SOL"], timeframe: "15m", leverage: 50, marginUsd: 50, long: { entry: { atLeast: 2, of: [{ left: { ind: "bb", out: "pctb" }, op: "<", right: 0 }, { left: { ind: "rsi", period: 7 }, op: "<", right: 25 }, { left: { ind: "rsi", asset: "BTC" }, op: ">", right: 45 }] } }, short: { entry: { atLeast: 2, of: [{ left: { ind: "bb", out: "pctb" }, op: ">", right: 1 }, { left: { ind: "rsi", period: 7 }, op: ">", right: 75 }, { left: { ind: "rsi", asset: "BTC" }, op: "<", right: 55 }] } }, stopLossPct: 0.8, takeProfitPct: 1.6 },
  ];
  const ids = [];
  for (const rule of rules) { const p = await tool("propose_agent", { rule }); const a = await tool("apply_proposal", { proposal_id: p.proposal_id }); ids.push(a.created); await tool("backtest", { agent_id: a.created }); }
  await tool("start_trading", { agent_id: ids[0] });
  await tool("start_trading", { agent_id: ids[2] });
  await tickAll(env);
  return cookie;
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  if (req.url === "/__tick") { const r = await tickAll(env); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r)); return; }
  if (req.url.startsWith("/__backfill")) { const n = Number(new URL(req.url, "http://x").searchParams.get("pages") || 4); const r = await backfill(env, n); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r)); return; }
  if (req.url === "/__demo") { const cookie = await demo(); res.writeHead(302, { location: env.SITE_PAGE, "set-cookie": cookie }); res.end(); return; }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  const r = await worker.fetch(request, env, { waitUntil() {} });
  const out = {};
  r.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`doko dev on http://127.0.0.1:${port}`));
setInterval(() => { tickAll(env).catch((e) => console.log("tick failed", e.message)); }, 60000);
