import { installLocks } from "./locks.js";
import * as M from "./src/lib/mnemonic.js";
import * as P from "./src/lib/protocol.js";
import * as W from "./src/lib/wots.js";
import * as E from "./src/lib/evmwots.js";
import { Engine, signedLeaf, EXEC_LIMIT } from "./src/lib/engine.js";
import { localCompute } from "./src/lib/compute.js";
import { EvmChain, checkAddress, parseUnits, formatUnits } from "./src/lib/evmwallet.js";
import { MemoryStore, IdbStore } from "./src/lib/vaultstore.js";
import { Rpc, pubkey, b58encode, b58decode, eq, hex, unhex } from "./src/lib/solana.js";
import { sha256 } from "./src/lib/sha256.js";
import { hexToBytes, bytesToHex } from "./src/lib/evmtx.js";
import { feePayer } from "./src/feekey.js";

installLocks();

export const VERSION = "0.1.0";

export const NETWORKS = Object.freeze({
  mainnet: Object.freeze({ program: "HL598vrersxS5AUUV6NyzHgpSyK31xAmqMsqUhxzeKm8", genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }),
  devnet: Object.freeze({ program: "424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN", genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }),
});

export const EVM_CHAINS = Object.freeze({
  1: Object.freeze({ chainId: 1, name: "Ethereum", symbol: "ETH", explorer: "https://etherscan.io" }),
  8453: Object.freeze({ chainId: 8453, name: "Base", symbol: "ETH", explorer: "https://basescan.org" }),
  42161: Object.freeze({ chainId: 42161, name: "Arbitrum", symbol: "ETH", explorer: "https://arbiscan.io" }),
  4663: Object.freeze({ chainId: 4663, name: "Robinhood Chain", symbol: "ETH", explorer: "https://robinhoodchain.blockscout.com" }),
  84532: Object.freeze({ chainId: 84532, name: "Base Sepolia", symbol: "ETH", explorer: "https://sepolia.basescan.org" }),
  31337: Object.freeze({ chainId: 31337, name: "Local", symbol: "ETH", explorer: "" }),
});

const MAX_PRIORITY = 100000;
const enc = new TextEncoder();
const httpsUrl = (u, what) => {
  if (typeof u !== "string" || !/^https?:\/\/[^\s]+$/.test(u)) throw new Error(`${what} must be an http(s) URL`);
  return u;
};
const key = (k) => (typeof k === "string" ? pubkey(k) : k instanceof Uint8Array && k.length === 32 ? k : (() => { throw new Error("a Solana address must be base58 text or 32 bytes"); })());
const bytes = (d) => (d == null ? new Uint8Array(0) : typeof d === "string" ? hexToBytes(d) : d instanceof Uint8Array ? d : Uint8Array.from(d));

export function newWords() {
  const m = M.newMaster();
  try { return M.toWords(m).join(" "); } finally { m.fill(0); }
}

const text = (w) => (Array.isArray(w) ? w.join(" ") : String(w));

export function checkWords(words) {
  M.fromWords(text(words)).fill(0);
  return true;
}

function toInner(ix) {
  if (Array.isArray(ix)) return [key(ix[0]), ix[1].map(([k, s, w]) => [key(k), !!s, !!w]), bytes(ix[2])];
  if (!ix || !ix.programId || !Array.isArray(ix.keys)) throw new Error("an instruction needs programId, keys and data");
  return [key(ix.programId), ix.keys.map((m) => [key(m.pubkey), !!m.isSigner, !!m.isWritable]), bytes(ix.data)];
}

function priceFor(rpc) {
  return async (cuLimit, keys) => {
    try {
      const recent = await rpc.call("getRecentPrioritizationFees", [keys.slice(0, 128).map(b58encode)]);
      if (!Array.isArray(recent)) return 0;
      const fees = recent.slice(0, 300).map((x) => x && x.prioritizationFee).filter((f) => Number.isSafeInteger(f) && f >= 0).sort((a, b) => a - b);
      if (!fees.length) return 0;
      return Math.max(0, Math.min(fees[Math.floor(fees.length * 0.75)], Math.floor((MAX_PRIORITY * 1e6) / cuLimit)));
    } catch { return 0; }
  };
}

export class Vault {
  constructor({ rpcUrl, network = "mainnet", program, genesis, store, compute = localCompute, checkRpcUrl } = {}) {
    const net = NETWORKS[network];
    if (!net && !(program && genesis)) throw new Error("network must be mainnet or devnet, or pass program and genesis");
    if (!store) throw new Error("pass a store: FileStore.open(dir) in Node, IdbStore in a browser, MemoryStore for tests");
    this.rpc = new Rpc(httpsUrl(rpcUrl, "rpcUrl"));
    this.engine = new Engine({ rpc: this.rpc, program: program || net.program, store, compute, payer: null });
    this.engine.genesis = genesis || net.genesis;
    this.engine.maxPriority = MAX_PRIORITY;
    this.engine.priceFor = priceFor(this.rpc);
    if (checkRpcUrl) this.engine.refRpc = new Rpc(httpsUrl(checkRpcUrl, "checkRpcUrl"));
    this.store = store;
  }

  async create(password, progress) {
    const { record, words } = await this.engine.create(password, progress);
    await this.engine.save(record);
    return { id: record.id, words: words.join(" ") };
  }

  async recover(words, password, progress) {
    await this.engine.checkCluster();
    const rec = await this.engine.recover(text(words), password, progress, null);
    const old = await this.store.get(rec.id);
    if (old) throw new Error("this wallet is already in the store; open it instead");
    await this.engine.save(rec);
    return { id: rec.id, active: rec.active };
  }

  async list() {
    return (await this.store.all()).filter((r) => r.v === 1 && r.program === b58encode(this.engine.program)).map((r) => ({ id: r.id, epoch: r.epoch, nextLeaf: r.next_leaf, active: r.active }));
  }

  async open(id, password) {
    const record = await this.store.get(id);
    if (!record) throw new Error("no wallet with that id in this store");
    const session = await this.engine.unlock(record, password);
    return new Account(this, session);
  }
}

export class Account {
  constructor(vault, session) {
    this.vault = vault;
    this.s = session;
    this.id = session.id;
    this.address = session.id;
    this.payer = null;
    this.chains = new Map();
  }

  live() { if (!this.s) throw new Error("this account is closed"); }

  async feeKey() {
    this.live();
    if (!this.payer) this.payer = await feePayer(this.s.master, this.vault.engine.program);
    this.vault.engine.payer = this.payer;
    return this.payer.address;
  }

  async use() {
    await this.feeKey();
    return this.s;
  }

  async status() {
    this.live();
    const st = await this.s.status();
    return {
      state: st.state,
      epoch: st.r.epoch,
      nextLeaf: Math.max(st.r.next_leaf, st.st ? st.st.next : 0),
      keysLeft: st.st ? Math.max(0, EXEC_LIMIT - Math.max(st.r.next_leaf, st.st.next)) : EXEC_LIMIT,
    };
  }

  async balance() {
    this.live();
    return this.vault.rpc.balance(this.s.wallet);
  }

  async activate() {
    await this.use();
    return this.vault.engine.init(await this.s.load());
  }

  async send(to, lamports, progress) {
    return (await this.use()).sendSol(key(to), BigInt(lamports), progress);
  }

  async execute(instructions, { computeUnits = 400000, progress } = {}) {
    if (!Array.isArray(instructions) || !instructions.length) throw new Error("pass at least one instruction");
    return (await this.use()).exec(instructions.map(toInner), computeUnits, progress);
  }

  async rekey(progress) {
    return (await this.use()).rekey(progress);
  }

  async useHere(progress) {
    return (await this.use()).takeover(progress);
  }

  words() {
    this.live();
    return this.s.words().join(" ");
  }

  async evm(chainId, { rpcUrl, checkUrl, store } = {}) {
    this.live();
    const meta = EVM_CHAINS[chainId];
    if (!meta) throw new Error(`chain ${chainId} is not an OPEQ network`);
    if (!checkUrl && chainId !== 31337) throw new Error("pass checkUrl: a second, independent RPC for this chain. OPEQ compares both before it signs");
    const raw = sha256(enc.encode("opeq/evm/records/v1"), this.s.master);
    let macKey;
    try { macKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
    finally { raw.fill(0); }
    const c = new EvmChain({
      chain: { ...meta, rpc: httpsUrl(rpcUrl, "rpcUrl"), check: checkUrl ? httpsUrl(checkUrl, "checkUrl") : null },
      store: store || this.vault.store, macKey, legacyMac: this.s.macKey, vaultId: this.s.id,
      master: this.s.master.slice(), compute: this.vault.engine.compute,
    });
    await c.loadIdentity(null);
    const a = new EvmAccount(c);
    this.chains.set(a, true);
    return a;
  }

  close() {
    for (const a of this.chains.keys()) a.close();
    this.chains.clear();
    if (this.s) { this.s.master.fill(0); this.s = null; }
    if (this.vault.engine.payer === this.payer) this.vault.engine.payer = null;
    this.payer = null;
  }
}

export class EvmAccount {
  constructor(chain) {
    this.c = chain;
    this.chainId = chain.id;
    this.address = chain.account;
    this.feeAddress = chain.feeAddress;
  }

  live() { if (!this.c) throw new Error("this EVM account is closed"); }

  async status() {
    this.live();
    const s = await this.c.status();
    return { state: s.state, balance: s.bal, feeBalance: s.feeBal, keysLeft: s.left };
  }

  async setup(progress, step) {
    this.live();
    const s = await this.c.setup(progress, step);
    return s.state;
  }

  async execute(calls, onHash) {
    this.live();
    if (!Array.isArray(calls) || !calls.length) throw new Error("pass at least one call");
    const norm = calls.map((x) => ({ to: checkAddress(x.to), value: BigInt(x.value || 0), data: bytes(x.data) }));
    return this.c.execute(norm, onHash);
  }

  async send(to, wei, onHash) {
    return this.execute([{ to, value: BigInt(wei) }], onHash);
  }

  async rekey(progress, onHash) {
    this.live();
    return this.c.rekey(progress, onHash);
  }

  async useHere(progress, onHash) {
    this.live();
    return this.c.takeover(progress, onHash);
  }

  close() {
    if (!this.c) return;
    this.c.master.fill(0);
    this.c.fee = 0n;
    this.c = null;
  }
}

export function solanaAccountFor(pubSeed, root, network = "mainnet") {
  const program = pubkey(NETWORKS[network].program);
  const aid = P.accountId(bytes(pubSeed), bytes(root));
  return { id: hex(aid), wallet: b58encode(P.walletPda(aid, program).key), state: b58encode(P.statePda(aid, program).key) };
}

export function verifySolanaInstruction(data, accountKeys, { pubSeed, root, aid, epoch }, network = "mainnet") {
  const program = pubkey(NETWORKS[network].program);
  const keys = accountKeys.map((k) => (typeof k === "string" ? k : b58encode(k)));
  const cur = { pubSeed: bytes(pubSeed), root: bytes(root), aid: bytes(aid), epoch };
  try { return signedLeaf(bytes(data), keys, program, cur); } catch { return null; }
}

export function verifyWots({ pubSeed, root, leaf, digest, signature, path }) {
  return W.verify(bytes(pubSeed), bytes(root), leaf, bytes(digest), bytes(signature), bytes(path));
}

const word = (b, o) => { let v = 0n; for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[o + i]); return v; };
const small = (b, o, max) => { const v = word(b, o); if (v > BigInt(max)) throw new Error("value out of range"); return Number(v); };

export function decodeEvmExecute(calldata) {
  const d = bytes(calldata);
  if (d.length < 4 + 192 || !eq(d.subarray(0, 4), E.EXECUTE_SELECTOR)) throw new Error("not an OPEQ execute call");
  const b = d.subarray(4);
  const callsAt = small(b, 0, b.length), leaf = small(b, 32, E.LEAVES - 1), deadline = word(b, 64);
  const salt = small(b, 96, 0xffffffff), rnd = b.slice(128, 128 + E.N), proofAt = small(b, 160, b.length);
  const n = small(b, callsAt, 256), calls = [];
  for (let i = 0; i < n; i++) {
    const at = callsAt + 32 + small(b, callsAt + 32 + i * 32, b.length);
    const to = "0x" + bytesToHex(b.slice(at + 12, at + 32)).replace(/^0x/, "");
    const value = word(b, at + 32);
    const dAt = at + small(b, at + 64, b.length);
    const len = small(b, dAt, b.length);
    if (dAt + 32 + len > b.length) throw new Error("call data runs past the end");
    calls.push({ to, value, data: b.slice(dAt + 32, dAt + 32 + len) });
  }
  const plen = small(b, proofAt, b.length);
  if (plen !== E.PROOF_LEN || proofAt + 32 + plen > b.length) throw new Error("bad proof length");
  return { leaf, deadline, salt, rnd, calls, proof: b.slice(proofAt + 32, proofAt + 32 + plen) };
}

export function verifyEvmExecute(calldata, { chainId, account, epoch, pubSeed, root }) {
  let x;
  try { x = decodeEvmExecute(calldata); } catch { return null; }
  const digest = E.execHasher(x.rnd, chainId, account, epoch, x.leaf, x.deadline, x.calls)(x.salt);
  return eq(E.rootFromProof(bytes(pubSeed), x.leaf, digest, x.proof), bytes(root)) ? { leaf: x.leaf, calls: x.calls, deadline: x.deadline } : null;
}

export function evmAccountAddress(words) {
  const m = M.fromWords(text(words));
  try {
    const id = E.deriveIdentityTree(m);
    return E.accountAddress(id.pubSeed, id.root);
  } finally { m.fill(0); }
}

export { MemoryStore, IdbStore, localCompute, parseUnits, formatUnits, checkAddress, b58encode, b58decode, hex, unhex, hexToBytes, bytesToHex };
export const lowLevel = Object.freeze({ wots: W, evmWots: E, protocol: P, mnemonic: M });
