import { SAFE, ROBOT, QC } from "./sprites.js";
import { glyph } from "./pixelfont.js";

const C = {
  night0: "#0c1430", night1: "#111c42", night2: "#17245a", night3: "#1e2d6b",
  cream: "#fff3d6", creamD: "#e8d9b5", beige: "#e9dcc0", beigeD: "#c8b994", beigeDD: "#9d8f6e",
  screen: "#0a1020", ice: "#3ad0ff", iceD: "#1c7fa8", metal: "#9aa6b8", metalD: "#6b778a",
  ink: "#0b0e13", star: "#fff3d6", cloud: "#2a3a7a", cloudL: "#34488f", moon: "#f6e6b8", moonD: "#d9c58f",
  grass: "#2fa58c", grassL: "#45c6a8", dirt: "#3a2f63", dirtL: "#4a3d7a", red: "#ff4d5e", violet: "#8b6cff",
  violetD: "#553cc4", yellow: "#ffd84d", led: "#5be49b",
};

const SAFE_MAP = { I: C.ice, S: "#2b3544", D: "#455266", L: "#2b3544", W: "#ffffff", K: C.ink, P: C.cream, O: C.cream, C: C.ice };
const ROBOT_MAP = { r: C.red, g: "#455266", M: "#9aa6b8", R: C.red, w: C.ink };
const QC_MAP = { v: C.violet, p: C.violetD, R: C.red };

function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function sprite(ctx, rows, map, x, y, k = 1, override) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === ".") continue;
      const color = (override && override(j, i, ch)) || map[ch];
      rect(ctx, x + i * k, y + j * k, k, k, color);
    }
  });
}

const boldCache = new Map();

function boldGlyph(ch) {
  if (boldCache.has(ch)) return boldCache.get(ch);
  let rows = glyph(ch).map((r) => r.padEnd(5, "0"));
  if (ch === " ") { boldCache.set(ch, { rows: [], w: 3 }); return boldCache.get(ch); }
  const stem = [...rows[0]].map((_, c) => {
    let best = 0, run = 0;
    for (const row of rows) { run = row[c] === "1" ? run + 1 : 0; best = Math.max(best, run); }
    return best >= 3;
  });
  rows = rows.map((row) => [...row].map((b, c) => (stem[c] ? b + b : b)).join(""));
  const used = [...rows[0]].map((_, c) => rows.some((row) => row[c] === "1"));
  const a = used.indexOf(true), b = used.lastIndexOf(true);
  rows = rows.map((row) => row.slice(a, b + 1));
  const out = { rows, w: b - a + 1 };
  boldCache.set(ch, out);
  return out;
}

function textWidth(s) {
  return [...s].reduce((w, ch) => w + boldGlyph(ch).w + 1, -1);
}

function text(ctx, s, x, y, color, align = "left") {
  let cx = Math.round(align === "center" ? x - textWidth(s) / 2 : x);
  const top = Math.round(y) - 7;
  for (const ch of s) {
    const g = boldGlyph(ch);
    g.rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] === "1") rect(ctx, cx + i, top + j, 1, 1, color); });
    cx += g.w + 1;
  }
}

function merkle(ctx, x, y, s, fg, leaf) {
  const cell = 3 * s, step = 4 * s;
  const cells = [[1.5, 0, 1], [0.5, 1, 0], [2.5, 1, 1], [0, 2, 0], [1, 2, 0], [2, 2, 2], [3, 2, 0]];
  for (const [cx, cy, kind] of cells) {
    const px = x + Math.round(cx * step), py = y + cy * step;
    if (kind === 1) rect(ctx, px, py, cell, cell, fg);
    else if (kind === 2) rect(ctx, px, py, cell, cell, leaf);
    else {
      rect(ctx, px, py, cell, s, fg); rect(ctx, px, py + cell - s, cell, s, fg);
      rect(ctx, px, py, s, cell, fg); rect(ctx, px + cell - s, py, s, cell, fg);
    }
  }
}

function seeded(n) {
  let s = n;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function sky(ctx, W, H, t, stars) {
  const bands = [C.night0, C.night1, C.night2, C.night3];
  const bh = Math.ceil(H / bands.length);
  bands.forEach((c, i) => rect(ctx, 0, i * bh, W, bh, c));
  for (let i = 0; i < bands.length - 1; i++) {
    for (let x = 0; x < W; x += 2) rect(ctx, x + ((i & 1) ? 1 : 0), (i + 1) * bh - 1, 1, 1, bands[i]);
  }
  for (const s of stars) {
    const on = Math.sin(t * s.speed + s.phase) > -0.6;
    if (!on) continue;
    rect(ctx, s.x, s.y, 1, 1, C.star);
    if (s.big && Math.sin(t * s.speed + s.phase) > 0.7) {
      rect(ctx, s.x - 1, s.y, 1, 1, C.creamD); rect(ctx, s.x + 1, s.y, 1, 1, C.creamD);
      rect(ctx, s.x, s.y - 1, 1, 1, C.creamD); rect(ctx, s.x, s.y + 1, 1, 1, C.creamD);
    }
  }
}

function makeStars(W, H, n, seed) {
  const r = seeded(seed);
  return Array.from({ length: n }, () => ({ x: Math.floor(r() * W), y: Math.floor(r() * H * 0.75), speed: 0.6 + r() * 1.6, phase: r() * 6.28, big: r() < 0.15 }));
}

function cloud(ctx, x, y, w) {
  rect(ctx, x + 4, y, w - 8, 3, C.cloudL);
  rect(ctx, x, y + 3, w, 4, C.cloud);
  rect(ctx, x + 8, y - 3, w * 0.4, 3, C.cloudL);
}

function moon(ctx, x, y) {
  rect(ctx, x + 3, y, 8, 14, C.moon); rect(ctx, x, y + 3, 14, 8, C.moon); rect(ctx, x + 1, y + 1, 12, 12, C.moon);
  rect(ctx, x + 4, y + 4, 2, 2, C.moonD); rect(ctx, x + 8, y + 7, 3, 2, C.moonD); rect(ctx, x + 5, y + 9, 2, 2, C.moonD);
}

function computer(ctx, t, plugged, screenPhase, blink) {
  rect(ctx, 70, 30, 52, 42, C.beigeD);
  rect(ctx, 71, 31, 50, 40, C.beige);
  rect(ctx, 76, 36, 40, 30, C.beigeDD);
  rect(ctx, 77, 37, 38, 28, C.screen);
  rect(ctx, 79, 38, 6, 1, "#1a2440");
  rect(ctx, 92, 72, 10, 6, C.beigeD);
  rect(ctx, 84, 78, 26, 3, C.beigeD);
  rect(ctx, 85, 78, 24, 2, C.beige);
  rect(ctx, 112, 67, 3, 2, plugged ? C.led : C.beigeDD);
  rect(ctx, 128, 34, 24, 48, C.beigeD);
  rect(ctx, 129, 35, 22, 46, C.beige);
  rect(ctx, 132, 40, 16, 2, C.beigeDD);
  rect(ctx, 132, 45, 16, 2, C.beigeDD);
  rect(ctx, 133, 75, 3, 2, plugged && blink ? C.ice : C.beigeDD);
  rect(ctx, 139, 59, 8, 5, C.beigeDD);
  rect(ctx, 140, 60, 6, 3, C.ink);
  if (screenPhase === 1 && Math.floor(t * 2.5) % 2 === 0) {
    rect(ctx, 81, 42, 2, 2, C.ice); rect(ctx, 83, 44, 2, 2, C.ice); rect(ctx, 81, 46, 2, 2, C.ice);
    rect(ctx, 87, 47, 7, 1, C.ice);
  } else if (screenPhase === 1) {
    rect(ctx, 81, 42, 2, 2, C.ice); rect(ctx, 83, 44, 2, 2, C.ice); rect(ctx, 81, 46, 2, 2, C.ice);
  }
  if (screenPhase === 2) {
    merkle(ctx, 89, 41, 1, C.cream, C.ice);
    text(ctx, "opeq", 96, 61, C.cream, "center");
  }
}

function usb(ctx, x) {
  rect(ctx, x, 60, 7, 3, C.metal);
  rect(ctx, x + 1, 61, 2, 1, C.metalD); rect(ctx, x + 4, 61, 2, 1, C.metalD);
  rect(ctx, x + 7, 58, 16, 7, C.iceD);
  rect(ctx, x + 7, 58, 16, 6, C.ice);
  rect(ctx, x + 12, 59, 2, 2, C.cream); rect(ctx, x + 10, 62, 1, 1, C.cream); rect(ctx, x + 12, 62, 1, 1, C.cream);
  rect(ctx, x + 14, 62, 1, 1, C.ink); rect(ctx, x + 16, 62, 1, 1, C.cream);
  rect(ctx, x + 21, 60, 1, 3, C.iceD);
}

export async function playIntro() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try { if (sessionStorage.getItem("opeq:intro")) return; } catch {}
  if (reduce) return;
  try { sessionStorage.setItem("opeq:intro", "1"); } catch {}
  const W = 240, H = 135;
  const wrap = document.createElement("div");
  wrap.className = "boot";
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  cv.className = "boot-canvas";
  cv.setAttribute("aria-hidden", "true");
  const skip = document.createElement("button");
  skip.className = "boot-skip";
  skip.textContent = "Skip";
  wrap.append(cv, skip);
  document.body.append(wrap);
  const ctx = cv.getContext("2d");
  const stars = makeStars(W, H, 40, 7);
  const start = performance.now();
  const DUR = 4.2;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    wrap.classList.add("boot-out");
    setTimeout(() => wrap.remove(), 500);
  };
  skip.addEventListener("click", finish);
  wrap.addEventListener("click", finish);
  window.addEventListener("keydown", finish, { once: true });
  const frame = (now) => {
    if (done) return;
    const t = (now - start) / 1000;
    sky(ctx, W, H, t, stars);
    const ease = (v) => 1 - Math.pow(1 - Math.min(1, Math.max(0, v)), 3);
    const x = 250 - (250 - 140) * ease((t - 0.2) / 1.1);
    const plugged = t > 1.3;
    const screenPhase = t < 1.5 ? 0 : t < 2.6 ? 1 : 2;
    computer(ctx, t, plugged, screenPhase, Math.floor(t * 6) % 2 === 0);
    usb(ctx, plugged ? 139 : x);
    if (t > 1.3 && t < 1.6) {
      for (const [dx, dy] of [[-3, -3], [-3, 6], [3, -5], [3, 8]]) rect(ctx, 145 + dx * 2, 61 + dy, 1, 1, C.yellow);
    }
    const label = t < 1.3 ? "Plugging in your key..." : t < 2.8 ? "Securing your keys..." : "Quantum-proof. Ready.";
    text(ctx, label, W / 2, 104, C.cream, "center");
    rect(ctx, 60, 111, 120, 6, C.cream);
    rect(ctx, 61, 112, 118, 4, C.screen);
    const fill = Math.min(1, Math.max(0, (t - 0.3) / 2.9));
    for (let i = 0; i < Math.floor(fill * 28); i++) rect(ctx, 62 + i * 4, 113, 3, 2, C.ice);
    if (t >= DUR) { finish(); return; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function heroScene(canvas) {
  const W = 320, H = 150;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const stars = makeStars(W, H, 70, 3);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let visible = true;
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(canvas);
  const draw = (t) => {
    sky(ctx, W, H, t, stars);
    moon(ctx, 268, 14);
    const drift = (sp, off) => ((t * sp + off) % (W + 80)) - 60;
    cloud(ctx, drift(4, 0), 22, 46);
    cloud(ctx, drift(2.5, 180), 40, 60);
    cloud(ctx, drift(3.2, 320), 12, 34);
    rect(ctx, 0, 122, W, 28, C.dirt);
    rect(ctx, 0, 118, W, 5, C.grass);
    rect(ctx, 0, 118, W, 1, C.grassL);
    for (let x = 3; x < W; x += 9) rect(ctx, x, 116 + ((x * 7) % 3), 1, 2, C.grassL);
    for (let x = 0; x < W; x += 6) rect(ctx, x + ((x / 6) & 1 ? 3 : 0), 130 + ((x * 3) % 5), 2, 1, C.dirtL);
    const glow = 0.5 + 0.5 * Math.sin(t * 2);
    ctx.globalAlpha = 0.18 + glow * 0.12;
    rect(ctx, 196, 64, 64, 56, C.ice);
    ctx.globalAlpha = 1;
    const blink = Math.floor(t * 10) % 40 === 0;
    sprite(ctx, SAFE, SAFE_MAP, 204, 70, 2, blink ? (j, i, ch) => (j >= 5 && j <= 7 && (ch === "W" || ch === "K") ? SAFE_MAP.S : null) : null);
    const peek = Math.sin(t * 0.8) > 0.3 ? 0 : 3;
    sprite(ctx, ROBOT, ROBOT_MAP, 140, 98 + peek, 1);
    const bob = Math.round(Math.sin(t * 1.6) * 2);
    sprite(ctx, QC, QC_MAP, 290, 46 + bob, 1);
  };
  let last = 0;
  const loop = (now) => {
    if (visible && now - last > 80) { draw(now / 1000); last = now; }
    if (!reduce) requestAnimationFrame(loop);
  };
  draw(0);
  if (!reduce) requestAnimationFrame(loop);
}

export function starBackground() {
  const cv = document.createElement("canvas");
  cv.width = 160; cv.height = 160;
  const ctx = cv.getContext("2d");
  const r = seeded(11);
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = r() < 0.2 ? "rgba(255,243,214,0.55)" : "rgba(255,243,214,0.25)";
    ctx.fillRect(Math.floor(r() * 160), Math.floor(r() * 160), 1, 1);
  }
  return cv.toDataURL("image/png");
}
