import { createHash, randomBytes } from "node:crypto";

const B = process.argv[2] || "https://doko.opeq.io";
const CB = "https://claude.ai/api/mcp/auth_callback";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = await (await fetch(`${B}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "smoke test", redirect_uris: [CB] }) })).json();
const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
const page = await (await fetch(`${B}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256" })}`)).text();
const pending = /name="pending" value="([^"]+)"/.exec(page)[1];
const r = await fetch(`${B}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: B }, body: new URLSearchParams({ pending, decision: "allow" }) });
const code = new URL(r.headers.get("location")).searchParams.get("code");
const tok = await (await fetch(`${B}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: verifier }) })).json();
console.log("connected:", !!tok.access_token);
let id = 0;
const tool = async (name, args = {}) => { const t0 = Date.now(); const x = await (await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) })).json(); const res = x.result || {}; return { err: !!res.isError, data: res.structuredContent, text: res.content ? res.content[0].text : JSON.stringify(x), ms: Date.now() - t0 }; };
const show = (n, x) => console.log(n, x.err ? `ERROR ${x.text.slice(0, 300)}` : JSON.stringify(x.data).slice(0, 220), `(${x.ms} ms)`);
show("market", await tool("market"));
const rule = { name: "Smoke test agent", pair: "SOL/USDC", timeframe: "15m", entry: { all: [{ left: { ind: "rsi", period: 14 }, op: "<", right: 40 }, { left: { ind: "funding" }, op: "<", right: 0.01 }] }, stopLossPct: 2, takeProfitPct: 2, orderUsd: 100 };
const p = await tool("propose_agent", { rule });
show("propose", p);
const a = await tool("apply_proposal", { proposal_id: p.data.proposal_id });
show("apply", a);
const ag = a.data.created;
show("backtest", await tool("backtest", { agent_id: ag, candles: 2000 }));
show("search_settings", await tool("search_settings", { agent_id: ag, candles: 3000 }));
show("start", await tool("start_trading", { agent_id: ag }));
let g;
for (let i = 0; i < Number(process.argv[3] || 10); i++) {
  await sleep(30000);
  g = await tool("get_agent", { agent_id: ag });
  console.log(`after ${(i + 1) * 30}s:`, g.data.status, JSON.stringify(g.data.recent));
  if (g.data.recent.length) break;
}
show("delete", await tool("delete_agent", { agent_id: ag, confirm_name: "Smoke test agent" }));
await fetch(`${B}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tok.refresh_token }) });
await fetch(`${B}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tok.access_token }) });
console.log("cleaned up");
