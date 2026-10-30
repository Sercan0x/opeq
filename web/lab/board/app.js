import * as P from "../../lib/protocol.js";
import { Engine, EXEC_LIMIT } from "../../lib/engine.js";
import { IdbStore } from "../../lib/vaultstore.js";
import { Rpc, pubkey, b58encode, SYSTEM, concat, u32, u64 } from "../../lib/solana.js";
import { discoverWallets, connect } from "../../lib/phantom.js";
import * as T from "../../lib/tokens.js";
try { sessionStorage.setItem("opeq:inside", "1"); } catch {}

const PROGRAM = "424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN";
const EXPLORER = "https://explorer.solana.com";
const $ = (id) => document.getElementById(id);
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

class WorkerCompute {
  constructor() {
    this.w = new Worker(new URL("../../lib/worker.js", import.meta.url), { type: "module" });
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

const rpc = new Rpc("https://api.devnet.solana.com");
const store = new IdbStore();
const engine = new Engine({ rpc, program: PROGRAM, store, compute: new WorkerCompute(), payer: null });
let session = null;
let current = null;
let busy = false;
let pending = null;

const VIEWS = ["v-welcome", "v-create", "v-recover", "v-unlock", "v-wallet"];
function show(id) { for (const v of VIEWS) $(v).classList.toggle("hidden", v !== id); }
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
    a.href = `${EXPLORER}/tx/${sig[1]}?cluster=devnet`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = short(sig[1]);
    line.append(a, text.slice(sig.index + sig[1].length));
  } else line.append(text);
  $("log").prepend(line);
}
engine.log = (m) => log(m);

function friendly(e) {
  let msg = e.message || String(e);
  const m = /error (\d+)\)/.exec(msg);
  if (m && P.ERRORS[m[1]] && e.program === PROGRAM) msg += `: ${P.ERRORS[m[1]]}`;
  if (/insufficient lamports|0x1\b/.test(msg + (e.logs || []).join(" "))) msg += "\nNot enough SOL in the wallet for this amount.";
  if (/User rejected|rejected the request/i.test(msg)) msg = "You rejected the request in your wallet.";
  return msg;
}

function parseSol(text) {
  const t = text.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(t)) throw new Error("enter an amount like 0.25 (at most 9 decimals)");
  const [w, f = ""] = t.split(".");
  const lamports = BigInt(w) * 1000000000n + BigInt((f + "000000000").slice(0, 9));
  if (lamports <= 0n) throw new Error("amount must be more than zero");
  return lamports;
}

function needPayer() { if (!engine.payer) throw new Error("connect a fee wallet first (POWER, on the left)"); }

async function guard(errId, okId, fn) {
  if (busy) return;
  busy = true;
  const buttons = document.querySelectorAll(".rig button");
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
  setDrive("on", "wallet unlocked, devnet");
  await refreshWallet();
  refreshPorts();
}

async function refreshWallet() {
  if (!session) return;
  const r = await session.load();
  $("w-addr").textContent = session.id;
  $("w-explorer").href = `${EXPLORER}/address/${session.id}?cluster=devnet`;
  const [bal, st] = await Promise.all([rpc.balance(session.wallet), engine.chainState(r)]);
  $("w-bal").textContent = (bal / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });
  if (r.inflight) {
    const note = await session.ackInflight(st);
    if (note.message) log(note.message, note.state === "pending" ? "err" : "ok");
  }
  $("w-init-box").classList.toggle("hidden", !!st);
  const info = await session.status();
  const inactive = info.state === "inactive";
  $("w-take-box").classList.toggle("hidden", !inactive);
  $("dock").classList.toggle("hidden", inactive);
  for (const id of ["w-send-box", "w-more", "w-rekey-box", "w-tokens-box"]) $(id).classList.toggle("hidden", !st);
  $("send-off").classList.toggle("hidden", !!st);
  if (st) {
    const next = Math.max(st.next, r.next_leaf);
    const left = Math.max(0, EXEC_LIMIT - next);
    $("w-status").textContent = `active, tree ${st.epoch}`;
    $("w-state").textContent = "active on chain";
    $("w-tree").textContent = `tree ${st.epoch}, next key ${next}`;
    $("w-left").textContent = String(left);
    renderDimms(left);
    refreshTokens().catch((e) => log(`token list: ${e.message}`, "err"));
  } else {
    $("w-status").textContent = "not activated";
    $("w-state").textContent = "not activated yet";
    $("w-tree").textContent = "tree 0";
    $("w-left").textContent = String(EXEC_LIMIT);
    renderDimms(EXEC_LIMIT);
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
  if (!altCache) altCache = [await rpc.lookupTable(T.DEMO.alt)];
  return altCache;
}
const tokenName = (mint) => T.KNOWN.get(pubkey(mint).join(",")) || short(mint);

async function refreshTokens() {
  if (!session) return;
  tokens = (await rpc.tokenAccounts(session.wallet)).filter((t) => t.amount > 0n || t.mint === b58encode(T.DEMO.mint));
  const list = $("t-list"), sel = $("t-sel");
  list.textContent = ""; sel.textContent = "";
  if (!tokens.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "No tokens yet. Try a swap."; list.append(p); }
  tokens.forEach((t, i) => {
    const row = document.createElement("div"); row.className = "tok";
    const left = document.createElement("div");
    const nm = document.createElement("b"); nm.textContent = tokenName(t.mint);
    const m = document.createElement("span"); m.className = "mint mono"; m.textContent = t.mint;
    left.append(nm, m);
    const right = document.createElement("div"); right.className = "mono amt"; right.textContent = T.formatAmount(t.amount, t.decimals);
    row.append(left, right); list.append(row);
    const o = document.createElement("option"); o.value = i; o.textContent = `${tokenName(t.mint)} (${T.formatAmount(t.amount, t.decimals)})`; sel.append(o);
  });
}

let quoteTimer = null;
function scheduleQuote() {
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

function lockVault(reason) {
  if (!session) return;
  if (session.master) session.master.fill(0);
  session.master = null;
  session = null;
  hideWords();
  if (pending) { pending.words = null; pending.pw = null; pending = null; }
  $("c-words").textContent = "";
  for (const id of ["u-pw", "c-pw", "c-pw2"]) $(id).value = "";
  if (current) {
    openVault(current);
    $("u-note").textContent = reason || "";
    $("u-note").classList.toggle("hidden", !reason);
  } else { show("v-welcome"); refreshPorts(); }
}

function initAutoLock() {
  const touch = () => { lastActive = Date.now(); };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, touch, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > HIDDEN_MS && session && !busy) lockVault("Locked because the tab was in the background for more than 5 minutes.");
    hiddenAt = null;
    touch();
  });
  setInterval(() => {
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
    session = await engine.unlock(pending.record, pending.pw);
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
    show("v-recover");
    setDrive("idle", "restore key");
  });
}

function initUnlock() {
  const go = () => guard("u-err", null, async () => {
    session = await engine.unlock(await store.get(current), $("u-pw").value);
    $("u-pw").value = "";
    await showWallet();
  });
  $("u-go").addEventListener("click", go);
  $("u-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("u-forget").addEventListener("click", async () => {
    if (!confirm("Remove this wallet from this browser? You can only get it back with the 24 words.")) return;
    await engine.remove(current);
    current = null; session = null;
    show("v-welcome");
    refreshPorts();
  });
}

function initWallet() {
  $("w-copy").addEventListener("click", async () => { await navigator.clipboard.writeText(session.id); log("address copied"); });
  $("w-refresh").addEventListener("click", () => guard(null, null, refreshWallet));
  $("w-lock").addEventListener("click", () => lockVault(""));
  $("w-take").addEventListener("click", () => guard("w-take-err", null, async () => {
    needPayer();
    if (!confirm("Use this wallet in this browser? This sends one rekey transaction. After it, any other browser or device that has these words stops signing until you choose Use on this device there.")) return;
    const sig = await signed("taking over in this browser", (pr) => session.takeover(pr));
    log(`this browser now signs for the wallet: ${sig}`, "ok");
    await refreshWallet();
  }));
  $("w-init").addEventListener("click", () => guard("i-err", null, async () => {
    needPayer();
    signing(true, "activating on chain");
    try {
      const res = await engine.init(await session.load());
      log(res === "already-initialized" ? "already active on chain" : `activated ${res}`, "ok");
    } finally { signing(false); }
    await refreshWallet();
  }));
  $("d-go").addEventListener("click", () => guard("d-err", "d-ok", async () => {
    needPayer();
    const lamports = parseSol($("d-amt").value);
    const sol = $("d-amt").value.trim();
    const ix = [SYSTEM, [[engine.payer.key(), true, true], [session.wallet, false, true]], concat(u32(2), u64(lamports))];
    const sig = await engine.submit(ix, (await rpc.slot()) + 150, 50000);
    $("d-ok").textContent = `deposited ${sol} SOL`;
    log(`deposited ${sol} SOL from the fee wallet: ${sig}`, "ok");
    $("d-amt").value = "";
    await refreshWallet();
    await refreshFee();
  }));
  $("s-go").addEventListener("click", () => guard("s-err", "s-ok", async () => {
    needPayer();
    const to = pubkey($("s-to").value.trim());
    if (b58encode(to) === session.id) throw new Error("that is this wallet's own address. To add funds, use Deposit.");
    const lamports = parseSol($("s-amt").value);
    const sol = $("s-amt").value.trim();
    if (!confirm(`Send ${sol} SOL from your opeq wallet to ${b58encode(to)}?`)) return;
    const sig = await signed("reserving a key, grinding the signature", (pr) => session.sendSol(to, lamports, pr));
    $("s-ok").textContent = `sent ${sol} SOL`;
    log(`sent ${sol} SOL to ${short(b58encode(to))}: ${sig}`, "ok");
    $("s-amt").value = "";
    await refreshWallet();
  }));
  $("t-go").addEventListener("click", () => guard("t-err", "t-ok", async () => {
    needPayer();
    const t = tokens[Number($("t-sel").value)];
    if (!t) throw new Error("no token selected");
    const to = pubkey($("t-to").value.trim());
    if (b58encode(to) === session.id) throw new Error("that is this wallet's own address");
    const amount = T.parseAmount($("t-amt").value, t.decimals);
    if (amount > t.amount) throw new Error("not enough of this token in the wallet");
    const name = tokenName(t.mint), shown = $("t-amt").value.trim();
    if (!confirm(`Send ${shown} ${name} to ${b58encode(to)}?`)) return;
    const prog = pubkey(t.program), mint = pubkey(t.mint);
    const inner = [T.createAtaIdempotent(engine.payer.key(), to, mint, prog),
      T.transferChecked(prog, pubkey(t.account), mint, T.ata(to, mint, prog), session.wallet, amount, t.decimals)];
    const tables = await lookupTables();
    const sig = await signed("signing the token transfer", (pr) => session.exec(inner, 400000, pr, tables));
    $("t-ok").textContent = `sent ${shown} ${name}`;
    log(`sent ${shown} ${name} to ${short(b58encode(to))}: ${sig}`, "ok");
    $("t-amt").value = "";
    await refreshWallet();
  }));
  $("x-amt").addEventListener("input", scheduleQuote);
  $("x-dir").addEventListener("change", scheduleQuote);
  $("x-go").addEventListener("click", () => guard("x-err", "x-ok", async () => {
    needPayer();
    const buy = $("x-dir").value === "buy";
    const amt = T.parseAmount($("x-amt").value, buy ? 9 : T.DEMO.decimals);
    const out = await T.quote(rpc, buy, amt);
    const minOut = (out * 99n) / 100n;
    const shown = $("x-amt").value.trim();
    const label = buy ? `${shown} SOL for about ${T.formatAmount(out, T.DEMO.decimals)} DEMO` : `${shown} DEMO for about ${T.formatAmount(out, 9)} SOL`;
    if (!confirm(`Swap ${label}? You get at least 99% of that or the swap is cancelled.`)) return;
    const tables = await lookupTables();
    const sig = await signed("signing the swap", (pr) => session.exec(T.swapInner(session.wallet, engine.payer.key(), buy, amt, minOut), 600000, pr, tables));
    $("x-ok").textContent = `swapped ${label}`;
    log(`swapped ${label}: ${sig}`, "ok");
    $("x-amt").value = "";
    $("x-quote").textContent = "\u00a0";
    await refreshWallet();
  }));
  $("k-rekey").addEventListener("click", () => guard("k-err", "k-ok", async () => {
    needPayer();
    if (!confirm("Move to a fresh tree of 1024 keys? Your address and words stay the same.")) return;
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
  $("fee-bal").textContent = `${(bal / 1e9).toFixed(4)} SOL for fees`;
}

function walletIcon(src) {
  if (typeof src !== "string" || !/^data:image\/(png|svg\+xml|webp|jpeg|gif);/i.test(src)) return null;
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.width = 18;
  img.height = 18;
  img.className = "wicon";
  return img;
}

function initFee() {
  const list = $("fee-list");
  let found = [];
  const render = () => {
    list.textContent = "";
    for (const w of found) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-line btn-sm wallet-btn";
      const ic = walletIcon(w.icon);
      if (ic) b.append(ic);
      b.append(`Connect ${w.name}`);
      b.addEventListener("click", () => guard(null, null, async () => {
        engine.payer = await connect(w);
        $("fee-none").classList.add("hidden");
        $("fee-on").classList.remove("hidden");
        $("fee-addr").textContent = engine.payer.address;
        const head = $("fee-name");
        head.textContent = "";
        const ic = walletIcon(w.icon);
        if (ic) head.append(ic);
        head.append(w.name);
        await refreshFee();
        log(`fee wallet ${short(engine.payer.address)} connected`);
      }));
      list.append(b);
    }
    $("fee-hint").textContent = found.length ? "" : "No Solana wallet found yet. Install Phantom and reload.";
  };
  discoverWallets((ws) => { found = ws; render(); });
  setTimeout(render, 1500);
  $("fee-off").addEventListener("click", async () => {
    try { await engine.payer.disconnect(); } catch {}
    engine.payer = null;
    $("fee-on").classList.add("hidden");
    $("fee-none").classList.remove("hidden");
  });
}

function mount() {
  const m = $("mount");
  if (reduce) { m.remove(); return Promise.resolve(); }
  return new Promise((res) => {
    m.classList.add("go");
    setTimeout(() => { $("mount-text").textContent = "opeq drive mounted"; m.classList.add("lit"); }, 1100);
    setTimeout(() => { m.classList.add("out"); res(); }, 1900);
    setTimeout(() => m.remove(), 2400);
  });
}

async function init() {
  initCreate(); initRecover(); initUnlock(); initWallet(); initFee(); initAutoLock(); initTabs();
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
