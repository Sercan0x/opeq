import { sha256, sha256Short } from "./sha256.js";

export const N = 16;
export const W = 256;
export const CHAINS = 18;
export const HEIGHT = 10;
export const LEAVES = 1 << HEIGHT;
export const SIG_LEN = CHAINS * N;
export const PATH_LEN = HEIGHT * N;

const T_CHAIN = 0, T_LEAF = 1, T_NODE = 2, T_PRF = 3;

function adrs(kind, a, b, idx) {
  return new Uint8Array([kind, a, b, 0, idx & 0xff, (idx >>> 8) & 0xff, (idx >>> 16) & 0xff, idx >>> 24]);
}

const fbuf = new Uint8Array(40);
const fout = new Uint8Array(N);

export function prf(skSeed, leaf, chain) {
  const m = new Uint8Array(40);
  m.set(skSeed, 0);
  m.set(adrs(T_PRF, chain, 0, leaf), 32);
  return sha256Short(m, new Uint8Array(N), N);
}

export function chainRun(pubSeed, leaf, chain, x, start, steps) {
  fbuf.set(pubSeed, 0);
  fbuf.set(adrs(T_CHAIN, chain, 0, leaf), 16);
  fbuf.set(x, 24);
  for (let pos = start; pos < start + steps; pos++) {
    fbuf[18] = pos;
    sha256Short(fbuf, fout, N);
    fbuf.set(fout, 24);
  }
  return fbuf.slice(24, 40);
}

export function leafCompress(pubSeed, leaf, pks) {
  return sha256(pubSeed, adrs(T_LEAF, 0, 0, leaf), ...pks).slice(0, N);
}

export function node(pubSeed, height, index, left, right) {
  return sha256(pubSeed, adrs(T_NODE, height, 0, index), left, right).slice(0, N);
}

export function digits(d16) {
  const d = Array.from(d16);
  let csum = 0;
  for (const x of d) csum += W - 1 - x;
  return d.concat([csum >> 8, csum & 0xff]);
}

export function verifyCost(d16) {
  return digits(d16).reduce((s, x) => s + (W - 1 - x), 0);
}

export function leafPk(skSeed, pubSeed, leaf) {
  const pks = [];
  for (let c = 0; c < CHAINS; c++) pks.push(chainRun(pubSeed, leaf, c, prf(skSeed, leaf, c), 0, W - 1));
  return leafCompress(pubSeed, leaf, pks);
}

export function buildTree(pubSeed, leaves) {
  const levels = [leaves];
  for (let h = 0; h < HEIGHT; h++) {
    const prev = levels[h], next = [];
    for (let i = 0; i < prev.length / 2; i++) next.push(node(pubSeed, h + 1, i, prev[2 * i], prev[2 * i + 1]));
    levels.push(next);
  }
  return levels;
}

export function rootFromPath(pubSeed, leaf, lf, path) {
  let x = lf;
  for (let h = 0; h < HEIGHT; h++) {
    const idx = leaf >>> (h + 1);
    x = (leaf >>> h) & 1 ? node(pubSeed, h + 1, idx, path[h], x) : node(pubSeed, h + 1, idx, x, path[h]);
  }
  return x;
}

export function verify(pubSeed, root, leaf, d16, sig, path) {
  const ds = digits(d16);
  const pks = [];
  for (let c = 0; c < CHAINS; c++) pks.push(chainRun(pubSeed, leaf, c, sig.subarray(c * N, c * N + N), ds[c], W - 1 - ds[c]));
  const paths = [];
  for (let h = 0; h < HEIGHT; h++) paths.push(path.subarray(h * N, h * N + N));
  const r = rootFromPath(pubSeed, leaf, leafCompress(pubSeed, leaf, pks), paths);
  return r.every((v, i) => v === root[i]);
}

export class TreeKey {
  constructor(skSeed, pubSeed, leaves) {
    this.skSeed = skSeed;
    this.pubSeed = pubSeed;
    this.levels = buildTree(pubSeed, leaves);
    this.root = this.levels[HEIGHT][0];
  }

  static generate(skSeed, pubSeed, progress) {
    const leaves = [];
    for (let i = 0; i < LEAVES; i++) {
      leaves.push(leafPk(skSeed, pubSeed, i));
      if (progress && (i & 31) === 31) progress((i + 1) / LEAVES);
    }
    return new TreeKey(skSeed, pubSeed, leaves);
  }

  sign(leaf, d16) {
    const sig = new Uint8Array(SIG_LEN), path = new Uint8Array(PATH_LEN);
    digits(d16).forEach((d, c) => sig.set(chainRun(this.pubSeed, leaf, c, prf(this.skSeed, leaf, c), 0, d), c * N));
    for (let h = 0; h < HEIGHT; h++) path.set(this.levels[h][(leaf >>> h) ^ 1], h * N);
    return { sig, path };
  }

  leavesBytes() {
    const out = new Uint8Array(LEAVES * N);
    this.levels[0].forEach((l, i) => out.set(l, i * N));
    return out;
  }

  static fromLeaves(skSeed, pubSeed, bytes) {
    const leaves = [];
    for (let i = 0; i < LEAVES; i++) leaves.push(bytes.slice(i * N, i * N + N));
    return new TreeKey(skSeed, pubSeed, leaves);
  }
}
