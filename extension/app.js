import * as P from "./lib/protocol.js";
import { Engine, Session, Inactive, EXEC_LIMIT } from "./lib/engine.js";
import { IdbStore, macKeyFrom } from "./lib/vaultstore.js";
import { Rpc, pubkey, b58encode, SYSTEM, concat, u32, u64, eq, isOnCurve, unhex } from "./lib/solana.js";
import * as T from "./lib/tokens.js";
import { feePayer } from "./feekey.js";
import * as keep from "./keep.js";
import { NET } from "./net.js";

const PROGRAM = NET.program;
const EXPLORER = "https://explorer.solana.com";
const LAMPORTS = 1000000000;
const FEE_LOW = 5000000;
const FEE_TOPUP = 20000000n;
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

function ask(text, yes = "Confirm") {
  const d = $("ask");
  $("ask-text").textContent = text;
  $("ask-yes").textContent = yes;
  d.showModal();
  $("ask-no").focus();
  return new Promise((res) => {
    const done = (v) => { d.close(); $("ask-yes").onclick = $("ask-no").onclick = d.oncancel = null; res(v); };
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

function log(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = document.createElement("time");
  t.textContent = new Date().toLocaleTimeString("en-GB");
  line.append(t, " ");
  const sig = /([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(text);
  if (sig) {
    line.append(text.slice(0, sig.index));
    const a = document.createElement("a");
    a.href = `${EXPLORER}/tx/${sig[1]}${NET.explorerQuery}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = short(sig[1]);
    line.append(a, text.slice(sig.index + sig[1].length));
  } else line.append(text);
  $("log").prepend(line);
}
engine.log = (m) => log(m);

function friendly(e) {
  let msg = String(e.message || e).slice(0, 300);
  if (e.fromRpc) msg = `The RPC answered: ${msg.slice(0, 160)}`;
  const m = /error (\d+)\)/.exec(msg);
  if (m && P.ERRORS[m[1]] && e.program === PROGRAM) msg += `: ${P.ERRORS[m[1]]}`;
  if (/insufficient lamports|0x1\b/.test(msg + (e.logs || []).join(" "))) msg += "\nNot enough SOL in the wallet for this amount.";
  if (/User rejected|rejected the request/i.test(msg)) msg = "You rejected the request in your wallet.";
  return msg;
}

function parseSol(text) {
  const t = text.trim();
  if (!/^\d{1,10}(\.\d{1,9})?$/.test(t)) throw new Error("enter an amount like 0.25 (at most 9 decimals)");
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
  await keep.save(s.id, s.master, s.macRaw);
  $("fee-none").classList.add("hidden");
  $("fee-on").classList.remove("hidden");
  $("fee-addr").textContent = engine.payer.address;
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

async function planTopup(inner, tables, spend) {
  const fee = await rpc.balance(engine.payer.key());
  if (fee >= FEE_LOW) return { amount: 0n, note: "" };
  let amount = BigInt(await rpc.balance(session.wallet)) - BigInt(spend) - VAULT_KEEP;
  if (amount > FEE_TOPUP) amount = FEE_TOPUP;
  const floor = 2 * (TX_FEE + MAX_PRIORITY);
  if (amount < 2000000n) {
    if (fee < floor) throw new Error(`the fee key is empty (${sol(fee)} SOL) and the wallet has too little SOL to top it up. Send 0.01 SOL to the fee key (Keys tab)`);
    return { amount: 0n, note: "" };
  }
  if (fee < floor) throw new Error(`the fee key is empty; send 0.01 SOL to it once (Keys tab, copy button). Nothing was signed`);
  const ix = feeTopupIx(amount);
  const inline = inner.length > 0 && (await session.execSize([...inner, ix], tables)) <= TX_LIMIT;
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

async function run(text, inner, plan, { cu = CU_SEND, tables = [], spend = 0n } = {}) {
  needPayer();
  const extra = await topup(plan, spend);
  const sig = await signed(text, (pr) => session.exec([...inner, ...extra], cu, pr, tables));
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
  const buttons = document.querySelectorAll(".rig button, .pmain button");
  buttons.forEach((b) => (b.disabled = true));
  if (errId) $(errId).textContent = "";
  if (okId) $(okId).textContent = "";
  try { await fn(); }
  catch (e) { if (errId) $(errId).textContent = friendly(e); log(friendly(e), "err"); }
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
    if (note.message) log(note.message, note.state === "pending" ? "err" : "ok");
  }
  $("w-init-box").classList.toggle("hidden", !!st);
  await refreshFee();
  for (const id of ["w-send-box", "w-more", "w-rekey-box", "w-tokens-box"]) $(id).classList.toggle("hidden", !st);
  $("send-off").classList.toggle("hidden", !!st);
  if (st) {
    const next = Math.max(st.next, r.next_leaf);
    const left = Math.max(0, EXEC_LIMIT - next);
    $("w-status").textContent = inactive ? "not active on this device" : `active, tree ${st.epoch}`;
    $("w-state").textContent = inactive ? "active on another device" : "active on chain";
    $("w-tree").textContent = `tree ${st.epoch}, next key ${next}`;
    $("w-left").textContent = String(left);
    renderDimms(left);
    rekeyWarn(inactive ? EXEC_LIMIT : left);
    refreshTokens().catch((e) => log(`token list: ${e.message}`, "err"));
  } else {
    $("w-status").textContent = "not activated";
    $("w-state").textContent = "not activated yet";
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
const tokenName = (mint) => KNOWN.get(pubkey(mint).join(",")) || short(mint);

async function refreshTokens() {
  if (!session) return;
  tokens = (await rpc.tokenAccounts(session.wallet)).filter((t) => t.amount > 0n || (NET.swap && t.mint === b58encode(T.DEMO.mint)));
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
    const o = document.createElement("option"); o.value = t.mint; o.textContent = `${tokenName(t.mint)} (${T.formatAmount(t.amount, t.decimals)})`; sel.append(o);
  });
  if (tokens.some((t) => t.mint === chosen)) sel.value = chosen;
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
let lastActive = Date.now(), hiddenAt = null;

function wipeInputs() {
  for (const id of ["u-pw", "c-pw", "c-pw2", "r-pw", "r-pw2", "r-words", "k-pw"]) $(id).value = "";
  $("c-words").textContent = "";
  $("c-quiz").textContent = "";
}

function lockVault(reason) {
  wipeInputs();
  if (!session) return;
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
    if (pw.length < 10) throw new Error("use at least 10 characters");
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
    if (pw.length < 10) throw new Error("use at least 10 characters");
    if (pw !== $("r-pw2").value) throw new Error("passwords do not match");
    setProgress("r-prog", 0);
    const words = $("r-words").value;
    let record = await engine.recover(words, pw, (p) => setProgress("r-prog", p));
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
    if (bal < 3000000 + FEE_KEEP) throw new Error(`send at least 0.01 SOL to the activation address first (it has ${sol(bal)} SOL)`);
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
    const to = pubkey($("s-to").value.trim());
    const lamports = parseSol($("s-amt").value);
    const amount = $("s-amt").value.trim();
    const warn = await checkRecipient(to, false);
    if (lamports < RENT_FLOOR && !(await rpc.account(to))) throw new Error("the receiving address is empty, so Solana needs at least 0.00089 SOL to create it. Send more. Nothing was signed");
    const low = await solCheck(lamports);
    const inner = [[SYSTEM, [[session.wallet, true, true], [to, false, true]], concat(u32(2), u64(lamports))]];
    const plan = await planTopup(inner, [], lamports);
    if (!(await ask(`${NET.mainnet ? "Mainnet, real funds.\n" : ""}Send ${sol(lamports)} ${NET.sol} from your opeq wallet to\n${b58encode(to)}?\nNetwork fee: about ${sol(await networkFee(CU_SEND))} SOL${plan.note}${low}${warn}`, "Send"))) return;
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
    const to = pubkey($("t-to").value.trim());
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
    if (!(await ask(`${NET.mainnet ? "Mainnet, real funds.\n" : ""}Send ${shown} ${name}${NET.mainnet ? "" : " (devnet)"}\nToken mint: ${t.mint}\nto\n${b58encode(to)}?\nNetwork fee: about ${sol(await networkFee(CU_TOKEN))} SOL${rent}${ext}${plan.note}${warn}`, "Send"))) return;
    const sig = await run("signing the token transfer", inner, plan, { cu: CU_TOKEN, tables, spend: 2100000n });
    $("t-ok").textContent = `sent ${shown} ${name}`;
    log(`sent ${shown} ${name} to ${short(b58encode(to))}: ${sig}`, "ok");
    $("t-amt").value = "";
    await refreshWallet();
  }));
  $("x-amt").addEventListener("input", scheduleQuote);
  $("x-dir").addEventListener("change", scheduleQuote);
  $("x-go").addEventListener("click", () => guard("x-err", "x-ok", async () => {
    if (!NET.swap) throw new Error("swaps are not available in this version");
    needPayer();
    const buy = $("x-dir").value === "buy";
    const amt = T.parseAmount($("x-amt").value, buy ? 9 : T.DEMO.decimals);
    const out = await T.quote(rpc, buy, amt);
    const minOut = (out * 99n) / 100n;
    const shown = $("x-amt").value.trim();
    const label = buy ? `${shown} SOL for about ${T.formatAmount(out, T.DEMO.decimals)} DEMO` : `${shown} DEMO for about ${T.formatAmount(out, 9)} SOL`;
    if (buy) await solCheck(amt + 4200000n);
    const tables = await lookupTables();
    const inner = T.swapInner(session.wallet, session.wallet, buy, amt, minOut);
    const spend = (buy ? amt : 0n) + 4200000n;
    const plan = await planTopup(inner, tables, spend);
    if (!(await ask(`Swap ${label}${NET.mainnet ? "" : " (devnet)"}? You get at least 99% of that or the swap is cancelled.\nNetwork fee: about ${sol(await networkFee(CU_SWAP))} SOL. If you hold no DEMO account yet, your wallet pays its rent, about 0.002 SOL.${plan.note}`, "Swap"))) return;
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
    if (!(await ask(`Move to a fresh key tree? Your address and words stay the same. This sends one transaction.${plan.note}`, "Rekey"))) return;
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
  $("n-now").textContent = u === NET.rpc ? `Connected through ${hostOf(u)} (default).` : `Connected through your RPC at ${hostOf(u)}.`;
}

async function loadRpc() {
  let u = null;
  try { u = (await chrome.storage.local.get(RPC_KEY))[RPC_KEY]; } catch {}
  setRpc(typeof u === "string" && validRpc(u) ? u : NET.rpc);
}

function initNetwork() {
  $("n-save").addEventListener("click", () => guard("n-err", "n-ok", async () => {
    const u = $("n-url").value.trim();
    if (!validRpc(u)) throw new Error("enter an https:// RPC address");
    let g;
    try { g = await new Rpc(u).call("getGenesisHash", []); } catch (e) { throw new Error(`that RPC did not answer: ${String(e.message || e).slice(0, 120)}`); }
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
  if (!NET.swap) { $("tab-swap").remove(); $("pane-swap").classList.add("hidden"); }
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
