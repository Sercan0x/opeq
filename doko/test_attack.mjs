import { createHash, randomBytes } from "node:crypto";

const B = process.argv[2] || "http://127.0.0.1:8810";
const SITE = process.argv[3] || "http://127.0.0.1:8798";
const CB = "https://claude.ai/api/mcp/auth_callback";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? "ok  " : "FAIL"} ${m}`); };
const b64u = (b) => b.toString("base64url");
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });

async function connect(cookie) {
  const reg = await (await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB] }) })).json();
  const verifier = b64u(randomBytes(32)), challenge = b64u(createHash("sha256").update(verifier).digest());
  const page = await (await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256" })}`, { headers: cookie ? { cookie } : {} })).text();
  const pending = /name="pending" value="([^"]+)"/.exec(page)[1];
  const r = await fetch(`${B}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: B, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ pending, decision: "allow" }) });
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  const tok = await (await fetch(`${B}/oauth/token`, form({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: verifier }))).json();
  return { reg, tok, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
}
let rid = 0;
const call = async (token, body) => (await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const tool = async (token, name, args = {}) => { const r = await call(token, { jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }); const j = await r.json(); const res = j.result || {}; return { err: !!res.isError || !!j.error, text: res.content ? res.content[0].text : JSON.stringify(j), data: res.structuredContent }; };
const good = { name: "Attack base", coins: ["SOL"], timeframe: "1h", leverage: 5, marginUsd: 100, long: { entry: { left: { ind: "rsi" }, op: "<", right: 30 } }, stopLossPct: 2 };

console.log("== OAuth");
for (const uri of ["https://evil.example/cb", "https://claude.ai.evil.example/cb", "https://evil.example/claude.ai", "https://user:pass@claude.ai/cb", "javascript:alert(1)", "http://evil.example/cb", "https://claude.ai/cb#frag"]) {
  const r = await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) });
  ok(r.status === 400, `register refuses ${uri}`);
}
const okReg = await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost:33418/callback", "https://claude.com/api/mcp/auth_callback"] }) });
ok(okReg.status === 201, "register accepts Claude Code localhost and claude.com callbacks");
const A = await connect(null), V = await connect(null);
ok(A.tok.access_token && V.tok.access_token, "two separate accounts connect");
const regA = A.reg;
const mismatch = await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: regA.client_id, redirect_uri: "https://claude.ai/other", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`);
ok(mismatch.status === 400, "authorize refuses a redirect_uri that was not registered");
const plain = await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: regA.client_id, redirect_uri: CB, code_challenge: "x".repeat(43), code_challenge_method: "plain" })}`);
ok(plain.status === 400, "authorize refuses PKCE plain");
const consent = await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: regA.client_id, redirect_uri: CB, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "<script>alert(1)</script>" })}`);
const ch = await consent.text();
ok(/frame-ancestors 'none'/.test(consent.headers.get("content-security-policy") || "") && consent.headers.get("x-frame-options") === "DENY", "consent page cannot be framed");
ok(!ch.includes("<script>alert"), "state is not echoed into the consent page");
const evilName = await (await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "<img src=x onerror=alert(1)>", redirect_uris: [CB] }) })).json();
const ch2 = await (await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: evilName.client_id, redirect_uri: CB, code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`)).text();
ok(!ch2.includes("<img src=x") && ch2.includes("&lt;img"), "client name is escaped on the consent page");
const pend = /name="pending" value="([^"]+)"/.exec(ch)[1];
for (const [h, label] of [[{ origin: "https://evil.example" }, "another origin"], [{ origin: "null", "sec-fetch-site": "cross-site" }, "a null origin from another site"], [{}, "no origin at all"]]) {
  const r = await fetch(`${B}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...h }, body: new URLSearchParams({ pending: pend, decision: "allow" }) });
  ok(r.status === 403, `consent post from ${label} is refused`);
}
const stolen = await fetch(`${B}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: A.tok.refresh_token }));
ok(stolen.status === 400, "refresh without the client id is refused");
const cross = await fetch(`${B}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: A.tok.refresh_token, client_id: V.reg.client_id }));
ok(cross.status === 400, "refresh with another client's id is refused");
const forged = await call("A".repeat(43), { jsonrpc: "2.0", id: 1, method: "ping" });
ok(forged.status === 401, "a made-up bearer token is refused");

console.log("== MCP input");
const big = await call(A.tok.access_token, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(300000) } }));
ok(big.status === 413, "a request over 256 KB is refused");
const batch = await call(A.tok.access_token, Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "ping" })));
ok(batch.status === 400, "a batch over 20 calls is refused");
const junk = await call(A.tok.access_token, "{not json");
ok(junk.status === 400, "broken JSON is refused");
const proto = [
  [{ ...good, timeframe: "constructor" }, "timeframe constructor"],
  [{ ...good, timeframe: "__proto__" }, "timeframe __proto__"],
  [{ ...good, long: { entry: { left: { ind: "constructor" }, op: "<", right: 1 } } }, "indicator constructor"],
  [{ ...good, long: { entry: { left: { ind: "__proto__" }, op: "<", right: 1 } } }, "indicator __proto__"],
  [{ ...good, long: { entry: { left: { ind: "rsi", constructor: 5 }, op: "<", right: 1 } } }, "setting constructor"],
  [JSON.parse('{"name":"p","coins":["SOL"],"timeframe":"1h","leverage":5,"marginUsd":100,"long":{"entry":{"left":{"ind":"rsi","__proto__":{"period":2}},"op":"<","right":30}},"stopLossPct":2}'), "setting __proto__"],
  [{ ...good, long: { entry: { left: { ind: "rsi", tf: "toString" }, op: "<", right: 1 } } }, "tf toString"],
  [{ ...good, long: { entry: { left: { ind: "rsi", out: ["value"] }, op: "<", right: 1 } } }, "out as an array"],
  [{ ...good, coins: ["__proto__"] }, "coin __proto__"],
  [{ ...good, coins: ["../../etc"] }, "coin path"],
  [{ ...good, long: { entry: { left: { ind: "rsi", asset: "constructor" }, op: "<", right: 1 } } }, "asset constructor"],
  [{ ...good, leverage: 0 }, "leverage 0"], [{ ...good, leverage: 126 }, "leverage 126"], [{ ...good, leverage: 1.5 }, "leverage 1.5"],
  [{ ...good, marginUsd: -5 }, "negative margin"], [{ ...good, stopLossPct: 0 }, "zero stop"], [{ ...good, stopLossPct: "2" }, "stop as text"],
  [{ ...good, long: { entry: { all: Array.from({ length: 9 }, () => good.long.entry) } } }, "9 conditions in one all"],
  [{ ...good, long: { entry: { not: { not: { not: { not: { not: good.long.entry } } } } } } }, "nesting deeper than 4"],
  [{ ...good, long: { entry: { atLeast: 1e9, of: [good.long.entry, good.long.entry] } } }, "atLeast too large"],
  [{ ...good, extra: 1 }, "unknown top field"], [{ ...good, name: "x".repeat(61) }, "name over 60"],
];
for (const [rule, label] of proto) { const r = await tool(A.tok.access_token, "propose_agent", { rule }); ok(r.err, `refused: ${label}${r.err ? "" : " (accepted!)"}`); }
const mk = await tool(A.tok.access_token, "market", { coin: "constructor" });
ok(mk.err || (mk.data && mk.data.coin === "SOL"), "market ignores a prototype coin name");
const disc = await tool(A.tok.access_token, "discover_strategies", { timeframe: "constructor", leverage: 5 });
ok(disc.err, "discovery refuses a prototype timeframe");

console.log("== Isolation");
const p = await tool(V.tok.access_token, "propose_agent", { rule: { ...good, name: "Victim agent" } });
const ap = await tool(V.tok.access_token, "apply_proposal", { proposal_id: p.data.proposal_id });
const VA = ap.data.created;
for (const [name, args] of [["get_agent", { agent_id: VA }], ["start_trading", { agent_id: VA }], ["pause_trading", { agent_id: VA }], ["reset_paper", { agent_id: VA }], ["rename_agent", { agent_id: VA, name: "pwned" }], ["delete_agent", { agent_id: VA, confirm_name: "Victim agent" }], ["backtest", { agent_id: VA }], ["propose_change", { agent_id: VA, rule: good }], ["revert_version", { agent_id: VA, version: 1 }]]) {
  const r = await tool(A.tok.access_token, name, args); ok(r.err, `another account cannot ${name} the victim's agent`);
}
const vp = await tool(V.tok.access_token, "propose_change", { agent_id: VA, rule: { ...good, name: "victim v2" } });
const steal = await tool(A.tok.access_token, "apply_proposal", { proposal_id: vp.data.proposal_id });
ok(steal.err, "another account cannot apply the victim's proposal");
const still = await tool(V.tok.access_token, "get_agent", { agent_id: VA });
ok(!still.err && still.data.name === "Victim agent", "the victim's agent is untouched");
const sqlish = await tool(A.tok.access_token, "get_agent", { agent_id: "' OR 1=1 --" });
ok(sqlish.err, "an SQL-looking id finds nothing");

console.log("== Site API");
const meEvil = await fetch(`${B}/api/me`, { headers: { cookie: V.cookie, origin: "https://evil.example" } });
ok(!meEvil.headers.get("access-control-allow-origin"), "no CORS for another origin");
const meNull = await fetch(`${B}/api/me`, { headers: { cookie: V.cookie, origin: "null" } });
ok(!meNull.headers.get("access-control-allow-origin"), "no CORS for a null origin");
const pre = await fetch(`${B}/api/me`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
ok(pre.status === 403, "preflight from another origin is refused");
const disc2 = await fetch(`${B}/api/disconnect`, { method: "POST", headers: { cookie: V.cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } });
ok(disc2.status === 403 && !(disc2.headers.get("set-cookie") || "").includes("Max-Age=0"), "disconnect from another site is refused");
const cookieForge = await (await fetch(`${B}/api/me`, { headers: { cookie: `doko_acct=${V.cookie.split("=")[1].split(".")[0]}.${"A".repeat(43)}`, origin: SITE } })).json();
ok(cookieForge.connected === false, "a cookie with the right account id but a wrong secret is refused");
const otherAgent = await fetch(`${B}/api/agent?id=${VA}`, { headers: { cookie: A.cookie, origin: SITE } });
ok(otherAgent.status === 404, "the site API will not show another account's agent");

await tool(V.tok.access_token, "delete_agent", { agent_id: VA, confirm_name: "Victim agent" });
for (const t of [A.tok.refresh_token, A.tok.access_token, V.tok.refresh_token, V.tok.access_token]) await fetch(`${B}/oauth/revoke`, form({ token: t }));
console.log(`\n${pass} passed, ${fail} failed`);

if (!B.includes("127.0.0.1")) {
  console.log("== Rate limits (live only)");
  const L = await connect(null);
  const res = [];
  for (let i = 0; i < 10; i++) res.push(await tool(L.tok.access_token, "backtest", { rule: good, candles: 300 }));
  const refused = res.filter((r) => r.err && /limited to 8 a minute/.test(r.text)).length;
  ok(refused >= 1 && res.slice(0, 8).every((r) => !r.err), `heavy tools stop after 8 a minute (${refused} of 10 refused)`);
  for (const t of [L.tok.refresh_token, L.tok.access_token]) await fetch(`${B}/oauth/revoke`, form({ token: t }));
  console.log(`after rate limits: ${pass} passed, ${fail} failed`);
}
