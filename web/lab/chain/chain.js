import { sha256 } from "../../lib/sha256.js";
import { Rpc } from "../../lib/solana.js";
import { bonkScene } from "../../lib/bonk.js";

const PROGRAM = "424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN";
const EXPLORER = "https://explorer.solana.com";
const rpc = new Rpc("https://api.devnet.solana.com");
const enc = new TextEncoder();
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const short = (s, n = 6) => `${s.slice(0, n)}…${s.slice(-n)}`;

function network() {
  const cv = $("net");
  const ctx = cv.getContext("2d");
  let w = 0, h = 0, nodes = [], edges = [], packets = [];
  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth; h = window.innerHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(70, Math.round((w * h) / 16000));
    nodes = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12, r: 1.2 + Math.random() * 1.6 }));
    edges = [];
    for (let i = 0; i < n; i++) {
      const near = nodes.map((m, j) => ({ j, d: Math.hypot(m.x - nodes[i].x, m.y - nodes[i].y) })).filter((e) => e.j !== i).sort((a, b) => a.d - b.d).slice(0, 2);
      for (const e of near) if (!edges.some(([a, b]) => (a === i && b === e.j) || (a === e.j && b === i))) edges.push([i, e.j]);
    }
    packets = [];
  };
  fit();
  window.addEventListener("resize", fit);
  const draw = (t) => {
    ctx.clearRect(0, 0, w, h);
    for (const p of nodes) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = "rgba(180,200,230,0.09)";
    ctx.beginPath();
    for (const [a, b] of edges) { ctx.moveTo(nodes[a].x, nodes[a].y); ctx.lineTo(nodes[b].x, nodes[b].y); }
    ctx.stroke();
    for (const p of nodes) { ctx.fillStyle = "rgba(180,200,230,0.35)"; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill(); }
    if (!reduce && Math.random() < 0.08 && edges.length) packets.push({ e: edges[(Math.random() * edges.length) | 0], k: 0, s: 0.006 + Math.random() * 0.008, dir: Math.random() < 0.5 ? 1 : -1 });
    for (const q of packets) {
      q.k += q.s;
      const [a, b] = q.e;
      const A = q.dir > 0 ? nodes[a] : nodes[b], B = q.dir > 0 ? nodes[b] : nodes[a];
      const x = A.x + (B.x - A.x) * q.k, y = A.y + (B.y - A.y) * q.k;
      ctx.fillStyle = "rgba(58,208,255,0.9)";
      ctx.shadowColor = "rgba(58,208,255,0.8)"; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 6.28); ctx.fill();
      ctx.shadowBlur = 0;
    }
    packets = packets.filter((q) => q.k < 1);
  };
  if (reduce) { draw(0); return; }
  let last = 0;
  const loop = (t) => { if (t - last > 33) { draw(t); last = t; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

function setState(ok, label) {
  const tag = $("net-state"), pulse = $("pulse");
  tag.textContent = label;
  tag.classList.toggle("on", ok === true);
  tag.classList.toggle("err", ok === false);
  pulse.classList.toggle("on", ok === true);
  pulse.classList.toggle("err", ok === false);
}

function ribbon() {
  const track = $("ribbon");
  let lastSlot = 0, shown = 0;
  const push = (slot) => {
    const el = document.createElement("div");
    el.className = "slot head";
    const b = document.createElement("b"); b.textContent = slot.toLocaleString("en-US");
    const s = document.createElement("span"); s.textContent = new Date().toLocaleTimeString("en-GB");
    el.append(b, s);
    for (const old of track.querySelectorAll(".slot.head")) old.classList.remove("head");
    track.prepend(el);
    while (track.children.length > 14) track.lastElementChild.remove();
    shown++;
    $("ribbon-note").textContent = `${shown} slot${shown === 1 ? "" : "s"} seen since you opened this page`;
  };
  const tick = async () => {
    try {
      const slot = await rpc.slot();
      $("slot").textContent = slot.toLocaleString("en-US");
      $("slot-2").textContent = slot.toLocaleString("en-US");
      setState(true, "live");
      if (slot > lastSlot) { push(slot); lastSlot = slot; }
    } catch {
      setState(false, "rpc unreachable");
    }
  };
  tick();
  setInterval(tick, 2500);
}

async function programInfo() {
  try {
    const height = await rpc.call("getBlockHeight", [{ commitment: "confirmed" }]);
    $("height").textContent = height.toLocaleString("en-US");
  } catch { $("height").textContent = "n/a"; }
  try {
    const info = await rpc.call("getAccountInfo", [PROGRAM, { encoding: "base64", commitment: "confirmed" }]);
    const data = info && info.value ? atob(info.value.data[0]) : "";
    const pd = data.length >= 36 ? data.slice(4, 36) : "";
    if (pd) {
      const bytes = Uint8Array.from(pd, (c) => c.charCodeAt(0));
      const { b58encode } = await import("../../lib/solana.js");
      const pdInfo = await rpc.call("getAccountInfo", [b58encode(bytes), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }]);
      const space = pdInfo && pdInfo.value ? pdInfo.value.space : null;
      $("prog-size").textContent = space ? `${(space - 45).toLocaleString("en-US")} B capacity, 8,080 B used (rev 1.1)` : "8,080 B (rev 1.1)";
    } else $("prog-size").textContent = "8,080 B (rev 1.1)";
  } catch { $("prog-size").textContent = "8,080 B (rev 1.1)"; }
}

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function feed() {
  const list = $("feed");
  try {
    const sigs = await rpc.call("getSignaturesForAddress", [PROGRAM, { limit: 10, commitment: "confirmed" }]);
    list.textContent = "";
    if (!sigs.length) { const li = document.createElement("li"); li.className = "dim"; li.textContent = "no transactions yet"; list.append(li); return; }
    for (const s of sigs) {
      const li = document.createElement("li");
      const dot = document.createElement("i"); dot.className = s.err ? "bad" : "ok";
      const a = document.createElement("a");
      a.href = `${EXPLORER}/tx/${s.signature}?cluster=devnet`; a.rel = "noopener noreferrer"; a.target = "_blank";
      a.textContent = short(s.signature, 8);
      a.title = s.err ? "failed" : "confirmed";
      const t = document.createElement("time"); t.textContent = ago(s.blockTime);
      li.append(dot, a, t);
      list.append(li);
    }
  } catch {
    list.textContent = "";
    const li = document.createElement("li"); li.className = "dim"; li.textContent = "could not load transactions"; list.append(li);
  }
}

function hashChain() {
  const blocks = Array.from(document.querySelectorAll(".block"));
  let prev = "genesis";
  for (const b of blocks) {
    const text = b.querySelector("[data-body]").textContent.replace(/\s+/g, " ").trim();
    const h = hex(sha256(enc.encode(prev + "\n" + text))).slice(0, 16);
    b.querySelector("[data-hash]").textContent = h;
    b.querySelector("[data-prev]").textContent = prev === "genesis" ? "genesis" : prev;
    prev = h;
  }
  const mark = (b) => { b.classList.add("confirmed"); b.querySelector("[data-state]").textContent = "confirmed"; };
  if (reduce) { blocks.forEach(mark); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { mark(e.target); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -20% 0px" });
  blocks.forEach((b) => io.observe(b));
}

network();
ribbon();
programInfo();
feed();
setInterval(feed, 45000);
hashChain();
const bonk = $("bonk");
if (bonk) bonkScene(bonk);
