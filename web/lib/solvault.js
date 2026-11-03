import { findPda, concat, u32, u64, SYSTEM, eq, isOnCurve } from "./solana.js";
import { sha256 } from "./sha256.js";
import { TOKEN, TOKEN22 } from "./tokens.js";

const enc = new TextEncoder();
export const IX_CREATE = 0, IX_PROPOSE = 1, IX_APPROVE = 2, IX_REVOKE = 3, IX_CANCEL = 4, IX_EXECUTE = 5, IX_CLOSE = 6, IX_SWEEP = 7;
export const INNER_SET_OWNERS = 0x80, INNER_SET_THRESHOLD = 0x81;
export const MS_MAGIC = "OPEQMS01", PR_MAGIC = "OPEQPR01";
export const MAX_OWNERS = 8, MAX_IXS = 8, MAX_METAS = 16, MAX_DATA = 900;
export const MAX_LIFETIME = 30 * 24 * 3600, DEFAULT_LIFETIME = 7 * 24 * 3600;
export const M_SIGNER = 1, M_WRITABLE = 2;
export const MS_LEN = 88 + 32 * MAX_OWNERS;
export const PR_OFF_DATA = 132;
export const ERRORS = {
  1: "bad instruction", 2: "too many accounts", 3: "account index out of range", 4: "caller must sign",
  5: "bad system program", 6: "bad owner list", 7: "bad threshold", 8: "owner is not an OPEQ wallet",
  9: "duplicate owner", 10: "creator is not an owner", 11: "multisig address mismatch", 12: "already initialized",
  13: "multisig not owned by this program", 14: "bad multisig account", 15: "not an owner", 16: "proposal address mismatch",
  17: "bad expiry", 18: "malformed proposal", 19: "signer escalation", 20: "bad proposal account",
  21: "proposal not live", 22: "content mismatch", 23: "already approved", 24: "not approved", 25: "not the proposer",
  26: "not enough approvals", 27: "vault address mismatch", 28: "missing account for a stored instruction",
  29: "not writable", 30: "proposal still live", 31: "nothing to sweep",
};

const u8 = (v) => Uint8Array.of(v);
const i64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); return b; };
const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };

export function createProgramAddress(seeds, program) {
  const h = sha256(...seeds, program, enc.encode("ProgramDerivedAddress"));
  if (isOnCurve(h)) throw new Error("seeds give a point on the curve");
  return h;
}

export const msPda = (creator, nonce, prog) => findPda([enc.encode("m"), creator, nonce], prog);
export const vaultPda = (ms, prog) => findPda([enc.encode("v"), ms], prog);
export const proposalPda = (ms, id, prog) => findPda([enc.encode("p"), ms, u64(id)], prog);

export function ownerFromId(aid, opeqProgram) {
  if (!(aid instanceof Uint8Array) || aid.length !== 32) throw new Error("an owner ID is 32 bytes");
  const w = findPda([enc.encode("w"), aid], opeqProgram);
  return { aid, wbump: w.bump, wallet: w.key };
}

export function encodeOwners(owners) {
  return concat(u8(owners.length), ...owners.flatMap((o) => [o.aid, u8(o.wbump)]));
}

export function encodeStored(ixs) {
  const parts = [u8(ixs.length)];
  for (const [prog, metas, data] of ixs) {
    parts.push(prog, u8(metas.length));
    for (const [key, flags] of metas) parts.push(key, u8(flags));
    parts.push(u16(data.length), data);
  }
  return concat(...parts);
}

export function decodeStored(buf, vault) {
  const bad = (code) => { const e = new Error(`the proposal is malformed (${ERRORS[code]})`); e.code = code; return e; };
  if (buf.length < 1 || buf.length > MAX_DATA) throw bad(18);
  const n = buf[0];
  if (n < 1 || n > MAX_IXS) throw bad(18);
  let pos = 1;
  const ixs = [];
  for (let i = 0; i < n; i++) {
    if (pos + 33 > buf.length) throw bad(18);
    const prog = buf.slice(pos, pos + 32), nm = buf[pos + 32];
    pos += 33;
    if (nm > MAX_METAS) throw bad(18);
    const metas = [];
    for (let j = 0; j < nm; j++) {
      if (pos + 33 > buf.length) throw bad(18);
      const key = buf.slice(pos, pos + 32), fl = buf[pos + 32];
      if (fl & 0xfc) throw bad(18);
      if (fl & M_SIGNER && !eq(key, vault)) throw bad(19);
      metas.push([key, fl]);
      pos += 33;
    }
    if (pos + 2 > buf.length) throw bad(18);
    const dl = buf[pos] | (buf[pos + 1] << 8);
    pos += 2;
    if (pos + dl > buf.length) throw bad(18);
    ixs.push([prog, metas, buf.slice(pos, pos + dl)]);
    pos += dl;
  }
  if (pos !== buf.length) throw bad(18);
  return ixs;
}

export function setOwnersData(threshold, owners) {
  return concat(u8(INNER_SET_OWNERS), u8(threshold), encodeOwners(owners));
}

export function setThresholdData(threshold) {
  return Uint8Array.of(INNER_SET_THRESHOLD, threshold);
}

export function createIx(prog, wallet, ms, nonce, threshold, owners) {
  return [prog, [[wallet, true, true], [ms, false, true], [SYSTEM, false, false]], concat(u8(IX_CREATE), u8(threshold), nonce, encodeOwners(owners))];
}

export function proposeIx(prog, wallet, ms, prop, expires, stored) {
  return [prog, [[wallet, true, true], [ms, false, true], [prop, false, true], [SYSTEM, false, false]], concat(u8(IX_PROPOSE), i64(expires), stored)];
}

export function voteIx(prog, tag, wallet, ms, prop, id, hash) {
  if (tag !== IX_APPROVE && tag !== IX_REVOKE) throw new Error("unknown vote");
  return [prog, [[wallet, true, false], [ms, false, false], [prop, false, true]], concat(u8(tag), u64(id), hash)];
}

export function cancelIx(prog, wallet, ms, prop, id) {
  return [prog, [[wallet, true, false], [ms, false, false], [prop, false, true]], concat(u8(IX_CANCEL), u64(id))];
}

export function executeIx(prog, wallet, ms, prop, vault, id, storedIxs) {
  const extra = [];
  const add = (key, writable) => {
    if ([wallet, ms, prop, vault].some((k) => eq(k, key))) return;
    const have = extra.find((m) => eq(m[0], key));
    if (have) have[2] = have[2] || writable;
    else extra.push([key, false, writable]);
  };
  for (const [p, metas] of storedIxs) {
    if (eq(p, prog)) continue;
    add(p, false);
    for (const [key, fl] of metas) add(key, !!(fl & M_WRITABLE));
  }
  const walletWritten = storedIxs.some(([p, metas]) => !eq(p, prog) && metas.some(([key, fl]) => eq(key, wallet) && fl & M_WRITABLE));
  return [prog, [[wallet, true, walletWritten], [ms, false, true], [prop, false, true], [vault, false, true], ...extra], concat(u8(IX_EXECUTE), u64(id))];
}

export function sweepIx(prog, ms, vault) {
  return [prog, [[ms, false, true], [vault, false, true]], u8(IX_SWEEP)];
}

export function closeIx(prog, wallet, ms, prop, id) {
  return [prog, [[wallet, false, true], [ms, false, false], [prop, false, true]], concat(u8(IX_CLOSE), u64(id))];
}

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const magic = (b) => new TextDecoder().decode(b.slice(0, 8));

export function unpackMs(data) {
  if (data.length !== MS_LEN || magic(data) !== MS_MAGIC) throw new Error("that account is not an OPEQ shared vault");
  const d = dv(data), n = data[77];
  if (n < 1 || n > MAX_OWNERS || data[76] < 1 || data[76] > n) throw new Error("malformed shared vault account");
  return {
    creator: data.slice(8, 40), nonce: data.slice(40, 72), config: d.getUint32(72, true), threshold: data[76], n,
    mbump: data[78], vbump: data[79], next: Number(d.getBigUint64(80, true)),
    owners: Array.from({ length: n }, (_, i) => data.slice(88 + 32 * i, 120 + 32 * i)),
  };
}

export function unpackProposal(data) {
  if (data.length < PR_OFF_DATA || magic(data) !== PR_MAGIC) throw new Error("that account is not an OPEQ vault proposal");
  const d = dv(data);
  const dl = d.getUint32(128, true);
  if (data.length !== PR_OFF_DATA + dl) throw new Error("malformed proposal account");
  const body = data.slice(PR_OFF_DATA);
  if (!eq(sha256(body), data.slice(96, 128))) throw new Error("the proposal does not match its hash");
  return {
    ms: data.slice(8, 40), id: Number(d.getBigUint64(40, true)), config: d.getUint32(48, true), flags: data[52], pbump: data[53],
    approvals: d.getUint16(54, true), expires: Number(d.getBigInt64(56, true)), proposer: data.slice(64, 96), hash: data.slice(96, 128), data: body,
  };
}

export function describe(ix, ctx) {
  const [prog, metas, data] = ix;
  const flat = metas.map(([k, f]) => ({ key: k, signer: !!(f & M_SIGNER), writable: !!(f & M_WRITABLE) }));
  if (eq(prog, ctx.program)) {
    if (metas.length === 0 && data.length === 2 && data[0] === INNER_SET_THRESHOLD) return { kind: "threshold", threshold: data[1] };
    if (metas.length === 0 && data.length >= 3 && data[0] === INNER_SET_OWNERS && data.length === 3 + 33 * data[2]) {
      const owners = Array.from({ length: data[2] }, (_, i) => ({ aid: data.slice(3 + 33 * i, 35 + 33 * i), wbump: data[35 + 33 * i] }));
      const canon = owners.map((o) => findPda([enc.encode("w"), o.aid], ctx.opeqProgram));
      if (canon.some((c, i) => c.bump !== owners[i].wbump)) return { kind: "contract", program: prog, metas: flat, data };
      return { kind: "owners", threshold: data[1], owners, wallets: canon.map((c) => c.key) };
    }
    return { kind: "contract", program: prog, metas: flat, data };
  }
  if (eq(prog, SYSTEM) && data.length === 12 && dv(data).getUint32(0, true) === 2 && flat.length === 2
    && eq(flat[0].key, ctx.vault) && flat[0].signer && flat[0].writable && !flat[1].signer && flat[1].writable) {
    return { kind: "pay", to: flat[1].key, lamports: dv(data).getBigUint64(4, true) };
  }
  if ((eq(prog, TOKEN) || eq(prog, TOKEN22)) && data.length === 10 && data[0] === 12 && flat.length === 4
    && eq(flat[3].key, ctx.vault) && flat[3].signer && !flat[0].signer && flat[0].writable && !flat[1].writable && !flat[1].signer && flat[2].writable && !flat[2].signer) {
    return { kind: "token", program: prog, source: flat[0].key, mint: flat[1].key, dest: flat[2].key, amount: dv(data).getBigUint64(1, true), decimals: data[9], mayHaveFee: eq(prog, TOKEN22) };
  }
  return { kind: "contract", program: prog, metas: flat, data };
}
