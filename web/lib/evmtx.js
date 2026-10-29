import { keccak256 } from "./keccak.js";
import { sign, toBytes32 } from "./secp256k1.js";

function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function intBytes(v) {
  let b = BigInt(v);
  if (b < 0n) throw new Error("negative integer");
  const out = [];
  while (b > 0n) { out.unshift(Number(b & 0xffn)); b >>= 8n; }
  return Uint8Array.from(out);
}

function lenPrefix(len, short, long) {
  if (len < 56) return Uint8Array.of(short + len);
  const l = intBytes(len);
  return concat(Uint8Array.of(long + l.length), l);
}

export function rlp(item) {
  if (Array.isArray(item)) {
    const body = concat(...item.map(rlp));
    return concat(lenPrefix(body.length, 0xc0, 0xf7), body);
  }
  if (!(item instanceof Uint8Array)) throw new Error("rlp item must be bytes or a list");
  if (item.length === 1 && item[0] < 0x80) return item;
  return concat(lenPrefix(item.length, 0x80, 0xb7), item);
}

export function hexToBytes(h) {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error("bad hex");
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
}

export function bytesToHex(b) {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function signTx1559(tx, priv) {
  const fields = [
    intBytes(tx.chainId), intBytes(tx.nonce), intBytes(tx.maxPriorityFeePerGas), intBytes(tx.maxFeePerGas), intBytes(tx.gas),
    tx.to ? hexToBytes(tx.to) : new Uint8Array(0), intBytes(tx.value || 0n), tx.data || new Uint8Array(0), [],
  ];
  const hash = keccak256(Uint8Array.of(2), rlp(fields));
  const { r, s, recovery } = sign(hash, priv);
  const raw = concat(Uint8Array.of(2), rlp([...fields, intBytes(recovery), intBytes(r), intBytes(s)]));
  return { raw: bytesToHex(raw), hash: bytesToHex(keccak256(raw)) };
}

export function create2Address(deployer, salt32, initCode) {
  const a = keccak256(Uint8Array.of(0xff), hexToBytes(deployer), salt32, keccak256(initCode)).slice(12);
  return bytesToHex(a);
}

export { toBytes32 };
