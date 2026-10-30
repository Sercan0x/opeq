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
export const TOPUP_LOW = 3n;
export const TAKEOVER_LO = 992;
const REKEY_EXTRA = 70000n;
const PENDING_REKEYS = 4;
export const TOPUP_TARGET = 10n;
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
  constructor({ chain, store, macKey, legacyMac, vaultId, master, compute, rpcUrl, checkUrl }) {
    this.legacyMac = legacyMac || null;
    this.chain = chain;
    this.id = chain.chainId;
    this.rpc = new EvmRpc(rpcUrl || chain.rpc);
    const ck = checkUrl === undefined ? chain.check : checkUrl;
    this.check = ck ? new EvmRpc(ck) : null;
    this.store = store;
    this.macKey = macKey;
    this.vaultId = vaultId;
    this.master = master;
    this.compute = compute;
    this.fee = S.feeKeyFromMaster(master);
    this.feeAddress = S.addressOf(this.fee);
    this.factory = E.factoryAddress();
    this.key = null;
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
    if (this.check && Number(await this.check.call("eth_chainId")) !== this.id) throw new Error(`the second network source is not on ${this.chain.name}`);
  }

  async run(op, args, progress) {
    if (!this.master || this.master.every((b) => b === 0)) throw new Error("the wallet locked, nothing was signed");
    const m = this.master.slice();
    try { return await this.compute.run(op, { ...args, master: m }, progress); }
    finally { m.fill(0); }
  }

  async agree(st, keys) {
    if (!this.check) return;
    let answered = false;
    for (let i = 0; i < 10; i++) {
      const w = await this.chainStateAt("latest", this.check).catch(() => null);
      if (w) answered = true;
      if (w && keys.every((k) => w[k] === st[k])) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(answered ? "two independent network sources disagree about your account, so nothing was signed. Try again in a minute" : "the second network source did not answer, so nothing was signed. Try again in a minute");
  }

  async clock() {
    const a = Number((await this.rpc.call("eth_getBlockByNumber", ["latest", false])).timestamp);
    if (!this.check) return a;
    const b = Number((await this.check.call("eth_getBlockByNumber", ["latest", false])).timestamp);
    if (Math.abs(a - b) > 120) throw new Error("the two network sources disagree about the time, so nothing was signed. Try again in a minute");
    return Math.min(a, b);
  }

  async seenBoth() {
    const a = await this.chainState();
    const b = this.check ? await this.chainStateAt("latest", this.check).catch(() => null) : a;
    return { a, b };
  }

  pendingText(p) {
    return `a transfer you signed earlier may still go through until ${new Date(p.deadline * 1000).toLocaleTimeString()}. Wait until it confirms or that time passes, or cancel it first. Nothing new was signed`;
  }

  async resolvePending(r) {
    const p = r.pending;
    if (!p) return;
    const { a, b } = await this.seenBoth();
    const gone = (x) => x && (x.epoch !== r.epoch || x.next > p.leaf);
    let done = gone(a) && gone(b);
    if (!done) done = (await this.clock()) > p.deadline;
    if (!done) { const e = new Error(this.pendingText(p)); e.pendingBlock = true; throw e; }
    delete r.pending;
    await this.put(r);
  }

  async gasFor(len, steps, calls = [], extra = 0n) {
    const filler = crypto.getRandomValues(new Uint8Array(len));
    const base = BigInt(await this.rpc.call("eth_estimateGas", [{ from: this.feeAddress, to: this.feeAddress, data: bytesToHex(filler) }]));
    return ((base + 30000n + BigInt(steps) * 80n + (await this.callsGas(calls)) + extra) * GAS_HEADROOM) / 10n;
  }

  async callsGas(calls) {
    let inner = 0n;
    for (const c of calls) {
      let g;
      try { g = BigInt(await this.rpc.call("eth_estimateGas", [{ from: this.account, to: c.to, value: "0x" + BigInt(c.value || 0).toString(16), data: bytesToHex(c.data || new Uint8Array(0)) }])); }
      catch (e) { throw new Error(`this transfer would fail on chain (${String(e.message).slice(0, 120)}). Nothing was signed`); }
      inner += (g > 21000n ? g - 21000n : 0n) + 12000n;
    }
    return inner;
  }

  bootPubSeed() {
    return bytesToHex(E.bootSeeds(this.master, this.id, this.account).pubSeed);
  }

  async loadIdentity(progress) {
    const key = `${this.vaultId}:evm:id:${this.factory}`;
    const pubSeed = E.identitySeeds(this.master, this.factory).pubSeed;
    let c = await this.store.get(key);
    if (c) {
      await this.verify(c);
      if (c.pub_seed !== bytesToHex(pubSeed)) throw new Error("the saved EVM identity does not match these words");
    } else {
      const t = await this.run("evmIdentity", {}, progress);
      c = await this.put({ id: key, pub_seed: bytesToHex(t.pubSeed), root: bytesToHex(t.root) });
    }
    this.identity = { pubSeed, root: hexToBytes(c.root) };
    this.account = E.accountAddress(this.identity.pubSeed, this.identity.root, this.factory);
    this.key = `${this.vaultId}:evm:${this.id}:${this.account}`;
    return this.account;
  }

  async verify(r) {
    try { await V.checkRecord(this.macKey, r); }
    catch (e) {
      if (!this.legacyMac) throw e;
      await V.checkRecord(this.legacyMac, r);
      await this.put(r);
    }
  }

  async record() {
    const r = await this.store.get(this.key);
    if (!r) return null;
    await this.verify(r);
    return r;
  }

  async put(r) {
    const old = await this.store.get(r.id);
    if (old && old.epoch === r.epoch && Array.isArray(old.used) && old.used.some((l) => !(r.used || []).includes(l))) throw new Error("refusing to forget a one-time key that was already used");
    await V.signRecord(this.macKey, r);
    await this.store.put(r);
    return r;
  }

  lock(fn) { return V.withLock(`opeq-evm:${this.key}`, fn); }

  async chainState() {
    return this.at((b) => this.chainStateAt(b));
  }

  async chainStateAt(block, rpc = this.rpc) {
    const code = await rpc.code(this.account, block);
    if (code === "0x") return { deployed: false, epoch: 0, next: 0, pubSeed: null, root: null };
    if (lower(code.slice(2)) !== lower(ACCOUNT_RUNTIME)) throw new Error("the code at your account address is not the OPEQ account contract, refusing to use it");
    const [ep, nx, ps, rt] = await Promise.all([SEL.epoch, SEL.next, SEL.pubSeed, SEL.root].map((s) => rpc.ethCall(this.account, s, block)));
    return { deployed: true, epoch: Number(word(ep)), next: Number(word(nx)), pubSeed: ps.slice(0, 34), root: rt.slice(0, 34) };
  }

  async tidy() {
    try { await this.lock(async () => { const r = await this.record(); if (r && r.pending) await this.resolvePending(r); }); } catch {}
  }

  async status() {
    const [[st, bal, feeBal], r] = await Promise.all([
      this.at((b) => Promise.all([this.chainStateAt(b), this.rpc.balance(this.account, b), this.rpc.balance(this.feeAddress, b)])),
      this.record(),
    ]);
    let state, next = null;
    const same = r && r.epoch === st.epoch && r.pub_seed === st.pubSeed && r.root === st.root;
    if (!st.deployed || st.epoch === 0) state = "setup";
    else if (same && r.active && st.pubSeed !== this.bootPubSeed()) state = "ready";
    else if (st.epoch === 1 && st.pubSeed === this.bootPubSeed()) state = "finish";
    else if (r && st.epoch === r.epoch + 1 && (next = (r.rekeys || []).find((k) => k.pub_seed === st.pubSeed && k.root === st.root))) state = "adopt";
    else state = "other";
    const left = state === "ready" ? Math.max(0, E.EXEC_LIMIT - Math.max(r.next_leaf, st.next)) : 0;
    return { state, st, r, bal, feeBal, left, next };
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
    this.feeCheck(f);
    const g = gas || (await this.estimate(to, data, value));
    const nonce = Math.max(Number(await this.rpc.call("eth_getTransactionCount", [this.feeAddress, "pending"])), this.nextNonce || 0);
    const need = g * f.maxFeePerGas + value;
    const have = await this.rpc.balance(this.feeAddress);
    if (have < need) throw new Error(`the gas key needs about ${formatUnits(need, 18)} ${this.chain.symbol} for this step and holds ${formatUnits(have, 18)}. Send a little ${this.chain.symbol} on ${this.chain.name} to ${this.feeAddress}`);
    const { raw, hash } = signTx1559({ chainId: this.id, nonce, maxPriorityFeePerGas: f.maxPriorityFeePerGas, maxFeePerGas: f.maxFeePerGas, gas: g, to, value, data }, this.fee);
    let got;
    try { got = await this.rpc.call("eth_sendRawTransaction", [raw]); }
    catch (e) { e.broadcast = true; e.hash = hash; if (!this.check) throw e; got = hash; }
    if (this.check) await this.check.call("eth_sendRawTransaction", [raw]).catch(() => null);
    if (lower(got) !== lower(hash)) { const e = new Error("the network returned a different transaction hash, refusing to trust it"); e.broadcast = true; e.hash = hash; throw e; }
    this.nextNonce = nonce + 1;
    if (onHash) onHash(hash);
    return this.wait(hash);
  }

  async wait(hash, ms = 120000) {
    const end = Date.now() + ms;
    let a = null, b = null;
    while (Date.now() < end) {
      a = a || (await this.rpc.call("eth_getTransactionReceipt", [hash]).catch(() => null));
      b = !this.check ? a : b || (await this.check.call("eth_getTransactionReceipt", [hash]).catch(() => null));
      if (a && b) {
        this.minBlock = Math.max(this.minBlock, Number(a.blockNumber));
        const okA = a.status === "0x1", okB = b.status === "0x1";
        if (okA && okB) return { hash, gasUsed: BigInt(a.gasUsed) };
        if (!okA && !okB) { const e = new Error(`the transaction failed on chain (${hash})`); e.hash = hash; e.reverted = true; e.broadcast = true; throw e; }
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    const e = new Error(`the transaction was sent but the two network sources have not both confirmed it. Check it on the explorer: ${hash}`);
    e.hash = hash;
    e.pending = true;
    e.broadcast = true;
    throw e;
  }

  async setup(progress, step = () => {}) {
    await this.checkNetwork();
    return this.lock(async () => {
      if ((await this.rpc.code(E.CREATE2_DEPLOYER)) === "0x") throw new Error("this network has no standard CREATE2 deployer, so OPEQ cannot be set up here");
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
      let boot = null;
      if (st.epoch === 0) {
        await this.agree(st, ["deployed", "epoch"]);
        await this.gasCheck(REKEY_GAS * 2n);
        step("building the key tree for this network");
        boot = await this.run("evmBoot", { chainId: this.id, account: this.account }, progress && ((p) => progress(p * 0.5)));
        step("moving the account off its identity key");
        const gas = await this.gasFor(boot.calldata.length, boot.cost, [], REKEY_EXTRA);
        try { await this.sendTx(this.account, boot.calldata, 0n, gas); }
        catch (e) { if (!e.reverted || (await this.chainState()).epoch === 0) throw e; }
        st = await this.chainState();
      }
      if (st.epoch === 1 && st.pubSeed === this.bootPubSeed()) {
        step("moving the account to a key tree only this device knows");
        await this._takeover(progress && ((p) => progress(0.5 + p * 0.5)), null, boot);
      }
      return this.status();
    });
  }

  async adopt(s) {
    await this.put({ id: this.key, epoch: s.r.epoch + 1, next_leaf: 0, pub_seed: s.next.pub_seed, root: s.next.root, leaves: s.next.leaves, active: true });
  }

  async sign(fn) {
    await this.checkNetwork();
    return this.lock(async () => {
      let s = await this.status();
      if (s.state === "adopt") { await this.agree(s.st, ["epoch", "pubSeed", "root"]); await this.adopt(s); s = await this.status(); }
      if (s.state !== "ready") throw new Error(s.state === "setup" ? "set up this network first" : "this copy of the wallet is not signing on this network. Choose Use on this device first");
      return fn(s);
    });
  }

  async topupPlan(spend) {
    const [f, [fee, main]] = await Promise.all([this.fees(), this.at((b) => Promise.all([this.rpc.balance(this.feeAddress, b), this.rpc.balance(this.account, b)]))]);
    this.feeCheck(f);
    const seen = this.check ? await this.check.balance(this.account).catch(() => 0n) : main;
    const bal = seen < main ? seen : main;
    const per = (EXEC_GAS * f.maxFeePerGas * 3n) / 2n;
    if (fee >= per * TOPUP_LOW) return 0n;
    const free = bal - spend;
    let amount = per * TOPUP_TARGET - fee;
    if (amount > free / 4n) amount = free / 4n;
    return amount >= per ? amount : 0n;
  }

  feeCheck(f) {
    if (this.cap && f.maxFeePerGas > this.cap) throw new Error("the network fee more than doubled since you confirmed. Nothing was signed; try again to see the new fee");
  }

  async gasCheck(gas) {
    const [f, have] = await Promise.all([this.fees(), this.rpc.balance(this.feeAddress)]);
    this.feeCheck(f);
    const need = (gas * f.maxFeePerGas * 3n) / 2n;
    if (have < need) throw new Error(`the gas key needs about ${formatUnits(need, 18)} ${this.chain.symbol} and holds ${formatUnits(have, 18)}. Send a little ${this.chain.symbol} on ${this.chain.name} to ${this.feeAddress}. Nothing was signed`);
  }

  async reserve(r, st, limit) {
    const leaf = Math.max(r.next_leaf, st.next);
    if (leaf >= limit) throw new Error(limit === E.EXEC_LIMIT ? "this key tree is used up for transactions; rekey first" : "no keys left on this tree");
    r.next_leaf = leaf + 1;
    await this.put(r);
    return leaf;
  }

  async cancelPending(onHash) {
    return this.execute([], onHash, true);
  }

  async execute(calls, onHash, cancel = false) {
    return this.sign(async ({ r, st }) => {
      if (cancel && !r.pending) return { hash: null, gasUsed: 0n, nothing: true };
      if (!cancel) await this.resolvePending(r);
      await this.gasCheck(EXEC_GAS + 40000n * BigInt(calls.length));
      const inner = await this.callsGas(calls);
      const deadline = (await this.clock()) + DEADLINE_S;
      const leaf = Math.max(r.next_leaf, st.next);
      r.pending = { leaf, deadline };
      await this.reserve(r, st, E.EXEC_LIMIT);
      const rnd = crypto.getRandomValues(new Uint8Array(16));
      const out = await this.run("evmSignExec", { chainId: this.id, account: this.account, epoch: r.epoch, pubSeed: hexToBytes(r.pub_seed), root: hexToBytes(r.root), leaves: unb64(r.leaves), leaf, deadline, rnd, calls });
      const clear = async () => { const cur = await this.record(); if (cur && cur.pending && cur.pending.leaf <= leaf) { delete cur.pending; await this.put(cur); } };
      let res;
      try {
        const gas = await this.gasFor(out.calldata.length, out.cost, [], inner);
        res = await this.sendTx(this.account, out.calldata, 0n, gas, onHash);
      } catch (e) {
        if (!e.broadcast) { await clear(); throw e; }
        const { a, b } = await this.seenBoth().catch(() => ({}));
        if (a && b && a.epoch === r.epoch && b.epoch === r.epoch && a.next > leaf && b.next > leaf) { await clear(); return { hash: e.hash, gasUsed: 0n, byOther: true }; }
        e.message = `${e.message}. ${this.pendingText({ deadline })[0].toUpperCase()}${this.pendingText({ deadline }).slice(1)}`;
        throw e;
      }
      await clear();
      return res;
    });
  }

  async rekey(progress, onHash) {
    return this.sign(async ({ r, st }) => {
      await this.gasCheck(REKEY_GAS);
      const leaf = await this.reserve(r, st, TAKEOVER_LO);
      return this._rekey(r, leaf, hexToBytes(r.pub_seed), hexToBytes(r.root), unb64(r.leaves), progress, onHash);
    });
  }

  async takeover(progress, onHash) {
    await this.checkNetwork();
    return this.lock(async () => {
      const s = await this.status();
      if (s.state === "ready") return s;
      if (s.state === "setup") throw new Error("set up this network first");
      if (s.state === "adopt") { await this.agree(s.st, ["epoch", "pubSeed", "root"]); await this.adopt(s); return this.status(); }
      await this._takeover(progress, onHash, null);
      return this.status();
    });
  }

  async _takeover(progress, onHash, boot) {
    const st = await this.chainState();
    if (st.next > E.EXEC_LIMIT) throw new Error("the network reports an impossible key counter for your account, so nothing was signed");
    await this.agree(st, ["deployed", "epoch", "pubSeed", "root", "next"]);
    await this.gasCheck(REKEY_GAS);
    const cur = boot && bytesToHex(boot.pubSeed) === st.pubSeed ? { root: boot.root, leaves: boot.leaves }
      : await this.run("evmTree", { chainId: this.id, account: this.account, epoch: st.epoch, pubSeed: hexToBytes(st.pubSeed) }, progress && ((p) => progress(p * 0.5)));
    if (bytesToHex(cur.root) !== st.root) throw new Error("these words do not control the key tree on chain, refusing to sign");
    const old = await this.record();
    if (old && old.epoch > st.epoch) throw new Error("this browser has a newer key tree than the chain, refusing to go back");
    const mine = old && old.epoch === st.epoch && old.pub_seed === st.pubSeed ? old : null;
    const used = new Set(mine ? mine.used || [] : []);
    const free = [];
    for (let i = Math.max(st.next, TAKEOVER_LO); i < E.LEAVES; i++) if (!used.has(i)) free.push(i);
    if (!free.length) throw new Error("this copy has used all its takeover keys on the current tree. Rekey from the device that signs now, or wait for a pending takeover to confirm");
    const leaf = free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length];
    const r = { id: this.key, epoch: st.epoch, next_leaf: mine ? mine.next_leaf : 0, pub_seed: st.pubSeed, root: st.root, leaves: b64(cur.leaves), active: false, used: [...used, leaf], rekeys: mine ? mine.rekeys || [] : [] };
    await this.put(r);
    return this._rekey(r, leaf, hexToBytes(st.pubSeed), hexToBytes(st.root), cur.leaves, progress && ((p) => progress(0.5 + p * 0.5)), onHash);
  }

  async _rekey(r, leaf, pubSeed, root, leaves, progress, onHash) {
    const f = await this.fees();
    const newPubSeed = crypto.getRandomValues(new Uint8Array(16));
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    const out = await this.run("evmSignRekey", { chainId: this.id, account: this.account, epoch: r.epoch, pubSeed, root, leaves, leaf, deadline: f.now + DEADLINE_S, rnd, newPubSeed }, progress);
    r.rekeys = [...(r.rekeys || []), { pub_seed: bytesToHex(newPubSeed), root: bytesToHex(out.newRoot), leaves: b64(out.newLeaves) }].slice(-PENDING_REKEYS);
    await this.put(r);
    const gas = await this.gasFor(out.calldata.length, out.cost, [], REKEY_EXTRA);
    const res = await this.sendTx(this.account, out.calldata, 0n, gas, onHash);
    const s = await this.status();
    if (s.state === "adopt") { await this.agree(s.st, ["epoch", "pubSeed", "root"]); await this.adopt(s); }
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
    if (this.check) {
      const again = await this.check.ethCall(a, SEL.decimals).catch(() => null);
      if (again === null || Number(word(again)) !== decimals) throw new Error("two independent network sources disagree about this token's decimals, so the amount could be wrong. Nothing was signed");
    }
    if (!(decimals >= 0 && decimals <= 36)) throw new Error("that contract does not look like an ERC-20 token");
    return { address: a, decimals, symbol: decodeSymbol(sym), balance: word(bal) };
  }

  async tokenBalance(a) {
    return word(await this.rpc.ethCall(a, SEL.balanceOf + "000000000000000000000000" + this.account.slice(2)));
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
