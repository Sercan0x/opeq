import { sha256 } from "../../lib/sha256.js";
import { bonkScene } from "../../lib/bonk.js";

const NS = "http://www.w3.org/2000/svg";
const enc = new TextEncoder();
const W = 256;

function el(name, attrs, parent, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}

function digits(msg) {
  const d = Array.from(sha256(enc.encode(msg)).slice(0, 16));
  const csum = d.reduce((s, x) => s + (W - 1 - x), 0);
  return d.concat([csum >> 8, csum & 0xff]);
}

function cost(ds) {
  return ds.reduce((s, x) => s + (W - 1 - x), 0);
}

function arrowDim(parent, x1, y1, x2, y2, label, cls = "", side = "right") {
  const g = el("g", { class: "fade" }, parent);
  el("line", { x1, y1, x2, y2, class: "dim" }, g);
  const horizontal = y1 === y2;
  const tick = 4;
  if (horizontal) {
    el("path", { d: `M${x1 + 6} ${y1 - 3} L${x1} ${y1} L${x1 + 6} ${y1 + 3}`, class: "dim" }, g);
    el("path", { d: `M${x2 - 6} ${y2 - 3} L${x2} ${y2} L${x2 - 6} ${y2 + 3}`, class: "dim" }, g);
    el("line", { x1, y1: y1 - tick - 6, x2: x1, y2: y1 + tick, class: "dim" }, g);
    el("line", { x1: x2, y1: y2 - tick - 6, x2, y2: y2 + tick, class: "dim" }, g);
    el("text", { x: (x1 + x2) / 2, y: y1 - 6, "text-anchor": "middle", class: `dim-text ${cls}` }, g, label);
  } else {
    el("path", { d: `M${x1 - 3} ${y1 + 6} L${x1} ${y1} L${x1 + 3} ${y1 + 6}`, class: "dim" }, g);
    el("path", { d: `M${x2 - 3} ${y2 - 6} L${x2} ${y2} L${x2 + 3} ${y2 - 6}`, class: "dim" }, g);
    const left = side === "left";
    el("text", { x: left ? x1 - 8 : x1 + 8, y: (y1 + y2) / 2 + 4, "text-anchor": left ? "end" : "start", class: `dim-text ${cls}` }, g, label);
  }
}

function leader(parent, x1, y1, x2, y2, text, anchor = "start") {
  const g = el("g", { class: "fade" }, parent);
  el("path", { d: `M${x1} ${y1} L${x2} ${y2} L${x2 + (anchor === "start" ? 10 : -10)} ${y2}`, class: "dim" }, g);
  el("circle", { cx: x1, cy: y1, r: 1.6, class: "fill-ink" }, g);
  el("text", { x: x2 + (anchor === "start" ? 14 : -14), y: y2 + 3.5, "text-anchor": anchor, class: "callout" }, g, text);
}

function hatch(svg, id) {
  const defs = el("defs", {}, svg);
  const pat = el("pattern", { id, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  el("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "ink-thin" }, pat);
}

function signatureDrawing(svg) {
  const X0 = 42, PITCH = 20, LW = 12, TOP = 64, BOT = 330, H = BOT - TOP, RUNGS = 24;
  const marks = [], hidden = [];
  hatch(svg, "hatch");
  const ladders = el("g", {}, svg);
  for (let c = 0; c < 18; c++) {
    const x = X0 + c * PITCH;
    const g = el("g", { class: `draw d${1 + Math.floor(c / 5)}`, pathLength: 1 }, ladders);
    el("line", { x1: x, y1: TOP, x2: x, y2: BOT, class: c >= 16 ? "ink-dash" : "ink", pathLength: 1 }, g);
    el("line", { x1: x + LW, y1: TOP, x2: x + LW, y2: BOT, class: c >= 16 ? "ink-dash" : "ink", pathLength: 1 }, g);
    for (let r = 1; r < RUNGS; r++) {
      const y = BOT - (r * H) / RUNGS;
      el("line", { x1: x, y1: y, x2: x + LW, y2: y, class: "ink-thin", pathLength: 1 }, g);
    }
    el("rect", { x: x - 1, y: TOP - 5, width: LW + 2, height: 5, class: "fill-ink" }, g);
    hidden.push(el("rect", { x: x + 1, y: TOP, width: LW - 2, height: H, class: "hidden-rungs", fill: "url(#hatch)" }, svg));
    marks.push(el("rect", { x: x - 3, y: BOT - 2, width: LW + 6, height: 4, class: "rung-mark" + (c >= 16 ? " cs" : "") }, svg));
    el("text", { x: x + LW / 2, y: BOT + 14, "text-anchor": "middle", class: "dim-text small" }, svg, c >= 16 ? `c${c - 15}` : String(c + 1));
  }
  const lastX = X0 + 17 * PITCH + LW;
  arrowDim(svg, X0, 36, lastX, 36, "288 B revealed rungs, 18 x 16 B");
  arrowDim(svg, X0 + 16 * PITCH, 368, lastX, 368, "checksum", "small");
  leader(svg, X0 + 7 * PITCH + LW / 2, TOP - 5, X0 + 7 * PITCH + 40, TOP - 22, "ladder tops form the public key");

  const TX = 480, LEAF_Y = 318, LV = [LEAF_Y, 248, 178, 108], N = 12;
  const lx = (i) => TX + i * 26;
  const nodeX = (lvl, i) => (lvl === 0 ? lx(i) : (nodeX(lvl - 1, 2 * i) + nodeX(lvl - 1, 2 * i + 1)) / 2);
  const route = el("path", { class: "route" }, svg);
  const tree = el("g", { class: "draw d3", pathLength: 1 }, svg);
  const edges = [], nodes = [];
  for (let lvl = 0; lvl < 3; lvl++) {
    for (let i = 0; i < 8 >> lvl; i++) {
      const line = el("line", { x1: nodeX(lvl, i), y1: LV[lvl], x2: nodeX(lvl + 1, i >> 1), y2: LV[lvl + 1], class: "edge", pathLength: 1 }, tree);
      edges.push({ lvl, i, line });
    }
  }
  for (let lvl = 0; lvl < 4; lvl++) {
    for (let i = 0; i < 8 >> lvl; i++) {
      nodes.push({ lvl, i, rect: el("rect", { x: nodeX(lvl, i) - N / 2, y: LV[lvl] - N / 2, width: N, height: N, class: "node" }, tree) });
    }
  }
  const keyBox = el("rect", { x: 0, y: LEAF_Y - N / 2 - 1, width: N + 2, height: N + 2, class: "pencil-line keybox" }, svg);
  const keyLabel = el("text", { x: 0, y: LEAF_Y + 26, "text-anchor": "middle", class: "callout fade" }, svg, "");
  arrowDim(svg, TX + 220, LEAF_Y + 6, TX + 220, LV[3] - 6, "160 B path, 10 x 16 B");
  leader(svg, nodeX(3, 0), LV[3] - N / 2, nodeX(3, 0) + 24, 78, "root, 16 B, on chain");
  arrowDim(svg, X0, 428, TX + 190, 428, "448 B on chain per signature");

  const BUS = TOP - 12;
  el("line", { x1: X0 + LW / 2, y1: BUS, x2: TX - 30, y2: BUS, class: "ink-dash fade" }, svg);

  const setLeaf = (leaf) => {
    const path = [leaf, leaf >> 1, leaf >> 2, 0];
    for (const n of nodes) {
      n.rect.classList.toggle("leaf", n.lvl === 0 && n.i === leaf);
      n.rect.classList.toggle("on", n.lvl > 0 && n.i === path[n.lvl]);
    }
    for (const e of edges) e.line.classList.toggle("on", e.i === path[e.lvl]);
    keyBox.setAttribute("x", lx(leaf) - N / 2 - 1);
    keyLabel.setAttribute("x", lx(leaf));
    keyLabel.textContent = "this signature's key, 1 of 1024";
    const under = LEAF_Y + N / 2 + 10;
    route.setAttribute("d", `M${TX - 30} ${BUS} L${TX - 30} ${under} L${lx(leaf)} ${under} L${lx(leaf)} ${LEAF_Y + N / 2}`);
  };
  return { marks, hidden, BOT, H, setLeaf };
}

function ladderDetail(svg) {
  const x = 120, TOP = 50, BOT = 360, H = BOT - TOP, R = 16, LW = 40;
  hatch(svg, "hatch2");
  const g = el("g", { class: "draw d1", pathLength: 1 }, svg);
  el("line", { x1: x, y1: TOP, x2: x, y2: BOT, class: "ink", pathLength: 1 }, g);
  el("line", { x1: x + LW, y1: TOP, x2: x + LW, y2: BOT, class: "ink", pathLength: 1 }, g);
  for (let r = 1; r < R; r++) el("line", { x1: x, y1: BOT - (r * H) / R, x2: x + LW, y2: BOT - (r * H) / R, class: "ink-thin", pathLength: 1 }, g);
  const revealed = 6;
  const ry = BOT - (revealed * H) / R;
  el("rect", { x: x + 2, y: ry, width: LW - 4, height: BOT - ry, fill: "url(#hatch2)", class: "hidden-rungs" }, svg);
  el("rect", { x: x - 4, y: ry - 2.5, width: LW + 8, height: 5, class: "fill-ink" }, svg);
  el("rect", { x: x - 1, y: TOP - 6, width: LW + 2, height: 6, class: "fill-ink" }, svg);
  el("circle", { cx: x + LW / 2, cy: BOT + 14, r: 5, class: "fill-paper" }, svg);
  leader(svg, x + LW + 2, TOP - 3, x + LW + 40, 40, "top: public, in the tree");
  leader(svg, x + LW + 4, ry, x + LW + 40, ry - 14, "revealed rung, 16 B");
  leader(svg, x + LW + 2, (ry + BOT) / 2, x + LW + 40, (ry + BOT) / 2 + 6, "below: secret, never shown");
  leader(svg, x + LW / 2 + 5, BOT + 14, x + LW + 40, BOT + 10, "secret number at the foot");
  arrowDim(svg, x - 26, BOT, x - 26, ry, `verifier climbs ${R - revealed} of ${R}`, "small", "left");
  arrowDim(svg, 404, BOT, 404, TOP, "255 rungs", "small", "left");
  const pen = el("g", { class: "fade" }, svg);
  el("path", { d: `M${x + LW + 6} ${ry + 30} q 8 -6 16 0 t 16 0`, class: "pencil-line" }, pen);
  el("text", { x: x + LW + 44, y: ry + 34, class: "callout pencil-text" }, pen, "up only");
}

function treeDrawing(svg) {
  const TX = 40, LEAF_Y = 300, LV = [LEAF_Y, 232, 164, 96], N = 11, LEAVES = 32;
  const lx = (i) => TX + 20 + i * 20;
  const nodeX = (lvl, i) => (lvl === 0 ? lx(i) : (nodeX(lvl - 1, 2 * i) + nodeX(lvl - 1, 2 * i + 1)) / 2);
  const g = el("g", { class: "draw d1", pathLength: 1 }, svg);
  const next = 9;
  for (let lvl = 0; lvl < 3; lvl++) {
    for (let i = 0; i < LEAVES >> lvl; i++) {
      el("line", { x1: nodeX(lvl, i), y1: LV[lvl], x2: nodeX(lvl + 1, i >> 1), y2: LV[lvl + 1], class: "ink-thin", pathLength: 1 }, g);
    }
  }
  for (let lvl = 0; lvl < 4; lvl++) {
    for (let i = 0; i < LEAVES >> lvl; i++) {
      const reserve = lvl === 0 && i >= LEAVES - 2;
      const spent = lvl === 0 && i < next;
      el("rect", { x: nodeX(lvl, i) - N / 2, y: LV[lvl] - N / 2, width: N, height: N, class: spent ? "fill-ink" : "fill-paper", "stroke-dasharray": reserve ? "2 2" : "" }, g);
      if (spent) el("line", { x1: nodeX(lvl, i) - 3, y1: LV[lvl] - 3, x2: nodeX(lvl, i) + 3, y2: LV[lvl] + 3, class: "paper-line" }, g);
    }
  }
  const ry = LEAF_Y + N / 2 + 10;
  const pen = el("g", { class: "fade" }, svg);
  el("path", { d: `M${lx(next) - 10} ${ry + 26} L${lx(next) - 10} ${ry + 4}`, class: "pencil-line" }, pen);
  el("path", { d: `M${lx(next) - 14} ${ry + 10} L${lx(next) - 10} ${ry + 4} L${lx(next) - 6} ${ry + 10}`, class: "pencil-line" }, pen);
  el("text", { x: lx(next) - 2, y: ry + 30, class: "callout pencil-text" }, pen, "counter: next key 9, keys 0 to 8 can never sign again");
  arrowDim(svg, lx(0), LEAF_Y + 30, lx(LEAVES - 3), LEAF_Y + 30, "keys 0 to 1007, transactions");
  leader(svg, lx(LEAVES - 1), LEAF_Y + N / 2, lx(LEAVES - 1) - 40, LEAF_Y + 74, "16 reserve keys, 1008 to 1023, for moving to the next tree", "end");
  leader(svg, nodeX(3, 0), LV[3] - N / 2, nodeX(3, 0) + 60, 60, "root, stored on chain, 16 B");
  leader(svg, nodeX(3, 3), LV[3] - N / 2, nodeX(3, 3) + 40, 60, "same address before and after a rekey");
  arrowDim(svg, TX + 10, LEAF_Y, TX + 10, LV[3], "10 levels", "small");
}

function initSignature() {
  const svg = document.getElementById("sig");
  const { marks, hidden, BOT, H, setLeaf } = signatureDrawing(svg);
  const input = document.getElementById("msg");
  const costEl = document.getElementById("cost");
  const update = () => {
    const ds = digits(input.value);
    ds.forEach((d, c) => {
      const y = BOT - (d / (W - 1)) * H;
      marks[c].setAttribute("transform", `translate(0 ${y - BOT})`);
      hidden[c].setAttribute("y", y.toFixed(1));
      hidden[c].setAttribute("height", Math.max(0.5, BOT - y).toFixed(1));
    });
    setLeaf(ds[15] & 7);
    costEl.textContent = `verifier climbs ${cost(ds).toLocaleString("en-US")} rungs for this message`;
  };
  update();
  input.addEventListener("input", update);
}

initSignature();
ladderDetail(document.getElementById("ladder"));
treeDrawing(document.getElementById("tree"));
const bonk = document.getElementById("bonk");
if (bonk) bonkScene(bonk);

const themeBtn = document.getElementById("theme");
function applyTheme(t) {
  if (t === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  themeBtn.textContent = t === "dark" ? "Light" : "Dark";
}
let theme = "light";
try { theme = localStorage.getItem("opeq:bp-theme") || "light"; } catch {}
applyTheme(theme);
themeBtn.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("opeq:bp-theme", theme); } catch {}
  applyTheme(theme);
});
