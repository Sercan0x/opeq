import * as E from "./evmwots.js";
import * as S from "./secp256k1.js";
import { signTx1559, hexToBytes, bytesToHex } from "./evmtx.js";
import { keccak256 } from "./keccak.js";
import { FACTORY_RUNTIME, ACCOUNT_RUNTIME } from "./evmcode.js";
import * as V from "./vaultstore.js";

const enc = new TextEncoder();
const sel = (sig) => bytesToHex(keccak256(enc.encode(sig)).slice(0, 4));
const SEL = {
  epoch: sel("epoch()"), next: sel("next()"), pubSeed: sel("pubSeed()"), root: sel("root()"),
  balanceOf: sel("balanceOf(address)"), decimals: sel("decimals()"), symbol: sel("symbol()"),
};
export const DEADLINE_S = 15 * 60;
export const REKEY_SOON = 100;
const GAS_HEADROOM = 13n;
export const EXEC_GAS = 320000n;
export const REKEY_GAS = 300000n;
export const SETUP_GAS = { factory: 1700000n, account: 1300000n };
const b64 = (b) => btoa(String.fromCharCode(...b));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const lower = (a) => a.toLowerCase();
const word = (h, i = 0) => BigInt("0x" + (h.slice(2 + 64 * i, 66 + 64 * i) || "0"));

export function checkAddress(text) {
  const t = String(text || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error("That is not an EVM address (0x followed by 40 hex characters).");
  if (/[a-f]/.test(t.slice(2)) && /[A-F]/.test(t.slice(2))) {
    const h = keccak256(enc.encode(t.slice(2).toLowerCase()));
    for (let i = 0; i < 40; i++) {
      const c = t[2 + i], nib = (h[i >> 1] >> (i % 2 ? 0 : 4)) & 15;
      if (/[a-f]/i.test(c) && (nib >= 8) !== (c === c.toUpperCase())) throw new Error("That address has a typo: its upper and lower case letters do not match its checksum.");
    }
  }
  if (/^0x0{40}$/.test(t)) throw new Error("That is the zero address. Funds sent there are burned.");
  return lower(t);
}

export function parseUnits(text, decimals) {
  let t = String(text || "").trim();
  if (t.startsWith(".")) t = "0" + t;
  const re = new RegExp(`^\\d{1,30}(\\.\\d{1,${decimals}})?$`);
  if (!decimals ? !/^\d{1,30}$/.test(t) : !re.test(t)) throw new Error(`Enter an amount like 0.01, with at most ${decimals} decimals.`);
  const [w, f = ""] = t.split(".");
  const v = BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (v <= 0n) throw new Error("The amount must be more than zero.");
  return v;
}

export function formatUnits(v, decimals, max = 6) {
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const w = v / base;
  let f = (v % base).toString().padStart(decimals, "0").slice(0, max).replace(/0+$/, "");
  return (neg ? "-" : "") + w.toLocaleString("en-US") + (f ? "." + f : "");
}

export class EvmRpc {
  constructor(url) { this.url = url; this.n = 0; }
  async call(method, params = []) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    let j;
    try {
      const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.n, method, params }), signal: ctl.signal });
      j = await r.json();
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "the network did not answer in 20 seconds" : "could not reach the network");
    } finally { clearTimeout(t); }
    if (j.error) { const e = new Error(String(j.error.message || "request failed").slice(0, 200)); e.fromRpc = true; e.data = j.error.data; throw e; }
    return j.result;
  }
  ethCall(to, data, block = "latest") { return this.call("eth_call", [{ to, data }, block]); }
  async balance(a, block = "latest") { return BigInt(await this.call("eth_getBalance", [a, block])); }
  async code(a, block = "latest") { return await this.call("eth_getCode", [a, block]); }
}

export class EvmChain {
  constructor({ chain, store, macKey, vaultId, master, compute, rpcUrl }) {
    this.chain = chain;
    this.id = chain.chainId;
    this.rpc = new EvmRpc(rpcUrl || chain.rpc);
    this.store = store;
    this.macKey = macKey;
    this.vaultId = vaultId;
    this.master = master;
    this.compute = compute;
    this.fee = S.feeKeyFromMaster(master);
    this.feeAddress = S.addressOf(this.fee);
    this.factory = E.factoryAddress();
    this.key = `${vaultId}:evm:${this.id}`;
    this.identity = null;
    this.minBlock = 0;
  }

  async at(fn) {
    for (let i = 0; i < 20; i++) {
      const n = Number(await this.rpc.call("eth_blockNumber"));
      if (n >= this.minBlock) {
        try { return await fn("0x" + n.toString(16)); }
        catch (e) { if (!e.fromRpc || !/header not found|unknown block|block not found|missing trie node/i.test(e.message)) throw e; }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("the network RPC is behind the last confirmed transaction; try again in a minute");
  }

  async checkNetwork() {
    const id = Number(await this.rpc.call("eth_chainId"));
    if (id !== this.id) throw new Error(`the RPC is on chain ${id}, not ${this.chain.name} (${this.id})`);
  }

  async loadIdentity(progress) {
    const key = `${this.vaultId}:evm:id`;
    const pubSeed = E.identitySeeds(this.master).pubSeed;
    let c = await this.store.get(key);
    if (c) {
      await V.checkRecord(this.macKey, c);
      if (c.pub_seed !== bytesToHex(pubSeed)) throw new Error("the saved EVM identity does not match these words");
    } else {
      const t = await this.compute.run("evmIdentity", { master: this.master.slice() }, progress);
      c = await this.put({ id: key, pub_seed: bytesToHex(t.pubSeed), root: bytesToHex(t.root) });
    }
    this.identity = { pubSeed, root: hexToBytes(c.root) };
    this.account = E.accountAddress(this.identity.pubSeed, this.identity.root, this.factory);
    return this.account;
  }

  async record() {
    const r = await this.store.get(this.key);
    if (!r) return null;
    await V.checkRecord(this.macKey, r);
    return r;
  }

  async put(r) {
    await V.signRecord(this.macKey, r);
    await this.store.put(r);
    return r;
  }

  lock(fn) { return V.withLock(`opeq-evm:${this.key}`, fn); }

  async chainState() {
    return this.at((b) => this.chainStateAt(b));
  }

  async chainStateAt(block) {
    const code = await this.rpc.code(this.account, block);
    if (code === "0x") return { deployed: false, epoch: 0, next: 0, pubSeed: null, root: null };
    if (lower(code.slice(2)) !== lower(ACCOUNT_RUNTIME)) throw new Error("the code at your account address is not the OPEQ account contract, refusing to use it");
    const [ep, nx, ps, rt] = await Promise.all([SEL.epoch, SEL.next, SEL.pubSeed, SEL.root].map((s) => this.rpc.ethCall(this.account, s, block)));
    return { deployed: true, epoch: Number(word(ep)), next: Number(word(nx)), pubSeed: ps.slice(0, 34), root: rt.slice(0, 34) };
  }

  async status() {
    const [[st, bal, feeBal], r] = await Promise.all([
      this.at((b) => Promise.all([this.chainStateAt(b), this.rpc.balance(this.account, b), this.rpc.balance(this.feeAddress, b)])),
      this.record(),
    ]);
    let state;
    if (!st.deployed || st.epoch === 0) state = "setup";
    else if (r && r.epoch === st.epoch && r.pub_seed === st.pubSeed && r.root === st.root && r.active) state = "ready";
    else if (r && r.rekeying && st.epoch === r.epoch + 1 && r.rekeying.pub_seed === st.pubSeed && r.rekeying.root === st.root) state = "adopt";
    else state = "other";
    const left = state === "ready" ? Math.max(0, E.EXEC_LIMIT - Math.max(r.next_leaf, st.next)) : 0;
    return { state, st, r, bal, feeBal, left };
  }

  async fees() {
    const [block, tip] = await Promise.all([this.rpc.call("eth_getBlockByNumber", ["latest", false]), this.rpc.call("eth_maxPriorityFeePerGas").catch(() => "0x0")]);
    const base = BigInt(block.baseFeePerGas || "0x0");
    const prio = BigInt(tip) > 0n ? BigInt(tip) : 1000000n;
    return { maxFeePerGas: base * 2n + prio, maxPriorityFeePerGas: prio, now: Number(block.timestamp) };
  }

  async estimate(to, data, value = 0n) {
    const g = await this.rpc.call("eth_estimateGas", [{ from: this.feeAddress, to, data: bytesToHex(data), value: "0x" + value.toString(16) }]);
    return (BigInt(g) * GAS_HEADROOM) / 10n;
  }

  async costOf(gas) {
    const f = await this.fees();
    return gas * f.maxFeePerGas;
  }

  async sendTx(to, data, value = 0n, gas = null, onHash) {
    const f = await this.fees();
    const g = gas || (await this.estimate(to, data, value));
    const nonce = Math.max(Number(await this.rpc.call("eth_getTransactionCount", [this.feeAddress, "pending"])), this.nextNonce || 0);
    const need = g * f.maxFeePerGas + value;
    const have = await this.rpc.balance(this.feeAddress);
    if (have < need) throw new Error(`the gas key needs about ${formatUnits(need, 18)} ${this.chain.symbol} for this step and holds ${formatUnits(have, 18)}. Send a little ${this.chain.symbol} on ${this.chain.name} to ${this.feeAddress}`);
    const { raw, hash } = signTx1559({ chainId: this.id, nonce, maxPriorityFeePerGas: f.maxPriorityFeePerGas, maxFeePerGas: f.maxFeePerGas, gas: g, to, value, data }, this.fee);
    const got = await this.rpc.call("eth_sendRawTransaction", [raw]);
    if (lower(got) !== lower(hash)) throw new Error("the network returned a different transaction hash, refusing to trust it");
    this.nextNonce = nonce + 1;
    if (onHash) onHash(hash);
    return this.wait(hash);
  }

  async wait(hash, ms = 120000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const rc = await this.rpc.call("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (rc) {
        if (rc.status !== "0x1") { const e = new Error(`the transaction failed on chain (${hash})`); e.hash = hash; throw e; }
        this.minBlock = Math.max(this.minBlock, Number(rc.blockNumber));
        return { hash, gasUsed: BigInt(rc.gasUsed) };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    const e = new Error(`the transaction was sent but has not confirmed after 2 minutes. Check it on the explorer: ${hash}`);
    e.hash = hash;
    throw e;
  }

  async setup(progress, step = () => {}) {
    await this.checkNetwork();
    return this.lock(async () => {
      const fcode = await this.rpc.code(this.factory);
      if (fcode === "0x") {
        step("deploying the OPEQ factory on this network");
        await this.sendTx(E.CREATE2_DEPLOYER, E.factoryDeployData());
      } else if (lower(fcode.slice(2)) !== lower(FACTORY_RUNTIME)) throw new Error("the code at the OPEQ factory address is not the expected factory, refusing to continue");
      let st = await this.chainState();
      if (!st.deployed) {
        step("creating your account contract");
        await this.sendTx(this.factory, E.encodeCreate(this.identity.pubSeed, this.identity.root));
        st = await this.chainState();
        if (!st.deployed) throw new Error("the account contract did not appear at the expected address");
      }
      if (st.epoch !== 0) return this.status();
      await this.gasCheck(REKEY_GAS);
      step("building the key tree for this network");
      const b = await this.compute.run("evmBoot", { master: this.master.slice(), chainId: this.id, account: this.account }, progress);
      const old = await this.record();
      if (!old || old.epoch < 1) await this.put({ id: this.key, epoch: 1, next_leaf: 0, pub_seed: bytesToHex(b.pubSeed), root: bytesToHex(b.root), leaves: b64(b.leaves), active: true });
      step("moving the account to its own key tree");
      await this.sendTx(this.account, b.calldata);
      return this.status();
    });
  }

  async adopt(s) {
    const r = s.r;
    await this.put({ id: this.key, epoch: r.epoch + 1, next_leaf: 0, pub_seed: r.rekeying.pub_seed, root: r.rekeying.root, leaves: r.rekeying.leaves, active: true });
  }

  async sign(fn) {
    await this.checkNetwork();
    return this.lock(async () => {
      let s = await this.status();
      if (s.state === "adopt") { await this.adopt(s); s = await this.status(); }
      if (s.state !== "ready") throw new Error(s.state === "setup" ? "set up this network first" : "this copy of the wallet is not signing on this network. Choose Use on this device first");
      return fn(s);
    });
  }

  async gasCheck(gas) {
    const [f, have] = await Promise.all([this.fees(), this.rpc.balance(this.feeAddress)]);
    const need = gas * f.maxFeePerGas;
    if (have < need) throw new Error(`the gas key needs about ${formatUnits(need, 18)} ${this.chain.symbol} and holds ${formatUnits(have, 18)}. Send a little ${this.chain.symbol} on ${this.chain.name} to ${this.feeAddress}. Nothing was signed`);
  }

  async reserve(r, st, limit) {
    const leaf = Math.max(r.next_leaf, st.next);
    if (leaf >= limit) throw new Error(limit === E.EXEC_LIMIT ? "this key tree is used up for transactions; rekey first" : "no keys left on this tree");
    r.next_leaf = leaf + 1;
    await this.put(r);
    return leaf;
  }

  async execute(calls, onHash) {
    return this.sign(async ({ r, st }) => {
      await this.gasCheck(EXEC_GAS + 40000n * BigInt(calls.length));
      const f = await this.fees();
      const leaf = await this.reserve(r, st, E.EXEC_LIMIT);
      const rnd = crypto.getRandomValues(new Uint8Array(16));
      const deadline = f.now + DEADLINE_S;
      const cd = await this.compute.run("evmSignExec", { master: this.master.slice(), chainId: this.id, account: this.account, epoch: r.epoch, pubSeed: hexToBytes(r.pub_seed), root: hexToBytes(r.root), leaves: unb64(r.leaves), leaf, deadline, rnd, calls });
      return this.sendTx(this.account, cd, 0n, null, onHash);
    });
  }

  async rekey(progress, onHash) {
    return this.sign(async ({ r, st }) => {
      await this.gasCheck(REKEY_GAS);
      const leaf = await this.reserve(r, st, E.LEAVES);
      return this._rekey(r, leaf, hexToBytes(r.pub_seed), hexToBytes(r.root), unb64(r.leaves), progress, onHash);
    });
  }

  async takeover(progress, onHash) {
    await this.checkNetwork();
    return this.lock(async () => {
      const s = await this.status();
      if (s.state === "ready") return s;
      if (s.state === "setup") throw new Error("set up this network first");
      if (s.state === "adopt") { await this.adopt(s); return this.status(); }
      const st = s.st;
      await this.gasCheck(REKEY_GAS);
      const cur = await this.compute.run("evmTree", { master: this.master.slice(), chainId: this.id, epoch: st.epoch, pubSeed: hexToBytes(st.pubSeed) }, progress && ((p) => progress(p * 0.5)));
      if (bytesToHex(cur.root) !== st.root) throw new Error("these words do not control the key tree on chain, refusing to sign");
      const lo = Math.max(st.next, E.EXEC_LIMIT);
      if (lo >= E.LEAVES) throw new Error("no rekey keys left on the current tree");
      const leaf = lo + (crypto.getRandomValues(new Uint32Array(1))[0] % (E.LEAVES - lo));
      const r = { id: this.key, epoch: st.epoch, next_leaf: leaf + 1, pub_seed: st.pubSeed, root: st.root, leaves: b64(cur.leaves), active: false };
      const old = await this.record();
      if (old && old.epoch === st.epoch && old.next_leaf > r.next_leaf) r.next_leaf = old.next_leaf;
      if (old && old.epoch > st.epoch) throw new Error("this browser has a newer key tree than the chain, refusing to go back");
      await this.put(r);
      return this._rekey(r, leaf, hexToBytes(st.pubSeed), hexToBytes(st.root), cur.leaves, progress && ((p) => progress(0.5 + p * 0.5)), onHash);
    });
  }

  async _rekey(r, leaf, pubSeed, root, leaves, progress, onHash) {
    const f = await this.fees();
    const newPubSeed = crypto.getRandomValues(new Uint8Array(16));
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    const out = await this.compute.run("evmSignRekey", { master: this.master.slice(), chainId: this.id, account: this.account, epoch: r.epoch, pubSeed, root, leaves, leaf, deadline: f.now + DEADLINE_S, rnd, newPubSeed }, progress);
    r.rekeying = { pub_seed: bytesToHex(newPubSeed), root: bytesToHex(out.newRoot), leaves: b64(out.newLeaves) };
    await this.put(r);
    const res = await this.sendTx(this.account, out.calldata, 0n, null, onHash);
    const s = await this.status();
    if (s.state === "adopt") await this.adopt(s);
    return res;
  }

  async token(addr) {
    const a = checkAddress(addr);
    const code = await this.rpc.code(a);
    if (code === "0x") throw new Error("there is no contract at that token address on this network");
    const [dec, sym, bal] = await Promise.all([
      this.rpc.ethCall(a, SEL.decimals),
      this.rpc.ethCall(a, SEL.symbol).catch(() => "0x"),
      this.rpc.ethCall(a, SEL.balanceOf + "000000000000000000000000" + this.account.slice(2)),
    ]);
    const decimals = Number(word(dec));
    if (!(decimals >= 0 && decimals <= 36)) throw new Error("that contract does not look like an ERC-20 token");
    return { address: a, decimals, symbol: decodeSymbol(sym), balance: word(bal) };
  }
}

function decodeSymbol(h) {
  try {
    const b = hexToBytes(h);
    let s;
    if (b.length >= 96) { const n = Number(BigInt(bytesToHex(b.slice(32, 64)))); s = new TextDecoder().decode(b.slice(64, 64 + Math.min(n, 32))); }
    else if (b.length === 32) s = new TextDecoder().decode(b).replace(/\0+$/, "");
    else return "token";
    s = s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16);
    return s || "token";
  } catch { return "token"; }
}
