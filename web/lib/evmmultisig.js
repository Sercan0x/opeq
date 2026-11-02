import * as E from "./evmwots.js";
import { keccak256 } from "./keccak.js";
import { bytesToHex, hexToBytes } from "./evmtx.js";
import { MS_FACTORY_INIT, MS_INIT, MS_RUNTIME } from "./evmmscode.js";

const enc = new TextEncoder();
const { word, leftWord, addressWord, concat, dynBytes, addressBytes, encodeCalls } = E;
const sel = (sig) => keccak256(enc.encode(sig)).slice(0, 4);
const SEL = {
  propose: sel("propose((address,uint256,bytes)[],uint64)"),
  approve: sel("approve(uint256)"),
  revoke: sel("revoke(uint256)"),
  cancel: sel("cancel(uint256)"),
  execute: sel("execute(uint256,(address,uint256,bytes)[])"),
  setOwners: sel("setOwners(address[],uint8)"),
  setThreshold: sel("setThreshold(uint8)"),
  create: sel("create(address[],uint8,bytes32)"),
  getOwners: sel("getOwners()"),
  threshold: sel("threshold()"),
  config: sel("config()"),
  proposalCount: sel("proposalCount()"),
  getProposal: sel("getProposal(uint256)"),
  transfer: sel("transfer(address,uint256)"),
};
export const MAX_OWNERS = 10;
export const MAX_LIFETIME_S = 30 * 24 * 3600;
export const DEFAULT_LIFETIME_S = 7 * 24 * 3600;
export const PROPOSE_GAS = 700000n;
export const APPROVE_GAS = 120000n;
const fromHex = (h) => hexToBytes(h.startsWith("0x") ? h : "0x" + h);
const MS_FACTORY_INIT_BYTES = fromHex(MS_FACTORY_INIT);
const MS_INIT_BYTES = fromHex(MS_INIT);
const lower = (a) => a.toLowerCase();

function create2(deployer, salt, initHash) {
  return bytesToHex(keccak256(Uint8Array.of(0xff), addressBytes(deployer), salt, initHash).slice(12));
}

function addressArray(owners) {
  return concat(word(owners.length), ...owners.map(addressWord));
}

export function factoryAddress() {
  return create2(E.CREATE2_DEPLOYER, new Uint8Array(32), keccak256(MS_FACTORY_INIT_BYTES));
}

export function factoryDeployData() {
  return concat(new Uint8Array(32), MS_FACTORY_INIT_BYTES);
}

export function checkOwners(owners, threshold) {
  const list = owners.map(lower);
  if (!list.length || list.length > MAX_OWNERS) throw new Error(`a shared vault needs between 1 and ${MAX_OWNERS} owners`);
  if (new Set(list).size !== list.length) throw new Error("the same owner is listed twice");
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > list.length) throw new Error(`the number of approvals must be between 1 and ${list.length}`);
  return list;
}

export function vaultSalt(creator, owners, threshold, nonce) {
  const tag = enc.encode("opeq/evm/multisig/v1");
  const strTail = dynBytes(tag);
  return keccak256(word(160), addressWord(creator), word(160 + strTail.length), word(threshold), leftWord(nonce), strTail, addressArray(owners));
}

export function vaultAddress(creator, owners, threshold, nonce, factory = factoryAddress()) {
  const args = concat(word(64), word(threshold), addressArray(owners));
  return create2(factory, vaultSalt(creator, owners, threshold, nonce), keccak256(MS_INIT_BYTES, args));
}

export function createCall(owners, threshold, nonce) {
  return { to: factoryAddress(), value: 0n, data: concat(SEL.create, word(96), word(threshold), leftWord(nonce), addressArray(owners)) };
}

export function proposeCall(vault, calls, expires) {
  return { to: vault, value: 0n, data: concat(SEL.propose, word(64), word(expires), encodeCalls(calls)) };
}

export function idCall(vault, kind, id) {
  return { to: vault, value: 0n, data: concat(SEL[kind], word(id)) };
}

export function executeCall(vault, id, calls) {
  return { to: vault, value: 0n, data: concat(SEL.execute, word(id), word(64), encodeCalls(calls)) };
}

export function setOwnersCall(vault, owners, threshold) {
  return { to: vault, value: 0n, data: concat(SEL.setOwners, word(64), word(threshold), addressArray(owners)) };
}

function words(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 64) throw new Error("malformed answer from the network");
  return { at: (i) => BigInt("0x" + (h.slice(64 * i, 64 * i + 64) || "0")), n: h.length / 64, hex: h };
}

function readAddr(v) {
  if (v >> 160n) throw new Error("malformed address in the answer from the network");
  return "0x" + v.toString(16).padStart(40, "0");
}

export function decodeCalls(bytes) {
  const h = bytesToHex(bytes).slice(2);
  const w = (byteOff) => BigInt("0x" + (h.slice(byteOff * 2, byteOff * 2 + 64) || "x"));
  const num = (byteOff, max) => { const v = w(byteOff); if (v > BigInt(max)) throw new Error("malformed proposal"); return Number(v); };
  const total = h.length / 2;
  const arr = num(0, total);
  const n = num(arr, 64);
  const base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + num(base + 32 * i, total);
    const to = readAddr(w(t));
    const value = w(t + 32);
    const d = t + num(t + 64, total);
    const len = num(d, total);
    if (d + 32 + len > total) throw new Error("malformed proposal");
    out.push({ to, value, data: bytes.slice(d + 32, d + 32 + len) });
  }
  if (bytesToHex(concat(word(32), encodeCalls(out))) !== bytesToHex(bytes)) throw new Error("the proposal's calls are not in the standard encoding, refusing to show or sign them");
  return out;
}

export function describe(call, vault) {
  const d = call.data || new Uint8Array(0);
  if (!d.length) return { kind: "pay", to: call.to, value: call.value };
  const s = bytesToHex(d.slice(0, 4));
  if (s === bytesToHex(SEL.transfer) && d.length === 68 && call.value === 0n) {
    const w = words(bytesToHex(d.slice(4)));
    return { kind: "token", token: call.to, to: readAddr(w.at(0)), amount: w.at(1) };
  }
  if (lower(call.to) === lower(vault) && s === bytesToHex(SEL.setOwners)) {
    const w = words(bytesToHex(d.slice(4)));
    const n = Number(w.at(2));
    if (n > MAX_OWNERS) throw new Error("malformed owner change");
    return { kind: "owners", threshold: Number(w.at(1)), owners: Array.from({ length: n }, (_, i) => readAddr(w.at(3 + i))) };
  }
  if (lower(call.to) === lower(vault) && s === bytesToHex(SEL.setThreshold)) return { kind: "threshold", threshold: Number(words(bytesToHex(d.slice(4))).at(0)) };
  return { kind: "contract", to: call.to, value: call.value, selector: s };
}

export class Vault {
  constructor(chain, address) {
    this.chain = chain;
    this.address = lower(address);
  }

  async readAt(rpc, block) {
    const code = await rpc.code(this.address, block);
    if (code === "0x") throw new Error("there is no shared vault at that address on this network");
    if (lower(code.slice(2)) !== lower(MS_RUNTIME)) throw new Error("the code at that address is not the OPEQ shared vault contract, refusing to use it");
    const [o, t, c, n, bal] = await Promise.all([
      rpc.ethCall(this.address, bytesToHex(SEL.getOwners), block),
      rpc.ethCall(this.address, bytesToHex(SEL.threshold), block),
      rpc.ethCall(this.address, bytesToHex(SEL.config), block),
      rpc.ethCall(this.address, bytesToHex(SEL.proposalCount), block),
      rpc.balance(this.address, block),
    ]);
    const ow = words(o);
    const count = Number(ow.at(1));
    if (count < 1 || count > MAX_OWNERS) throw new Error("malformed owner list from the network");
    const owners = Array.from({ length: count }, (_, i) => readAddr(ow.at(2 + i)));
    return { owners, threshold: Number(words(t).at(0)), config: Number(words(c).at(0)), proposals: Number(words(n).at(0)), balance: bal };
  }

  async read() {
    const a = await this.chain.at((b) => this.readAt(this.chain.rpc, b));
    if (this.chain.check) {
      const b = await this.readAt(this.chain.check, "latest").catch(() => null);
      if (!b || b.owners.join() !== a.owners.join() || b.threshold !== a.threshold || b.config !== a.config) throw new Error("two independent network sources disagree about this shared vault, so nothing is shown as safe to sign. Try again in a minute");
    }
    return a;
  }

  async proposalAt(rpc, id, block = "latest") {
    const raw = await rpc.ethCall(this.address, bytesToHex(concat(SEL.getProposal, word(id))), block);
    const w = words(raw);
    const off = Number(w.at(6));
    if (off % 32 || off / 32 + 1 > w.n) throw new Error("malformed proposal from the network");
    const len = Number(w.at(off / 32));
    const bytes = hexToBytes("0x" + w.hex.slice((off + 32) * 2, (off + 32 + len) * 2));
    if (bytes.length !== len) throw new Error("malformed proposal from the network");
    const callsHash = "0x" + w.at(0).toString(16).padStart(64, "0");
    if (bytesToHex(keccak256(bytes)) !== callsHash) throw new Error("the proposal's calls do not match its hash, refusing to show or sign them");
    return {
      id, callsHash, proposer: readAddr(w.at(1)), expires: Number(w.at(2)), config: Number(w.at(3)),
      executed: w.at(4) !== 0n, cancelled: w.at(5) !== 0n, approvals: Number(w.at(7)), live: w.at(8) !== 0n,
      calls: decodeCalls(bytes),
    };
  }

  async proposal(id) {
    const a = await this.chain.at((b) => this.proposalAt(this.chain.rpc, id, b));
    if (this.chain.check) {
      const b = await this.proposalAt(this.chain.check, id).catch(() => null);
      if (!b || b.callsHash !== a.callsHash || b.proposer !== a.proposer || b.expires !== a.expires || b.config !== a.config) throw new Error("two independent network sources disagree about this proposal, so nothing was signed. Try again in a minute");
    }
    return a;
  }

  async approvedBy(id, owner) {
    const s = sel("approved(uint256,address)");
    const r = await this.chain.rpc.ethCall(this.address, bytesToHex(concat(s, word(id), addressWord(owner))));
    return words(r).at(0) !== 0n;
  }
}
