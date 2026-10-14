import { rr, vg, dot, logo } from "./intro.js";

const W = 192, H = 108, GROUND = 96;
const C = {
  bg0: "#0f1a28", bg1: "#0a121c", floor: "#132030", floorLine: "#26364b",
  ice: "#3ad0ff", iceHi: "#9beaff", paper: "#eef1f5", ink: "#0b0e13",
  steel0: "#334155", steel1: "#1f2834", door: "#3a475b", doorLine: "#4f5e75",
  metalHi: "#d5dce6", metal: "#9aa6b8", metalLo: "#5d6879", red: "#ff4d5e",
  violet: "#8b6cff", violetHi: "#b3a0ff", violetLo: "#4a33b0", yellow: "#ffd84d",
};

const SAFE_X = 72, SAFE_Y = GROUND - 48;
const PIVOT = [SAFE_X + 24, SAFE_Y - 1];
const AI_STOP = 18, QC_STOP = 142, QC_Y = 24;
const UP = -Math.PI / 2;
const AI_T = [AI_STOP + 16, GROUND - 48];
const QC_T = [QC_STOP + 16, QC_Y - 8];
const HIT_AI = Math.atan2(AI_T[1] - PIVOT[1], AI_T[0] - PIVOT[0]) - 2 * Math.PI;
const HIT_QC = Math.atan2(QC_T[1] - PIVOT[1], QC_T[0] - PIVOT[0]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const L_AI = dist(PIVOT, AI_T), L_QC = dist(PIVOT, QC_T);
const FRAMES = 104, STEP = 0.08, HOLD = 2.5;

const clamp = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => a + (b - a) * clamp(t);
const ease = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };

function font(weight, size) {
  const sans = getComputedStyle(document.documentElement).getPropertyValue("--sans").trim() || "sans-serif";
  return `${weight} ${size}px ${sans}`;
}

function label(ctx, s, x, y, color, size, weight = 700) {
  ctx.save();
  ctx.font = font(weight, size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = size * 0.28;
  ctx.strokeStyle = C.ink;
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.restore();
}

function background(ctx) {
  ctx.fillStyle = vg(ctx, 0, GROUND, C.bg0, C.bg1);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(238,241,245,0.05)";
  for (let y = 6; y < GROUND; y += 8) for (let x = 6; x < W; x += 8) ctx.fillRect(x, y, 0.6, 0.6);
  ctx.fillStyle = C.floor;
  ctx.fillRect(0, GROUND, W, H - GROUND);
  ctx.fillStyle = C.floorLine;
  ctx.fillRect(0, GROUND, W, 0.8);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  for (let k = 0; k < W; k += 12) { ctx.fillRect(k + 3, GROUND + 5, 1.2, 0.6); ctx.fillRect(k + 9, GROUND + 9, 1.2, 0.6); }
}

function shadow(ctx, cx, w, alpha = 0.45) {
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.beginPath();
  ctx.ellipse(cx, GROUND + 1, w / 2, 1.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function safe(ctx, f) {
  const x = SAFE_X, y = SAFE_Y;
  const g = ctx.createRadialGradient(x + 24, y + 22, 4, x + 24, y + 22, 40);
  g.addColorStop(0, "rgba(58,208,255,0.16)");
  g.addColorStop(1, "rgba(58,208,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - 20, y - 20, 88, 80);
  shadow(ctx, x + 24, 44);
  rr(ctx, x + 7, y + 41, 7, 7, 2, C.ice);
  rr(ctx, x + 34, y + 41, 7, 7, 2, C.ice);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x + 1, y + 1, 46, 42, 8);
  ctx.fillStyle = vg(ctx, y, y + 44, C.steel0, C.steel1);
  ctx.fill();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = C.ice;
  ctx.shadowColor = "rgba(58,208,255,0.6)";
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.restore();
  rr(ctx, x + 6, y + 6, 36, 33, 5, C.door, C.doorLine);
  const blink = f % 40 < 2;
  const look = f >= 14 && f < 40 ? (Math.floor(f / 6) % 2 === 0 ? -1 : 1) : 0;
  for (const ex of [x + 15, x + 33]) {
    ctx.save();
    ctx.translate(ex, y + 13);
    ctx.scale(1, blink ? 0.15 : 1);
    dot(ctx, 0, 0, 3.8, "#ffffff");
    dot(ctx, look * 1.5, 0.3, 1.8, C.ink);
    ctx.restore();
  }
  logo(ctx, x + 12, y + 21, 1.6, C.paper, C.ice);
}

function robot(ctx, x, y, squash, dazed) {
  shadow(ctx, x + 16, 26);
  ctx.save();
  ctx.translate(x, y + 40);
  ctx.scale(1, squash);
  ctx.translate(0, -40);
  ctx.strokeStyle = C.metalLo;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(16, 6); ctx.lineTo(16, 1.5); ctx.stroke();
  dot(ctx, 16, 1.5, 1.8, C.red, 4);
  rr(ctx, 1, 24, 4, 10, 2, C.metal, C.metalLo);
  rr(ctx, 27, 24, 4, 10, 2, C.metal, C.metalLo);
  rr(ctx, 9, 34, 5.5, 6, 1.5, C.metalLo);
  rr(ctx, 17.5, 34, 5.5, 6, 1.5, C.metalLo);
  rr(ctx, 5, 22, 22, 13, 4, vg(ctx, 22, 35, C.metalHi, C.metal), C.metalLo);
  rr(ctx, 12, 28, 8, 2.2, 1.1, C.red);
  rr(ctx, 12.5, 19.5, 7, 3, 1, C.metalLo);
  rr(ctx, 3.5, 5, 25, 15.5, 4.5, vg(ctx, 5, 20, C.metalHi, C.metal), C.metalLo);
  for (const ex of [10.5, 21.5]) {
    if (dazed) {
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(ex - 2.2, 9.6); ctx.lineTo(ex + 2.2, 13.8);
      ctx.moveTo(ex + 2.2, 9.6); ctx.lineTo(ex - 2.2, 13.8);
      ctx.stroke();
    } else {
      ctx.save();
      ctx.shadowColor = C.red;
      ctx.shadowBlur = 4;
      rr(ctx, ex - 3, 9, 6, 5, 1.6, C.red);
      ctx.restore();
    }
  }
  rr(ctx, 10, 16, 12, 2, 1, C.ink);
  ctx.restore();
}

function quantum(ctx, x, y, squash, dazed) {
  const g = ctx.createRadialGradient(x + 16, y + 20, 2, x + 16, y + 20, 26);
  g.addColorStop(0, "rgba(139,108,255,0.22)");
  g.addColorStop(1, "rgba(139,108,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - 12, y - 8, 56, 52);
  ctx.save();
  ctx.translate(x, y + 34);
  ctx.scale(1, squash);
  ctx.translate(0, -34);
  ctx.strokeStyle = C.violet;
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const [xs, y0, y1] of [[[10, 16, 22], 6.4, 10], [[7.5, 13, 19, 24.5], 12.4, 16], [[5, 12, 20, 27], 18.4, 22.5]]) {
    for (const rx of xs) { ctx.moveTo(rx, y0); ctx.lineTo(rx, y1); }
  }
  ctx.stroke();
  rr(ctx, 14, 0, 4, 5, 1.5, C.violet);
  rr(ctx, 6, 4, 20, 2.6, 1.3, C.violetHi);
  rr(ctx, 4, 10, 24, 2.6, 1.3, C.violetHi);
  rr(ctx, 2, 16, 28, 2.6, 1.3, C.violetHi);
  rr(ctx, 3, 22, 26, 9.5, 4.5, vg(ctx, 22, 31.5, C.violet, C.violetLo));
  rr(ctx, 12, 30.5, 8, 3.5, 1.6, C.violetLo);
  for (const ex of [10, 22]) {
    if (dazed) {
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ex - 2.2, 24.6); ctx.lineTo(ex + 2.2, 28.8);
      ctx.moveTo(ex + 2.2, 24.6); ctx.lineTo(ex - 2.2, 28.8);
      ctx.stroke();
    } else {
      ctx.save();
      ctx.shadowColor = C.red;
      ctx.shadowBlur = 4;
      rr(ctx, ex - 3, 24.2, 6, 5, 1.6, C.red);
      ctx.restore();
    }
  }
  ctx.restore();
}

function hammer(ctx, ang, length) {
  ctx.save();
  ctx.translate(PIVOT[0], PIVOT[1]);
  ctx.rotate(ang);
  const h = ctx.createLinearGradient(0, -2, 0, 2);
  h.addColorStop(0, C.metalHi);
  h.addColorStop(1, C.metalLo);
  rr(ctx, 0, -1.8, Math.max(0, length - 7), 3.6, 1.8, h);
  ctx.translate(length, 0);
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 3;
  rr(ctx, -8, -12, 16, 24, 3.5, C.paper);
  ctx.shadowBlur = 0;
  rr(ctx, -8, -2.4, 16, 4.8, 0, C.ice);
  rr(ctx, -8, -12, 16, 24, 3.5, null, C.ink);
  ctx.restore();
}

function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fillStyle = C.yellow;
  ctx.fill();
}

function stars(ctx, cx, cy, phase, r) {
  for (let k = 0; k < 3; k++) {
    const a = phase + (k * 2 * Math.PI) / 3;
    star(ctx, cx + r * Math.cos(a), cy + 0.4 * r * Math.sin(a), 2.3);
  }
}

function burst(ctx, cx, cy, r, k) {
  ctx.save();
  ctx.strokeStyle = C.yellow;
  ctx.globalAlpha = 1 - k * 0.6;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + Math.PI / 8;
    ctx.moveTo(cx + (r - 5) * Math.cos(a), cy + (r - 5) * Math.sin(a));
    ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.stroke();
  ctx.restore();
}

function bonkText(ctx, x, y, k) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.12);
  const s = k < 0.25 ? 0.6 + k * 2.4 : 1.2 - Math.min(0.2, (k - 0.25) * 0.4);
  ctx.scale(s, s);
  label(ctx, "BONK!", 0, 0, C.yellow, 16, 800);
  ctx.restore();
}

export function scene(ctx, f) {
  ctx.clearRect(0, 0, W, H);
  background(ctx);
  safe(ctx, f);

  let aiX = lerp(-36, AI_STOP, ease((f - 10) / 26));
  let qcX = lerp(W + 4, QC_STOP, ease((f - 12) / 26));
  if (f >= 66) {
    aiX = lerp(AI_STOP, -40, ease((f - 66) / 12));
    qcX = lerp(QC_STOP, W + 40, ease((f - 68) / 12));
  }
  const qcY = QC_Y + (f >= 54 && f < 66 ? 0 : 2 * Math.sin(f / 3));
  const aiSquash = f >= 46 && f < 50 ? 0.6 : f >= 50 && f < 54 ? 0.8 : 1;
  const qcSquash = f >= 58 && f < 62 ? 0.6 : f >= 62 && f < 65 ? 0.8 : 1;
  const aiDazed = f >= 46 && f < 78, qcDazed = f >= 58 && f < 80;
  const hop = f > 10 && f < 36 ? -Math.abs(Math.sin(f * 1.05)) * 2 : 0;

  if (f < 80) {
    robot(ctx, aiX, GROUND - 40 + hop, aiSquash, aiDazed);
    quantum(ctx, qcX, qcY, qcSquash, qcDazed);
    if (f >= 16 && f < 46) {
      const a = clamp((f - 16) / 3);
      ctx.save();
      ctx.globalAlpha = a;
      label(ctx, "AI", aiX + 16, GROUND - 48, C.red, 8);
      label(ctx, "Quantum", qcX + 16, qcY - 7, C.violetHi, 8);
      ctx.restore();
    }
    if (f >= 30 && f < 42 && Math.floor(f / 2) % 2 === 0) {
      label(ctx, "?", aiX + 37, GROUND - 42, C.yellow, 9, 800);
      label(ctx, "?", qcX - 5, qcY + 8, C.yellow, 9, 800);
    }
    if (aiDazed && f >= 50) stars(ctx, aiX + 16, GROUND - 44 + (40 - 40 * aiSquash), f / 2, 14);
    if (qcDazed && f >= 62) stars(ctx, qcX + 16, qcY - 4 + (34 - 34 * qcSquash), f / 2, 14);
  }

  let ang = null, length = 0;
  if (f >= 36 && f < 42) { ang = UP; length = lerp(4, L_AI, (f - 36) / 5); }
  else if (f >= 42 && f < 46) { ang = lerp(UP, HIT_AI, ease((f - 41) / 4)); length = L_AI; }
  else if (f >= 46 && f < 52) {
    const t = [AI_T[0], GROUND - 40 * aiSquash - 8];
    ang = Math.atan2(t[1] - PIVOT[1], t[0] - PIVOT[0]) - 2 * Math.PI;
    length = dist(PIVOT, t);
  } else if (f >= 52 && f < 58) { const t = ease((f - 51) / 6); ang = lerp(HIT_AI, HIT_QC, t); length = lerp(L_AI, L_QC, t); }
  else if (f >= 58 && f < 64) {
    const t = [QC_T[0], qcY + 34 * (1 - qcSquash) - 8];
    ang = Math.atan2(t[1] - PIVOT[1], t[0] - PIVOT[0]);
    length = dist(PIVOT, t);
  } else if (f >= 64 && f < 72) { ang = lerp(HIT_QC, UP, ease((f - 63) / 8)); length = lerp(L_QC, 4, (f - 66) / 6); }
  if (ang !== null && length > 5) hammer(ctx, ang, length);

  if (f >= 46 && f < 52) { burst(ctx, AI_T[0], AI_T[1] + 8, 18 + (f - 46), (f - 46) / 6); bonkText(ctx, 34, 16, (f - 46) / 6); }
  if (f >= 58 && f < 64) { burst(ctx, QC_T[0], QC_T[1] + 8, 18 + (f - 58), (f - 58) / 6); bonkText(ctx, 150, 70, (f - 58) / 6); }

  if (f >= 80) {
    const t = ease((f - 80) / 8);
    ctx.fillStyle = "rgba(9,14,22,0.94)";
    ctx.fillRect(0, 0, W, 46 * t);
    if (f >= 86) {
      ctx.save();
      ctx.globalAlpha = clamp((f - 86) / 3);
      label(ctx, "Quantum-proof wallets", W / 2, 11, C.paper, 7.5, 600);
      ctx.restore();
    }
    if (f >= 90) {
      ctx.save();
      ctx.globalAlpha = clamp((f - 90) / 3);
      ctx.shadowColor = "rgba(58,208,255,0.5)";
      ctx.shadowBlur = 5;
      logo(ctx, 71, 22, 1.4, C.paper, C.ice);
      ctx.shadowBlur = 0;
      ctx.font = font(650, 15);
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = C.paper;
      ctx.fillText("opeq", 98, 36);
      ctx.restore();
    }
  } else if (f < 10) {
    ctx.save();
    ctx.globalAlpha = 1 - clamp((f - 7) / 3);
    label(ctx, "opeq", W / 2, 18, C.paper, 15, 650);
    ctx.restore();
  }
}

function fit(canvas) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || W * 4;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(w * (H / W) * dpr);
  const ctx = canvas.getContext("2d");
  const k = canvas.width / W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  return ctx;
}

export function bonkScene(canvas) {
  let ctx = fit(canvas);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const loop = FRAMES * STEP + HOLD;
  let visible = false, start = null, paused = 0, hiddenAt = 0;
  const frameAt = (t) => Math.min(FRAMES - 1, (t % loop) / STEP);
  new ResizeObserver(() => { ctx = fit(canvas); scene(ctx, reduce ? 52 : frameAt(start ? (performance.now() - start - paused) / 1000 : 0)); }).observe(canvas);
  if (reduce) { scene(ctx, 52); return; }
  new IntersectionObserver((e) => {
    const now = performance.now();
    if (e[0].isIntersecting && !visible) { if (start === null) start = now; else paused += now - hiddenAt; }
    else if (!e[0].isIntersecting && visible) hiddenAt = now;
    visible = e[0].isIntersecting;
  }).observe(canvas);
  scene(ctx, 0);
  const tick = (now) => {
    if (visible && start !== null) scene(ctx, frameAt((now - start - paused) / 1000));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
