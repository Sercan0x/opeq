import { createHash, randomBytes } from "node:crypto";
const B = process.argv[2] || "https://doko.opeq.io", CB = "https://claude.ai/api/mcp/auth_callback";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = await (await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "live test", redirect_uris: [CB] }) })).json();
const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
const page = await (await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256" })}`)).text();
const pending = /name="pending" value="([^"]+)"/.exec(page)[1];
const r = await fetch(`${B}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: B }, body: new URLSearchParams({ pending, decision: "allow" }) });
const code = new URL(r.headers.get("location")).searchParams.get("code");
const tok = await (await fetch(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: verifier }) })).json();
let id = 0;
const tool = async (name, args = {}) => { const x = await (await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) })).json(); const res = x.result || {}; return { err: !!res.isError, data: res.structuredContent, text: res.content ? res.content[0].text : JSON.stringify(x) }; };
const t0 = Date.now();
const d = await tool("discover_strategies", { coins: ["SOL"], timeframe: process.argv[3] || "1h", leverage: 10, sides: "both", tries: Number(process.argv[4] || 1000), seed: 7 });
if (!d.data) { console.log("raw", d.text.slice(0, 500)); }
console.log(`discover ${Date.now() - t0} ms`, d.err || !d.data ? d.text.slice(0, 400) : JSON.stringify({ built: d.data.built, enough: d.data.enoughTrades, checked: d.data.testedOnCheck, survivors: d.data.survivorsCount, search: d.data.searchPart, check: d.data.checkPart }));
if (!d.err && d.data.survivors[0]) { const s = d.data.survivors[0]; console.log("first survivor", JSON.stringify(s.search), JSON.stringify(s.check)); console.log(Object.entries(s.rules).map(([k, v]) => `  ${k}: ${v.replace(/\n/g, " / ")}`).join("\n")); const p = await tool("propose_agent", { rule: { ...s.rule, name: "Found by search" } }); console.log("proposable:", !p.err, p.err ? p.text.slice(0, 200) : ""); }
const deep = await tool("discover_strategies", { coins: ["SOL"], timeframe: "4h", leverage: 5, sides: "both", tries: 500, candles: 10000, seed: 3 });
console.log("deep 4h 10000", deep.err ? deep.text.slice(0, 200) : JSON.stringify({ survivors: deep.data.survivorsCount, search: deep.data.searchPart, check: deep.data.checkPart }));
for (const t of [tok.refresh_token, tok.access_token]) await fetch(`${B}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t }) });
