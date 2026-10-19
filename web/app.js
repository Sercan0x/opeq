import { sha256 } from "./lib/sha256.js";
import { digits, verifyCost } from "./lib/wots.js";
import * as P from "./lib/protocol.js";
import { Engine } from "./lib/engine.js";
import { IdbStore } from "./lib/vaultstore.js";
import { Rpc, pubkey, b58encode, SYSTEM, concat, u32, u64 } from "./lib/solana.js";
import { discoverWallets, connect } from "./lib/phantom.js";
import * as T from "./lib/tokens.js";
import { playIntro, dropCover } from "./lib/intro.js";
import { initWaitlist } from "./lib/waitlist.js";
import { bonkScene } from "./lib/bonk.js";

const PROGRAM = "424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN";
const RPC_URL = "https://api.devnet.solana.com";
const EXPLORER = "https://explorer.solana.com";
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

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

const rpc = new Rpc(RPC_URL);
const store = new IdbStore();
const engine = new Engine({ rpc, program: PROGRAM, store, compute: new WorkerCompute(), payer: null });
engine.genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
let session = null;
let current = null;
let busy = false;

function show(id) {
  for (const v of ["view-welcome", "view-create", "view-recover", "view-unlock", "view-wallet"]) $(v).classList.toggle("hidden", v !== id);
}

let firstRoute = true;

let enterWaitlist = null;

function route() {
  const app = location.hash.startsWith("#/app");
  const wl = location.hash.startsWith("#/waitlist");
  if (firstRoute && !app && !wl) playIntro();
  else dropCover();
  firstRoute = false;
  $("app").classList.toggle("hidden", !app);
  $("waitlist").classList.toggle("hidden", !wl);
  $("site").classList.toggle("hidden", app || wl);
  if (app || wl) window.scrollTo(0, 0);
  if (wl) {
    if (!enterWaitlist) enterWaitlist = initWaitlist();
    enterWaitlist();
  }
}

function setProgress(id, frac) {
  const el = $(id);
  if (frac === null) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}

function short(a) { return `${a.slice(0, 4)}…${a.slice(-4)}`; }

function log(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const sig = /([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(text);
  if (sig) {
    line.append(text.slice(0, sig.index));
    const a = document.createElement("a");
    a.href = `${EXPLORER}/tx/${sig[1]}?cluster=devnet`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = short(sig[1]);
    line.append(a, text.slice(sig.index + sig[1].length));
  } else {
    line.textContent = text;
  }
  const box = $("log");
  box.prepend(line);
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

function needPayer() {
  if (!engine.payer) throw new Error("connect a fee wallet first (left side)");
}

async function guard(btn, errId, okId, fn) {
  if (busy) return;
  busy = true;
  const buttons = document.querySelectorAll("#app button");
  buttons.forEach((b) => (b.disabled = true));
  if (errId) $(errId).textContent = "";
  if (okId) $(okId).textContent = "";
  try {
    await fn();
  } catch (e) {
    if (errId) $(errId).textContent = friendly(e);
    log(friendly(e), "err");
  } finally {
    busy = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}

const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.append(e);
  return e;
}

function initDemo() {
  const svg = $("sig-svg");
  if (!svg) return;
  const fig = svg.closest(".sig");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const X0 = 22, PITCH = 21, W = 13, TOP = 46, BOT = 318, H = BOT - TOP;
  svgEl("text", { x: X0, y: 26, class: "lad-title" }, svg).textContent = "18 hash ladders";
  const LEAF_Y = 304, LV = [LEAF_Y, 232, 160, 88], NODE = 16;
  const lx = (i) => 466 + i * 22;
  const nodeX = (level, i) => level === 0 ? lx(i) : (nodeX(level - 1, 2 * i) + nodeX(level - 1, 2 * i + 1)) / 2;
  const BUS = TOP - 12;
  svgEl("line", { x1: X0 + W / 2, y1: BUS, x2: 446, y2: BUS, class: "lad-bus" }, svg);
  const route = svgEl("path", { class: "lad-route" }, svg);
  const ladders = [];
  for (let c = 0; c < 18; c++) {
    const x = X0 + c * PITCH;
    const g = svgEl("g", {}, svg);
    const secret = svgEl("rect", { x, y: TOP, width: W, height: H, class: "lad-secret" }, g);
    svgEl("line", { x1: x, y1: TOP, x2: x, y2: BOT, class: "lad-rail" }, g);
    svgEl("line", { x1: x + W, y1: TOP, x2: x + W, y2: BOT, class: "lad-rail" }, g);
    for (let r = 1; r < 25; r++) {
      const y = BOT - (r * H) / 25;
      svgEl("line", { x1: x, y1: y, x2: x + W, y2: y, class: "lad-rung" }, g);
    }
    const mark = svgEl("rect", { x: x - 3, y: BOT - 2, width: W + 6, height: 4, rx: 1, class: "lad-mark" + (c >= 16 ? " cs" : "") }, g);
    svgEl("text", { x: x + W / 2, y: BOT + 18, "text-anchor": "middle", class: "lad-label" }, g).textContent = c >= 16 ? `c${c - 15}` : c + 1;
    svgEl("line", { x1: x + W / 2, y1: BUS, x2: x + W / 2, y2: TOP, class: "lad-bus" }, g);
    secret.style.transitionDelay = reduce ? "0s" : `${c * 45}ms`;
    mark.style.transitionDelay = reduce ? "0s" : `${c * 45}ms`;
    ladders.push({ secret, mark, x });
  }
  const edges = [], nodes = [];
  for (let level = 0; level < 4; level++) {
    const row = [];
    for (let i = 0; i < 8 >> level; i++) {
      const cx = nodeX(level, i), cy = LV[level];
      if (level > 0) {
        for (const child of [2 * i, 2 * i + 1]) {
          edges.push({ level, parent: i, child, line: svgEl("line", { x1: cx, y1: cy + NODE / 2, x2: nodeX(level - 1, child), y2: LV[level - 1] - NODE / 2, class: "tree-edge" }, svg) });
        }
      }
      row.push(svgEl("rect", { x: cx - NODE / 2, y: cy - NODE / 2, width: NODE, height: NODE, rx: 2, class: "tree-node" }, svg));
    }
    nodes.push(row);
  }
  svgEl("text", { x: nodeX(3, 0), y: LV[3] - 22, "text-anchor": "middle", class: "lad-title" }, svg).textContent = "root, stored on chain";
  svgEl("text", { x: nodeX(3, 0), y: BOT + 30, "text-anchor": "middle", class: "lad-label" }, svg).textContent = "one key of 1024";
  route.style.transitionDelay = reduce ? "0s" : "0.9s";
  for (const e of edges) e.line.style.transitionDelay = reduce ? "0s" : "1.1s";

  const update = (first) => {
    const d = sha256(enc.encode($("demo-msg").value)).slice(0, 16);
    const leaf = d[15] & 7;
    digits(d).forEach((v, i) => {
      const L = ladders[i];
      L.secret.style.transform = `scaleY(${Math.max(v, 1) / 255})`;
      L.mark.style.transform = `translateY(${-(v / 255) * H}px)`;
      if (!first) { L.secret.style.transitionDelay = "0s"; L.mark.style.transitionDelay = "0s"; }
    });
    const path = [leaf, leaf >> 1, leaf >> 2, 0];
    const under = LEAF_Y + NODE / 2 + 9;
    route.setAttribute("d", `M446,${BUS} L446,${under} L${lx(leaf)},${under} L${lx(leaf)},${LEAF_Y + NODE / 2}`);
    nodes.forEach((row, level) => row.forEach((n, i) => {
      n.classList.toggle("leaf", level === 0 && i === leaf);
      n.classList.toggle("on", level > 0 && i === path[level]);
    }));
    for (const e of edges) {
      e.line.classList.toggle("on", e.parent === path[e.level] && e.child === path[e.level - 1]);
      if (!first) e.line.style.transitionDelay = "0s";
    }
    const cost = verifyCost(d);
    $("demo-cost").textContent = `For this message the verifier climbs ${cost} rungs. The real client tries 131,072 salts and keeps one that needs about 1,275.`;
  };
  fig.classList.add("pre");
  update(true);
  requestAnimationFrame(() => requestAnimationFrame(() => fig.classList.remove("pre")));
  $("demo-msg").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  $("demo-msg").addEventListener("input", (e) => {
    if (e.target.value.includes("\n")) e.target.value = e.target.value.replace(/[\r\n]+/g, " ");
    update(false);
  });
}

function initErrors() {
  const table = $("errors");
  if (!table) return;
  const t = table.tBodies[0] || table;
  for (const [code, text] of Object.entries(P.ERRORS)) {
    const tr = document.createElement("tr");
    const a = document.createElement("td"); a.className = "mono"; a.textContent = code;
    const b = document.createElement("td"); b.textContent = text;
    tr.append(a, b);
    t.append(tr);
  }
}

async function vaults() {
  return (await store.all()).filter((r) => r.program === PROGRAM).sort((a, b) => a.created - b.created);
}

async function autoOpen() {
  const all = await vaults();
  if (!all.length || session) return;
  const last = lastVault();
  const pick = all.find((r) => r.id === last) || all[all.length - 1];
  openVault(pick.id);
}

async function refreshVaults() {
  const list = $("vault-list");
  list.textContent = "";
  const all = await vaults();
  if (!all.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "None yet.";
    list.append(p);
  }
  for (const r of all) {
    const b = document.createElement("button");
    b.className = "vault-item" + (current === r.id ? " active" : "");
    b.textContent = short(r.id);
    const s = document.createElement("small");
    s.textContent = session && session.id === r.id ? "unlocked" : "locked";
    b.append(s);
    b.addEventListener("click", () => openVault(r.id));
    list.append(b);
  }
}

function remember(id) {
  try { localStorage.setItem("opeq:last", id); } catch {}
}

function lastVault() {
  try { return localStorage.getItem("opeq:last"); } catch { return null; }
}

const IDLE_MS = 10 * 60 * 1000;
const HIDDEN_MS = 5 * 60 * 1000;
const WORDS_MS = 60 * 1000;
let lastActive = Date.now();
let hiddenAt = null;
let wordsTimer = null;

let clipTimer = null;
let clipText = null;

async function copyWords(words, btn) {
  const text = words.join(" ");
  await navigator.clipboard.writeText(text);
  clipText = text;
  const label = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => { btn.textContent = label; }, 2000);
  clearTimeout(clipTimer);
  clipTimer = setTimeout(clearClipboard, 60000);
}

async function clearClipboard() {
  if (!clipText) return;
  try {
    const now = await navigator.clipboard.readText().catch(() => null);
    if (now === null || now === clipText) await navigator.clipboard.writeText("");
  } catch {}
  clipText = null;
}

function hideWords() {
  clearTimeout(wordsTimer);
  $("k-copy-row").classList.add("hidden");
  const el = $("k-wordlist");
  el.textContent = "";
  el.classList.add("hidden");
  $("k-copy").onclick = null;
  $("k-auth").classList.add("hidden");
  $("k-pw").value = "";
}

function lockVault(reason) {
  if (!session) return;
  if (session.master) session.master.fill(0);
  session.master = null;
  session = null;
  hideWords();
  if (pending) { pending.words = null; pending.pw = null; pending = null; }
  $("c-words").textContent = "";
  clearClipboard();
  for (const id of ["u-pw", "c-pw", "c-pw2", "r-pw", "r-pw2", "r-words"]) $(id).value = "";
  if (current) {
    openVault(current);
    const note = $("u-note");
    note.textContent = reason || "";
    note.classList.toggle("hidden", !reason);
  } else {
    show("view-welcome");
    refreshVaults();
  }
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
    else if (document.hidden && hiddenAt && Date.now() - hiddenAt > HIDDEN_MS) lockVault("Locked because the tab was in the background for more than 5 minutes.");
  }, 15000);
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
  show("view-unlock");
  refreshVaults();
  $("u-pw").focus();
}

async function showWallet() {
  show("view-wallet");
  $("k-wordlist").classList.add("hidden");
  await refreshWallet();
  refreshVaults();
}

async function refreshWallet() {
  if (!session) return;
  const r = await store.get(session.id);
  $("w-addr").textContent = session.id;
  $("w-explorer").href = `${EXPLORER}/address/${session.id}?cluster=devnet`;
  const [bal, st] = await Promise.all([rpc.balance(session.wallet), engine.chainState(r)]);
  $("w-bal").textContent = (bal / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });
  if (r.inflight) {
    const note = await session.ackInflight(st);
    if (note.state !== "none") log(note.message, note.state === "pending" ? "err" : "ok");
  }
  $("w-init-box").classList.toggle("hidden", !!st);
  for (const id of ["w-send-box", "w-tsend-box", "w-swap-box"]) $(id).classList.toggle("hidden", !st);
  refreshTokens().catch((e) => log(`token list: ${e.message}`, "err"));
  if (st) {
    $("w-status").textContent = "active on chain";
    $("w-tree").textContent = `tree ${st.epoch}, next key ${Math.max(st.next, r.next_leaf)}`;
    $("w-left").textContent = String(Math.max(0, P.EXEC_LEAF_LIMIT - Math.max(st.next, r.next_leaf)));
  } else {
    $("w-status").textContent = "not activated yet";
    $("w-tree").textContent = "tree 0";
    $("w-left").textContent = String(P.EXEC_LEAF_LIMIT);
  }
}

let tokens = [];
let altCache = null;

async function lookupTables() {
  if (!altCache) altCache = [await rpc.lookupTable(T.DEMO.alt)];
  return altCache;
}

function tokenName(mint) {
  return T.KNOWN.get(pubkey(mint).join(",")) || short(mint);
}

async function refreshTokens() {
  if (!session) return;
  tokens = (await rpc.tokenAccounts(session.wallet)).filter((t) => t.amount > 0n || t.mint === b58encode(T.DEMO.mint));
  const list = $("t-list"), sel = $("t-sel");
  list.textContent = "";
  sel.textContent = "";
  if (!tokens.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No tokens yet. Try a swap below.";
    list.append(p);
  }
  tokens.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "tok";
    const left = document.createElement("div");
    left.textContent = tokenName(t.mint);
    const m = document.createElement("div");
    m.className = "mint";
    m.textContent = t.mint;
    left.append(m);
    const right = document.createElement("div");
    right.textContent = T.formatAmount(t.amount, t.decimals);
    row.append(left, right);
    list.append(row);
    const o = document.createElement("option");
    o.value = i;
    o.textContent = `${tokenName(t.mint)}  (${T.formatAmount(t.amount, t.decimals)})`;
    sel.append(o);
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
    } catch {
      q.textContent = "\u00a0";
    }
  }, 300);
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

let pending = null;

function initCreate() {
  $("go-create").addEventListener("click", () => {
    pending = null;
    ["create-step2", "create-step3"].forEach((x) => $(x).classList.add("hidden"));
    $("create-step1").classList.remove("hidden");
    $("c-pw").value = $("c-pw2").value = "";
    $("c-err").textContent = "";
    show("view-create");
  });
  $("c-make").addEventListener("click", () => guard($("c-make"), "c-err", null, async () => {
    const pw = $("c-pw").value;
    if (pw.length < 10) throw new Error("use at least 10 characters");
    if (pw !== $("c-pw2").value) throw new Error("passwords do not match");
    setProgress("c-prog", 0);
    const { record, words } = await engine.create(pw, (p) => setProgress("c-prog", p));
    setProgress("c-prog", null);
    pending = { record, words, pw };
    renderWords($("c-words"), words);
    $("create-step1").classList.add("hidden");
    $("create-step2").classList.remove("hidden");
  }));
  $("c-copy").addEventListener("click", () => {
    if (pending) copyWords(pending.words, $("c-copy")).catch((e) => { $("c-qerr").textContent = `could not copy: ${e.message}`; });
  });
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
      const lab = document.createElement("label");
      lab.className = "f";
      lab.textContent = `Word #${i + 1}`;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.autocomplete = "off";
      inp.spellcheck = false;
      inp.dataset.idx = i;
      q.append(lab, inp);
    }
    $("c-qerr").textContent = "";
    $("create-step2").classList.add("hidden");
    $("create-step3").classList.remove("hidden");
  });
  $("c-back").addEventListener("click", () => {
    $("create-step3").classList.add("hidden");
    $("create-step2").classList.remove("hidden");
  });
  $("c-check").addEventListener("click", () => guard($("c-check"), "c-qerr", null, async () => {
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
    $("r-words").value = $("r-pw").value = $("r-pw2").value = "";
    $("r-err").textContent = "";
    show("view-recover");
  });
  $("r-go").addEventListener("click", () => guard($("r-go"), "r-err", null, async () => {
    const pw = $("r-pw").value;
    if (pw.length < 10) throw new Error("use at least 10 characters");
    if (pw !== $("r-pw2").value) throw new Error("passwords do not match");
    setProgress("r-prog", 0);
    let record = await engine.recover($("r-words").value, pw, (p) => setProgress("r-prog", p));
    setProgress("r-prog", null);
    if (await store.get(record.id)) {
      if (!confirm("This wallet already exists in this browser. Replace its password with the new one? Its key counter is kept.")) return;
      record = await engine.replace(record.id, $("r-words").value, pw, (p) => setProgress("r-prog", p));
    } else await engine.save(record);
    session = await engine.unlock(record, pw);
    current = session.id;
    remember(current);
    $("r-words").value = "";
    log(`wallet ${short(session.id)} recovered at tree ${record.epoch}`, "ok");
    await showWallet();
  }));
}

function initUnlock() {
  const go = () => guard($("u-go"), "u-err", null, async () => {
    const r = await store.get(current);
    session = await engine.unlock(r, $("u-pw").value);
    $("u-pw").value = "";
    await showWallet();
  });
  $("u-go").addEventListener("click", go);
  $("u-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("u-forget").addEventListener("click", async () => {
    if (!confirm("Remove this wallet from this browser? You can only get it back with the 24 words.")) return;
    await engine.remove(current);
    current = null;
    session = null;
    show("view-welcome");
    refreshVaults();
  });
}

function initWallet() {
  $("w-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(session.id);
    log("address copied");
  });
  $("w-refresh").addEventListener("click", () => guard(null, null, null, refreshWallet));
  $("w-lock").addEventListener("click", () => lockVault(""));
  $("w-init").addEventListener("click", () => guard($("w-init"), "s-err", null, async () => {
    needPayer();
    const res = await engine.init(await store.get(session.id));
    log(res === "already-initialized" ? "already active on chain" : `activated ${res}`, "ok");
    await refreshWallet();
  }));
  $("d-go").addEventListener("click", () => guard($("d-go"), "d-err", "d-ok", async () => {
    needPayer();
    const lamports = parseSol($("d-amt").value);
    const sol = $("d-amt").value.trim();
    const ix = [SYSTEM, [[engine.payer.key(), true, true], [session.wallet, false, true]], concat(u32(2), u64(lamports))];
    const sig = await engine.submit(ix, (await rpc.slot()) + 150, 50000);
    $("d-ok").textContent = `deposited ${sol} SOL`;
    log(`deposited ${sol} SOL from fee wallet: ${sig}`, "ok");
    $("d-amt").value = "";
    await refreshWallet();
    const bal = await rpc.balance(engine.payer.key());
    $("wallet-bal").textContent = `${(bal / 1e9).toFixed(4)} SOL for fees`;
  }));
  $("s-go").addEventListener("click", () => guard($("s-go"), "s-err", "s-ok", async () => {
    needPayer();
    const to = pubkey($("s-to").value.trim());
    if (b58encode(to) === session.id) throw new Error("that is this wallet's own address. To add funds, use Deposit above.");
    const lamports = parseSol($("s-amt").value);
    const sol = $("s-amt").value.trim();
    if (!confirm(`Send ${sol} SOL from your opeq wallet to ${b58encode(to)}?`)) return;
    setProgress("s-prog", 0);
    const sig = await session.sendSol(to, lamports, (p) => setProgress("s-prog", p));
    setProgress("s-prog", null);
    $("s-ok").textContent = `sent ${sol} SOL`;
    log(`sent ${sol} SOL to ${short(b58encode(to))}: ${sig}`, "ok");
    $("s-amt").value = "";
    await refreshWallet();
  }).finally(() => setProgress("s-prog", null)));
  $("t-go").addEventListener("click", () => guard($("t-go"), "t-err", "t-ok", async () => {
    needPayer();
    const t = tokens[Number($("t-sel").value)];
    if (!t) throw new Error("no token selected");
    const to = pubkey($("t-to").value.trim());
    if (b58encode(to) === session.id) throw new Error("that is this wallet's own address");
    const amount = T.parseAmount($("t-amt").value, t.decimals);
    if (amount > t.amount) throw new Error("not enough of this token in the wallet");
    const name = tokenName(t.mint);
    const prog = pubkey(t.program), mint = pubkey(t.mint);
    const ext = await T.mintWarnings(rpc, mint, prog);
    if (!confirm(`Send ${$("t-amt").value.trim()} ${name}\nToken mint: ${t.mint}\nto ${b58encode(to)}?${ext}`)) return;
    const inner = [T.createAtaIdempotent(engine.payer.key(), to, mint, prog),
      T.transferChecked(prog, pubkey(t.account), mint, T.ata(to, mint, prog), session.wallet, amount, t.decimals)];
    setProgress("t-prog", 0);
    const sig = await session.exec(inner, 400000, (p) => setProgress("t-prog", p), await lookupTables());
    $("t-ok").textContent = `sent ${$("t-amt").value.trim()} ${name}`;
    log(`sent ${$("t-amt").value.trim()} ${name} to ${short(b58encode(to))}: ${sig}`, "ok");
    $("t-amt").value = "";
    await refreshWallet();
  }).finally(() => setProgress("t-prog", null)));
  $("x-amt").addEventListener("input", scheduleQuote);
  $("x-dir").addEventListener("change", scheduleQuote);
  $("x-go").addEventListener("click", () => guard($("x-go"), "x-err", "x-ok", async () => {
    needPayer();
    const buy = $("x-dir").value === "buy";
    const amt = T.parseAmount($("x-amt").value, buy ? 9 : T.DEMO.decimals);
    const out = await T.quote(rpc, buy, amt);
    const minOut = (out * 99n) / 100n;
    const label = buy ? `${$("x-amt").value.trim()} SOL for about ${T.formatAmount(out, T.DEMO.decimals)} DEMO` : `${$("x-amt").value.trim()} DEMO for about ${T.formatAmount(out, 9)} SOL`;
    if (!confirm(`Swap ${label}? You get at least 99% of that or the swap is cancelled.`)) return;
    setProgress("x-prog", 0);
    const sig = await session.exec(T.swapInner(session.wallet, engine.payer.key(), buy, amt, minOut), 600000, (p) => setProgress("x-prog", p), await lookupTables());
    $("x-ok").textContent = `swapped ${label}`;
    log(`swapped ${label}: ${sig}`, "ok");
    $("x-amt").value = "";
    $("x-quote").textContent = "\u00a0";
    await refreshWallet();
  }).finally(() => setProgress("x-prog", null)));
  $("k-rekey").addEventListener("click", () => guard($("k-rekey"), "k-err", "k-ok", async () => {
    needPayer();
    if (!confirm("Move to a fresh tree of 1024 keys? Your address and words stay the same.")) return;
    setProgress("k-prog", 0);
    const sig = await session.rekey((p) => setProgress("k-prog", p));
    setProgress("k-prog", null);
    $("k-ok").textContent = "rekeyed";
    log(`rekeyed: ${sig}`, "ok");
    await refreshWallet();
  }).finally(() => setProgress("k-prog", null)));
  $("k-words").addEventListener("click", () => {
    if (!$("k-wordlist").classList.contains("hidden") || !$("k-auth").classList.contains("hidden")) { hideWords(); return; }
    $("k-auth").classList.remove("hidden");
    $("k-err").textContent = "";
    $("k-pw").focus();
  });
  $("k-cancel").addEventListener("click", hideWords);
  const showWords = () => guard($("k-show"), "k-err", null, async () => {
    const pw = $("k-pw").value;
    $("k-pw").value = "";
    const check = await engine.unlock(await store.get(session.id), pw);
    const words = check.words();
    check.master.fill(0);
    $("k-auth").classList.add("hidden");
    renderWords($("k-wordlist"), words);
    $("k-wordlist").classList.remove("hidden");
    $("k-copy-row").classList.remove("hidden");
    $("k-copy").onclick = () => copyWords(words, $("k-copy")).catch((e) => { $("k-err").textContent = `could not copy: ${e.message}`; });
    clearTimeout(wordsTimer);
    wordsTimer = setTimeout(hideWords, WORDS_MS);
  });
  $("k-show").addEventListener("click", showWords);
  $("k-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") showWords(); });
}

function initWallets() {
  const list = $("wallet-list");
  let found = [];
  const render = () => {
    list.textContent = "";
    for (const w of found) {
      const b = document.createElement("button");
      b.className = "btn btn-line";
      b.textContent = `Connect ${w.name}`;
      b.addEventListener("click", () => guard(b, null, null, async () => {
        engine.payer = await connect(w);
        $("wallet-none").classList.add("hidden");
        $("wallet-on").classList.remove("hidden");
        $("wallet-addr").textContent = engine.payer.address;
        const bal = await rpc.balance(engine.payer.key());
        $("wallet-bal").textContent = `${(bal / 1e9).toFixed(4)} SOL for fees`;
        log(`fee wallet ${short(engine.payer.address)} connected`);
      }));
      list.append(b);
    }
    $("wallet-hint").textContent = found.length ? "" : "No Solana wallet found yet. Install Phantom and reload.";
  };
  discoverWallets((ws) => { found = ws; render(); });
  setTimeout(render, 1500);
  $("wallet-off").addEventListener("click", async () => {
    try { await engine.payer.disconnect(); } catch {}
    engine.payer = null;
    $("wallet-on").classList.add("hidden");
    $("wallet-none").classList.remove("hidden");
  });
}

function applyTheme(t) {
  if (t === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-btn").textContent = t === "light" ? "Dark mode" : "Light mode";
  document.querySelector('meta[name="theme-color"]').content = t === "light" ? "#f3f6f8" : "#0b1420";
}

function initTheme() {
  let t = "dark";
  try { t = localStorage.getItem("opeq:theme") || "dark"; } catch {}
  applyTheme(t);
  $("theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    try { localStorage.setItem("opeq:theme", next); } catch {}
    applyTheme(next);
  });
}

function init() {
  initTheme();
  bonkScene($("bonk"));
  $("menu-btn").addEventListener("click", () => $("nav").classList.toggle("open"));
  $("nav").addEventListener("click", (e) => { if (e.target.tagName === "A") $("nav").classList.remove("open"); });
  window.addEventListener("hashchange", route);
  route();
  initDemo();
  initErrors();
  initCreate();
  initRecover();
  initUnlock();
  initWallet();
  initWallets();
  initAutoLock();
  refreshVaults().then(autoOpen);
  window.addEventListener("beforeunload", (e) => { if (busy) { e.preventDefault(); e.returnValue = ""; } });
}

init();
