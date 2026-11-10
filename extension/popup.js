const $ = (id) => document.getElementById(id);
const body = document.body;
const EXEC_LIMIT = 960;

function panel(open) {
  $("p-panel").classList.toggle("hidden", !open);
  $("p-wallets").setAttribute("aria-expanded", String(open));
}

$("p-wallets").addEventListener("click", () => panel($("p-panel").classList.contains("hidden")));
$("p-expand").addEventListener("click", async () => {
  const url = chrome.runtime.getURL("app.html");
  const open = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  if (open.length) {
    await chrome.tabs.update(open[0].tabId, { active: true });
    await chrome.windows.update(open[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url });
  window.close();
});
for (const b of document.querySelectorAll("[data-proxy]")) b.addEventListener("click", () => $(b.dataset.proxy).click());

const evmOn = () => $("v-wallet").classList.contains("evm-mode");
const walletOpen = () => !$("v-wallet").classList.contains("hidden");

function screen(name, title = "") {
  body.dataset.screen = name;
  $("p-back").classList.toggle("hidden", name === "home");
  $("p-sheet").classList.toggle("hidden", name !== "menu");
  $("p-title").textContent = title;
  $("p-menu").setAttribute("aria-expanded", String(name === "menu"));
  const m = document.querySelector(".pmain");
  if (m) m.scrollTop = 0;
}

function openTab(id, title) {
  const t = $(id);
  if (!t || t.hidden) return;
  t.click();
  screen("pane", title);
}

for (const b of document.querySelectorAll(".edge button")) b.addEventListener("click", () => openTab(b.dataset.tab, b.dataset.title));

const GO = {
  wallets: () => { screen("home"); panel(true); },
  tokens: () => openTab(evmOn() ? "etab-toks" : "tab-tokens", "Tokens"),
  multisig: () => openTab(evmOn() ? "etab-ms" : "tab-vaults", "Multisig"),
  keys: () => openTab(evmOn() ? "etab-keys" : "tab-keys", "Keys"),
  activity: () => { const bus = document.querySelector(".bus"); if (bus) bus.open = true; screen("log", "Activity"); },
  expand: () => $("p-expand").click(),
  lock: () => { screen("home"); $("w-lock").click(); },
};
for (const b of document.querySelectorAll("[data-go]")) b.addEventListener("click", () => GO[b.dataset.go]());

$("p-menu").addEventListener("click", () => {
  if (!walletOpen()) return;
  panel(false);
  if (body.dataset.screen === "menu") screen("home");
  else screen("menu", "Settings");
});
$("p-back-go").addEventListener("click", () => screen("home"));
$("p-alert-go").addEventListener("click", () => { const r = $(evmOn() ? "e-refresh" : "w-refresh"); if (r) r.click(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && body.dataset.screen !== "home" && !document.querySelector("dialog[open]")) screen("home"); });
document.addEventListener("opeq:view", () => { panel(false); screen("home"); });
$("chain-menu").addEventListener("click", () => screen("home"));

function meter(el, left, limit = EXEC_LIMIT) {
  const bar = el.querySelector(".mbar");
  if (!bar.children.length) for (let i = 0; i < 40; i++) bar.append(document.createElement("i"));
  if (!Number.isFinite(left)) { el.classList.add("off"); return; }
  el.classList.remove("off");
  const used = Math.max(0, Math.min(40, Math.round(((limit - left) / limit) * 40)));
  [...bar.children].forEach((x, i) => x.classList.toggle("u", i < used));
  el.classList.toggle("low", left < 100);
  const out = el.querySelector(".mleft");
  out.textContent = "";
  const b = document.createElement("b");
  b.textContent = String(left);
  out.append(b, ` of ${limit} left`);
}

function solKeys() {
  const m = /^(\d+) of (\d+)/.exec($("w-keys").textContent || "");
  return m && $("w-status").textContent.trim() !== "…" ? { left: Number(m[2]) - Number(m[1]), limit: Number(m[2]) } : { left: NaN, limit: EXEC_LIMIT };
}
const solLeft = () => solKeys().left;

function evmLeft() {
  const t = ($("e-left").textContent || "").trim();
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

function setOff(b, off) { if (b.disabled !== off) b.disabled = off; }

function edgeSync(edge) {
  let n = 0;
  for (const b of edge.querySelectorAll("button")) {
    const t = $(b.dataset.tab);
    b.hidden = !t || t.hidden;
    if (!b.hidden) n++;
  }
  edge.classList.toggle("n3", n === 3);
  edge.classList.toggle("n2", n === 2);
  edge.classList.toggle("n1", n === 1);
}

let queued = false;
function sync() {
  queued = false;
  const slot = document.querySelector(evmOn() ? "#e-cpu .chain-slot" : "#cpu .chain-slot");
  if (slot && $("chainbar").parentElement !== slot) slot.append($("chainbar"));
  const ports = [...$("ports").children];
  const at = ports.findIndex((b) => b.classList.contains("active"));
  $("p-wname").textContent = at >= 0 ? `Wallet ${at + 1}` : "Wallets";
  $("w-home-bal").textContent = $("w-bal").textContent;
  const solOff = $("dock").classList.contains("hidden");
  const notActive = !$("w-init-box").classList.contains("hidden");
  const solUnknown = $("w-status").textContent.trim() === "…";
  for (const b of $("w-edge").querySelectorAll("button")) setOff(b, solOff || solUnknown || (notActive && b.dataset.tab !== "tab-receive"));
  edgeSync($("w-edge"));
  $("w-home-toks").classList.toggle("hidden", solOff || solUnknown || $("w-tokens-box").classList.contains("hidden"));
  meter($("w-meter"), solKeys().left, solKeys().limit);
  if ($("t-list") && $("t-list").parentElement !== $("w-home-list")) $("w-home-list").append($("t-list"));
  if ($("evm-view")) {
    const eOff = $("e-dock").classList.contains("hidden");
    for (const b of $("e-edge").querySelectorAll("button")) setOff(b, eOff);
    edgeSync($("e-edge"));
    $("e-home-toks").classList.toggle("hidden", eOff);
    $("e-home-bal").textContent = $("e-bal").textContent;
    $("e-home-sym").textContent = $("e-sym").textContent;
    $("e-home-name").textContent = ($("chain-name").textContent || "").trim() || "Native coin";
    $("e-home-ico").style.backgroundImage = getComputedStyle($("chain-ico")).backgroundImage;
    meter($("e-meter"), evmLeft());
    if ($("e-toks") && $("e-toks").parentElement !== $("e-home-list")) $("e-home-list").append($("e-toks"));
  }
  const left = evmOn() ? evmLeft() : solLeft();
  $("m-left").textContent = Number.isFinite(left) ? `${left} left` : "";
  $("m-expand").hidden = !globalThis.chrome?.runtime?.getURL;
  $("p-menu").hidden = !walletOpen();
  const unknown = evmOn() ? false : solUnknown;
  const top = $("log").firstElementChild;
  const err = unknown && top && top.classList.contains("err") ? (top.querySelector(".msg") || top).textContent : "";
  $("p-alert-text").textContent = err ? `${err}. Balance and status are not loaded yet.` : "";
  $("p-alert").classList.toggle("hidden", !(walletOpen() && body.dataset.screen === "home" && err));
  if (body.dataset.screen !== "home" && !walletOpen()) screen("home");
}
const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(sync); } };
new MutationObserver(schedule).observe($("v-wallet"), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden"] });
for (const e of document.querySelectorAll(".edge")) new MutationObserver(schedule).observe(e, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
new MutationObserver(schedule).observe($("chainbar"), { subtree: true, childList: true, characterData: true, attributes: true });
new MutationObserver(schedule).observe($("log"), { childList: true });
new MutationObserver(schedule).observe($("ports"), { subtree: true, childList: true, attributes: true });
screen("home");
sync();
