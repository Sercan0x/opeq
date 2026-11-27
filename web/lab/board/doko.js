try { sessionStorage.setItem("opeq:inside", "1"); } catch {}

const API = ["127.0.0.1", "localhost"].includes(location.hostname) ? "http://127.0.0.1:8810" : "https://doko.opeq.io";
const START = 1000;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const pct = (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const tone = (v) => (v == null || Math.abs(v) < 0.005 ? null : v > 0 ? "up" : "down");
$("mcp-url").textContent = `${API}/mcp`;

let state = null;

async function api(path, opts = {}) {
  const r = await fetch(`${API}${path}`, { credentials: "include", ...opts });
  if (!r.ok && r.status !== 401 && r.status !== 404) throw new Error(`DOKO answered ${r.status}`);
  return r.json();
}

function avatar(cv, id) {
  const g = cv.getContext("2d"), n = 5, s = cv.width / (n + 2);
  let h = 2166136261;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = "#0a1119"; g.fillRect(0, 0, cv.width, cv.height);
  const color = h & 1 ? "#3ad0ff" : "#ffc94a";
  for (let y = 0; y < n; y++) for (let x = 0; x < 3; x++) {
    if (!((h >>> (y * 3 + x + 1)) & 1)) continue;
    g.fillStyle = (x + y) % 3 === 0 ? "#e6ebf2" : color;
    for (const xx of x === 2 ? [2] : [x, n - 1 - x]) g.fillRect(s * (xx + 1) + 1, s * (y + 1) + 1, s - 2, s - 2);
  }
}
function spark(cv, vals) {
  const g = cv.getContext("2d"), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  if (!vals || vals.length < 2) { g.strokeStyle = "rgba(255,255,255,0.12)"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke(); return; }
  const lo = Math.min(...vals, START), hi = Math.max(...vals, START), span = hi - lo || 1;
  const x = (i) => (i / (vals.length - 1)) * W, y = (v) => H - 3 - ((v - lo) / span) * (H - 6);
  g.strokeStyle = "rgba(255,255,255,0.14)"; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(0, y(START)); g.lineTo(W, y(START)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = vals[vals.length - 1] >= START ? "#4fd18b" : "#ff7a6e"; g.lineWidth = 1.6;
  g.beginPath(); vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke();
}
function lineChart(cv, vals) {
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, pad = 30;
  g.clearRect(0, 0, W, H);
  const lo = Math.min(...vals, START), hi = Math.max(...vals, START), span = hi - lo || 1;
  const x = (i) => pad + (i / Math.max(1, vals.length - 1)) * (W - 2 * pad), y = (v) => H - pad - ((v - lo) / span) * (H - 2 * pad);
  g.strokeStyle = "rgba(255,255,255,0.07)"; g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const yy = pad + (k / 4) * (H - 2 * pad); g.beginPath(); g.moveTo(pad, yy); g.lineTo(W - pad, yy); g.stroke(); }
  g.strokeStyle = "rgba(255,255,255,0.22)"; g.setLineDash([5, 5]); g.beginPath(); g.moveTo(pad, y(START)); g.lineTo(W - pad, y(START)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = vals[vals.length - 1] >= START ? "#4fd18b" : "#ff7a6e"; g.lineWidth = 2.2;
  g.beginPath(); vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke();
  g.fillStyle = "#7f8a9b"; g.font = "12px ui-monospace, monospace";
  g.fillText(usd(hi), 4, pad - 10); g.fillText(usd(lo), 4, H - 8);
}
const STATUS = { trading: ["live", "Trading"], paused: ["idle", "Paused"], "not started": ["idle", "Not started"], "no rules": ["draft", "No rules yet"] };
const winRate = (p) => (p && p.winRatePct != null ? `${p.winRatePct}%` : "None yet");

function stat(box, items) {
  box.textContent = "";
  for (const [k, v, cls] of items) { const d = el("div", "dk-stat"); d.append(el("small", null, k)); d.append(el("b", cls || null, v)); box.append(d); }
}

function paintList() {
  const box = $("agents"); box.textContent = "";
  for (const a of state.agents) {
    const p = a.paper, [st, stText] = STATUS[a.status] || ["idle", a.status];
    const card = el("a", `dk-agent ${st}`); card.href = `#agent=${a.id}`;
    const top = el("div", "dk-atop");
    const cv = el("canvas", "dk-ava"); cv.width = 40; cv.height = 40; avatar(cv, a.id); top.append(cv);
    const nm = el("div", "dk-grow"); nm.append(el("h3", null, a.name)); nm.append(el("p", "dk-sub", a.coins && a.coins.length ? `${a.coins.join(", ")}, ${a.timeframe}, ${a.leverage}x ${a.sides.join(" and ")}` : "No rules yet")); top.append(nm);
    top.append(el("span", `dk-pill ${st}`, stText));
    card.append(top);
    const big = el("div", "dk-big");
    if (p && p.started) { big.append(el("b", tone(p.resultPct), pct(p.resultPct))); big.append(el("small", null, `paper result, ${usd(p.balance)} now`)); }
    else if (a.backtest) { big.append(el("b", tone(a.backtest.returnPct), pct(a.backtest.returnPct))); big.append(el("small", null, "in its last backtest")); }
    else big.append(el("b", "dk-none", "No results yet"));
    card.append(big);
    const sp = el("canvas", "dk-spark"); sp.width = 300; sp.height = 44; spark(sp, a.spark); card.append(sp);
    const meta = el("dl", "dk-meta");
    const add = (k, v) => { const d = el("div"); d.append(el("dt", null, k)); d.append(el("dd", null, v)); meta.append(d); };
    add("Win rate", winRate(p));
    add("Trades", String(p ? p.closedTrades : 0));
    add("Liquidated", String(p ? p.liquidations || 0 : 0));
    add("Open", p && p.positions && p.positions.length ? p.positions.map((x) => `${x.side === "long" ? "L" : "S"} ${x.coin}`).join(", ") : "None");
    card.append(meta);
    box.append(card);
  }
  if (!state.agents.length) {
    const e = el("div", "dk-agent dk-new");
    e.append(el("b", null, "No agents yet"));
    e.append(el("span", null, "Open Claude and ask it to build one, for example: “Make me a DOKO agent that buys SOL when RSI drops under 30 and sells above 55, with a 3% stop loss.”"));
    box.append(e);
  }
}

const fmtPx = (v) => (v == null || !Number.isFinite(v) ? "-" : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 3) : v.toPrecision(4));
const fmtT = (s) => { if (!s) return "-"; const d = new Date(s * 1000); return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${d.toTimeString().slice(0, 5)}`; };
const STATUS_OF = (why) => (why.startsWith("liquidated") ? ["LIQ", "liq"] : why.startsWith("take profit") ? ["TP HIT", "tp"] : why.startsWith("stop loss") ? ["SL HIT", "sl"] : why.startsWith("opposite") ? ["REVERSED", "ex"] : why.startsWith("paused") ? ["PAUSED", "ex"] : ["EXIT", "ex"]);
function td(text, cls) { return el("td", cls || null, text); }
let tab = "positions";
for (const b of document.querySelectorAll(".ag-tab")) b.addEventListener("click", () => { tab = b.dataset.tab; for (const x of document.querySelectorAll(".ag-tab")) x.classList.toggle("on", x === b); for (const k of ["positions", "trades", "rules", "activity"]) $(`tab-${k}`).classList.toggle("hidden", k !== tab); });

async function paintAgent(id) {
  const a = await api(`/api/agent?id=${encodeURIComponent(id)}`);
  if (a.error) { location.hash = ""; return; }
  const p = a.paper || {}, [st, stText] = STATUS[a.status] || ["idle", a.status];
  avatar($("a-ava"), a.id);
  $("a-name").textContent = a.name; $("a-name2").textContent = a.name;
  $("a-pill").className = `dk-pill ${st}`; $("a-pill").textContent = stText;
  const chips = $("a-chips"); chips.textContent = "";
  for (const c of a.coins || []) chips.append(el("span", "ag-chip coin", c));
  if (a.timeframe) chips.append(el("span", "ag-chip", a.timeframe.toUpperCase()));
  if (a.leverage) chips.append(el("span", "ag-chip lev", `${a.leverage}x`));
  for (const sd of a.sides || []) chips.append(el("span", `ag-chip ${sd}`, sd.toUpperCase()));
  $("a-sub").textContent = `Version ${a.version}${p.since ? `, trading since ${new Date(p.since).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}. Paper money, 1,000 dollars to start.`;
  const open = p.positions || [];
  const stats = $("a-stats"); stats.textContent = "";
  const box = (label, value, cls) => { const d = el("div", "ag-stat"); d.append(el("b", cls || null, value)); d.append(el("small", null, label)); stats.append(d); };
  box("Win rate", p.winRatePct != null ? `${p.winRatePct}%` : "-", "ice");
  box("Wins", String(p.wins || 0), "up");
  box("Losses", String(p.losses || 0), "down");
  box("Total PnL", p.started ? pct(p.resultPct || 0) : "0.00%", tone(p.resultPct));
  box("Balance", usd(p.balance != null ? p.balance : START));
  box("Open positions", String(open.length));
  const w = p.wins || 0, l = p.losses || 0, n = w + l;
  $("a-wl-w").style.width = n ? `${(100 * w) / n}%` : "50%"; $("a-wl-l").style.width = n ? `${(100 * l) / n}%` : "50%";
  $("a-wl").classList.toggle("empty", !n);
  $("a-wl-text").textContent = n ? `${w} wins (${Math.round((100 * w) / n)}%), ${l} losses (${Math.round((100 * l) / n)}%)${p.liquidations ? `, ${p.liquidations} liquidated` : ""}` : "No closed trades yet.";
  const curve = a.curve && a.curve.length > 1 ? a.curve : null;
  $("eq-chart").classList.toggle("hidden", !curve);
  $("eq-legend").textContent = curve ? `since ${new Date(curve[0].t).toLocaleString()}` : "";
  $("eq-hint").textContent = curve ? "" : a.running ? "The chart fills in as candles close." : "The chart fills in once the agent is trading. Ask Claude to start it.";
  if (curve) lineChart($("eq-chart"), curve.map((q) => q.e));
  const bt = a.backtest;
  $("a-bt").textContent = bt ? `Backtest: ${pct(bt.returnPct)} over ${bt.candles ? `${bt.candles.toLocaleString("en-US")} candles, ` : ""}${bt.period}, ${bt.trades} trades, ${bt.liquidations || 0} liquidations, worst drop ${pct(bt.maxDrawdownPct)}.` : "No backtest on file. Ask Claude to backtest this agent.";
  const pr = $("pos-rows"); pr.textContent = "";
  if (!open.length) { const tr = el("tr"), c = td(a.running ? "No open position. Waiting for a signal." : "No open position.", "ag-empty"); c.colSpan = 10; tr.append(c); pr.append(tr); }
  for (const x of open) {
    const tr = el("tr");
    tr.append(td(x.coin, "b")); tr.append(td(x.side.toUpperCase(), x.side)); tr.append(td(`${x.leverage}x`, "ice"));
    tr.append(td(fmtPx(x.entry))); tr.append(td(fmtPx(x.mark)));
    tr.append(td(x.pnl == null ? "-" : `${x.pnl >= 0 ? "+" : ""}${usd(x.pnl)} (${pct(x.pnlPct)})`, tone(x.pnl)));
    tr.append(td(fmtPx(x.stop), "down")); tr.append(td(x.takeProfit ? fmtPx(x.takeProfit) : "-", "up")); tr.append(td(fmtPx(x.liquidation), "liq")); tr.append(td(fmtT(x.opened), "dim"));
    pr.append(tr);
  }
  const trs = $("trade-rows"); trs.textContent = "";
  if (!a.trades || !a.trades.length) { const tr = el("tr"), c = td("No closed trades yet.", "ag-empty"); c.colSpan = 9; tr.append(c); trs.append(tr); }
  for (const x of a.trades || []) {
    const tr = el("tr"), [label, cls] = STATUS_OF(x.why || "");
    tr.append(td(x.coin, "b")); tr.append(td(x.side.toUpperCase(), x.side)); tr.append(td(`${x.lev}x`, "ice"));
    tr.append(td(fmtPx(x.entry))); tr.append(td(fmtPx(x.exit)));
    tr.append(td(`${x.pnl >= 0 ? "+" : ""}${usd(x.pnl)} (${pct(x.pnlPct)})`, tone(x.pnl)));
    const sc = td(""); sc.append(el("span", `ag-status ${cls}`, label)); tr.append(sc);
    tr.append(td(fmtT(x.opened), "dim")); tr.append(td(fmtT(x.closed), "dim"));
    trs.append(tr);
  }
  $("cur-tag").textContent = a.rule ? `APPROVED, VERSION ${a.version}` : "NO RULES YET";
  const ul = $("cur-lines"); ul.textContent = "";
  for (const [k, v] of Object.entries(a.rules || {})) { const li = el("li"); li.append(el("b", null, `${k}: `)); li.append(el("span", "dk-pre", v)); ul.append(li); }
  $("cur-json-box").classList.toggle("hidden", !a.rule);
  $("cur-json").textContent = a.rule ? JSON.stringify(a.rule, null, 2) : "";
  const h = $("hist"); h.textContent = "";
  $("hist-box").classList.toggle("hidden", a.versions.length < 2);
  for (const v of a.versions) h.append(el("li", null, `Version ${v.version}: ${v.name} (${new Date(v.at).toLocaleString()})${v.current ? ", in use" : ""}`));
  const log = $("pp-log"); log.textContent = "";
  if (!a.recent.length) log.append(el("li", null, "Nothing yet."));
  for (const x of a.recent) log.append(el("li", null, `${new Date(x.at).toLocaleString()}  ${x.text}`));
}

async function route() {
  $("load-err").textContent = "";
  try {
    state = await api("/api/me");
    const m = /^#agent=([0-9a-f]{12})$/.exec(location.hash);
    const show = (v) => { for (const k of ["v-connect", "v-list", "v-agent"]) $(k).classList.toggle("hidden", k !== v); };
    if (!state.connected) { show("v-connect"); return; }
    if (m) { show("v-agent"); await paintAgent(m[1]); }
    else { show("v-list"); paintList(); }
  } catch (x) {
    $("load-err").textContent = "Could not reach DOKO. Check your connection; this page tries again every minute.";
  }
}

$("copy-url").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("mcp-url").textContent); $("copy-url").textContent = "Copied"; setTimeout(() => { $("copy-url").textContent = "Copy"; }, 1500); } catch {} });
$("to-list").addEventListener("click", () => { location.hash = ""; });
$("disconnect").addEventListener("click", async () => {
  if (!confirm("Stop showing your agents in this browser? They keep running, and Claude keeps its connection. To see them here again, reconnect DOKO in Claude from this browser.")) return;
  try { await api("/api/disconnect", { method: "POST" }); } catch {}
  route();
});
window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
route();
setInterval(() => { if (document.visibilityState === "visible") route(); }, 60000);
