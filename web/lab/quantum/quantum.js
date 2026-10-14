import { sha256 } from "../../lib/sha256.js";
import { bonkScene } from "../../lib/bonk.js";

const enc = new TextEncoder();
const W = 256;
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function digits(msg) {
  const d = Array.from(sha256(enc.encode(msg)).slice(0, 16));
  const csum = d.reduce((s, x) => s + (W - 1 - x), 0);
  return d.concat([csum >> 8, csum & 0xff]);
}

function field() {
  const cv = document.getElementById("field");
  const ctx = cv.getContext("2d");
  let w = 0, h = 0, dpr = 1, pts = [];
  const fit = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth; h = window.innerHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(140, Math.round((w * h) / 9000));
    pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25, r: 0.8 + Math.random() * 1.6, p: Math.random() * 6.28, c: Math.random() < 0.5 ? "34,230,255" : "255,47,179" }));
  };
  fit();
  window.addEventListener("resize", fit);
  let mx = w / 2, my = h / 2;
  window.addEventListener("pointermove", (e) => { mx = e.clientX; my = e.clientY; }, { passive: true });
  const draw = (t) => {
    ctx.clearRect(0, 0, w, h);
    const g = ctx.createRadialGradient(mx, my, 0, mx, my, Math.max(w, h) * 0.6);
    g.addColorStop(0, "rgba(123,63,255,0.14)");
    g.addColorStop(0.4, "rgba(34,230,255,0.04)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < -10) p.x = w + 10; if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10; if (p.y > h + 10) p.y = -10;
    }
    ctx.lineWidth = 0.6;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 130 * 130) {
          const k = 1 - Math.sqrt(d2) / 130;
          ctx.strokeStyle = `rgba(${a.c},${(0.22 * k).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    for (const p of pts) {
      const tw = 0.6 + 0.4 * Math.sin(t / 700 + p.p);
      ctx.fillStyle = `rgba(${p.c},${(0.9 * tw).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * tw, 0, 6.28); ctx.fill();
    }
  };
  if (reduce) { draw(0); return; }
  let last = 0;
  const loop = (t) => { if (t - last > 33) { draw(t); last = t; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

function reactor() {
  const cv = document.getElementById("tree3d");
  const ctx = cv.getContext("2d");
  const LEVELS = 7;
  const nodes = [];
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const count = 1 << (LEVELS - 1 - lvl);
    const radius = lvl === LEVELS - 1 ? 0 : 1.05 - (lvl / (LEVELS - 1)) * 0.85;
    const y = 0.95 - (lvl / (LEVELS - 1)) * 1.9;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (lvl * 0.37);
      nodes.push({ lvl, i, x: Math.cos(a) * radius, y, z: Math.sin(a) * radius });
    }
  }
  const index = new Map(nodes.map((n, k) => [`${n.lvl}:${n.i}`, k]));
  const edges = [];
  for (const n of nodes) if (n.lvl < LEVELS - 1) edges.push([index.get(`${n.lvl}:${n.i}`), index.get(`${n.lvl + 1}:${n.i >> 1}`)]);
  let lit = new Set(), leaf = 0, size = 0, dpr = 1;
  const fit = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    size = cv.clientWidth || 480;
    cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  new ResizeObserver(fit).observe(cv);
  let tiltX = 0, tiltY = 0, tx = 0, ty = 0;
  cv.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(); tx = ((e.clientX - r.left) / r.width - 0.5) * 0.8; ty = ((e.clientY - r.top) / r.height - 0.5) * 0.6; }, { passive: true });
  cv.addEventListener("pointerleave", () => { tx = 0; ty = 0; });
  const setLeaf = (l) => {
    leaf = l; lit = new Set();
    let i = l;
    for (let lvl = 0; lvl < LEVELS; lvl++) { lit.add(`${lvl}:${i}`); i >>= 1; }
  };
  setLeaf(0);
  const project = (n, rot) => {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    let x = n.x * cs - n.z * sn, z = n.x * sn + n.z * cs, y = n.y;
    const cy = Math.cos(tiltY), sy = Math.sin(tiltY);
    const y2 = y * cy - z * sy; z = y * sy + z * cy; y = y2;
    const f = 2.6 / (2.6 + z);
    return { x: size / 2 + x * f * size * 0.36 + tiltX * 20, y: size / 2 + y * f * size * 0.36, z, f };
  };
  const draw = (t) => {
    tiltX += (tx - tiltX) * 0.06; tiltY += (ty - tiltY) * 0.06;
    const rot = t / 6000;
    ctx.clearRect(0, 0, size, size);
    const ring = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.5);
    ring.addColorStop(0, "rgba(123,63,255,0.10)"); ring.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = ring; ctx.fillRect(0, 0, size, size);
    const P = nodes.map((n) => project(n, rot));
    ctx.lineCap = "round";
    for (const [a, b] of edges) {
      const A = P[a], B = P[b];
      const na = nodes[a], on = lit.has(`${na.lvl}:${na.i}`);
      const depth = (A.z + B.z) / 2;
      const alpha = on ? 0.95 : 0.12 + 0.18 * (1 - (depth + 1) / 2);
      ctx.strokeStyle = on ? `rgba(255,47,179,${alpha})` : `rgba(160,120,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = on ? 2.2 : 0.8;
      if (on) { ctx.shadowColor = "rgba(255,47,179,0.9)"; ctx.shadowBlur = 12; } else ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    const order = P.map((p, k) => k).sort((a, b) => P[a].z - P[b].z);
    for (const k of order) {
      const n = nodes[k], p = P[k], on = lit.has(`${n.lvl}:${n.i}`);
      const isLeaf = n.lvl === 0 && n.i === leaf, isRoot = n.lvl === LEVELS - 1;
      const r = (isRoot ? 6 : isLeaf ? 5 : 1.6 + n.lvl * 0.35) * p.f;
      if (on) {
        ctx.shadowColor = isLeaf ? "rgba(34,230,255,1)" : "rgba(255,47,179,0.9)";
        ctx.shadowBlur = isLeaf ? 22 : 14;
        ctx.fillStyle = isLeaf ? "#22e6ff" : isRoot ? "#ffffff" : "#ff2fb3";
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(190,170,255,${(0.25 + 0.5 * (1 - (p.z + 1) / 2)).toFixed(3)})`;
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.28); ctx.fill();
    }
    ctx.shadowBlur = 0;
    const pulse = 0.5 + 0.5 * Math.sin(t / 500);
    const root = P[index.get(`${LEVELS - 1}:0`)];
    ctx.strokeStyle = `rgba(255,255,255,${(0.25 + 0.35 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(root.x, root.y, 11 + pulse * 4, 0, 6.28); ctx.stroke();
    ctx.font = `600 11px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
    ctx.fillStyle = "rgba(239,234,255,0.8)";
    ctx.textAlign = "center";
    ctx.fillText("root, on chain", root.x, root.y - 20);
    const lf = P[index.get(`0:${leaf}`)];
    ctx.fillStyle = "rgba(34,230,255,0.9)";
    ctx.textAlign = lf.x < size * 0.3 ? "left" : lf.x > size * 0.7 ? "right" : "center";
    ctx.fillText("this signature's key, 1 of 1024", Math.min(size - 6, Math.max(6, lf.x)), Math.min(size - 8, lf.y + 18));
  };
  if (reduce) { draw(0); return setLeaf; }
  const loop = (t) => { draw(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return (l) => { setLeaf(l); };
}

function equalizer(setLeaf) {
  const eq = document.getElementById("eq");
  const bars = Array.from({ length: 18 }, () => { const i = document.createElement("i"); eq.append(i); return i; });
  const input = document.getElementById("msg");
  const costEl = document.getElementById("cost");
  const update = () => {
    const ds = digits(input.value);
    ds.forEach((d, c) => { bars[c].style.height = `${Math.max(6, (d / 255) * 100)}%`; });
    setLeaf(ds[15] & 63);
    const cost = ds.reduce((s, x) => s + (W - 1 - x), 0);
    costEl.textContent = `18 revealed rungs. the verifier climbs ${cost.toLocaleString("en-US")} rungs for this message`;
  };
  update();
  input.addEventListener("input", update);
}

field();
const setLeaf = reactor();
equalizer(setLeaf);
const bonk = document.getElementById("bonk");
if (bonk) bonkScene(bonk);
