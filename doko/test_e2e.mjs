import { createHash, randomBytes } from "node:crypto";

const B = process.argv[2] || "http://127.0.0.1:8810";
const SITE = "http://127.0.0.1:8798";
const CB = "https://claude.ai/api/mcp/auth_callback";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? "ok  " : "FAIL"} ${m}`); };
const b64u = (b) => b.toString("base64url");

async function connect(cookie) {
  const reg = await (await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB] }) })).json();
  const verifier = b64u(randomBytes(32)), challenge = b64u(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256", state: "st1", scope: "doko" });
  const page = await (await fetch(`${B}/oauth/authorize?${q}`, { headers: cookie ? { cookie } : {} })).text();
  const pending = /name="pending" value="([^"]+)"/.exec(page)[1];
  const r = await fetch(`${B}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: B, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ pending, decision: "allow" }) });
  const loc = new URL(r.headers.get("location"));
  const set = r.headers.get("set-cookie");
  const code = loc.searchParams.get("code");
  const tok = await (await fetch(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: verifier }) })).json();
  return { reg, page, loc, set, code, verifier, tok, cookie: set ? set.split(";")[0] : cookie };
}
let rid = 0;
async function rpc(token, method, params) {
  const r = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
  return r.json();
}
async function tool(token, name, args = {}) {
  const t0 = Date.now();
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const res = r.result || {};
  return { err: !!res.isError, text: res.content ? res.content[0].text : JSON.stringify(r), data: res.structuredContent, ms: Date.now() - t0 };
}

const meta = await (await fetch(`${B}/.well-known/oauth-authorization-server`)).json();
ok(meta.code_challenge_methods_supported.join() === "S256" && meta.registration_endpoint.endsWith("/oauth/register"), "authorization server metadata");
const prm = await (await fetch(`${B}/.well-known/oauth-protected-resource/mcp`)).json();
ok(prm.resource === `${B}/mcp`, "protected resource metadata");
const noauth = await fetch(`${B}/mcp`, { method: "POST", body: "{}" });
ok(noauth.status === 401 && /resource_metadata=/.test(noauth.headers.get("www-authenticate") || ""), "mcp without token is 401 with resource_metadata");
const badReg = await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
ok(badReg.status === 400, "register refuses plain http redirect");

const A = await connect(null);
ok(/claude\.ai/.test(A.page) && !/class="warn"/.test(A.page), "consent page names claude.ai, no warning");
ok(A.loc.origin + A.loc.pathname === CB && A.loc.searchParams.get("state") === "st1" && A.code, "allow redirects back with code and state");
ok(/HttpOnly/.test(A.set || "") && /SameSite=Lax/.test(A.set || ""), "account cookie set HttpOnly Lax");
ok(A.tok.access_token && A.tok.refresh_token, "token exchange gives access and refresh");
const reuse = await fetch(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: A.code, redirect_uri: CB, client_id: A.reg.client_id, code_verifier: A.verifier }) });
ok(reuse.status === 400, "code cannot be used twice");

const csrfPage = await (await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: A.reg.client_id, redirect_uri: CB, code_challenge: b64u(createHash("sha256").update("x".repeat(50)).digest()), code_challenge_method: "S256" })}`)).text();
const pend = /name="pending" value="([^"]+)"/.exec(csrfPage)[1];
const csrf = await fetch(`${B}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: new URLSearchParams({ pending: pend, decision: "allow" }) });
ok(csrf.status === 403, "consent post from another origin refused");
const wrongPkce = await connect(null);
ok(wrongPkce.tok.access_token, "second flow works");

const T = A.tok.access_token;
const init = await rpc(T, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
ok(init.result && init.result.protocolVersion === "2025-06-18" && init.result.instructions, "initialize");
const note = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
ok(note.status === 202, "notification gets 202");
const tl = await rpc(T, "tools/list", {});
ok(tl.result.tools.length === 16, `tools/list (${tl.result.tools.length})`);
const rf = await tool(T, "rule_format");
ok(!rf.err && rf.text.includes("supertrend") && rf.text.length > 2000, `rule_format (${rf.text.length} chars)`);

const R1 = { name: "SOL RSI dip with 4h trend", pair: "SOL/USDC", timeframe: "1h", entry: { all: [{ left: { ind: "rsi", period: 14 }, op: "<", right: 35 }, { left: { ind: "supertrend", out: "dir", tf: "4h" }, op: ">", right: 0 }] }, exit: { left: { ind: "rsi", period: 14 }, op: ">", right: 55 }, stopLossPct: 3, orderUsd: 100 };
const bad = await tool(T, "propose_agent", { rule: { ...R1, leverage: 5 } });
ok(bad.err && /leverage/.test(bad.text), "bad rule refused with reason");
const pr = await tool(T, "propose_agent", { rule: R1 });
ok(!pr.err && pr.data.proposal_id && pr.data.rules["Buy when"], "propose_agent gives summary");
const ap = await tool(T, "apply_proposal", { proposal_id: pr.data.proposal_id });
ok(!ap.err && ap.data.created, "apply_proposal creates agent");
const again = await tool(T, "apply_proposal", { proposal_id: pr.data.proposal_id });
ok(again.err, "proposal cannot be applied twice");
const AG = ap.data.created;
const la = await tool(T, "list_agents");
ok(la.data.agents.length === 1 && la.data.agents[0].status === "not started", "list_agents");
const bt = await tool(T, "backtest", { agent_id: AG });
ok(!bt.err && typeof bt.data.agentPct === "number", `backtest agent ${bt.data && bt.data.agentPct}% vs hold ${bt.data && bt.data.holdingSolPct}% (${bt.ms} ms)`);
const ss = await tool(T, "search_settings", { agent_id: AG, candles: 2000 });
ok(!ss.err && ss.data.tried > 0, `search_settings tried ${ss.data && ss.data.tried} (${ss.ms} ms)`);
const mk = await tool(T, "market");
ok(!mk.err && mk.data.price > 0, `market price ${mk.data && mk.data.price} (${mk.ms} ms)`);
const st = await tool(T, "start_trading", { agent_id: AG });
ok(!st.err && st.data.trading, "start_trading");
const tk = await (await fetch(`${B}/__tick`)).json();
ok(tk.running >= 1 && tk.written >= 1, `tick ${JSON.stringify(tk)}`);
const ga = await tool(T, "get_agent", { agent_id: AG });
ok(!ga.err && ga.data.status === "trading" && ga.data.recent.length === 1 && ga.data.backtest, "get_agent shows trading, log and backtest");

const B2 = wrongPkce.tok.access_token;
const other = await tool(B2, "get_agent", { agent_id: AG });
ok(other.err, "another account cannot read the agent");
const otherList = await tool(B2, "list_agents");
ok(otherList.data.agents.length === 0, "another account sees no agents");

const same = await connect(A.cookie);
ok(!same.set, "reconnect from the same browser keeps the account");
const sameList = await tool(same.tok.access_token, "list_agents");
ok(sameList.data.agents.length === 1, "reconnected token sees the same agents");

const me = await fetch(`${B}/api/me`, { headers: { cookie: A.cookie, origin: SITE } });
const meJ = await me.json();
ok(me.headers.get("access-control-allow-origin") === SITE && me.headers.get("access-control-allow-credentials") === "true" && meJ.connected && meJ.agents.length === 1, "site api with cookie");
const meEvil = await fetch(`${B}/api/me`, { headers: { cookie: A.cookie, origin: "https://evil.example" } });
ok(!meEvil.headers.get("access-control-allow-origin"), "site api gives no CORS to other origins");
const anon = await (await fetch(`${B}/api/me`, { headers: { origin: SITE } })).json();
ok(anon.connected === false, "site api without cookie");

const ch = await tool(T, "propose_change", { agent_id: AG, rule: { ...R1, name: "SOL RSI dip v2", takeProfitPct: 6 } });
const ap2 = await tool(T, "apply_proposal", { proposal_id: ch.data.proposal_id });
ok(!ap2.err && ap2.data.version === 2 && ap2.data.trading, "propose_change and apply makes version 2, still trading");
const rv = await tool(T, "revert_version", { agent_id: AG, version: 1 });
ok(!rv.err && rv.data.version === 1, "revert_version");
const pa = await tool(T, "pause_trading", { agent_id: AG });
ok(!pa.err && pa.data.trading === false, "pause_trading");
const del1 = await tool(T, "delete_agent", { agent_id: AG, confirm_name: "wrong" });
ok(del1.err, "delete needs the exact name");

const rf2 = await (await fetch(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.tok.refresh_token, client_id: A.reg.client_id }) })).json();
ok(rf2.access_token && rf2.refresh_token !== A.tok.refresh_token, "refresh rotates tokens");
const rf3 = await fetch(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.tok.refresh_token, client_id: A.reg.client_id }) });
ok(rf3.status === 400, "old refresh token is dead");
await fetch(`${B}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: rf2.access_token }) });
const after = await fetch(`${B}/mcp`, { method: "POST", headers: { authorization: `Bearer ${rf2.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
ok(after.status === 401, "revoked token refused");
console.log(`\n${pass} passed, ${fail} failed`);
