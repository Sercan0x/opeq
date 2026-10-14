const P = {
  plasticHi: "#f8f2e4", plastic: "#ece3cf", plasticLo: "#d6c9aa", edge: "#b7a882", slot: "#a3936f",
  hole: "#262b36", screenHi: "#10203a", screenLo: "#050b16", ice: "#3ad0ff", iceHi: "#a4ecff", iceLo: "#1683b0",
  metal: "#d3d9e2", metalLo: "#8c95a5", led: "#4fe39a", ledOff: "#a59a7e", amber: "#ffbe55", text: "#eaf7ff",
};

const W = 240, H = 150;
const PORT_X = 200, PLUG_X = 190, START_X = 262;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function rr(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.6; ctx.stroke(); }
}

export function vg(ctx, y0, y1, a, b) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

export function dot(ctx, x, y, r, fill, glow) {
  ctx.save();
  if (glow) { ctx.shadowColor = fill; ctx.shadowBlur = glow; }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

export function logo(ctx, x, y, u, fg, leaf) {
  const cell = 3 * u, step = 4 * u, r = 0.5 * u;
  const cells = [[1.5, 0, 1], [0.5, 1, 0], [2.5, 1, 1], [0, 2, 0], [1, 2, 0], [2, 2, 2], [3, 2, 0]];
  for (const [cx, cy, kind] of cells) {
    const px = x + cx * step, py = y + cy * step;
    if (kind === 1) rr(ctx, px, py, cell, cell, r, fg);
    else if (kind === 2) rr(ctx, px, py, cell, cell, r, leaf);
    else {
      ctx.beginPath();
      ctx.roundRect(px + u * 0.4, py + u * 0.4, cell - u * 0.8, cell - u * 0.8, r);
      ctx.strokeStyle = fg;
      ctx.lineWidth = u * 0.8;
      ctx.stroke();
    }
  }
}

function shadow(ctx) {
  const g = ctx.createRadialGradient(120, 117, 4, 120, 117, 100);
  g.addColorStop(0, "rgba(0,0,0,0.42)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.scale(1, 0.08);
  ctx.fillStyle = g;
  ctx.fillRect(0, 117 / 0.08 - 110, W, 220);
  ctx.restore();
}

function screen(ctx, s) {
  const x = 51, y = 26, w = 84, h = 56;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.clip();
  const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 4, x + w / 2, y + h / 2, w * 0.7);
  g.addColorStop(0, s.on ? "#13284a" : P.screenHi);
  g.addColorStop(1, P.screenLo);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  const mono = cssVar("--mono") || "monospace";
  const sans = cssVar("--sans") || "sans-serif";
  if (s.phase === 1) {
    ctx.font = `5px ${mono}`;
    ctx.textBaseline = "top";
    ctx.fillStyle = P.ice;
    ctx.shadowColor = P.ice;
    ctx.shadowBlur = 3;
    const lines = ["> usb key found", "> reading 24 words", "> building key tree"];
    const k = Math.max(0, s.boot) * 3.4;
    const shown = Math.min(lines.length, Math.floor(k) + 1);
    lines.slice(0, shown).forEach((l, i) => {
      const typing = i === shown - 1 && k < lines.length;
      const part = typing ? l.slice(0, Math.ceil(l.length * Math.min(1, (k % 1) / 0.55))) : l;
      ctx.fillText(part, x + 5, y + 6 + i * 8);
    });
    if (s.cursor) ctx.fillRect(x + 5, y + 6 + shown * 8, 3, 5);
  }
  if (s.phase === 2) {
    ctx.shadowColor = "rgba(58,208,255,0.55)";
    ctx.shadowBlur = 6;
    logo(ctx, x + w / 2 - 7.5, y + 11, 1, P.text, P.ice);
    ctx.font = `600 11px ${sans}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = P.text;
    ctx.fillText("opeq", x + w / 2, y + 43);
    ctx.textAlign = "left";
    ctx.shadowBlur = 0;
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.028)";
  for (let yy = y; yy < y + h; yy += 1.5) ctx.fillRect(x, yy, w, 0.5);
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + w * 0.42, y); ctx.lineTo(x, y + h * 0.62); ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.035)";
  ctx.fill();
  ctx.restore();
  rr(ctx, x, y, w, h, 4, null, "rgba(0,0,0,0.5)");
}

function monitor(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(84, 97); ctx.lineTo(102, 97); ctx.lineTo(107, 108); ctx.lineTo(79, 108); ctx.closePath();
  ctx.fillStyle = vg(ctx, 97, 108, P.plasticLo, P.slot);
  ctx.fill();
  rr(ctx, 66, 106, 54, 7, 3, vg(ctx, 106, 113, P.plasticHi, P.plasticLo), P.edge);
  rr(ctx, 38, 14, 110, 84, 7, vg(ctx, 14, 98, P.plasticHi, P.plasticLo), P.edge);
  rr(ctx, 46, 21, 94, 66, 5, vg(ctx, 21, 87, P.plasticLo, P.plastic));
  screen(ctx, s);
  rr(ctx, 50, 91, 18, 2, 1, P.slot);
  rr(ctx, 50, 94, 12, 1.2, 0.6, P.plasticLo);
  dot(ctx, 140, 92, 1.4, s.on ? P.led : P.ledOff, s.on ? 4 : 0);
}

function tower(ctx, s) {
  rr(ctx, 160, 24, 40, 90, 6, vg(ctx, 24, 114, P.plasticHi, P.plasticLo), P.edge);
  for (const yy of [33, 44]) {
    rr(ctx, 166, yy, 28, 7, 2, P.plasticLo, P.edge);
    rr(ctx, 169, yy + 3, 22, 1.3, 0.6, P.hole);
  }
  for (let i = 0; i < 5; i++) rr(ctx, 168, 60 + i * 3.2, 24, 1.1, 0.5, P.plasticLo);
  dot(ctx, 178, 100, 3.6, P.plasticLo);
  ctx.beginPath(); ctx.arc(178, 100, 3.6, 0, Math.PI * 2); ctx.strokeStyle = P.edge; ctx.lineWidth = 0.6; ctx.stroke();
  dot(ctx, 189, 100, 1.2, s.disk ? P.amber : P.ledOff, s.disk ? 4 : 0);
  rr(ctx, PORT_X - 2.2, 64.5, 2.4, 6, 0.6, P.hole);
}

function stick(ctx, sx, s) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(PORT_X, 0, W, H);
  ctx.clip();
  rr(ctx, sx, 65.4, 11, 5.2, 0.6, vg(ctx, 65.4, 70.6, P.metal, P.metalLo));
  rr(ctx, sx + 2.5, 66.8, 2, 1.2, 0.3, P.hole);
  rr(ctx, sx + 6, 66.8, 2, 1.2, 0.3, P.hole);
  ctx.restore();
  const bx = sx + 10;
  rr(ctx, bx, 62.5, 30, 11, 3.5, vg(ctx, 62.5, 73.5, P.iceHi, P.iceLo));
  rr(ctx, bx + 2, 63.6, 24, 2, 1, "rgba(255,255,255,0.35)");
  rr(ctx, bx, 62.5, 30, 11, 3.5, null, "rgba(10,60,90,0.6)");
  ctx.beginPath(); ctx.arc(bx + 26, 68, 1.6, 0, Math.PI * 2); ctx.strokeStyle = "rgba(10,60,90,0.7)"; ctx.lineWidth = 0.7; ctx.stroke();
  dot(ctx, bx + 6, 68.5, 1, s.keyLed ? "#ffffff" : "rgba(255,255,255,0.35)", s.keyLed ? 4 : 0);
}

function sparks(ctx, k) {
  if (k <= 0 || k >= 1) return;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    const r = 3 + k * 9;
    dot(ctx, PORT_X + Math.cos(a) * r, 68 + Math.sin(a) * r * 0.8, 0.9 * (1 - k), P.iceHi, 3);
  }
}

const ease = (v) => 1 - Math.pow(1 - Math.min(1, Math.max(0, v)), 3);

const TIMING = { slide: [0.5, 2.3], plug: 2.3, boot: [2.8, 6.6], done: 9.4 };

function stateAt(t) {
  const [a, b] = TIMING.slide;
  const sx = START_X - (START_X - PLUG_X) * ease((t - a) / (b - a));
  const plugged = t >= TIMING.plug;
  const [b0, b1] = TIMING.boot;
  return {
    sx: plugged ? PLUG_X : sx,
    on: t >= b0,
    phase: t < b0 ? 0 : t < b1 ? 1 : 2,
    boot: (t - b0) / (b1 - b0),
    cursor: Math.floor(t * 2.5) % 2 === 0,
    disk: plugged && t < TIMING.boot[1] + 0.3 && Math.floor(t * 6) % 2 === 0,
    keyLed: plugged && Math.floor(t * 2) % 2 === 0,
    spark: (t - TIMING.plug) / 0.4,
  };
}

function fit(canvas) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || W * 3;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round((w * H / W) * dpr);
  const ctx = canvas.getContext("2d");
  const k = canvas.width / W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  return ctx;
}

function draw(ctx, t) {
  ctx.clearRect(0, 0, W, H);
  const s = stateAt(t);
  shadow(ctx);
  monitor(ctx, s);
  tower(ctx, s);
  stick(ctx, s.sx, s);
  sparks(ctx, s.spark);
}

export function dropCover() {
  const cover = document.getElementById("boot-cover");
  if (cover) cover.remove();
}

export function playIntro() {
  if (document.querySelector(".boot-live")) return Promise.resolve();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { dropCover(); return Promise.resolve(); }
  return new Promise((resolve) => {
    const cover = document.getElementById("boot-cover");
    const wrap = cover || document.createElement("div");
    wrap.removeAttribute("id");
    wrap.className = "boot boot-live";
    const stage = document.createElement("div");
    stage.className = "boot-stage";
    const cv = document.createElement("canvas");
    cv.className = "boot-canvas";
    cv.setAttribute("aria-hidden", "true");
    const label = document.createElement("p");
    label.className = "boot-label";
    const bar = document.createElement("div");
    bar.className = "boot-bar";
    const fill = document.createElement("i");
    bar.append(fill);
    stage.append(cv, label, bar);
    wrap.append(stage);
    if (!cover) document.body.append(wrap);
    document.documentElement.classList.add("booting");
    const ctx = fit(cv);
    const start = performance.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wrap.classList.add("boot-out");
      document.documentElement.classList.remove("booting");
      setTimeout(() => wrap.remove(), 450);
      resolve();
    };
    window.addEventListener("keydown", finish, { once: true });
    const frame = (now) => {
      if (done) return;
      const t = (now - start) / 1000;
      draw(ctx, t);
      label.textContent = t < TIMING.plug ? "Plugging in your key" : t < TIMING.boot[1] ? "Securing your wallet" : "Quantum-proof. Ready.";
      fill.style.width = `${Math.round(Math.min(1, t / (TIMING.done - 0.8)) * 100)}%`;
      if (t >= TIMING.done) { finish(); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
