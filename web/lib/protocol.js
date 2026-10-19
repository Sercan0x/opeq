import { Sha256, sha256 } from "./sha256.js";
import { N, LEAVES, verifyCost } from "./wots.js";
import { concat, findPda, u32, u64 } from "./solana.js";

const enc = new TextEncoder();

export const IX_INIT = 0, IX_EXEC = 1, IX_REKEY = 2;
export const STATE_MAGIC = "OPEQST01";
export const STATE_LEN = 88;
export const F_SIGNER = 1, F_WRITABLE = 2;
export const R_LEN = 16;
export const REKEY_RESERVE = 16;
export const EXEC_LEAF_LIMIT = LEAVES - REKEY_RESERVE;
export const GRIND_TRIES = 1 << 17;
export const SALT_OFF = 13, R_OFF = 17, SIG_OFF = 33;
export const TAG_EXEC = enc.encode("opeq/exec/v1");
export const TAG_REKEY = enc.encode("opeq/rekey/v1");

export const ERRORS = {
  1: "bad instruction", 2: "too many accounts", 3: "state not owned by program", 4: "bad state account",
  5: "wallet/state address mismatch", 6: "signature expired", 7: "leaf already used", 8: "leaf out of range",
  9: "self cpi", 10: "bad meta flags", 11: "signer escalation", 12: "malformed inner instructions",
  13: "bad signature", 14: "state not writable", 15: "init address mismatch", 16: "too many slices",
  17: "account index out of range", 18: "payer must sign", 19: "already initialized", 20: "bad system program",
  21: "too many metas", 22: "rekey to the current root",
};

export function accountId(pubSeed, root) {
  return sha256(enc.encode("opeq/id/v1"), pubSeed, root);
}

export const statePda = (aid, program) => findPda([enc.encode("s"), aid], program);
export const walletPda = (aid, program) => findPda([enc.encode("w"), aid], program);

function leafEpochExpiry(epoch, leaf, expiry) {
  return concat(u32(epoch), u32(leaf), u64(expiry));
}

export function execHasher(program, aid, epoch, leaf, expiry, inner, r) {
  checkInner(inner);
  if (r.length !== N) throw new Error("randomizer must be 16 bytes");
  const h = new Sha256();
  h.update(r).update(TAG_EXEC).update(program).update(aid).update(leafEpochExpiry(epoch, leaf, expiry));
  h.update(new Uint8Array([inner.length]));
  for (const [prog, metas, data] of inner) {
    h.update(prog).update(new Uint8Array([metas.length]));
    for (const [key, signer, writable] of metas) {
      h.update(key).update(new Uint8Array([(signer ? F_SIGNER : 0) | (writable ? F_WRITABLE : 0)]));
    }
    h.update(new Uint8Array([data.length & 0xff, data.length >> 8])).update(data);
  }
  return h;
}

export function rekeyHasher(program, aid, epoch, leaf, expiry, newPubSeed, newRoot, r) {
  if (r.length !== N) throw new Error("randomizer must be 16 bytes");
  return new Sha256().update(r).update(TAG_REKEY).update(program).update(aid)
    .update(leafEpochExpiry(epoch, leaf, expiry)).update(newPubSeed).update(newRoot);
}

export function salted(hasher, salt) {
  return hasher.clone().update(u32(salt)).digest().slice(0, N);
}

export function grind(hasher, tries = GRIND_TRIES, progress) {
  let best = null;
  const sb = new Uint8Array(4);
  for (let salt = 0; salt < tries; salt++) {
    sb[0] = salt & 0xff; sb[1] = (salt >>> 8) & 0xff; sb[2] = (salt >>> 16) & 0xff; sb[3] = salt >>> 24;
    const d = hasher.clone().update(sb).digest().slice(0, N);
    const c = verifyCost(d);
    if (!best || c < best.cost) best = { salt, digest: d, cost: c };
    if (progress && (salt & 8191) === 8191) progress((salt + 1) / tries);
  }
  return best;
}

function header(tag, leaf, expiry, salt, r) {
  return concat(new Uint8Array([tag]), u32(leaf), u64(expiry), u32(salt), r);
}

function checkInner(inner) {
  if (inner.length > 255) throw new Error("too many inner instructions");
  for (const [, metas, data] of inner) {
    if (metas.length > 255) throw new Error("too many accounts in an inner instruction");
    if (data.length > 0xffff) throw new Error("inner instruction data too long");
  }
}

export function buildExec(leaf, expiry, salt, r, sig, path, inner, outerKeys) {
  checkInner(inner);
  const pos = new Map(outerKeys.map((k, i) => [k.join(","), i]));
  const at = (k) => { const i = pos.get(k.join(",")); if (i === undefined || i > 255) throw new Error("inner instruction key missing from the transaction"); return i; };
  const parts = [header(IX_EXEC, leaf, expiry, salt, r), sig, path, new Uint8Array([inner.length])];
  for (const [prog, metas, data] of inner) {
    parts.push(new Uint8Array([at(prog), metas.length]));
    for (const [key, signer, writable] of metas) {
      parts.push(new Uint8Array([at(key), (signer ? F_SIGNER : 0) | (writable ? F_WRITABLE : 0)]));
    }
    parts.push(new Uint8Array([data.length & 0xff, data.length >> 8]), data);
  }
  return concat(...parts);
}

export function buildRekey(leaf, expiry, salt, r, sig, path, newPubSeed, newRoot) {
  return concat(header(IX_REKEY, leaf, expiry, salt, r), sig, path, newPubSeed, newRoot);
}

export function buildInit(pubSeed, root, lamports) {
  return concat(new Uint8Array([IX_INIT]), pubSeed, root, u64(lamports));
}

export function unpackState(data) {
  if (data.length < STATE_LEN || new TextDecoder().decode(data.slice(0, 8)) !== STATE_MAGIC) throw new Error("not an opeq state account");
  const dv = new DataView(data.buffer, data.byteOffset);
  return {
    id: data.slice(8, 40), pubSeed: data.slice(40, 56), root: data.slice(56, 72),
    next: dv.getUint32(72, true), epoch: dv.getUint32(76, true), sbump: data[80], wbump: data[81],
  };
}

export function outerLayout(state, wallet, inner) {
  const outer = [state, wallet];
  const has = (k) => outer.some((o) => o.join(",") === k.join(","));
  for (const [prog, metas] of inner) for (const k of [prog, ...metas.map((m) => m[0])]) if (!has(k)) outer.push(k);
  const writable = new Set([state.join(","), wallet.join(",")]);
  for (const [, metas] of inner) for (const [k, , w] of metas) if (w) writable.add(k.join(","));
  return { outer, metas: outer.map((k) => [k, false, writable.has(k.join(","))]) };
}
