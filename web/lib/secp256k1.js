import { sha256 } from "./sha256.js";
import { keccak256 } from "./keccak.js";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const enc = new TextEncoder();

const mod = (a, m = P) => { const r = a % m; return r < 0n ? r + m : r; };

function inv(a, m = P) {
  let [r0, r1, t0, t1] = [mod(a, m), m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [t0, t1] = [t1, t0 - q * t1];
  }
  if (r0 !== 1n) throw new Error("no inverse");
  return mod(t0, m);
}

function dbl([x, y, z]) {
  if (y === 0n || z === 0n) return [0n, 1n, 0n];
  const a = mod(x * x), b = mod(y * y), c = mod(b * b);
  const d = mod(2n * (mod((x + b) * (x + b)) - a - c));
  const e = mod(3n * a), f = mod(e * e);
  const x3 = mod(f - 2n * d);
  return [x3, mod(e * (d - x3) - 8n * c), mod(2n * y * z)];
}

function add(p1, p2) {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const [x1, y1, z1] = p1, [x2, y2, z2] = p2;
  const z1z1 = mod(z1 * z1), z2z2 = mod(z2 * z2);
  const u1 = mod(x1 * z2z2), u2 = mod(x2 * z1z1);
  const s1 = mod(y1 * z2 * z2z2), s2 = mod(y2 * z1 * z1z1);
  if (u1 === u2) return s1 === s2 ? dbl(p1) : [0n, 1n, 0n];
  const h = mod(u2 - u1), i = mod(4n * h * h), j = mod(h * i), r = mod(2n * (s2 - s1)), v = mod(u1 * i);
  const x3 = mod(r * r - j - 2n * v);
  return [x3, mod(r * (v - x3) - 2n * s1 * j), mod((mod((z1 + z2) * (z1 + z2)) - z1z1 - z2z2) * h)];
}

function mul(k, pt = [GX, GY, 1n]) {
  let acc = [0n, 1n, 0n];
  for (let i = 255; i >= 0; i--) {
    acc = dbl(acc);
    if ((k >> BigInt(i)) & 1n) acc = add(acc, pt);
  }
  return acc;
}

function affine([x, y, z]) {
  if (z === 0n) throw new Error("point at infinity");
  const zi = inv(z), zi2 = mod(zi * zi);
  return [mod(x * zi2), mod(y * zi2 * zi)];
}

export function toBig(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function toBytes32(v) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function hmac(key, ...parts) {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const ipad = k.map((b) => b ^ 0x36), opad = k.map((b) => b ^ 0x5c);
  return sha256(opad, sha256(ipad, ...parts));
}

function rfc6979(priv, h) {
  const x = toBytes32(priv), m = toBytes32(mod(toBig(h), N));
  let v = new Uint8Array(32).fill(1), k = new Uint8Array(32);
  k = hmac(k, v, Uint8Array.of(0), x, m);
  v = hmac(k, v);
  k = hmac(k, v, Uint8Array.of(1), x, m);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const t = toBig(v);
    if (t > 0n && t < N) return t;
    k = hmac(k, v, Uint8Array.of(0));
    v = hmac(k, v);
  }
}

export function feeKeyFromMaster(master) {
  const h = toBig(sha256(enc.encode("opeq/evm/fee/v1"), master));
  return mod(h, N - 1n) + 1n;
}

export function publicKey(priv) {
  if (priv <= 0n || priv >= N) throw new Error("private key out of range");
  return affine(mul(priv));
}

export function addressOf(priv) {
  const [x, y] = publicKey(priv);
  const a = keccak256(toBytes32(x), toBytes32(y)).slice(12);
  return "0x" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sign(hash32, priv) {
  if (hash32.length !== 32) throw new Error("hash must be 32 bytes");
  const z = mod(toBig(hash32), N);
  const k = rfc6979(priv, hash32);
  const [rx, ry] = affine(mul(k));
  const r = mod(rx, N);
  if (r === 0n) throw new Error("bad nonce");
  let s = mod(inv(k, N) * (z + r * priv), N);
  let recovery = Number(ry & 1n) | (rx >= N ? 2 : 0);
  if (s > N / 2n) { s = N - s; recovery ^= 1; }
  if (s === 0n || recovery > 1) throw new Error("bad signature");
  return { r, s, recovery };
}
