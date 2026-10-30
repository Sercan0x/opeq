import { keccak256 } from "./keccak.js";
import { sha256 } from "./sha256.js";
import { FACTORY_INIT, ACCOUNT_INIT } from "./evmcode.js";

export const N = 16;
export const W = 256;
export const CHAINS = 18;
export const HEIGHT = 10;
export const LEAVES = 1 << HEIGHT;
export const SIG_LEN = CHAINS * N;
export const PATH_LEN = HEIGHT * N;
export const PROOF_LEN = SIG_LEN + PATH_LEN;
export const REKEY_RESERVE = 64;
export const EXEC_LIMIT = LEAVES - REKEY_RESERVE;
export const GRIND_TRIES = 1 << 17;

const T_CHAIN = 0, T_LEAF = 1, T_NODE = 2, T_PRF = 3;
const enc = new TextEncoder();

export const TAG_EXEC = keccak256(enc.encode("opeq/evm/exec/v1"));
export const CREATE_SELECTOR = keccak256(enc.encode("create(bytes16,bytes16)")).slice(0, 4);
export const TAG_REKEY = keccak256(enc.encode("opeq/evm/rekey/v1"));
export const EXECUTE_SELECTOR = keccak256(enc.encode("execute((address,uint256,bytes)[],uint32,uint64,uint32,bytes16,bytes)")).slice(0, 4);
export const REKEY_SELECTOR = keccak256(enc.encode("rekey(bytes16,bytes16,uint32,uint64,uint32,bytes16,bytes)")).slice(0, 4);

export function adrs(kind, a, b, idx) {
  return new Uint8Array([kind, a, b, 0, (idx >>> 24) & 0xff, (idx >>> 16) & 0xff, (idx >>> 8) & 0xff, idx & 0xff]);
}

const cbuf = new Uint8Array(40);

export function chainRun(pubSeed, leaf, c, x, start, steps) {
  cbuf.set(pubSeed, 0);
  cbuf.set(adrs(T_CHAIN, c, 0, leaf), 16);
  cbuf.set(x, 24);
  for (let pos = start; pos < start + steps; pos++) {
    cbuf[18] = pos;
    cbuf.set(keccak256(cbuf).subarray(0, N), 24);
  }
  return cbuf.slice(24, 40);
}

export function secret(skSeed, leaf, c) {
  return keccak256(skSeed, adrs(T_PRF, c, 0, leaf)).slice(0, N);
}

export function leafCompress(pubSeed, leaf, pks) {
  return keccak256(pubSeed, adrs(T_LEAF, 0, 0, leaf), ...pks).slice(0, N);
}

export function node(pubSeed, height, index, left, right) {
  return keccak256(pubSeed, adrs(T_NODE, height, 0, index), left, right).slice(0, N);
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
  for (let c = 0; c < CHAINS; c++) pks.push(chainRun(pubSeed, leaf, c, secret(skSeed, leaf, c), 0, W - 1));
  return leafCompress(pubSeed, leaf, pks);
}

export function rootFromProof(pubSeed, leaf, d16, proof) {
  const ds = digits(d16);
  const pks = [];
  for (let c = 0; c < CHAINS; c++) pks.push(chainRun(pubSeed, leaf, c, proof.subarray(c * N, c * N + N), ds[c], W - 1 - ds[c]));
  let x = leafCompress(pubSeed, leaf, pks);
  for (let h = 0; h < HEIGHT; h++) {
    const sib = proof.subarray(SIG_LEN + h * N, SIG_LEN + h * N + N);
    const idx = leaf >>> (h + 1);
    x = (leaf >>> h) & 1 ? node(pubSeed, h + 1, idx, sib, x) : node(pubSeed, h + 1, idx, x, sib);
  }
  return x;
}

export class EvmTreeKey {
  constructor(skSeed, pubSeed, leaves) {
    this.skSeed = skSeed;
    this.pubSeed = pubSeed;
    this.levels = [leaves];
    for (let h = 0; h < HEIGHT; h++) {
      const prev = this.levels[h], next = [];
      for (let i = 0; i < prev.length / 2; i++) next.push(node(pubSeed, h + 1, i, prev[2 * i], prev[2 * i + 1]));
      this.levels.push(next);
    }
    this.root = this.levels[HEIGHT][0];
  }

  static generate(skSeed, pubSeed, progress) {
    const leaves = [];
    for (let i = 0; i < LEAVES; i++) {
      leaves.push(leafPk(skSeed, pubSeed, i));
      if (progress && (i & 31) === 31) progress((i + 1) / LEAVES);
    }
    return new EvmTreeKey(skSeed, pubSeed, leaves);
  }

  sign(leaf, d16) {
    const out = new Uint8Array(PROOF_LEN);
    digits(d16).forEach((d, c) => out.set(chainRun(this.pubSeed, leaf, c, secret(this.skSeed, leaf, c), 0, d), c * N));
    for (let h = 0; h < HEIGHT; h++) out.set(this.levels[h][(leaf >>> h) ^ 1], SIG_LEN + h * N);
    return out;
  }
}

function u32be(v) { return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]); }

function u64be(v) {
  const b = BigInt(v), out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((b >> BigInt(56 - 8 * i)) & 0xffn);
  return out;
}

export const CHAIN_SLOTS = Object.freeze({ 8453: 0, 84532: 1, 31337: 2, 1: 3, 42161: 4, 4663: 5, 421614: 6, 11155111: 7 });

export function chainSlot(chainId) {
  const s = CHAIN_SLOTS[chainId];
  if (s === undefined) throw new Error("chain " + chainId + " has no identity slot");
  return s;
}

export function identitySeeds(master) {
  return {
    skSeed: sha256(enc.encode("opeq/evm/tree/sk/v1"), master, u32be(0)),
    pubSeed: sha256(enc.encode("opeq/evm/tree/pub/v1"), master, u32be(0)).slice(0, N),
  };
}

export function chainTreeSeeds(master, chainId, epoch, pubSeed) {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff) throw new Error("chain tree epoch must be 1 or more");
  if (!(pubSeed instanceof Uint8Array) || pubSeed.length !== N) throw new Error("pubSeed must be 16 bytes");
  chainSlot(chainId);
  return { skSeed: sha256(enc.encode("opeq/evm/tree/sk/v2"), master, u64be(chainId), u32be(epoch), pubSeed), pubSeed: pubSeed.slice() };
}

export function deriveIdentityTree(master, progress) {
  const { skSeed, pubSeed } = identitySeeds(master);
  return EvmTreeKey.generate(skSeed, pubSeed, progress);
}

export function deriveChainTree(master, chainId, epoch, pubSeed, progress) {
  const s = chainTreeSeeds(master, chainId, epoch, pubSeed);
  return EvmTreeKey.generate(s.skSeed, s.pubSeed, progress);
}

function word(n) {
  let v = BigInt(n);
  if (v < 0n || v >= 1n << 256n) throw new Error("value does not fit in 256 bits");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function leftWord(bytes) {
  if (bytes.length > 32) throw new Error("fixed bytes longer than 32");
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

export function addressBytes(addr) {
  if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error("not an EVM address");
  return Uint8Array.from(addr.slice(2).match(/../g), (h) => parseInt(h, 16));
}

function addressWord(addr) {
  const out = new Uint8Array(32);
  out.set(addressBytes(addr), 12);
  return out;
}

function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function dynBytes(data) {
  const pad = (32 - (data.length % 32)) % 32;
  return concat(word(data.length), data, new Uint8Array(pad));
}

export function encodeCalls(calls) {
  const bodies = calls.map((c) => concat(addressWord(c.to), word(c.value), word(96), dynBytes(c.data || new Uint8Array(0))));
  const heads = [];
  let off = 32 * calls.length;
  for (const b of bodies) { heads.push(word(off)); off += b.length; }
  return concat(word(calls.length), ...heads, ...bodies);
}

export function callsHash(calls) {
  return keccak256(word(32), encodeCalls(calls));
}

export function execHasher(rnd, chainId, account, epoch, leaf, deadline, calls) {
  if (rnd.length !== N) throw new Error("randomizer must be 16 bytes");
  const head = concat(leftWord(rnd), TAG_EXEC, word(chainId), addressWord(account), word(epoch), word(leaf), word(deadline), callsHash(calls));
  return (salt) => keccak256(head, word(salt)).slice(0, N);
}

export function rekeyHasher(rnd, chainId, account, epoch, leaf, deadline, newPubSeed, newRoot) {
  if (rnd.length !== N) throw new Error("randomizer must be 16 bytes");
  const head = concat(leftWord(rnd), TAG_REKEY, word(chainId), addressWord(account), word(epoch), word(leaf), word(deadline), leftWord(newPubSeed), leftWord(newRoot));
  return (salt) => keccak256(head, word(salt)).slice(0, N);
}

export function grind(hasher, tries = GRIND_TRIES, progress) {
  let best = null;
  for (let salt = 0; salt < tries; salt++) {
    const d = hasher(salt);
    const c = verifyCost(d);
    if (!best || c < best.cost) best = { salt, digest: d, cost: c };
    if (progress && (salt & 8191) === 8191) progress((salt + 1) / tries);
  }
  return best;
}

export function encodeExecute(calls, leaf, deadline, salt, rnd, proof) {
  if (proof.length !== PROOF_LEN) throw new Error("proof must be 448 bytes");
  const callsEnc = encodeCalls(calls);
  const headLen = 32 * 6;
  return concat(
    EXECUTE_SELECTOR,
    word(headLen), word(leaf), word(deadline), word(salt), leftWord(rnd), word(headLen + callsEnc.length),
    callsEnc,
    dynBytes(proof),
  );
}

export function encodeRekey(newPubSeed, newRoot, leaf, deadline, salt, rnd, proof) {
  if (proof.length !== PROOF_LEN) throw new Error("proof must be 448 bytes");
  return concat(
    REKEY_SELECTOR,
    leftWord(newPubSeed), leftWord(newRoot), word(leaf), word(deadline), word(salt), leftWord(rnd), word(32 * 7),
    dynBytes(proof),
  );
}

export function encodeCreate(pubSeed, root) {
  return concat(CREATE_SELECTOR, leftWord(pubSeed), leftWord(root));
}

export const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

function fromHex(h) {
  return Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
}

function toAddr(b) {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function create2(deployer, salt, initHash) {
  return toAddr(keccak256(Uint8Array.of(0xff), addressBytes(deployer), salt, initHash).slice(12));
}

const FACTORY_INIT_BYTES = fromHex(FACTORY_INIT);
const ACCOUNT_INIT_BYTES = fromHex(ACCOUNT_INIT);

export function factoryAddress() {
  return create2(CREATE2_DEPLOYER, new Uint8Array(32), keccak256(FACTORY_INIT_BYTES));
}

export function factoryDeployData() {
  return concat(new Uint8Array(32), FACTORY_INIT_BYTES);
}

export function accountSalt(pubSeed, root) {
  const tag = enc.encode("opeq/evm/id/v1");
  return keccak256(word(96), leftWord(pubSeed), leftWord(root), dynBytes(tag));
}

export function accountAddress(pubSeed, root, factory = factoryAddress()) {
  return create2(factory, accountSalt(pubSeed, root), keccak256(ACCOUNT_INIT_BYTES, leftWord(pubSeed), leftWord(root)));
}

export function bootSeeds(master, chainId) {
  chainSlot(chainId);
  return {
    pubSeed: sha256(enc.encode("opeq/evm/chain/pub/v1"), master, u64be(chainId)).slice(0, N),
    rnd: sha256(enc.encode("opeq/evm/boot/rnd/v1"), master, u64be(chainId)).slice(0, N),
  };
}

export function bootstrapCall(master, chainId, account, identity, progress) {
  const { pubSeed, rnd } = bootSeeds(master, chainId);
  const tree = deriveChainTree(master, chainId, 1, pubSeed, progress);
  const slot = chainSlot(chainId);
  const g = grind(rekeyHasher(rnd, chainId, account, 0, slot, 0, tree.pubSeed, tree.root));
  return { tree, cost: g.cost, calldata: encodeRekey(tree.pubSeed, tree.root, slot, 0, g.salt, rnd, identity.sign(slot, g.digest)) };
}

export function treeFromLeaves(skSeed, pubSeed, bytes) {
  if (bytes.length !== LEAVES * N) throw new Error("stored key tree has the wrong size");
  const leaves = [];
  for (let i = 0; i < LEAVES; i++) leaves.push(bytes.slice(i * N, i * N + N));
  return new EvmTreeKey(skSeed, pubSeed, leaves);
}

export function leavesBytes(tree) {
  const out = new Uint8Array(LEAVES * N);
  tree.levels[0].forEach((l, i) => out.set(l, i * N));
  return out;
}

export function encodeErc20Transfer(to, amount) {
  return concat(keccak256(enc.encode("transfer(address,uint256)")).slice(0, 4), addressWord(to), word(amount));
}
