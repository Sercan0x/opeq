import { pubkey, findPda, concat, u64, eq, SYSTEM, b58encode } from "./solana.js";
import { sha256 } from "./sha256.js";
import { TOKEN, TOKEN22 } from "./tokens.js";
import { decodeTokenAuthority } from "./agent.js";

const enc = new TextEncoder();
export const PROGRAM = pubkey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
export const PERM_INITIATE = 1;
export const PERM_VOTE = 2;
export const PERM_EXECUTE = 4;
export const SHOW = 10;

const ixDisc = (n) => sha256(enc.encode("global:" + n)).slice(0, 8);
const accDisc = (n) => sha256(enc.encode("account:" + n)).slice(0, 8);
export const DISC = {
  multisig: accDisc("Multisig"),
  proposal: accDisc("Proposal"),
  vaultTx: accDisc("VaultTransaction"),
  configTx: accDisc("ConfigTransaction"),
  batch: accDisc("Batch"),
  approve: ixDisc("proposal_approve"),
  reject: ixDisc("proposal_reject"),
};

const STATUS = ["draft", "active", "rejected", "approved", "executing", "executed", "cancelled"];

class Reader {
  constructor(data, off = 0) { this.d = data; this.o = off; }
  need(n) { if (this.o + n > this.d.length) throw new Error("malformed Squads account"); }
  u8() { this.need(1); return this.d[this.o++]; }
  u16() { this.need(2); const v = this.d[this.o] | (this.d[this.o + 1] << 8); this.o += 2; return v; }
  u32() { this.need(4); const v = new DataView(this.d.buffer, this.d.byteOffset + this.o, 4).getUint32(0, true); this.o += 4; return v; }
  u64() { this.need(8); const v = new DataView(this.d.buffer, this.d.byteOffset + this.o, 8).getBigUint64(0, true); this.o += 8; return v; }
  i64() { this.need(8); const v = new DataView(this.d.buffer, this.d.byteOffset + this.o, 8).getBigInt64(0, true); this.o += 8; return v; }
  key() { this.need(32); const k = this.d.slice(this.o, this.o + 32); this.o += 32; return k; }
  bytes(n) { this.need(n); const b = this.d.slice(this.o, this.o + n); this.o += n; return b; }
  len(max) { const n = this.u32(); if (n > max) throw new Error("malformed Squads account"); return n; }
  vec(max, f) { return Array.from({ length: this.len(max) }, () => f()); }
  opt(f) { const t = this.u8(); if (t > 1) throw new Error("malformed Squads account"); return t ? f() : null; }
}

const startsWith = (data, disc) => data && data.length >= 8 && eq(data.slice(0, 8), disc);

export const multisigPda = (createKey) => findPda([enc.encode("multisig"), enc.encode("multisig"), createKey], PROGRAM).key;
export const vaultPda = (ms, index) => findPda([enc.encode("multisig"), ms, enc.encode("vault"), Uint8Array.of(index)], PROGRAM).key;
export const transactionPda = (ms, index) => findPda([enc.encode("multisig"), ms, enc.encode("transaction"), u64(index)], PROGRAM).key;
export const proposalPda = (ms, index) => findPda([enc.encode("multisig"), ms, enc.encode("transaction"), u64(index), enc.encode("proposal")], PROGRAM).key;

export function unpackMultisig(data) {
  if (!startsWith(data, DISC.multisig)) throw new Error("that address is not a Squads multisig");
  const r = new Reader(data, 8);
  const createKey = r.key(), configAuthority = r.key();
  const threshold = r.u16(), timeLock = r.u32();
  const transactionIndex = r.u64(), staleIndex = r.u64();
  const rentCollector = r.opt(() => r.key());
  const bump = r.u8();
  const members = r.vec(65535, () => ({ key: r.key(), perms: r.u8() }));
  if (threshold < 1 || threshold > members.length) throw new Error("malformed Squads multisig");
  return { createKey, configAuthority, threshold, timeLock, transactionIndex, staleIndex, rentCollector, bump, members };
}

export function unpackProposal(data) {
  if (!startsWith(data, DISC.proposal)) throw new Error("malformed Squads proposal");
  const r = new Reader(data, 8);
  const ms = r.key(), index = r.u64();
  const tag = r.u8();
  if (tag >= STATUS.length) throw new Error("unknown Squads proposal state");
  const at = tag === 4 ? null : Number(r.i64());
  const bump = r.u8();
  const approved = r.vec(65535, () => r.key()), rejected = r.vec(65535, () => r.key()), cancelled = r.vec(65535, () => r.key());
  return { ms, index, status: STATUS[tag], at, bump, approved, rejected, cancelled };
}

function unpackMessage(r) {
  const numSigners = r.u8(), numWritableSigners = r.u8(), numWritableNonSigners = r.u8();
  const keys = r.vec(256, () => r.key());
  const ixs = r.vec(64, () => ({ prog: r.u8(), accounts: Array.from(r.bytes(r.len(256))), data: r.bytes(r.len(65536)) }));
  const lookups = r.vec(32, () => ({ table: r.key(), writable: Array.from(r.bytes(r.len(256))), readonly: Array.from(r.bytes(r.len(256))) }));
  if (numWritableSigners > numSigners || numSigners + numWritableNonSigners > keys.length) throw new Error("malformed Squads transaction");
  for (const ix of ixs) if (ix.prog >= keys.length || ix.accounts.some((a) => a >= keys.length + lookups.reduce((n, l) => n + l.writable.length + l.readonly.length, 0))) throw new Error("malformed Squads transaction");
  const writable = (i) => i < numSigners ? i < numWritableSigners : i - numSigners < numWritableNonSigners;
  return { numSigners, keys, lookups, ixs: ixs.map((ix) => ({
    program: keys[ix.prog],
    metas: ix.accounts.map((a) => a < keys.length ? { key: keys[a], signer: a < numSigners, writable: writable(a), known: true } : { key: null, signer: false, writable: false, known: false }),
    data: ix.data,
  })) };
}

const ACTIONS = ["add member", "remove member", "change threshold", "set time lock", "add spending limit", "remove spending limit", "set rent collector"];

function unpackAction(r) {
  const t = r.u8();
  if (t === 0) return { kind: "add", key: r.key(), perms: r.u8() };
  if (t === 1) return { kind: "remove", key: r.key() };
  if (t === 2) return { kind: "threshold", threshold: r.u16() };
  if (t === 3) return { kind: "timelock", seconds: r.u32() };
  if (t === 4) {
    const createKey = r.key(), vaultIndex = r.u8(), mint = r.key(), amount = r.u64(), period = r.u8();
    const members = r.vec(256, () => r.key()), destinations = r.vec(256, () => r.key());
    return { kind: "limit", createKey, vaultIndex, mint, amount, period, members, destinations };
  }
  if (t === 5) return { kind: "unlimit", key: r.key() };
  if (t === 6) return { kind: "rent", key: r.opt(() => r.key()) };
  throw new Error("unknown Squads settings change");
}

export function unpackTransaction(data, ms) {
  if (startsWith(data, DISC.vaultTx)) {
    const r = new Reader(data, 8);
    const m = r.key(), creator = r.key(), index = r.u64();
    r.u8();
    const vaultIndex = r.u8();
    r.u8();
    r.vec(32, () => r.u8());
    if (!eq(m, ms)) throw new Error("malformed Squads transaction");
    return { kind: "vault", creator, index, vaultIndex, message: unpackMessage(r) };
  }
  if (startsWith(data, DISC.configTx)) {
    const r = new Reader(data, 8);
    const m = r.key(), creator = r.key(), index = r.u64();
    r.u8();
    if (!eq(m, ms)) throw new Error("malformed Squads transaction");
    return { kind: "config", creator, index, actions: r.vec(64, () => unpackAction(r)) };
  }
  if (startsWith(data, DISC.batch)) return { kind: "batch" };
  return { kind: "unknown" };
}

export function lockState(info, me) {
  const mine = info.members.find((m) => eq(m.key, me));
  const others = info.members.filter((m) => !eq(m.key, me) && (m.perms & PERM_VOTE)).length;
  const issues = [];
  if (!mine) issues.push("Your OPEQ address is not a member of this multisig.");
  else if (!(mine.perms & PERM_VOTE)) issues.push("Your OPEQ address is a member but cannot vote. Give it the Vote permission.");
  if (mine && (mine.perms & PERM_VOTE) && others >= info.threshold) issues.push(`The other members can still approve alone: ${others} of them can vote and ${info.threshold} approvals are needed. Raise the threshold to ${others + 1}.`);
  if (!eq(info.configAuthority, SYSTEM)) issues.push(`A config authority (${b58encode(info.configAuthority)}) can change members and limits without any vote. Remove it in Squads.`);
  return { member: !!mine, voter: !!(mine && (mine.perms & PERM_VOTE)), others, locked: issues.length === 0, issues };
}

const u32le = (d, o) => new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true);
const u64le = (d, o) => new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);

export function describeIx(ix, vault) {
  const p = ix.program, d = ix.data, m = ix.metas;
  if (eq(p, SYSTEM) && d.length === 12 && u32le(d, 0) === 2 && m.length === 2 && m.every((a) => a.known)) {
    return { kind: "pay", from: m[0].key, to: m[1].key, lamports: u64le(d, 4), fromVault: eq(m[0].key, vault) };
  }
  if ((eq(p, TOKEN) || eq(p, TOKEN22)) && m.every((a) => a.known)) {
    if (d.length === 9 && d[0] === 3 && m.length >= 3) return { kind: "token", program: p, source: m[0].key, dest: m[1].key, authority: m[2].key, amount: u64le(d, 1), mint: null, decimals: null };
    if (d.length === 10 && d[0] === 12 && m.length >= 4) return { kind: "token", program: p, source: m[0].key, mint: m[1].key, dest: m[2].key, authority: m[3].key, amount: u64le(d, 1), decimals: d[9] };
    const auth = decodeTokenAuthority(p, m.map((a) => a.key), d);
    if (auth) return auth;
  }
  return { kind: "call", program: p, metas: m, data: d };
}

export function voteIx(kind, ms, member, proposal) {
  const disc = kind === "approve" ? DISC.approve : kind === "reject" ? DISC.reject : null;
  if (!disc) throw new Error("unknown vote");
  return [PROGRAM, [[ms, false, false], [member, true, true], [proposal, false, true]], concat(disc, Uint8Array.of(0))];
}

export { ACTIONS };
