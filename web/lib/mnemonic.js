import { sha256 } from "./sha256.js";
import { WORDS } from "./wordlist.js";
import { N, TreeKey } from "./wots.js";

const INDEX = new Map(WORDS.map((w, i) => [w, i]));

export function newMaster() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function toWords(entropy) {
  if (entropy.length !== 32) throw new Error("master seed must be 32 bytes");
  let bits = 0n;
  for (const b of entropy) bits = (bits << 8n) | BigInt(b);
  bits = (bits << 8n) | BigInt(sha256(entropy)[0]);
  const words = [];
  for (let i = 0; i < 24; i++) words.push(WORDS[Number((bits >> BigInt(11 * (23 - i))) & 0x7ffn)]);
  return words;
}

export function fromWords(text) {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length !== 24) throw new Error(`expected 24 words, got ${words.length}`);
  let bits = 0n;
  for (let w of words) {
    if (!INDEX.has(w)) {
      const m = w.length >= 4 ? WORDS.filter((x) => x.startsWith(w.slice(0, 4))) : [];
      if (m.length !== 1) throw new Error(`unknown word: ${w}`);
      w = m[0];
    }
    bits = (bits << 11n) | BigInt(INDEX.get(w));
  }
  const entropy = new Uint8Array(32);
  let e = bits >> 8n;
  for (let i = 31; i >= 0; i--) { entropy[i] = Number(e & 0xffn); e >>= 8n; }
  if (Number(bits & 0xffn) !== sha256(entropy)[0]) throw new Error("checksum mismatch: a word is wrong or out of order");
  return entropy;
}

function epochBytes(epoch) {
  return new Uint8Array([epoch & 0xff, (epoch >>> 8) & 0xff, (epoch >>> 16) & 0xff, epoch >>> 24]);
}

const enc = new TextEncoder();

export function treeSeeds(master, epoch) {
  const e = epochBytes(epoch);
  return {
    skSeed: sha256(enc.encode("opeq/tree/sk/v1"), master, e),
    pubSeed: sha256(enc.encode("opeq/tree/pub/v1"), master, e).slice(0, N),
  };
}

export function deriveTree(master, epoch, progress) {
  const { skSeed, pubSeed } = treeSeeds(master, epoch);
  return TreeKey.generate(skSeed, pubSeed, progress);
}
