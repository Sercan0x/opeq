import { EvmChain, checkAddress, parseUnits, formatUnits, REKEY_SOON, EXEC_GAS, REKEY_GAS, SETUP_GAS } from "./lib/evmwallet.js";
import { encodeErc20Transfer, factoryAddress } from "./lib/evmwots.js";
import { IdbStore } from "./lib/vaultstore.js";
import { NET } from "./net.js";

const $ = (id) => document.getElementById(id);
const store = new IdbStore("opeq-evm");
const NETS = NET.evm || [];
const TOK_MAX = 20;
let ui = null;
let chain = null;
let status = null;
let tokens = [];
let loading = null;

export function available() {
  return NETS.length > 0 && !!$("evm-view");
}

function hide(id, on) { $(id).classList.toggle("hidden", on); }

function bar(id, frac) {
  const el = $(id);
  if (frac === null) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}

const CHAIN_KEY = "opeq:chain";
const COLORS = { 1: "#627eea", 8453: "#0052ff", 84532: "#0052ff", 42161: "#28a0f0", 421614: "#28a0f0", 4663: "#ccff00", 11155111: "#627eea" };
let picked = "sol";
function net() { return NETS.find((n) => String(n.chainId) === picked) || NETS[0]; }
const evmOn = () => picked !== "sol";
const CHOICES = () => [{ v: "sol", name: "Solana", tag: NET.mainnet ? "" : "devnet", sol: true }, ...NETS.map((n) => ({ v: String(n.chainId), name: n.name.replace(/ Sepolia$/, ""), tag: /sepolia|test/i.test(n.name) ? "testnet" : "", color: COLORS[n.chainId] || "#8a96a8" }))];

function icon(el, c) {
  el.className = "chain-ico" + (c.sol ? " sol" : "") + (c.tag ? " test" : "");
  el.style.background = c.sol ? "" : c.color;
}

function mode() {
  $("v-wallet").classList.toggle("evm-mode", evmOn());
  hide("evm-view", !evmOn());
}

function explorer(kind, v) { return `${net().explorer}/${kind}/${v}`; }

function last(text, hash) {
  $("e-last-text").textContent = text;
  $("e-last-link").href = explorer("tx", hash);
  hide("e-last", false);
}

const tokKey = () => `opeq:evm-tokens:${chain.vaultId}:${chain.id}`;

async function loadTokens() {
  let list = [];
  try { list = (await chrome.storage.local.get(tokKey()))[tokKey()]; } catch {}
  return (Array.isArray(list) ? list : []).filter((a) => typeof a === "string" && /^0x[0-9a-f]{40}$/.test(a)).slice(0, TOK_MAX);
}

async function saveTokens(list) {
  try { await chrome.storage.local.set({ [tokKey()]: list.slice(0, TOK_MAX) }); } catch {}
}

export function stop() {
  if (chain && chain.master) chain.master.fill(0);
  chain = null; status = null; tokens = []; loading = null;
  if (!available()) return;
  for (const id of ["e-main", "e-gas", "e-setup", "e-take", "e-send", "e-rekey", "e-last", "e-load", "e-rw"]) hide(id, true);
  $("e-bal").textContent = $("e-state").textContent = "…";
  $("e-ok").textContent = $("e-err").textContent = "";
}

async function open() {
  const s = ui.session();
  if (!s) return;
  const n = net();
  if (chain && chain.vaultId === s.id && chain.id === n.chainId) return refresh();
  if (loading) return loading;
  loading = (async () => {
    if (chain && chain.master) chain.master.fill(0);
    chain = new EvmChain({ chain: n, store, macKey: s.macKey, vaultId: s.id, master: s.master.slice(), compute: ui.compute });
    hide("e-load", false);
    try {
      await chain.loadIdentity((p) => { $("e-load-bar").style.width = `${Math.round(p * 100)}%`; });
    } finally { hide("e-load", true); }
    $("e-addr").textContent = chain.account;
    $("e-gas-addr").textContent = chain.feeAddress;
    $("e-explorer").href = explorer("address", chain.account);
    hide("e-main", false);
    hide("e-gas", false);
    await refresh();
  })();
  try { await loading; } finally { loading = null; }
}

async function refresh() {
  if (!chain) return;
  const c = chain;
  const s = await c.status();
  if (c !== chain) return;
  status = s;
  const sym = c.chain.symbol;
  $("e-bal").textContent = formatUnits(s.bal, 18);
  $("e-sym").textContent = sym;
  $("e-gas-bal").textContent = `${formatUnits(s.feeBal, 18)} ${sym}`;
  $("e-gas").classList.toggle("low", s.feeBal === 0n);
  $("e-state").textContent = { setup: s.st.deployed ? "needs setup" : "not set up", ready: "active", adopt: "finishing a rekey", other: "other device" }[s.state];
  $("e-tree").textContent = s.state === "ready" ? `tree ${s.st.epoch}` : "–";
  $("e-left").textContent = s.state === "ready" ? String(s.left) : "–";
  hide("e-setup", s.state !== "setup");
  hide("e-take", s.state !== "other");
  hide("e-send", s.state !== "ready");
  hide("e-rekey", s.state !== "ready");
  hide("e-rw", !(s.state === "ready" && s.left <= REKEY_SOON));
  $("e-rw-text").textContent = `${s.left} signatures left on this network's key tree. Rekey soon, it takes one transaction.`;
  await refreshTokens();
}

async function refreshTokens() {
  const c = chain;
  const list = await loadTokens();
  const found = [];
  for (const a of list) { try { found.push(await c.token(a)); } catch {} }
  if (c !== chain) return;
  tokens = found;
  const box = $("e-toks"), sel = $("e-asset"), keep = sel.value;
  box.textContent = ""; sel.textContent = "";
  const opt = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o); };
  opt("native", `${c.chain.symbol} (${formatUnits(status.bal, 18)})`);
  for (const t of tokens) {
    const row = document.createElement("div"); row.className = "tok";
    const left = document.createElement("div");
    const nm = document.createElement("b"); nm.textContent = `${t.symbol} (unverified)`;
    const m = document.createElement("span"); m.className = "mint mono"; m.textContent = t.address;
    left.append(nm, m);
    const right = document.createElement("div"); right.className = "mono amt"; right.textContent = formatUnits(t.balance, t.decimals, t.decimals);
    row.append(left, right); box.append(row);
    opt(t.address, `${t.symbol} ${t.address.slice(0, 6)}…${t.address.slice(-4)} (${formatUnits(t.balance, t.decimals, t.decimals)})`);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function progressTo(id) {
  bar(id, 0);
  return (p) => bar(id, p);
}

async function feeText(gas) {
  return `about ${formatUnits(await chain.costOf(gas), 18, 8)} ${chain.chain.symbol}, paid by the gas key`;
}

function tag() { return { tag: `${chain.chain.name}, test funds` }; }

async function recipient(text) {
  const to = checkAddress(text);
  if (to === chain.account) throw new Error("that is this EVM account's own address");
  if (to === chain.feeAddress.toLowerCase()) throw new Error("that is your gas key. It only pays network fees and is not quantum-safe, so never keep savings there");
  if (to === factoryAddress()) throw new Error("that is the OPEQ factory contract, not a wallet");
  const code = await chain.rpc.code(to);
  return code !== "0x" ? "This address is a contract, not a plain wallet. Make sure it can receive this asset." : "";
}

function bind() {
  const btn = $("chain-btn"), menu = $("chain-menu");
  const choices = CHOICES();
  const paint = () => {
    const c = choices.find((x) => x.v === picked);
    icon($("chain-ico"), c);
    $("chain-name").textContent = c.name;
    $("chain-tag").textContent = c.tag;
    hide("chain-tag", !c.tag);
    for (const li of menu.children) li.setAttribute("aria-selected", String(li.dataset.v === picked));
  };
  menu.textContent = "";
  for (const c of choices) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.v = c.v;
    li.tabIndex = -1;
    const i = document.createElement("i"); icon(i, c);
    const nm = document.createElement("span"); nm.className = "chain-name"; nm.textContent = c.name;
    li.append(i, nm);
    if (c.tag) { const t = document.createElement("em"); t.className = "chain-tag"; t.textContent = c.tag; li.append(t); }
    menu.append(li);
  }
  let saved = null;
  try { saved = localStorage.getItem(CHAIN_KEY); } catch {}
  if (choices.some((c) => c.v === saved)) picked = saved;
  const showBar = () => hide("chainbar", $("v-wallet").classList.contains("hidden"));
  showBar();
  paint();
  mode();
  const tryOpen = () => {
    if (!evmOn() || !ui.session() || $("v-wallet").classList.contains("hidden")) return;
    if (ui.busy()) { setTimeout(tryOpen, 400); return; }
    ui.guard("e-err", null, open);
  };
  const close = (focus) => { hide("chain-menu", true); btn.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); if (focus) btn.focus(); };
  const outside = (e) => { if (!$("chainbar").contains(e.target)) close(false); };
  const choose = (v, keyboard) => {
    close(keyboard);
    if (v === picked) return;
    picked = v;
    try { localStorage.setItem(CHAIN_KEY, v); } catch {}
    $("e-ok").textContent = $("e-err").textContent = "";
    hide("e-last", true);
    paint();
    mode();
    tryOpen();
  };
  btn.addEventListener("click", () => {
    if (!menu.classList.contains("hidden")) { close(true); return; }
    hide("chain-menu", false);
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    const cur = [...menu.children].find((li) => li.dataset.v === picked) || menu.firstElementChild;
    cur.focus({ focusVisible: false });
  });
  menu.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) choose(li.dataset.v, e.detail === 0); });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.children], i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
    else if ((e.key === "Enter" || e.key === " ") && i >= 0) { e.preventDefault(); choose(items[i].dataset.v, true); }
    else if (e.key === "Tab") close(false);
  });
  document.addEventListener("opeq:view", (e) => { showBar(); if (e.detail !== "v-wallet") close(false); else setTimeout(tryOpen, 0); });
  btn.title = "Switch network";
  $("e-refresh").addEventListener("click", () => ui.guard("e-err", null, refresh));
  $("e-copy").addEventListener("click", (e) => ui.copyTo(e.currentTarget, chain.account, "EVM address copied"));
  $("e-gas-copy").addEventListener("click", (e) => ui.copyTo(e.currentTarget, chain.feeAddress, "gas key address copied"));

  $("e-setup-go").addEventListener("click", () => ui.guard("e-err", "e-ok", async () => {
    const fresh = (await chain.rpc.code(chain.factory)) === "0x";
    const deployed = status && status.st.deployed;
    const gas = (fresh ? SETUP_GAS.factory : 0n) + (deployed ? 0n : SETUP_GAS.account) + REKEY_GAS;
    if (!(await ui.ask({ ...tag(), title: `Set up on ${chain.chain.name}`,
      rows: [["Your EVM address", chain.account, true], ["Network fee", await feeText(gas)]],
      notes: [{ text: `Up to ${1 + (fresh ? 1 : 0) + (deployed ? 0 : 1)} transactions from your gas key.${fresh ? " The first one installs the OPEQ factory on this network, once for everyone." : ""}` }, { text: "This builds a key tree for this network. It takes about 20 seconds." }] }, "Set up"))) return;
    $("e-setup-step").textContent = "";
    try {
      await chain.setup(progressTo("e-setup-prog"), (m) => { $("e-setup-step").textContent = m.charAt(0).toUpperCase() + m.slice(1); });
    } finally { bar("e-setup-prog", null); $("e-setup-step").textContent = ""; }
    $("e-ok").textContent = `set up on ${chain.chain.name}`;
    ui.log(`EVM account ready on ${chain.chain.name}`, "ok");
    await refresh();
  }));

  $("e-take-go").addEventListener("click", () => ui.guard("e-err", "e-ok", async () => {
    if (!(await ui.ask({ ...tag(), title: "Use on this device",
      rows: [["Network fee", await feeText(REKEY_GAS)]],
      notes: [{ text: `This sends one rekey transaction on ${chain.chain.name}. Any other copy of these words stops signing on this network until it does the same.`, warn: true }] }, "Use here"))) return;
    try { await chain.takeover(progressTo("e-take-prog"), (h) => last("Rekey sent.", h)); } finally { bar("e-take-prog", null); }
    $("e-ok").textContent = "this device now signs on this network";
    ui.log(`EVM: this device now signs on ${chain.chain.name}`, "ok");
    await refresh();
  }));

  const rekey = () => ui.guard("e-err", "e-ok", async () => {
    if (!(await ui.ask({ ...tag(), title: "Move to a fresh key tree", rows: [["Network fee", await feeText(REKEY_GAS)]],
      notes: [{ text: "Your address, balance and words stay the same. This sends one transaction." }] }, "Rekey"))) return;
    try { await chain.rekey(progressTo("e-rekey-prog"), (h) => last("Rekey sent.", h)); } finally { bar("e-rekey-prog", null); }
    $("e-ok").textContent = "rekeyed";
    ui.log(`EVM rekeyed on ${chain.chain.name}`, "ok");
    await refresh();
  });
  $("e-rekey-go").addEventListener("click", rekey);
  $("e-rw-go").addEventListener("click", rekey);

  $("e-tok-go").addEventListener("click", () => ui.guard("e-err", "e-ok", async () => {
    const t = await chain.token($("e-tok").value);
    const list = await loadTokens();
    if (!list.includes(t.address)) {
      if (list.length >= TOK_MAX) throw new Error(`at most ${TOK_MAX} tokens per network`);
      await saveTokens([...list, t.address]);
    }
    $("e-tok").value = "";
    $("e-ok").textContent = `added ${t.symbol}`;
    await refreshTokens();
  }));

  $("e-send-go").addEventListener("click", () => ui.guard("e-err", "e-ok", async () => {
    const asset = $("e-asset").value;
    const warn = await recipient($("e-to").value);
    const to = checkAddress($("e-to").value);
    const s = await chain.status();
    let calls, title, rows;
    if (asset === "native") {
      const v = parseUnits($("e-amt").value, 18);
      if (v > s.bal) throw new Error(`not enough ${chain.chain.symbol}: the account holds ${formatUnits(s.bal, 18)}`);
      calls = [{ to, value: v, data: new Uint8Array(0) }];
      title = `Send ${formatUnits(v, 18, 18)} ${chain.chain.symbol}`;
      rows = [["To", to, true]];
    } else {
      const t = await chain.token(asset);
      const v = parseUnits($("e-amt").value, t.decimals);
      if (v > t.balance) throw new Error(`not enough ${t.symbol}: the account holds ${formatUnits(t.balance, t.decimals, t.decimals)}`);
      calls = [{ to: t.address, value: 0n, data: encodeErc20Transfer(to, v) }];
      title = `Send ${formatUnits(v, t.decimals, t.decimals)} ${t.symbol}`;
      rows = [["To", to, true], ["Token contract", t.address, true]];
    }
    rows.push(["Network fee", await feeText(EXEC_GAS)]);
    const notes = [{ text: "Signed with one quantum-resistant one-time key." }];
    if (asset !== "native") notes.push({ text: "Anyone can create a token with any name. Check the token contract above against the project's official site.", warn: true });
    if (warn) notes.push({ text: warn, warn: true });
    if (!(await ui.ask({ ...tag(), title, rows, notes }, "Send"))) return;
    const pr = progressTo("e-send-prog");
    pr(0.3);
    let res;
    try { res = await chain.execute(calls, (h) => { pr(0.7); last(`${title} sent.`, h); }); } finally { bar("e-send-prog", null); }
    $("e-ok").textContent = title.replace(/^Send/, "sent");
    last(`${title} confirmed.`, res.hash);
    ui.log(`EVM: ${title.toLowerCase()} on ${chain.chain.name}`, "ok");
    $("e-amt").value = "";
    await refresh();
  }));
}

export function init(api) {
  if (!available()) {
    if ($("chainbar")) $("chainbar").remove();
    if ($("evm-view")) $("evm-view").remove();
    return;
  }
  ui = api;
  bind();
}
