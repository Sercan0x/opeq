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
const rule = { name: "Live watcher test", coins: ["SOL"], timeframe: "5m", leverage: 10, marginUsd: 100, long: { entry: { left: { ind: "price" }, op: ">", right: 0 } }, stopLossPct: 0.05, takeProfitPct: 0.05 };
const bt = await tool("backtest", { rule, candles: 2000 });
console.log("backtest", bt.err ? bt.text.slice(0, 200) : JSON.stringify({ pct: bt.data.agentPct, trades: bt.data.trades, months: bt.data.months.slice(-2) }));
const p = await tool("propose_agent", { rule }), a = await tool("apply_proposal", { proposal_id: p.data.proposal_id }), ag = a.data.created;
console.log("start", JSON.stringify((await tool("start_trading", { agent_id: ag })).data));
const t0 = Date.now();
let seenLive = false;
for (let i = 0; i < 40 && !seenLive; i++) {
  await sleep(20000);
  const g = await tool("get_agent", { agent_id: ag });
  const lines = (g.data.recent || []).map((x) => `${x.at.slice(11, 19)} ${x.text}`);
  console.log(`+${Math.round((Date.now() - t0) / 1000)}s`, g.data.paper && JSON.stringify(g.data.paper.positions), "|", lines.slice(0, 3).join(" || "));
  seenLive = lines.some((l) => l.includes("(live)"));
}
console.log(seenLive ? "LIVE CLOSE SEEN" : "no live close seen");
console.log("delete", JSON.stringify((await tool("delete_agent", { agent_id: ag, confirm_name: rule.name })).data));
for (const t of [tok.refresh_token, tok.access_token]) await fetch(`${B}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t }) });
