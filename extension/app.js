import * as P from "./lib/protocol.js";
import { Engine, Session, Inactive, EXEC_LIMIT } from "./lib/engine.js";
import { IdbStore, macKeyFrom } from "./lib/vaultstore.js";
import { Rpc, pubkey, b58encode, SYSTEM, concat, u32, u64, eq, isOnCurve, unhex } from "./lib/solana.js";
import * as T from "./lib/tokens.js";
import * as J from "./lib/jupiter.js";
import { feePayer } from "./feekey.js";
import * as keep from "./keep.js";
import { NET } from "./net.js";

const PROGRAM = NET.program;
const EXPLORER = "https://explorer.solana.com";
const LAMPORTS = 1000000000;
const FEE_LOW = 2000000;
const FEE_TOPUP = 10000000n;
const FEE_KEEP = 5000000;
const TX_FEE = 5000;
const MAX_PRIORITY = 100000;
const VAULT_KEEP = 1000000n;
const TX_LIMIT = 1232;
const CU_SEND = 260000, CU_TOKEN = 400000, CU_SWAP = 600000;
const REKEY_SOON = 100, REKEY_NOW = 20;
const RENT_FLOOR = 890880n;
const FEE_SURPLUS = 30000000;
const LOADERS = ["BPFLoaderUpgradeab1e11111111111111111111111", "BPFLoader2111111111111111111111111111111111", "BPFLoader1111111111111111111111111111111111", "NativeLoader1111111111111111111111111111111"];
const $ = (id) => document.getElementById(id);
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const POPUP = document.body.dataset.mode === "popup";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function notes(...parts) {
  return parts.flatMap((x) => String(x || "").split("\n")).map((s) => s.trim()).filter(Boolean)
    .map((text) => ({ text, warn: /^(Warning|This token|New accounts|After this|This address|Anyone can)/.test(text) }));
}

function ask(msg, yes = "Confirm") {
  const d = $("ask"), box = $("ask-text");
  box.textContent = "";
  if (typeof msg === "string") box.append(el("p", "", msg));
  else {
    if (msg.tag) box.append(el("span", NET.mainnet ? "ask-tag" : "ask-tag test", msg.tag));
    if (msg.title) box.append(el("h3", "ask-title", msg.title));
    for (const [k, v, addr] of msg.rows || []) {
      const r = el("div", "ask-row");
      r.append(el("span", "ask-k", k), el(addr ? "code" : "span", addr ? "ask-v ask-addr" : "ask-v", v));
      box.append(r);
    }
    for (const n of msg.notes || []) box.append(el("p", n.warn ? "ask-note caution" : "ask-note", n.text));
  }
  $("ask-yes").textContent = yes;
  d.showModal();
  $("ask-no").focus();
  return new Promise((res) => {
    const timer = setTimeout(() => done(false), 60000);
    const done = (v) => { clearTimeout(timer); d.close(); $("ask-yes").onclick = $("ask-no").onclick = d.oncancel = null; res(v); };
    $("ask-yes").onclick = () => done(true);
    $("ask-no").onclick = () => done(false);
    d.oncancel = () => done(false);
  });
}

class WorkerCompute {
  constructor() {
    this.w = new Worker(new URL("./lib/worker.js", import.meta.url), { type: "module" });
    this.n = 0;
    this.pending = new Map();
    this.w.onmessage = (e) => {
      const m = e.data, h = this.pending.get(m.id);
      if (!h) return;
      if ("progress" in m) { if (h.progress) h.progress(m.progress); return; }
      this.pending.delete(m.id);
      if (m.error) h.rej(new Error(m.error)); else h.res(m.result);
    };
  }

  run(op, args, progress) {
    const id = ++this.n;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, progress });
      this.w.postMessage({ id, op, args });
    });
  }
}

const rpc = new Rpc(NET.rpc);
const store = new IdbStore();
const engine = new Engine({ rpc, program: PROGRAM, store, compute: new WorkerCompute(), payer: null });
engine.genesis = NET.genesis;
engine.priceFor = async (cuLimit, keys) => {
  try {
    const recent = await rpc.call("getRecentPrioritizationFees", [keys.slice(0, 128).map(b58encode)]);
    if (!Array.isArray(recent)) return 0;
    const fees = recent.slice(0, 300).map((x) => x && x.prioritizationFee).filter((f) => Number.isSafeInteger(f) && f >= 0).sort((a, b) => a - b);
    if (!fees.length) return 0;
    return Math.max(0, Math.min(fees[Math.floor(fees.length * 0.75)], Math.floor((MAX_PRIORITY * 1e6) / cuLimit)));
  } catch { return 0; }
};
let session = null;
let current = null;
let busy = false;
let pending = null;

const VIEWS = ["v-welcome", "v-create", "v-recover", "v-unlock", "v-wallet"];
function show(id) {
  for (const v of VIEWS) $(v).classList.toggle("hidden", v !== id);
  document.dispatchEvent(new CustomEvent("opeq:view", { detail: id }));
}
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function setProgress(id, frac) {
  const el = $(id);
  if (frac === null) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}

const LOG_MAX = 40;
const SIG_RE = /([1-9A-HJ-NP-Za-km-z]{80,90})/;
let logKey = null;

function stamp(t) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

function entryEl(e) {
  const row = el("div", `entry ${e.cls}`);
  const body = el("span", "body");
  const meta = el("span", "meta");
  meta.append(el("time", "", stamp(e.t)));
  if (e.sig) {
    const a = el("a", "", "view on explorer");
    a.href = `${EXPLORER}/tx/${e.sig}${NET.explorerQuery}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    meta.append(a);
  }
  body.append(el("span", "msg", e.text.charAt(0).toUpperCase() + e.text.slice(1)), meta);
  row.append(el("i", "dot"), body);
  return row;
}

function logCount() {
  const n = $("log").children.length;
  $("log-count").textContent = n ? String(n) : "";
}

function log(text, cls, keepIt = true) {
  const m = SIG_RE.exec(text);
  const msg = (m ? text.slice(0, m.index) + text.slice(m.index + m[1].length) : text).replace(/[\s:]+$/, "").trim().slice(0, 300);
  const e = { t: Date.now(), text: msg, cls: cls === "ok" || cls === "err" ? cls : "", sig: m ? m[1] : null };
  $("log").prepend(entryEl(e));
  while ($("log").children.length > LOG_MAX) $("log").lastChild.remove();
  logCount();
  const k = logKey;
  if (!k || !keepIt || !e.cls) return;
  const prev = $("log").children[1];
  if (prev && prev.querySelector(".msg") && prev.querySelector(".msg").textContent.toLowerCase() === (e.text.charAt(0).toUpperCase() + e.text.slice(1)).toLowerCase() && !e.sig) return;
  chrome.storage.local.get(k).then((v) => chrome.storage.local.set({ [k]: [e, ...(Array.isArray(v[k]) ? v[k] : [])].slice(0, LOG_MAX) })).catch(() => {});
}

async function loadLog(id) {
  logKey = id ? `opeq:log:${id}` : null;
  $("log").textContent = "";
  let list = [];
  if (logKey) try { list = (await chrome.storage.local.get(logKey))[logKey]; } catch {}
  for (const e of (Array.isArray(list) ? list : []).slice(0, LOG_MAX).reverse()) {
    if (!e || typeof e.text !== "string" || !Number.isFinite(e.t)) continue;
    $("log").prepend(entryEl({ t: e.t, text: e.text.slice(0, 300), cls: e.cls === "ok" || e.cls === "err" ? e.cls : "", sig: typeof e.sig === "string" && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(e.sig) ? e.sig : null }));
  }
  logCount();
}
engine.log = (m) => log(m);

function friendly(e) {
  let msg = String(e.message || e).slice(0, 300);
  if (e.fromRpc) msg = `The RPC answered: ${msg.slice(0, 160)}`;
  const m = /error (\d+)\)/.exec(msg);
  if (m && P.ERRORS[m[1]] && e.program === PROGRAM) msg += `: ${P.ERRORS[m[1]]}`;
  if (/insufficient lamports|0x1\b/.test(msg + (e.logs || []).join(" "))) msg += "\nNot enough SOL in the wallet for this amount.";
  if (/User rejected|rejected the request/i.test(msg)) msg = "You rejected the request in your wallet.";
  if (/invalid base58|not a 32 byte address/.test(msg)) msg = "That is not a Solana address.";
  if (/No routes found/i.test(msg)) msg = "No pool can swap this amount. Try a larger amount or another token.";
  if (/0x1771|SlippageToleranceExceeded/.test(msg + (e.logs || []).join(" "))) msg = "The price moved more than you allowed, so the swap was cancelled. Only the network fee was spent.";
  else if (/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed/.test((e.logs || []).join(" "))) msg = "The pool turned the swap down, usually because its price changed a moment ago. Nothing was swapped and only the network fee was spent. Try again.";
  return msg;
}

function addrOf(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("Enter an address.");
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error("That looks like an Ethereum address. OPEQ needs a Solana address.");
  if (/\s/.test(t)) throw new Error("Remove the spaces inside the address.");
  try { return pubkey(t); } catch { throw new Error("That is not a Solana address."); }
}

function parseSol(text) {
  let t = text.trim();
  if (t.startsWith(".")) t = "0" + t;
  if (!/^\d{1,10}(\.\d{1,9})?$/.test(t)) throw new Error(T.amountError(t, 9));
  const [w, f = ""] = t.split(".");
  const lamports = BigInt(w) * 1000000000n + BigInt((f + "000000000").slice(0, 9));
  if (lamports <= 0n) throw new Error("amount must be more than zero");
  return lamports;
}

const sol = (lamports) => (Number(lamports) / LAMPORTS).toLocaleString("en-US", { maximumFractionDigits: 9 });

function needPayer() { if (!engine.payer || !session) throw new Error("unlock a wallet first"); }

async function startSession(s) {
  engine.payer = await feePayer(s.master, engine.program);
  session = s;
  await loadLog(s.id);
  await keep.save(s.id, s.master, s.macRaw);
  $("fee-none").classList.add("hidden");
  $("fee-on").classList.remove("hidden");
  $("fee-addr").textContent = engine.payer.address;
  $("fee-addr").title = engine.payer.address;
}

function stopFee() {
  engine.payer = null;
  $("fee-on").classList.add("hidden");
  $("fee-none").classList.remove("hidden");
  $("fee-addr").textContent = "";
  $("fee-bal").textContent = "";
}

async function networkFee(cuLimit) {
  return engine.feeFor(cuLimit, await engine.price(cuLimit, [session.wallet, engine.payer.key()]));
}

async function planTopup(inner, tables, spend, allowInline = true) {
  const fee = await rpc.balance(engine.payer.key());
  if (fee >= FEE_LOW) return { amount: 0n, note: "" };
  const free = BigInt(await rpc.balance(session.wallet)) - BigInt(spend);
  let amount = free - VAULT_KEEP;
  if (amount > FEE_TOPUP) amount = FEE_TOPUP;
  if (amount > free / 4n) amount = free / 4n;
  const floor = 2 * (TX_FEE + MAX_PRIORITY);
  if (amount < 2000000n) {
    if (fee < floor) throw new Error(`the fee key is empty (${sol(fee)} SOL) and the wallet has too little SOL to top it up. Send 0.01 SOL to the fee key (Keys tab)`);
    return { amount: 0n, note: "" };
  }
  if (fee < floor) throw new Error(`the fee key is empty; send 0.01 SOL to it once (Keys tab, copy button). Nothing was signed`);
  const ix = feeTopupIx(amount);
  const inline = allowInline && inner.length > 0 && (await session.execSize([...inner, ix], tables)) <= TX_LIMIT;
  const note = inline
    ? `\nThis transaction also moves ${sol(amount)} SOL from your wallet to your fee key, which pays network fees.`
    : `\nFirst, a separate transaction moves ${sol(amount)} SOL from your wallet to your fee key, which pays network fees. That costs one more network fee and one more one-time key.`;
  return { amount, inline, note };
}

async function checkRecipient(to, token) {
  const addr = b58encode(to);
  if (addr === session.id) throw new Error("that is this wallet's own address");
  if (eq(to, engine.payer.key())) throw new Error("that is your fee key. It only pays network fees and is not quantum-safe, so never keep savings there");
  if (eq(to, SYSTEM) || LOADERS.includes(addr)) throw new Error("that is a Solana system address, not a wallet");
  const r = await session.load();
  if (eq(to, P.statePda(unhex(r.aid), engine.program).key)) throw new Error("that is this wallet's internal state account, not a wallet");
  const acc = await rpc.account(to);
  if (acc && (acc.executable || LOADERS.includes(b58encode(acc.owner)))) throw new Error("that address is a program, not a wallet");
  if (acc && (eq(acc.owner, T.TOKEN) || eq(acc.owner, T.TOKEN22))) throw new Error("that address is a token account or a token mint, not a wallet. Ask for the owner's wallet address");
  if (acc && eq(acc.owner, engine.program) && acc.data && acc.data.length) throw new Error("that is the internal state account of an opeq wallet, not a wallet address");
  if (acc && !eq(acc.owner, SYSTEM) && !eq(acc.owner, engine.program)) return `\nWarning: this address is owned by another program (${short(b58encode(acc.owner))}). Funds sent there may be lost.`;
  if (!isOnCurve(to) && !acc) return `\nWarning: this address has no private key and has never held anything on ${NET.mainnet ? "mainnet" : "devnet"}. If it is an opeq address from the ${NET.mainnet ? "devnet" : "mainnet"} app, funds sent here are lost.`;
  if (!isOnCurve(to)) return "\nNote: this address has no private key (a program address). That is normal for opeq wallets, but double check it.";
  return "";
}

function feeTopupIx(lamports) {
  return [SYSTEM, [[session.wallet, true, true], [engine.payer.key(), false, true]], concat(u32(2), u64(lamports))];
}

async function topup(plan, spend) {
  if (!plan.amount) return [];
  const have = BigInt(await rpc.balance(session.wallet)) - BigInt(spend) - VAULT_KEEP;
  if (have < plan.amount) throw new Error("the wallet balance changed after you confirmed. Nothing was signed, try again");
  const amount = plan.amount;
  const ix = feeTopupIx(amount);
  if (plan.inline) {
    log(`this transaction also tops up the fee key with ${sol(amount)} SOL`);
    return [ix];
  }
  const sig = await signed("topping up the fee key", (pr) => session.exec([ix], CU_SEND, pr));
  log(`fee key topped up with ${sol(amount)} SOL: ${sig}`, "ok");
  return [];
}

async function run(text, inner, plan, { cu = CU_SEND, tables = [], spend = 0n, verify = null } = {}) {
  needPayer();
  const extra = await topup(plan, spend);
  const sig = await signed(text, (pr) => session.exec([...inner, ...extra], cu, pr, tables, verify));
  refreshFee().catch(() => {});
  return sig;
}

function rekeyWarn(left) {
  const box = $("w-rw");
  if (!box) return;
  box.classList.toggle("hidden", left > REKEY_SOON);
  box.classList.toggle("urgent", left <= REKEY_NOW);
  $("w-rw-text").textContent = left <= REKEY_NOW
    ? `Only ${left} signatures left on this key tree. Rekey now to keep sending.`
    : `${left} signatures left on this key tree. Rekey soon, it takes one transaction.`;
}

async function guard(errId, okId, fn) {
  if (busy) return;
  busy = true;
  const buttons = document.querySelectorAll(".rig button, .pmain button, #p-panel button");
  buttons.forEach((b) => (b.disabled = true));
  if (errId) $(errId).textContent = "";
  if (okId) $(okId).textContent = "";
  try { await fn(); }
  catch (e) { if (errId) $(errId).textContent = friendly(e); log(friendly(e), "err", !!(e.sent || e.maybeLanded)); }
  finally { busy = false; buttons.forEach((b) => (b.disabled = false)); }
}

function setDrive(state, text) {
  $("drive").className = `drive mono ${state}`;
  $("drive-text").textContent = text;
}

async function vaults() {
  return (await store.all()).filter((r) => r.program === PROGRAM).sort((a, b) => a.created - b.created);
}
const remember = (id) => { try { localStorage.setItem("opeq:last", id); } catch {} };
const lastVault = () => { try { return localStorage.getItem("opeq:last"); } catch { return null; } };

async function refreshPorts() {
  const box = $("ports");
  box.textContent = "";
  for (const r of await vaults()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "port" + (current === r.id ? " active" : "") + (session && session.id === r.id ? " live" : "");
    const stick = document.createElement("span"); stick.className = "port-stick";
    const led = document.createElement("i"); stick.append(led);
    const txt = document.createElement("span");
    const name = document.createElement("b"); name.className = "mono"; name.textContent = short(r.id);
    const st = document.createElement("small"); st.textContent = session && session.id === r.id ? "unlocked" : "locked";
    txt.append(name, st);
    b.append(stick, txt);
    b.addEventListener("click", () => openVault(r.id));
    box.append(b);
  }
}

function openVault(id) {
  if (busy) return;
  current = id;
  remember(id);
  if (session && session.id === id) { showWallet(); return; }
  if (session) lockVault("");
  session = null;
  $("u-note").classList.add("hidden");
  $("u-id").textContent = id;
  $("u-pw").value = "";
  $("u-err").textContent = "";
  show("v-unlock");
  setDrive("locked", "wallet locked");
  refreshPorts();
  $("u-pw").focus();
}

function renderDimms(left) {
  const used = EXEC_LIMIT - left;
  $("keys-fill").style.width = `${((used / EXEC_LIMIT) * 100).toFixed(2)}%`;
  $("w-keys").textContent = `${used} of ${EXEC_LIMIT} one-time keys used`;
}

function initTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  const pick = (t) => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      $(x.getAttribute("aria-controls")).classList.toggle("hidden", !on);
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => pick(t));
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      pick(n); n.focus();
    });
  });
  pick(tabs[0]);
}

async function showWallet() {
  show("v-wallet");
  setDrive("on", `wallet unlocked, ${NET.name}`);
  await refreshWallet();
  refreshPorts();
}

async function refreshWallet() {
  if (!session) return;
  const r = await session.load();
  $("w-addr").textContent = session.id;
  $("v-addr").textContent = session.id;
  $("i-addr").textContent = engine.payer.address;
  $("w-explorer").href = `${EXPLORER}/address/${session.id}${NET.explorerQuery}`;
  const [bal, info] = await Promise.all([rpc.balance(session.wallet), session.status()]);
  const st = info.st;
  const inactive = info.state === "inactive";
  $("w-take-box").classList.toggle("hidden", !inactive);
  $("dock").classList.toggle("hidden", inactive);
  $("w-bal").textContent = (bal / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });
  if (r.inflight && !inactive) {
    const note = await session.ackInflight(st);
    if (note.message) log(note.message, note.state === "pending" ? "err" : "ok", note.state !== "pending");
  }
  $("w-init-box").classList.toggle("hidden", !!st);
  await refreshFee();
  for (const id of ["w-send-box", "w-more", "w-rekey-box", "w-tokens-box"]) $(id).classList.toggle("hidden", !st);
  for (const id of ["pre-recv", "pre-tok", "pre-swap"]) if ($(id)) $(id).classList.toggle("hidden", !!st);
  if ($("j-box")) $("j-box").classList.toggle("hidden", !st || !NET.jupiter);
  $("send-off").classList.toggle("hidden", !!st);
  if (st) {
    const next = Math.max(st.next, r.next_leaf);
    const left = Math.max(0, EXEC_LIMIT - next);
    $("w-status").textContent = inactive ? "not active on this device" : `active, tree ${st.epoch}`;
    $("w-state").textContent = inactive ? "other device" : "active";
    $("w-tree").textContent = `tree ${st.epoch}`;
    $("w-left").textContent = String(left);
    renderDimms(left);
    rekeyWarn(inactive ? EXEC_LIMIT : left);
    refreshTokens().catch((e) => log(`token list: ${e.message}`, "err", false));
  } else {
    $("w-status").textContent = "not activated";
    $("w-state").textContent = "not active yet";
    $("w-tree").textContent = "tree 0";
    $("w-left").textContent = String(EXEC_LIMIT);
    renderDimms(EXEC_LIMIT);
    rekeyWarn(EXEC_LIMIT);
  }
}

function signing(on, text) {
  $("sign").classList.toggle("hidden", !on);
  $("cpu").classList.toggle("busy", on);
  if (text) $("sign-text").textContent = text;
  if (!on) $("sign-bar").style.width = "0%";
}

let tokens = [];
let altCache = null;
async function lookupTables() {
  if (!NET.swap) return [];
  if (!altCache) altCache = [await rpc.lookupTable(T.DEMO.alt)];
  return altCache;
}
const KNOWN = NET.mainnet ? T.KNOWN_MAINNET : T.KNOWN;
const confusable = (s) => s.toUpperCase().replace(/0/g, "O").replace(/[1|!]/g, "I").replace(/[5$]/g, "S").replace(/8/g, "B").replace(/[^A-Z]/g, "");
const KNOWN_NAMES = new Set([...KNOWN.values(), "SOL", "USDC", "USDT", "OPEQ", "TETHER", "USDCOIN", "SOLANA", "JUPITER"].map(confusable));
const KNOWN_DECIMALS = new Map([["So11111111111111111111111111111111111111112", 9], ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6], ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6], ["9tpHqTJ2d8jMZJjZzsf9MCfnCEmbAjsqjPJ56PzSpump", 6]]);
const labels = new Map();
const tokenName = (mint) => {
  const known = KNOWN.get(pubkey(mint).join(","));
  if (known) return known;
  const l = labels.get(mint);
  if (!l) return short(mint);
  const bare = confusable(l);
  return [...KNOWN_NAMES].some((k) => bare.includes(k)) ? `${l} (unverified)` : l;
};

async function refreshTokens() {
  if (!session) return;
  const owner = session;
  const fresh = await rpc.tokenAccounts(session.wallet);
  if (session !== owner) return;
  for (const t of fresh.slice(0, 30)) {
    if (labels.has(t.mint) || KNOWN.has(pubkey(t.mint).join(","))) continue;
    labels.set(t.mint, await T.tokenLabel(rpc, pubkey(t.mint), pubkey(t.program)).catch(() => ""));
  }
  tokens = fresh.filter((t) => t.amount > 0n || (NET.swap && t.mint === b58encode(T.DEMO.mint)));
  const list = $("t-list"), sel = $("t-sel"), chosen = sel.value;
  list.textContent = ""; sel.textContent = "";
  if (!tokens.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = NET.swap ? "No tokens yet. Try a swap." : "No tokens yet. Anyone can send tokens to your address."; list.append(p); }
  tokens.forEach((t, i) => {
    const row = document.createElement("div"); row.className = "tok";
    const left = document.createElement("div");
    const nm = document.createElement("b"); nm.textContent = tokenName(t.mint);
    const m = document.createElement("span"); m.className = "mint mono"; m.textContent = t.mint;
    left.append(nm, m);
    const right = document.createElement("div"); right.className = "mono amt"; right.textContent = T.formatAmount(t.amount, t.decimals);
    row.append(left, right); list.append(row);
    const o = document.createElement("option"); o.value = t.mint;
    o.textContent = `${tokenName(t.mint)}${KNOWN.has(pubkey(t.mint).join(",")) || !labels.get(t.mint) ? "" : ` ${short(t.mint)}`} (${T.formatAmount(t.amount, t.decimals)})`;
    sel.append(o);
  });
  if (tokens.some((t) => t.mint === chosen)) sel.value = chosen;
  fillSwap();
}

const CU_JUP = 1400000;
const SOL_MINT = J.SOL_MINT;
const SWAP_TO = NET.mainnet ? ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "9tpHqTJ2d8jMZJjZzsf9MCfnCEmbAjsqjPJ56PzSpump"] : [];

const jcache = { mints: new Map(), table: null };

async function mintInfo(mint) {
  const info = await J.mintInfo(rpc, mint, jcache);
  if (KNOWN_DECIMALS.has(mint) && KNOWN_DECIMALS.get(mint) !== info.decimals) throw new Error("the RPC reported wrong decimals for a well-known token, refusing to continue");
  if (!KNOWN_DECIMALS.has(mint) && rpc.url !== NET.rpc && !info.crossChecked) {
    const ref = await new Rpc(NET.rpc).account(pubkey(mint)).catch(() => null);
    if (!ref || ref.data[44] !== info.decimals) throw new Error("your RPC and the default one disagree about this token, refusing to continue");
    info.crossChecked = true;
  }
  if (mint !== SOL_MINT && !labels.has(mint) && !KNOWN.has(pubkey(mint).join(","))) labels.set(mint, await T.tokenLabel(rpc, pubkey(mint), info.prog).catch(() => ""));
  return info;
}

const symOf = (mint) => (mint === SOL_MINT ? "SOL" : tokenName(mint));

async function swapPlan(from, to, amount, slip) {
  await mintInfo(from); await mintInfo(to);
  try { return await J.swapPlan(rpc, session, from, to, amount, slip, jcache); }
  catch (e) { throw new Error(String(e.message).replace(/\{(\w+)\}/g, (_, m) => symOf(m))); }
}

let slipBps = 100;

function swapInputs() {
  const from = $("j-from").value;
  let to = $("j-to").value;
  if (to === "other") { to = b58encode(addrOf($("j-mint").value)); }
  if (!from || !to) throw new Error("choose the tokens to swap");
  return { from, to, slip: slipBps };
}

function fillSwap() {
  if (!NET.jupiter) return;
  const fromSel = $("j-from"), toSel = $("j-to"), f = fromSel.value, t = toSel.value;
  fromSel.textContent = ""; toSel.textContent = "";
  const opt = (sel, v, text) => { const o = el("option", "", text); o.value = v; sel.append(o); };
  opt(fromSel, SOL_MINT, "SOL");
  const named = (m) => (KNOWN.has(pubkey(m).join(",")) ? symOf(m) : `${symOf(m)} ${short(m)}`);
  for (const tk of tokens) opt(fromSel, tk.mint, named(tk.mint));
  for (const m of [SOL_MINT, ...SWAP_TO]) opt(toSel, m, symOf(m));
  opt(toSel, "other", "Other");
  if ([...fromSel.options].some((o) => o.value === f)) fromSel.value = f;
  if ([...toSel.options].some((o) => o.value === t)) toSel.value = t;
  else toSel.value = fromSel.value === SOL_MINT ? SWAP_TO[0] || SOL_MINT : SOL_MINT;
  $("j-mint").classList.toggle("hidden", toSel.value !== "other");
  showBalance();
  flipState();
}

function flipState() {
  const to = $("j-to").value;
  $("j-flip").disabled = to === "other" || ![...$("j-from").options].some((o) => o.value === to);
  $("j-flip").title = $("j-flip").disabled ? `You hold no ${symOf(to === "other" ? "" : to) || "of that token"} to pay with` : "Switch pay and receive";
}

function balanceOf(from) {
  if (from === SOL_MINT) return { amount: BigInt(Math.round(Number($("w-bal").textContent.replace(/,/g, "")) * 1e9) || 0), decimals: 9 };
  const held = tokens.find((x) => x.mint === from);
  return held ? { amount: held.amount, decimals: held.decimals } : { amount: 0n, decimals: 0 };
}

function showBalance() {
  const from = $("j-from").value;
  if (!from) return;
  const b = balanceOf(from);
  $("j-have").textContent = `Balance ${T.formatAmount(b.amount, b.decimals)} ${symOf(from)}`;
}

function quoteView(out, min, route) {
  const from = $("j-from").value, b = from ? balanceOf(from) : null;
  try { if (b && $("j-amt").value.trim() && T.parseAmount($("j-amt").value, b.decimals) > b.amount) min = `More than your balance. ${min}`; } catch {}
  $("j-out").textContent = out;
  $("j-min").textContent = min;
  $("j-route").textContent = route;
}

let jupTimer = null, jupSeq = 0;
function scheduleJup() {
  if (!NET.jupiter) return;
  showBalance();
  flipState();
  $("j-mint").classList.toggle("hidden", $("j-to").value !== "other");
  clearTimeout(jupTimer);
  const seq = ++jupSeq;
  if (!$("j-amt").value.trim()) { quoteView("0", "", "Jupiter"); return; }
  $("j-out").classList.add("wait");
  jupTimer = setTimeout(async () => {
    try {
      const { from, to, slip } = swapInputs();
      const fi = await mintInfo(from), ti = await mintInfo(to);
      const amount = T.parseAmount($("j-amt").value, fi.decimals);
      let q, via = false;
      try { q = await J.quote(pubkey(from), pubkey(to), amount, slip, 28, true); }
      catch (e) {
        if (!/no routes/i.test(e.message) || from === SOL_MINT || to === SOL_MINT) throw e;
        const a = await J.quote(pubkey(from), T.WSOL, amount, slip, 28, true);
        q = await J.quote(T.WSOL, pubkey(to), J.minOut(a), slip, 28, true);
        via = true;
      }
      if (seq !== jupSeq) return;
      quoteView(T.formatAmount(BigInt(q.outAmount), ti.decimals), `At least ${T.formatAmount(J.minOut(q), ti.decimals)} ${symOf(to)}`,
        via ? `${symOf(from)} to SOL to ${symOf(to)}` : J.labels(q).join(", "));
    } catch (e) { if (seq === jupSeq) quoteView("0", String(e.message || e).slice(0, 110), "Jupiter"); }
    finally { if (seq === jupSeq) $("j-out").classList.remove("wait"); }
  }, 600);
}

let quoteTimer = null;
function scheduleQuote() {
  if (!NET.swap) return;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    const q = $("x-quote");
    try {
      const buy = $("x-dir").value === "buy";
      const amt = T.parseAmount($("x-amt").value, buy ? 9 : T.DEMO.decimals);
      const out = await T.quote(rpc, buy, amt);
      q.textContent = `about ${T.formatAmount(out, buy ? T.DEMO.decimals : 9)} ${buy ? "DEMO" : "SOL"} (at least ${T.formatAmount((out * 99n) / 100n, buy ? T.DEMO.decimals : 9)})`;
    } catch { q.textContent = "\u00a0"; }
  }, 300);
}

async function signed(text, fn) {
  signing(true, text);
  try {
    return await fn((p) => {
      $("sign-bar").style.width = `${Math.round(p * 100)}%`;
      if (p >= 1) $("sign-text").textContent = "waiting for the chain";
    });
  } finally { signing(false); }
}

const WORDS_MS = 60 * 1000;
let wordsTimer = null;
function hideWords() {
  clearTimeout(wordsTimer);
  $("k-wordlist").textContent = "";
  $("k-panel").classList.add("hidden");
  $("k-auth").classList.add("hidden");
  $("k-pw").value = "";
}

const IDLE_MS = 10 * 60 * 1000, HIDDEN_MS = 5 * 60 * 1000;
let lastActive = Date.now(), hiddenAt = null, lastRefresh = Date.now();

function wipeInputs() {
  for (const id of ["u-pw", "c-pw", "c-pw2", "r-pw", "r-pw2", "r-words", "k-pw"]) $(id).value = "";
  $("c-words").textContent = "";
  $("c-quiz").textContent = "";
}

function lockVault(reason) {
  wipeInputs();
  if (!session) return;
  loadLog(null);
  if (session.master) session.master.fill(0);
  if (session.macRaw) session.macRaw.fill(0);
  session.master = null;
  session = null;
  stopFee();
  keep.clear();
  hideWords();
  if (pending) { pending.words = null; pending.pw = null; pending = null; }
  if (current) {
    openVault(current);
    $("u-note").textContent = reason || "";
    $("u-note").classList.toggle("hidden", !reason);
  } else { show("v-welcome"); refreshPorts(); }
}

function initAutoLock() {
  let kept = 0;
  const touch = () => {
    if (session && !busy && Date.now() - lastActive > IDLE_MS) { lockVault("Locked after 10 minutes without activity."); return; }
    lastActive = Date.now();
    if (session && lastActive - kept > 20000) { kept = lastActive; keep.touch(); }
  };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, touch, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > HIDDEN_MS && session && !busy) lockVault("Locked because the tab was in the background for more than 5 minutes.");
    hiddenAt = null;
    touch();
  });
  setInterval(() => {
    if (session && !busy && !document.hidden && Date.now() - lastRefresh > 20000) {
      lastRefresh = Date.now();
      refreshWallet().catch(() => {});
    }
  }, 5000);
  setInterval(() => {
    if (!session && !busy && Date.now() - lastActive > IDLE_MS && (pending || $("r-words").value || $("c-words").textContent)) {
      hideWords(); wipeInputs();
      if (pending) { pending.words = null; pending.pw = null; pending = null; }
      lastActive = Date.now();
      if (current) openVault(current); else show("v-welcome");
      return;
    }
    if (!session || busy) return;
    if (Date.now() - lastActive > IDLE_MS) lockVault("Locked after 10 minutes without activity.");
  }, 15000);
}

function renderWords(el, words) {
  el.textContent = "";
  words.forEach((w, i) => {
    const d = document.createElement("div");
    const n = document.createElement("span");
    n.textContent = i + 1;
    d.append(n, w);
    el.append(d);
  });
}

function initCreate() {
  $("go-create").addEventListener("click", () => {
    for (const id of ["c-pw", "c-pw2"]) $(id).value = "";
    $("c-err").textContent = "";
    $("c1").classList.remove("hidden"); $("c2").classList.add("hidden"); $("c3").classList.add("hidden");
    show("v-create");
    setDrive("idle", "new key");
  });
  $("c-make").addEventListener("click", () => guard("c-err", null, async () => {
    const pw = $("c-pw").value;
    if (pw.trim().length < 10 || pw.replace(/\s/g, "").length < 6) throw new Error("use at least 10 characters, not just spaces");
    if (pw !== $("c-pw2").value) throw new Error("passwords do not match");
    setProgress("c-prog", 0);
    const { record, words } = await engine.create(pw, (p) => setProgress("c-prog", p));
    setProgress("c-prog", null);
    pending = { record, words, pw };
    renderWords($("c-words"), words);
    $("c1").classList.add("hidden"); $("c2").classList.remove("hidden");
  }));
  $("c-written").addEventListener("click", () => {
    const picks = [];
    while (picks.length < 3) {
      const i = crypto.getRandomValues(new Uint32Array(1))[0] % 24;
      if (!picks.includes(i)) picks.push(i);
    }
    picks.sort((a, b) => a - b);
    const q = $("c-quiz");
    q.textContent = "";
    for (const i of picks) {
      const lab = document.createElement("label"); lab.className = "f"; lab.textContent = `Word #${i + 1}`;
      const inp = document.createElement("input"); inp.type = "text"; inp.autocomplete = "off"; inp.spellcheck = false; inp.dataset.idx = i;
      q.append(lab, inp);
    }
    $("c-err").textContent = "";
    $("c2").classList.add("hidden"); $("c3").classList.remove("hidden");
  });
  $("c-back").addEventListener("click", () => { $("c3").classList.add("hidden"); $("c2").classList.remove("hidden"); });
  $("c-check").addEventListener("click", () => guard("c-err", null, async () => {
    for (const inp of $("c-quiz").querySelectorAll("input")) {
      if (inp.value.trim().toLowerCase() !== pending.words[Number(inp.dataset.idx)]) throw new Error(`word #${Number(inp.dataset.idx) + 1} does not match`);
    }
    await engine.save(pending.record);
    await startSession(await engine.unlock(pending.record, pending.pw));
    current = session.id;
    remember(current);
    log(`wallet ${short(session.id)} created`, "ok");
    pending = null;
    $("c-words").textContent = "";
    await showWallet();
  }));
}

function initRecover() {
  $("go-recover").addEventListener("click", () => {
    $("r-words").value = $("r-pw").value = $("r-pw2").value = "";
    $("r-err").textContent = "";
    show("v-recover");
    setDrive("idle", "restore key");
  });
  $("r-go").addEventListener("click", () => guard("r-err", null, async () => {
    const pw = $("r-pw").value;
    if (pw.trim().length < 10 || pw.replace(/\s/g, "").length < 6) throw new Error("use at least 10 characters, not just spaces");
    if (pw !== $("r-pw2").value) throw new Error("passwords do not match");
    setProgress("r-prog", 0);
    const words = $("r-words").value;
    let record = await engine.recover(words, pw, (p) => setProgress("r-prog", p));
    if (!(await engine.chainState(record).catch(() => null))) {
      setProgress("r-prog", null);
      if (!(await ask("This wallet has never been activated on chain. If you expected funds in it, one of the words is probably wrong. Continue anyway?", "Continue"))) return;
    }
    const existing = await store.get(record.id);
    if (existing) {
      setProgress("r-prog", null);
      if (!(await ask("This wallet already exists in this browser. Replace its password with the new one? Its key counter is kept.", "Replace"))) return;
      record = await engine.replace(record.id, words, pw, (p) => setProgress("r-prog", p));
    } else await engine.save(record);
    setProgress("r-prog", null);
    await startSession(await engine.unlock(record, pw));
    current = session.id;
    remember(current);
    $("r-words").value = "";
    log(`wallet ${short(session.id)} recovered at tree ${record.epoch}. If it is already active on chain, choose Use on this device before sending.`, "ok");
    await showWallet();
  }));
}

function initUnlock() {
  const go = () => guard("u-err", null, async () => {
    await startSession(await engine.unlock(await store.get(current), $("u-pw").value));
    $("u-pw").value = "";
    await showWallet();
  });
  $("u-go").addEventListener("click", go);
  $("u-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("u-forget").addEventListener("click", () => guard("u-err", null, async () => {
    const pw = $("u-pw").value;
    if (!pw) throw new Error("type this wallet's password above first, then choose Remove");
    const check = await engine.unlock(await store.get(current), pw);
    check.master.fill(0);
    if (check.macRaw) check.macRaw.fill(0);
    $("u-pw").value = "";
    if (!(await ask("Remove this wallet from this browser? Its funds stay on chain, but you can only get it back with your 24 recovery words. Make sure you have them written down.", "Remove"))) return;
    await engine.remove(current);
    current = null; session = null;
    show("v-welcome");
    refreshPorts();
  }));
}

async function copyTo(btn, text, note) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    log(`could not copy: ${e.message}`, "err");
    return;
  }
  log(note);
  clearTimeout(btn._copied);
  if (btn.classList.contains("icon-btn")) {
    btn.classList.add("copied");
  } else {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
  }
  btn._copied = setTimeout(() => {
    btn.classList.remove("copied");
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }, 1500);
}

async function sweepFee() {
  const left = (await rpc.balance(engine.payer.key())) - FEE_KEEP - TX_FEE;
  if (left <= 1000000) return;
  const ix = [SYSTEM, [[engine.payer.key(), true, true], [session.wallet, false, true]], concat(u32(2), u64(left))];
  const sig = await engine.submit(ix, (await rpc.slot()) + 150, 50000, [], 0);
  log(`moved ${sol(left)} SOL from the fee key into your opeq wallet: ${sig}`, "ok");
}

async function solCheck(lamports) {
  const bal = BigInt(await rpc.balance(session.wallet));
  const rest = bal - lamports;
  if (rest < 0n) throw new Error(`not enough SOL: the wallet has ${sol(bal)} SOL`);
  if (rest > 0n && rest < RENT_FLOOR) throw new Error(`this would leave ${sol(rest)} SOL, below Solana's 0.00089 SOL minimum. Send everything or leave at least 0.00089 SOL`);
  if (rest === 0n) return "\nAfter this the wallet is empty.";
  return rest < 25000000n ? "\nAfter this the wallet has little SOL left to pay future network fees." : "";
}

function initWallet() {
  $("w-copy").addEventListener("click", (e) => copyTo(e.currentTarget, session.id, "address copied"));
  $("w-refresh").addEventListener("click", () => guard(null, null, refreshWallet));
  $("w-lock").addEventListener("click", () => lockVault(""));
  $("v-copy").addEventListener("click", (e) => copyTo(e.currentTarget, session.id, "address copied"));
  const copyFee = (e) => copyTo(e.currentTarget, engine.payer.address, "fee key address copied");
  $("fee-copy").addEventListener("click", copyFee);
  $("t-fee-copy").addEventListener("click", copyFee);
  $("w-fe-copy").addEventListener("click", copyFee);
  $("i-copy").addEventListener("click", (e) => copyTo(e.currentTarget, engine.payer.address, "activation address copied"));
  $("i-check").addEventListener("click", () => guard("i-err", null, refreshFee));
  $("w-init").addEventListener("click", () => guard("i-err", null, async () => {
    needPayer();
    const bal = await rpc.balance(engine.payer.key());
    if (bal < 3000000 + FEE_KEEP) {
      const w = await rpc.balance(session.wallet);
      throw new Error(`send at least 0.01 SOL to the activation address first (it has ${sol(bal)} SOL).${w > 0 ? ` The ${sol(w)} SOL you sent to the wallet address is safe and stays there, but activation needs SOL on the activation address.` : ""}`);
    }
    signing(true, "activating on chain");
    try {
      const res = await engine.init(await session.load());
      log(res === "already-initialized" ? "already active on chain" : `activated ${res}`, "ok");
      await sweepFee();
    } finally { signing(false); }
    await refreshWallet();
  }));
  $("w-sweep-go").addEventListener("click", () => guard(null, null, async () => {
    needPayer();
    signing(true, "moving SOL from the fee key into your wallet");
    try { await sweepFee(); } finally { signing(false); }
    await refreshWallet();
  }));
  $("w-take").addEventListener("click", () => guard("w-take-err", null, async () => {
    needPayer();
    if (!(await ask("Use this wallet on this device? This sends one rekey transaction. After it, any other browser or device that has these words stops signing until you choose Use on this device there.", "Use here"))) return;
    let sig;
    try { sig = await signed("taking over on this device", (pr) => session.takeover(pr)); }
    catch (e) { throw new Error(`${friendly(e)}\nThe takeover did not complete. Try again here, on this device, until it does. Do not start a takeover on another device meanwhile.`); }
    log(`this device now signs for the wallet: ${sig}`, "ok");
    await refreshWallet();
  }));
  $("s-go").addEventListener("click", () => guard("s-err", "s-ok", async () => {
    needPayer();
    const to = addrOf($("s-to").value);
    const lamports = parseSol($("s-amt").value);
    const amount = $("s-amt").value.trim();
    const warn = await checkRecipient(to, false);
    if (lamports < RENT_FLOOR && !(await rpc.account(to))) throw new Error("the receiving address is empty, so Solana needs at least 0.00089 SOL to create it. Send more. Nothing was signed");
    const low = await solCheck(lamports);
    const inner = [[SYSTEM, [[session.wallet, true, true], [to, false, true]], concat(u32(2), u64(lamports))]];
    const plan = await planTopup(inner, [], lamports);
    if (!(await ask({ tag: NET.mainnet ? "Mainnet, real funds" : "Devnet test funds", title: `Send ${sol(lamports)} ${NET.sol}`,
      rows: [["To", b58encode(to), true], ["Network fee", `about ${sol(await networkFee(CU_SEND))} SOL`]],
      notes: notes(plan.note, low, warn) }, "Send"))) return;
    const sig = await run("reserving a key, grinding the signature", inner, plan, { spend: lamports });
    $("s-ok").textContent = `sent ${amount} SOL`;
    log(`sent ${amount} SOL to ${short(b58encode(to))}: ${sig}`, "ok");
    $("s-amt").value = "";
    await refreshWallet();
  }));
  $("t-go").addEventListener("click", () => guard("t-err", "t-ok", async () => {
    needPayer();
    const t = tokens.find((x) => x.mint === $("t-sel").value);
    if (!t) throw new Error("no token selected");
    const to = addrOf($("t-to").value);
    const warn = await checkRecipient(to, true);
    const amount = T.parseAmount($("t-amt").value, t.decimals);
    if (amount > t.amount) throw new Error("not enough of this token in the wallet");
    const name = tokenName(t.mint), shown = $("t-amt").value.trim();
    const prog = pubkey(t.program), mint = pubkey(t.mint);
    const hasAta = !!(await rpc.account(T.ata(to, mint, prog)));
    const rent = hasAta ? "" : "\nThe receiver has no account for this token yet, so your wallet also pays its rent, about 0.002 SOL.";
    const ext = await T.mintWarnings(rpc, mint, prog);
    const inner = [T.createAtaIdempotent(session.wallet, to, mint, prog),
      T.transferChecked(prog, pubkey(t.account), mint, T.ata(to, mint, prog), session.wallet, amount, t.decimals)];
    const tables = await lookupTables();
    const plan = await planTopup(inner, tables, 2100000n);
    if (!(await ask({ tag: NET.mainnet ? "Mainnet, real funds" : "Devnet test funds", title: `Send ${shown} ${name}`,
      rows: [["To", b58encode(to), true], ["Token mint", t.mint, true], ["Network fee", `about ${sol(await networkFee(CU_TOKEN))} SOL`]],
      notes: notes(rent, ext, plan.note, warn) }, "Send"))) return;
    const sig = await run("signing the token transfer", inner, plan, { cu: CU_TOKEN, tables, spend: 2100000n });
    $("t-ok").textContent = `sent ${shown} ${name}`;
    log(`sent ${shown} ${name} to ${short(b58encode(to))}: ${sig}`, "ok");
    $("t-amt").value = "";
    await refreshWallet();
  }));
  if (NET.jupiter) {
    for (const id of ["j-from", "j-to"]) $(id).addEventListener("change", scheduleJup);
    for (const id of ["j-amt", "j-mint"]) $(id).addEventListener("input", scheduleJup);
    for (const b of $("j-slip").querySelectorAll("button")) b.addEventListener("click", () => {
      slipBps = Number(b.dataset.slip);
      for (const o of $("j-slip").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
      scheduleJup();
    });
    $("j-max").addEventListener("click", () => {
      const from = $("j-from").value, b = balanceOf(from);
      let amt = from === SOL_MINT ? b.amount - 10000000n : b.amount;
      if (amt < 0n) amt = 0n;
      $("j-amt").value = T.formatAmount(amt, b.decimals);
      scheduleJup();
    });
    $("j-flip").addEventListener("click", () => {
      const from = $("j-from").value, to = $("j-to").value;
      if (to === "other" || ![...$("j-from").options].some((o) => o.value === to)) return;
      $("j-from").value = to;
      $("j-to").value = from;
      $("j-amt").value = "";
      scheduleJup();
    });
    $("j-go").addEventListener("click", () => guard("j-err", "j-ok", async () => {
      needPayer();
      if (!(await session.status()).st) throw new Error("Activate the wallet first.");
      const { from, to, slip } = swapInputs();
      const fi = await mintInfo(from), ti = await mintInfo(to);
      const amount = T.parseAmount($("j-amt").value, fi.decimals);
      const shown = T.formatAmount(amount, fi.decimals);
      if (from !== SOL_MINT) {
        const held = tokens.find((x) => x.mint === from);
        if (!held || held.amount < amount) throw new Error(`not enough ${symOf(from)} in the wallet`);
      }
      signing(true, "finding a route on Jupiter");
      let plan;
      try { plan = await swapPlan(from, to, amount, slip); } finally { signing(false); }
      const ntx = plan.legs.reduce((n, l) => n + l.txs.length, 0);
      const rent = plan.legs.reduce((n, l) => n + l.rent, 0n);
      const spend = (from === SOL_MINT ? amount : 0n) + rent + BigInt(ntx) * 200000n;
      const low = from === SOL_MINT ? await solCheck(amount + rent) : "";
      const ext = ti.prog.join(",") === T.TOKEN22.join(",") ? await T.mintWarnings(rpc, pubkey(to), ti.prog) : "";
      if (/transfer fee/.test(ext)) throw new Error(`${symOf(to)} charges a fee on every transfer, which this wallet cannot swap into yet. Nothing was signed`);
      const first = plan.legs[0];
      const topPlan = await planTopup(first.txs[0], first.tables, spend, false);
      const planned = Date.now();
      const route = plan.via ? `${symOf(from)} to SOL to ${symOf(to)}` : J.labels(first.q).join(", ");
      const rows = [["You get about", `${T.formatAmount(plan.out, ti.decimals)} ${symOf(to)}`], ["At least", `${T.formatAmount(plan.min, ti.decimals)} ${symOf(to)}`], ["Route", `${route} (Jupiter)`]];
      if (to !== SOL_MINT && !KNOWN.has(pubkey(to).join(","))) rows.push(["Token mint", to, true]);
      rows.push(["Network fee", `about ${sol((await networkFee(CU_JUP)) * ntx)} SOL${ntx > 1 ? ` for ${ntx} transactions` : ""}`]);
      if (!(await ask({ tag: NET.mainnet ? "Mainnet, real funds" : "Devnet test funds", title: `Swap ${shown} ${symOf(from)} for ${symOf(to)}`, rows,
        notes: notes(`If the price moves more than ${slip / 100}%, the swap is cancelled and only the network fee is spent.`,
          rent ? `This creates a token account for ${symOf(to)} in your wallet. Its rent is about ${sol(rent)} SOL, paid once.` : "",
          plan.via ? "There is no direct pool, so this is two swaps through SOL. If the price moves between them, the second swap is skipped and you keep the SOL." : "",
          ntx > (plan.via ? 2 : 1) ? "The route is large, so the wallet prepares your token accounts in a separate transaction first." : "",
          to !== SOL_MINT && !KNOWN.has(pubkey(to).join(",")) ? "This token is not on the wallet's known list. Anyone can create a token with any name. Check the mint address above against the project's official site before you buy." : "",
          ext, topPlan.note, low) }, "Swap"))) return;
      if (Date.now() - planned > 45000) throw new Error("this price is more than 45 seconds old. Nothing was signed; review the swap again for a fresh price");
      if (topPlan.amount) { await topup(topPlan, spend); refreshFee().catch(() => {}); }
      let sig = "";
      const topupNone = { amount: 0n, note: "" };
      for (let li = 0; li < plan.legs.length; li++) {
        let leg = plan.legs[li];
        if (li === 1) {
          log(`swap 1 of 2 done: ${shown} ${symOf(from)} for at least ${T.formatAmount(J.minOut(plan.legs[0].q), 9)} SOL: ${sig}`, "ok");
          try { leg = await J.secondLeg(rpc, session, to, J.minOut(plan.legs[0].q), plan.min, jcache); }
          catch (e) { $("j-amt").value = ""; refreshWallet().catch(() => {}); throw new Error(`Swap 1 of 2 went through and you now hold the SOL. Swap 2 was not signed: ${friendly(e)}`); }
        }
        for (const tx of leg.txs) {
          await J.check(rpc, leg.q, leg.ctx, leg.ix);
          const verify = tx.includes(leg.ix.swap) ? await J.balanceGuard(rpc, leg.ctx, J.minOut(leg.q), leg.rent + (leg.ix.pump ? 5000000n : 0n), tx) : null;
          try { sig = await run(plan.legs.length > 1 ? `signing swap ${li + 1} of 2` : "signing the swap", tx, topupNone, { cu: CU_JUP, tables: leg.tables, spend, verify }); }
          catch (e) {
            if (/failed in simulation/.test(e.message)) {
              jcache.bad = [...new Set([...(jcache.bad || []), ...J.labels(leg.q)])];
              e.message += `. The ${J.labels(leg.q).join(", ")} pool failed, so the next try will avoid it.`;
            }
            if (li === 1) { $("j-amt").value = ""; refreshWallet().catch(() => {}); throw new Error(`Swap 1 of 2 went through and you now hold the SOL. Swap 2 did not complete: ${friendly(e)}`); }
            throw e;
          }
        }
      }
      $("j-ok").textContent = `swapped ${shown} ${symOf(from)}`;
      log(`swapped ${shown} ${symOf(from)} for about ${T.formatAmount(plan.out, ti.decimals)} ${symOf(to)}: ${sig}`, "ok");
      $("j-amt").value = "";
      quoteView("0", "", "Jupiter");
      await refreshWallet();
    }));
  }
  $("x-amt").addEventListener("input", scheduleQuote);
  $("x-dir").addEventListener("change", scheduleQuote);
  $("x-go").addEventListener("click", () => guard("x-err", "x-ok", async () => {
    if (!NET.swap) throw new Error("swaps are not available in this version");
    needPayer();
    const buy = $("x-dir").value === "buy";
    const amt = T.parseAmount($("x-amt").value, buy ? 9 : T.DEMO.decimals);
    const shownAmt = T.formatAmount(amt, buy ? 9 : T.DEMO.decimals);
    const out = await T.quote(rpc, buy, amt);
    const minOut = (out * 99n) / 100n;
    const shown = shownAmt;
    const label = buy ? `${shown} SOL for about ${T.formatAmount(out, T.DEMO.decimals)} DEMO` : `${shown} DEMO for about ${T.formatAmount(out, 9)} SOL`;
    if (buy) await solCheck(amt + 4200000n);
    const tables = await lookupTables();
    const inner = T.swapInner(session.wallet, session.wallet, buy, amt, minOut);
    const spend = (buy ? amt : 0n) + 4200000n;
    const plan = await planTopup(inner, tables, spend);
    if (!(await ask({ tag: NET.mainnet ? "Mainnet, real funds" : "Devnet test funds", title: `Swap ${label}`,
      rows: [["Network fee", `about ${sol(await networkFee(CU_SWAP))} SOL`]],
      notes: notes("You get at least 99% of that or the swap is cancelled.", "If you hold no DEMO account yet, your wallet pays its rent, about 0.002 SOL.", plan.note) }, "Swap"))) return;
    const sig = await run("signing the swap", inner, plan, { cu: CU_SWAP, tables, spend });
    $("x-ok").textContent = `swapped ${label}`;
    log(`swapped ${label}: ${sig}`, "ok");
    $("x-amt").value = "";
    $("x-quote").textContent = "\u00a0";
    await refreshWallet();
  }));
  if ($("w-rw-go")) $("w-rw-go").addEventListener("click", () => $("k-rekey").click());
  $("k-rekey").addEventListener("click", () => guard("k-err", "k-ok", async () => {
    needPayer();
    const plan = await planTopup([], [], 0n);
    if (!(await ask({ tag: NET.mainnet ? "Mainnet, real funds" : "Devnet test funds", title: "Move to a fresh key tree",
      notes: notes("Your address, balance and words stay the same. This sends one transaction.", plan.note) }, "Rekey"))) return;
    await topup(plan, 0n);
    const sig = await signed("building the next tree", (pr) => session.rekey(pr));
    $("k-ok").textContent = "rekeyed";
    log(`rekeyed: ${sig}`, "ok");
    await refreshWallet();
  }));
  $("k-words").addEventListener("click", () => {
    if (!$("k-panel").classList.contains("hidden") || !$("k-auth").classList.contains("hidden")) { hideWords(); return; }
    $("k-auth").classList.remove("hidden");
    $("w-err").textContent = "";
    $("k-pw").focus();
  });
  $("k-cancel").addEventListener("click", hideWords);
  $("k-hide").addEventListener("click", hideWords);
  const showWords = () => guard("w-err", null, async () => {
    const pw = $("k-pw").value;
    $("k-pw").value = "";
    const check = await engine.unlock(await store.get(session.id), pw);
    const words = check.words();
    check.master.fill(0);
    if (check.macRaw) check.macRaw.fill(0);
    $("k-auth").classList.add("hidden");
    renderWords($("k-wordlist"), words);
    $("k-panel").classList.remove("hidden");
    clearTimeout(wordsTimer);
    wordsTimer = setTimeout(hideWords, WORDS_MS);
  });
  $("k-show").addEventListener("click", showWords);
  $("k-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") showWords(); });
}

async function refreshFee() {
  if (!engine.payer) return;
  const bal = await rpc.balance(engine.payer.key());
  $("fee-bal").textContent = `${sol(bal)} SOL for fees`;
  $("t-fee-addr").textContent = engine.payer.address;
  $("t-fee-bal").textContent = bal >= 2 * (TX_FEE + MAX_PRIORITY) ? `${sol(bal)} SOL, enough for this step` : `${sol(bal)} SOL. Send it 0.01 ${NET.sol} first, then choose Use on this device.`;
  $("i-bal").textContent = `Activation address balance: ${sol(bal)} SOL`;
  const activated = $("w-init-box").classList.contains("hidden");
  $("w-fe").classList.toggle("hidden", !session || bal >= 2 * (TX_FEE + MAX_PRIORITY) || !activated);
  const surplus = bal - FEE_KEEP - TX_FEE;
  $("w-sweep").classList.toggle("hidden", !session || !activated || bal < FEE_SURPLUS);
  $("w-sweep-text").textContent = `${sol(surplus)} SOL is sitting on your fee key, which is not quantum-safe.`;
}

function mount() {
  const m = $("mount");
  if (!m) return Promise.resolve();
  if (reduce) { m.remove(); return Promise.resolve(); }
  return new Promise((res) => {
    m.classList.add("go");
    setTimeout(() => { $("mount-text").textContent = "opeq drive mounted"; m.classList.add("lit"); }, 1100);
    setTimeout(() => { m.classList.add("out"); res(); }, 1900);
    setTimeout(() => m.remove(), 2400);
  });
}

function watchLock() {
  if (!(globalThis.chrome && chrome.storage && chrome.storage.onChanged)) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!(area === "session" && changes["opeq:session"] && !changes["opeq:session"].newValue && session)) return;
    const go = () => { if (session) lockVault("Locked from another opeq window."); };
    if (!busy) return go();
    const wait = setInterval(() => { if (!busy) { clearInterval(wait); go(); } }, 500);
  });
}

const RPC_KEY = "opeq:rpc";
const hostOf = (u) => { try { return new URL(u).host; } catch { return "?"; } };

function validRpc(u) {
  try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && u.length < 400; } catch { return false; }
}

function setRpc(u) {
  rpc.url = u;
  engine._genesisOk = false;
  altCache = null;
  jcache.mints.clear();
  jcache.table = null;
  jcache.ataRent = null;
  labels.clear();
  $("n-now").textContent = u === NET.rpc ? `Connected through ${hostOf(u)} (default).` : `Connected through your RPC at ${hostOf(u)}.`;
}

async function loadRpc() {
  let u = null;
  try { u = (await chrome.storage.local.get(RPC_KEY))[RPC_KEY]; } catch {}
  setRpc(typeof u === "string" && validRpc(u) ? u : NET.rpc);
}

function initNetwork() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[RPC_KEY]) return;
      const u = changes[RPC_KEY].newValue;
      setRpc(typeof u === "string" && validRpc(u) ? u : NET.rpc);
    });
  } catch {}
  $("n-save").addEventListener("click", () => guard("n-err", "n-ok", async () => {
    const u = $("n-url").value.trim();
    if (!validRpc(u)) throw new Error("enter an https:// RPC address");
    let g;
    try { g = await new Rpc(u).call("getGenesisHash", []); } catch (e) { throw new Error(e.fromRpc ? `that RPC refused the request: ${String(e.message).slice(0, 120)}` : "that RPC could not be reached from the extension"); }
    if (g !== NET.genesis) throw new Error(`that RPC is on a different Solana network than this wallet (${NET.name})`);
    await chrome.storage.local.set({ [RPC_KEY]: u });
    setRpc(u);
    $("n-url").value = "";
    $("n-ok").textContent = "saved";
  }));
  $("n-reset").addEventListener("click", () => guard("n-err", "n-ok", async () => {
    await chrome.storage.local.remove(RPC_KEY);
    setRpc(NET.rpc);
    $("n-ok").textContent = "back to the default";
  }));
}

async function init() {
  await loadRpc();
  initNetwork();
  if (NET.jupiter) { $("j-box").classList.remove("hidden"); $("x-box").classList.add("hidden"); fillSwap(); }
  else if (!NET.swap) { $("tab-swap").remove(); $("pane-swap").classList.add("hidden"); }
  watchLock();
  initCreate(); initRecover(); initUnlock(); initWallet(); initAutoLock(); initTabs();
  const kept = await keep.load(IDLE_MS);
  if (kept) {
    const r = await store.get(kept.id);
    if (r && r.program === PROGRAM) {
      try {
        const s = new Session(engine, kept.id, kept.master, await macKeyFrom(kept.macRaw));
        s.macRaw = kept.macRaw;
        await s.load();
        await startSession(s);
        current = s.id;
        remember(current);
        await showWallet();
        return;
      } catch { await keep.clear(); }
    } else await keep.clear();
  }
  await mount();
  const all = await vaults();
  await refreshPorts();
  if (all.length) {
    const pick = all.find((r) => r.id === lastVault()) || all[all.length - 1];
    openVault(pick.id);
  } else { show("v-welcome"); setDrive("idle", "no wallet yet"); }
  window.addEventListener("beforeunload", (e) => { if (busy) { e.preventDefault(); e.returnValue = ""; } });
}

init();
