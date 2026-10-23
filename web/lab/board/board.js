import { bonkScene } from "../../lib/bonk.js";
import { playIntro, dropCover } from "../../lib/intro.js";

const NS = "http://www.w3.org/2000/svg";
const svg = document.getElementById("board");
const drawer = document.getElementById("drawer");
const scrim = document.getElementById("scrim");
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function el(name, attrs, parent, text) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  if (parent) parent.append(n);
  return n;
}

const defs = el("defs", {}, svg);
const grad = (id, stops, x2 = 0, y2 = 1) => {
  const g = el("linearGradient", { id, x1: 0, y1: 0, x2, y2 }, defs);
  stops.forEach(([o, c]) => el("stop", { offset: o, "stop-color": c }, g));
};
grad("pcb", [["0", "#0e1824"], ["1", "#0a121c"]]);
grad("metal", [["0", "#2a3647"], ["1", "#161f2b"]]);
grad("ihs", [["0", "#3a4658"], ["0.5", "#273243"], ["1", "#1b2431"]], 1, 1);
grad("stick", [["0", "#9beaff"], ["1", "#1683b0"]]);
grad("plug", [["0", "#d5dce6"], ["1", "#8c95a5"]]);
const glow = el("filter", { id: "glow", x: "-30%", y: "-30%", width: "160%", height: "160%" }, defs);
el("feGaussianBlur", { stdDeviation: 4, result: "b" }, glow);
const merge = el("feMerge", {}, glow);
el("feMergeNode", { in: "b" }, merge);
el("feMergeNode", { in: "SourceGraphic" }, merge);

const board = el("g", {}, svg);
el("rect", { x: 140, y: 30, width: 1080, height: 720, rx: 16, class: "pcb" }, board);
for (const [x, y] of [[166, 56], [1194, 56], [166, 724], [1194, 724], [720, 724], [720, 56]]) {
  el("circle", { cx: x, cy: y, r: 9, class: "hole" }, board);
  el("circle", { cx: x, cy: y, r: 4, class: "hole-in" }, board);
}
const vias = el("g", { class: "vias" }, board);
for (let x = 300; x < 1200; x += 26) for (let y = 690; y < 735; y += 22) el("circle", { cx: x, cy: y, r: 1.6 }, vias);
for (let x = 940; x < 1100; x += 22) for (let y = 90; y < 300; y += 22) el("circle", { cx: x, cy: y, r: 1.6 }, vias);
el("text", { x: 1196, y: 742, "text-anchor": "end", class: "silk silk-dim" }, board, "OPEQ BOARD REV 1.1  SOLANA DEVNET");

const traceLayer = el("g", {}, svg);
const traces = [];
function bus(a, b, pts, n = 3, gap = 5) {
  const horiz = (i) => pts[i + 1] && pts[i][1] === pts[i + 1][1];
  for (let k = 0; k < n; k++) {
    const off = (k - (n - 1) / 2) * gap;
    const shifted = pts.map(([x, y], i) => {
      const segH = horiz(Math.min(i, pts.length - 2));
      return segH ? [x, y + off] : [x + off, y];
    });
    const d = shifted.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
    const base = el("path", { d, class: "trace" }, traceLayer);
    const pulse = el("path", { d, class: "pulse", pathLength: 100 }, traceLayer);
    traces.push({ a, b, base, pulse });
  }
}
bus("usb", "chipset", [[250, 170], [280, 170], [280, 455], [830, 455], [830, 500]]);
bus("chipset", "cpu", [[800, 500], [800, 438], [715, 438], [715, 290], [680, 290]]);
bus("cpu", "ram", [[680, 200], [740, 200]], 5, 6);
bus("cpu", "m2", [[630, 330], [630, 380]]);
bus("chipset", "pcie", [[760, 565], [720, 565]]);
bus("power", "cpu", [[1130, 250], [1100, 250], [1100, 60], [560, 60], [560, 90]], 2, 6);
bus("chipset", "cmos", [[900, 560], [946, 560]], 2, 6);
bus("cmos", "tpm", [[990, 604], [990, 680], [1040, 680]], 2, 6);
bus("chipset", "audio", [[800, 620], [800, 705], [270, 705]]);
bus("tpm", "power", [[1120, 680], [1155, 680], [1155, 380]], 2, 6);

const parts = {};
function part(id, label, section, hit, draw, labelAt) {
  const g = el("g", { class: "part", id: `part-${id}`, tabindex: 0, role: "button", "aria-label": `${label}: ${section}`, "data-panel": id }, svg);
  draw(g);
  el("rect", { ...hit, class: "hit" }, g);
  const [lx, ly, anchor = "start"] = labelAt;
  const tx = anchor === "start" ? lx + 17 : lx;
  const t = el("text", { x: tx, y: ly, "text-anchor": anchor, class: "silk" }, g);
  el("tspan", { x: tx, dy: 0, class: "silk-name" }, t, label);
  el("tspan", { x: tx, dy: 14, class: "silk-sec" }, t, section);
  const dot = el("g", { class: "spotg" }, g);
  el("circle", { cx: 0, cy: 0, r: 7, class: "spot-ring" }, dot);
  el("circle", { cx: 0, cy: 0, r: 3, class: "spot" }, dot);
  requestAnimationFrame(() => {
    const w = t.querySelector(".silk-name").getComputedTextLength();
    const dx = anchor === "start" ? lx + 4 : lx - w - 13;
    dot.setAttribute("transform", `translate(${dx} ${ly - 4})`);
  });
  parts[id] = g;
  return g;
}

part("usb", "USB", "start here", { x: 36, y: 128, width: 214, height: 50 }, (g) => {
  el("rect", { x: 150, y: 60, width: 100, height: 340, rx: 6, class: "io" }, g);
  const housing = (y, w, h, slotH) => {
    el("rect", { x: 150, y, width: w, height: h, rx: 2, class: "housing" }, g);
    el("rect", { x: 150, y: y + 3, width: w - 4, height: h - 6, rx: 1, class: "housing-top" }, g);
    if (slotH) el("rect", { x: 150, y: y + (h - slotH) / 2, width: 5, height: slotH, class: "housing-mouth" }, g);
  };
  housing(138, 56, 30, 18);
  housing(214, 62, 46, 30);
  housing(284, 56, 24, 14);
  housing(314, 56, 24, 14);
  el("rect", { x: 150, y: 352, width: 42, height: 18, rx: 3, class: "housing" }, g);
  el("rect", { x: 150, y: 376, width: 42, height: 18, rx: 3, class: "housing" }, g);
  const stick = el("g", { class: "stick" }, g);
  el("path", { d: "M150 137 L58 137 Q40 137 40 153 Q40 169 58 169 L150 169 Z", fill: "url(#stick)", class: "stick-body" }, stick);
  el("rect", { x: 136, y: 137, width: 14, height: 32, class: "stick-collar" }, stick);
  el("rect", { x: 56, y: 140, width: 74, height: 5, rx: 2.5, class: "stick-shine" }, stick);
  el("circle", { cx: 53, cy: 153, r: 4.5, class: "stick-hole" }, stick);
  el("text", { x: 96, y: 158, "text-anchor": "middle", class: "stick-label" }, stick, "opeq");
  el("circle", { cx: 127, cy: 153, r: 2.2, class: "led" }, stick);
}, [156, 108]);

part("cpu", "CPU", "how it works", { x: 440, y: 90, width: 240, height: 240 }, (g) => {
  el("rect", { x: 440, y: 90, width: 240, height: 240, rx: 8, class: "socket" }, g);
  for (let i = 0; i < 14; i++) {
    const p = 458 + i * 15;
    el("rect", { x: p, y: 96, width: 6, height: 4, class: "pin" }, g);
    el("rect", { x: p, y: 320, width: 6, height: 4, class: "pin" }, g);
    el("rect", { x: 446, y: p - 350, width: 4, height: 6, class: "pin" }, g);
    el("rect", { x: 670, y: p - 350, width: 4, height: 6, class: "pin" }, g);
  }
  el("rect", { x: 470, y: 120, width: 180, height: 180, rx: 10, fill: "url(#ihs)", class: "ihs" }, g);
  el("text", { x: 560, y: 205, "text-anchor": "middle", class: "chip-big" }, g, "OPEQ Q1");
  el("text", { x: 560, y: 226, "text-anchor": "middle", class: "chip-small" }, g, "WOTS+ 18 x 255");
  el("text", { x: 560, y: 242, "text-anchor": "middle", class: "chip-small" }, g, "SHA-256 / 16 B");
  el("path", { d: "M486 136 l10 0 l-10 10 z", class: "pin1" }, g);
}, [440, 360]);

part("ram", "RAM", "specification", { x: 736, y: 66, width: 132, height: 370 }, (g) => {
  for (let i = 0; i < 4; i++) {
    const x = 740 + i * 32;
    el("rect", { x: x - 2, y: 66, width: 24, height: 368, rx: 3, class: "dimm-slot" }, g);
    el("rect", { x, y: 74, width: 20, height: 352, rx: 2, class: "dimm" }, g);
    for (let k = 0; k < 8; k++) el("rect", { x: x + 4, y: 92 + k * 40, width: 12, height: 26, rx: 1.5, class: "dram" }, g);
    el("rect", { x: x + 8, y: 248, width: 4, height: 10, class: "notch" }, g);
  }
}, [878, 84]);

part("power", "POWER", "built from scratch", { x: 1124, y: 116, width: 62, height: 268 }, (g) => {
  el("rect", { x: 1130, y: 120, width: 50, height: 260, rx: 5, class: "atx" }, g);
  for (let r = 0; r < 12; r++) for (let c = 0; c < 2; c++) el("rect", { x: 1138 + c * 20, y: 128 + r * 21, width: 14, height: 15, rx: 3, class: "atx-pin" }, g);
}, [1186, 408, "end"]);

part("m2", "M.2", "the problem", { x: 296, y: 376, width: 400, height: 40 }, (g) => {
  el("rect", { x: 300, y: 380, width: 360, height: 30, rx: 3, class: "m2" }, g);
  el("rect", { x: 300, y: 384, width: 14, height: 22, class: "m2-key" }, g);
  for (let i = 0; i < 4; i++) el("rect", { x: 340 + i * 74, y: 385, width: 58, height: 20, rx: 2, class: "dram" }, g);
  el("circle", { cx: 682, cy: 395, r: 7, class: "screw" }, g);
}, [300, 432]);

part("pcie", "PCIe", "compared", { x: 286, y: 476, width: 438, height: 178 }, (g) => {
  for (const [i, y] of [480, 555, 630].entries()) {
    el("rect", { x: 290, y, width: 430, height: 20, rx: 3, class: "slot" }, g);
    el("rect", { x: 300, y: y + 6, width: 410, height: 8, rx: 1, class: "slot-in" }, g);
    el("rect", { x: 380, y, width: 4, height: 20, class: "slot-key" }, g);
    el("text", { x: 716, y: y - 4, "text-anchor": "end", class: "silk silk-dim" }, g, `PCIE_${i + 1}`);
  }
}, [290, 676]);

part("chipset", "CHIPSET", "what opeq is", { x: 756, y: 496, width: 148, height: 128 }, (g) => {
  el("rect", { x: 760, y: 500, width: 140, height: 120, rx: 8, class: "heatsink" }, g);
  for (let i = 0; i < 9; i++) el("rect", { x: 770 + i * 14, y: 508, width: 6, height: 104, rx: 2, class: "fin" }, g);
  el("rect", { x: 796, y: 538, width: 68, height: 44, rx: 4, class: "badge" }, g);
  el("text", { x: 830, y: 558, "text-anchor": "middle", class: "chip-small strong" }, g, "MERKLE");
  el("text", { x: 830, y: 572, "text-anchor": "middle", class: "chip-small" }, g, "H10");
}, [760, 644]);

part("cmos", "CMOS", "the one rule", { x: 940, y: 510, width: 100, height: 100 }, (g) => {
  el("circle", { cx: 990, cy: 560, r: 46, class: "batt-holder" }, g);
  el("circle", { cx: 990, cy: 560, r: 38, class: "batt" }, g);
  el("text", { x: 990, y: 556, "text-anchor": "middle", class: "chip-big" }, g, "+");
  el("text", { x: 990, y: 576, "text-anchor": "middle", class: "chip-small" }, g, "CR2032");
}, [940, 632]);

part("tpm", "TPM", "security", { x: 1036, y: 646, width: 90, height: 70 }, (g) => {
  for (let i = 0; i < 6; i++) {
    el("rect", { x: 1048 + i * 10, y: 646, width: 4, height: 8, class: "pin" }, g);
    el("rect", { x: 1048 + i * 10, y: 706, width: 4, height: 8, class: "pin" }, g);
  }
  el("rect", { x: 1040, y: 652, width: 76, height: 56, rx: 4, class: "chip" }, g);
  el("text", { x: 1078, y: 684, "text-anchor": "middle", class: "chip-small strong" }, g, "TPM 2.0");
}, [1120, 606, "end"]);

part("audio", "AUDIO", "questions", { x: 166, y: 466, width: 108, height: 220 }, (g) => {
  el("rect", { x: 186, y: 608, width: 64, height: 64, rx: 4, class: "chip" }, g);
  el("text", { x: 218, y: 644, "text-anchor": "middle", class: "chip-small strong" }, g, "FAQ");
  for (const [x, y, r] of [[190, 504, 13], [228, 504, 13], [190, 542, 11], [228, 542, 11], [190, 576, 9], [228, 576, 9]]) {
    el("circle", { cx: x, cy: y, r, class: "cap" }, g);
    el("path", { d: `M${x - r * 0.6} ${y - r * 0.2} L${x + r * 0.6} ${y - r * 0.2}`, class: "cap-mark" }, g);
  }
}, [166, 456]);

const order = ["usb", "m2", "chipset", "cpu", "pcie", "cmos", "tpm", "ram", "power", "audio"];
const titles = { usb: "Start", m2: "Problem", chipset: "What it is", cpu: "How it works", pcie: "Compared", cmos: "One rule", tpm: "Security", ram: "Spec", power: "Built", audio: "Questions" };
const legend = document.getElementById("legend");
order.forEach((id, i) => {
  const a = document.createElement("a");
  a.href = `#${id}`;
  a.dataset.panel = id;
  const n = document.createElement("span"); n.className = "num"; n.textContent = String(i + 1).padStart(2, "0");
  const t = document.createElement("span"); t.textContent = titles[id];
  a.title = parts[id].querySelector(".silk-name").textContent;
  a.append(n, t);
  legend.append(a);
  a.addEventListener("click", (e) => { e.preventDefault(); lastFocus = a; open(id); });
  a.addEventListener("pointerenter", () => { parts[id].classList.add("peek"); if (!active) setTraces(id); });
  a.addEventListener("pointerleave", () => { parts[id].classList.remove("peek"); if (!active) setTraces(null); });
});
traces.forEach((t, i) => {
  t.idle = t.base.cloneNode();
  t.idle.setAttribute("class", "idle");
  t.idle.setAttribute("pathLength", "100");
  t.base.after(t.idle);
  if (!reduce) {
    t.idle.style.animationDelay = `${-(i * 0.37) % 3}s`;
    t.idle.style.animationDuration = `${2.6 + (i % 5) * 0.35}s`;
  }
});
const fitTop = () => document.documentElement.style.setProperty("--top", `${document.querySelector(".bar").offsetHeight}px`);
fitTop();
window.addEventListener("resize", fitTop);
let active = null;
let lastFocus = null;
let bonkStarted = false;

function setTraces(id) {
  for (const t of traces) {
    const hot = id && (t.a === id || t.b === id);
    t.base.classList.toggle("hot", !!hot);
    t.pulse.classList.toggle("run", !!hot && !reduce);
  }
  for (const a of legend.querySelectorAll("a")) a.classList.toggle("lit", a.dataset.panel === id);
}

function open(id, push = true) {
  if (!parts[id]) return;
  for (const p of document.querySelectorAll(".panel")) p.hidden = p.id !== `p-${id}`;
  for (const [k, g] of Object.entries(parts)) g.classList.toggle("active", k === id);
  setTraces(id);
  active = id;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  scrim.classList.add("on");
  document.getElementById("drawer-in").scrollTop = 0;
  if (id === "m2" && !bonkStarted) {
    const c = document.getElementById("bonk");
    if (c) { bonkStarted = true; requestAnimationFrame(() => bonkScene(c)); }
  }
  if (push && location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  document.getElementById(`h-${id}`).focus({ preventScroll: true });
}

function close() {
  if (!active) return;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  scrim.classList.remove("on");
  for (const g of Object.values(parts)) g.classList.remove("active");
  setTraces(null);
  const was = active;
  active = null;
  history.replaceState(null, "", location.pathname);
  (lastFocus || parts[was]).focus({ preventScroll: true });
}

for (const [id, g] of Object.entries(parts)) {
  g.addEventListener("click", () => { lastFocus = g; open(id); });
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); lastFocus = g; open(id); } });
  g.addEventListener("pointerenter", () => { if (!active) setTraces(id); });
  g.addEventListener("pointerleave", () => { if (!active) setTraces(null); });
}
for (const p of document.querySelectorAll(".crumb")) p.setAttribute("tabindex", "-1");
document.getElementById("close").addEventListener("click", close);
scrim.addEventListener("click", close);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
  if (!active) return;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const i = order.indexOf(active);
    open(order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length]);
  }
});

const start = location.hash.slice(1);
if (parts[start]) open(start, false);

function cameFromSite() {
  try {
    const inside = sessionStorage.getItem("opeq:inside") === "1";
    sessionStorage.removeItem("opeq:inside");
    return inside;
  } catch { return false; }
}
const booted = cameFromSite() ? (dropCover(), Promise.resolve()) : playIntro();
booted.then(() => {
  if (!reduce) svg.classList.add("powerup");
});
