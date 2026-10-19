import * as M from "./mnemonic.js";
import * as P from "./protocol.js";
import * as V from "./vaultstore.js";
import { LEAVES, PATH_LEN, SIG_LEN } from "./wots.js";
import {
  COMPUTE_BUDGET, SYSTEM, b58encode, compileV0, concat, eq, hex, pubkey, u32, u64, unhex, unsignedTx,
} from "./solana.js";

export const EXPIRY_SLOTS = 150;
export const RESTORE_GAP = 64;
export const TAKEOVER_FLOOR = 768;
export const SIGN_LIMIT = TAKEOVER_FLOOR;
export const EXEC_LIMIT = TAKEOVER_FLOOR - RESTORE_GAP - 16;
export const TX_LIMIT = 1232;
export const BASE_FEE = 5000;
const RENT_MIN = 1000000, RENT_MAX = 2000000;
const CONFIRM_MS = 90000;

const b64 = (b) => btoa(String.fromCharCode(...b));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class Failed extends Error {}
export class Inactive extends Error {}

function describe(err) {
  const logs = (err.data && err.data.logs) || [];
  const m = /custom program error: (0x[0-9a-f]+)/.exec(err.message + logs.join("\n"));
  const deepest = logs.map((l) => /Program (\w+) failed: custom program error: (0x[0-9a-f]+)/.exec(l)).find(Boolean);
  let msg = err.message;
  if (deepest) msg += ` (${deepest[1].slice(0, 6)}… error ${parseInt(deepest[2], 16)})`;
  else if (m) msg += ` (error ${parseInt(m[1], 16)})`;
  return { msg, logs, code: deepest ? parseInt(deepest[2], 16) : null, program: deepest ? deepest[1] : null };
}

export class Engine {
  constructor({ rpc, program, store, compute, payer }) {
    this.rpc = rpc;
    this.program = typeof program === "string" ? pubkey(program) : program;
    this.store = store;
    this.compute = compute;
    this.payer = payer;
    this.priceFor = null;
    this.maxPriority = 100000;
    this.genesis = null;
    this._genesisOk = false;
    this.log = () => {};
  }

  async create(password, progress) {
    const master = M.newMaster();
    const t = await this.compute.run("treeFor", { master, epoch: 0, program: this.program }, progress);
    const aid = P.accountId(t.pubSeed, t.root);
    const record = await this._record(master, password, aid, 0, t, 0, true);
    return { record, words: M.toWords(master) };
  }

  async recover(words, password, progress, existing = null) {
    const master = M.fromWords(words);
    const t0 = await this.compute.run("treeFor", { master, epoch: 0, program: this.program }, progress && ((p) => progress(p * 0.5)));
    const aid = P.accountId(t0.pubSeed, t0.root);
    const acc = await this.rpc.account(P.statePda(aid, this.program).key);
    let epoch = 0, next = 0, t = t0;
    if (acc) {
      if (!eq(acc.owner, this.program)) throw new Error("state account is not owned by the opeq program");
      const st = P.unpackState(acc.data);
      epoch = st.epoch;
      next = existing && existing.aid && existing.epoch === epoch ? Math.max(existing.next_leaf, st.next) : st.next;
      if (epoch > 0) t = await this.compute.run("treeFor", { master, epoch, program: this.program, pubSeed: st.pubSeed }, progress && ((p) => progress(0.5 + p * 0.5)));
      if (!eq(t.root, st.root)) throw new Error("these words do not control this wallet's current tree");
    }
    if (existing && existing.epoch > epoch) throw new Error("this browser already holds a newer copy of this wallet");
    const keep = {};
    if (existing && existing.epoch === epoch) for (const k of ["takeover", "inflight", "rekeying"]) if (existing[k]) keep[k] = existing[k];
    return this._record(master, password, aid, epoch, t, next, !!(existing && existing.active === true && existing.epoch === epoch), keep);
  }

  async _record(master, password, aid, epoch, t, next, active = true, keep = {}) {
    const { blob, macKey } = await V.seal(master, password, aid);
    const wallet = P.walletPda(aid, this.program).key;
    const record = {
      id: b58encode(wallet), v: 1, program: b58encode(this.program), aid: hex(aid), epoch, next_leaf: next,
      pub_seed: hex(t.pubSeed), root: hex(t.root), leaves: b64(t.leaves), enc: blob, created: Date.now(), active, ...keep,
    };
    return V.signRecord(macKey, record);
  }

  async save(record) { await this.store.put(record); }

  async unlock(record, password) {
    const aid = unhex(record.aid);
    const { master, macKey, macRaw } = await V.unlock(record.enc, password, aid);
    await V.checkRecord(macKey, record);
    if (record.program !== b58encode(this.program)) throw new Error("this wallet belongs to a different opeq program");
    const seeds = M.treeSeeds(master, record.epoch, this.program, unhex(record.pub_seed));
    if (hex(seeds.pubSeed) !== record.pub_seed) throw new Error("wallet tree does not match its master seed");
    const session = new Session(this, record.id, master, macKey);
    session.macRaw = macRaw;
    return session;
  }

  initIx(record) {
    const aid = unhex(record.aid);
    return async () => {
      const lamports = await this.rpc.rent(P.STATE_LEN);
      if (!Number.isSafeInteger(lamports) || lamports < RENT_MIN || lamports > RENT_MAX) throw new Error("the RPC returned an implausible rent amount, refusing to activate");
      return [this.program, [[this.payer.key(), true, true], [P.statePda(aid, this.program).key, false, true],
        [pubkey(record.id), false, false], [SYSTEM, false, false]], P.buildInit(unhex(record.pub_seed), unhex(record.root), lamports)];
    };
  }

  async init(record) {
    await this.checkCluster();
    const ix = await this.initIx(record)();
    const slot = await this.rpc.slot();
    try {
      return await this.submit(ix, slot + EXPIRY_SLOTS, 60000, [], await this.price(60000, [this.payer.key()]));
    } catch (e) {
      const st = await this.chainState(record);
      if (st && hex(st.root) === record.root) return "already-initialized";
      throw e;
    }
  }

  async checkCluster() {
    if (!this.genesis || this._genesisOk) return;
    const g = await this.rpc.call("getGenesisHash", []);
    if (g !== this.genesis) throw new Error("the RPC is connected to a different Solana cluster than this wallet expects, refusing to sign");
    this._genesisOk = true;
  }

  async chainState(record) {
    const acc = await this.rpc.account(P.statePda(unhex(record.aid), this.program).key);
    if (!acc) return null;
    if (!eq(acc.owner, this.program)) throw new Error("state account is not owned by the opeq program");
    return P.unpackState(acc.data);
  }

  priceCap(cuLimit) {
    return Math.floor((this.maxPriority * 1e6) / cuLimit);
  }

  async price(cuLimit, keys) {
    if (!this.priceFor) return 0;
    let p = 0;
    try { p = await this.priceFor(cuLimit, keys); } catch { p = 0; }
    if (!Number.isSafeInteger(p) || p < 0) return 0;
    return Math.min(p, this.priceCap(cuLimit));
  }

  feeFor(cuLimit, price) {
    return BASE_FEE + Math.ceil((price * cuLimit) / 1e6);
  }

  async payerCovers(lamports) {
    const bal = await this.rpc.balance(this.payer.key());
    if (!Number.isSafeInteger(bal) || bal < lamports) {
      const f = new Failed(`the fee wallet cannot pay the network fee (it needs ${lamports} lamports, has ${bal}); nothing was signed`);
      f.feeEmpty = true;
      throw f;
    }
  }

  budget(cuLimit, price) {
    if (!Number.isSafeInteger(price) || price < 0 || price > this.priceCap(cuLimit)) throw new Error("priority fee out of range");
    const out = [[COMPUTE_BUDGET, [], concat(new Uint8Array([2]), u32(cuLimit))]];
    if (price) out.push([COMPUTE_BUDGET, [], concat(new Uint8Array([3]), u64(price))]);
    return out;
  }

  txSize(ix, cuLimit, tables = []) {
    const { message } = compileV0(this.payer.key(), [...this.budget(cuLimit, this.priceFor ? 1 : 0), ix], new Uint8Array(32), tables);
    return unsignedTx(message, 1).length;
  }

  async submit(ix, expiry, cuLimit, tables = [], price = 0) {
    await this.checkCluster();
    const { message, signers } = compileV0(this.payer.key(), [...this.budget(cuLimit, price), ix], await this.rpc.blockhash(), tables);
    if (signers.length !== 1) throw new Error("unexpected extra signer");
    const signed = await this.payer.sign(unsignedTx(message, 1));
    if (signed.length > TX_LIMIT) throw new Failed(`transaction too large: ${signed.length} bytes`);
    let sig;
    try {
      sig = await this.rpc.sendRaw(signed);
      if (sig !== b58encode(signed.slice(1, 65))) throw new Error("the RPC returned a signature that is not this transaction's");
    } catch (e) {
      const d = describe(e);
      const f = new Failed(d.msg);
      f.code = d.code; f.program = d.program; f.logs = d.logs; f.sent = true;
      throw f;
    }
    const started = Date.now();
    for (;;) {
      let st = null;
      try { st = await this.rpc.status(sig); } catch { st = null; }
      if (st && st.err) {
        const f = new Failed(`transaction failed: ${JSON.stringify(st.err).slice(0, 200)}`);
        f.sent = true;
        throw f;
      }
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
      let slot = 0;
      try { slot = await this.rpc.slot(); } catch { slot = 0; }
      if (slot > expiry + 2) {
        let again = null;
        try { again = await this.rpc.status(sig); } catch { again = null; }
        if (again && !again.err) return sig;
        const f = new Failed("transaction expired without landing");
        f.sent = true; f.expired = true;
        throw f;
      }
      if (Date.now() - started > CONFIRM_MS) {
        const f = new Failed("could not confirm the transaction in time");
        f.sent = true;
        throw f;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

export class Session {
  constructor(engine, id, master, macKey) {
    this.e = engine;
    this.id = id;
    this.master = master;
    this.macKey = macKey;
    this.wallet = pubkey(id);
  }

  async load() {
    const r = await this.e.store.get(this.id);
    if (!r) throw new Error("wallet not found in this browser");
    await V.checkRecord(this.macKey, r);
    if (r.program !== b58encode(this.e.program)) throw new Error("this wallet belongs to a different opeq program");
    return r;
  }

  async put(r) {
    await V.signRecord(this.macKey, r);
    await this.e.store.put(r);
    return r;
  }

  lock(fn, wait = false) {
    return V.withLock(`opeq:${this.id}`, fn, { wait });
  }

  ownRekey(r, st) {
    if (!r.rekeying || Number(r.rekeying.epoch) !== st.epoch) return false;
    if (!M.chainSeeded(this.e.program, st.epoch)) return false;
    return typeof r.rekeying.pub_seed === "string" && r.rekeying.pub_seed === hex(st.pubSeed);
  }

  async adopt(r, st) {
    if (st.epoch === r.epoch) return r;
    if (st.epoch < r.epoch) throw new Error("on-chain epoch is behind this wallet, refusing to sign");
    const own = this.ownRekey(r, st);
    if (!own) {
      if (r.active) { r.active = false; await this.put(r); }
      throw new Inactive("This wallet was rekeyed from another device or browser, so this copy stopped signing. To use it here, choose Use on this device.");
    }
    const t = await this.e.compute.run("treeFor", { master: this.master, epoch: st.epoch, program: this.e.program, pubSeed: st.pubSeed });
    if (!eq(t.root, st.root)) throw new Error("on-chain tree is not derived from this wallet's words");
    Object.assign(r, { epoch: st.epoch, next_leaf: 0, pub_seed: hex(t.pubSeed), root: hex(t.root), leaves: b64(t.leaves), active: true });
    delete r.rekeying;
    delete r.takeover;
    delete r.inflight;
    this.e.log(`wallet moved to tree ${st.epoch}`);
    return this.put(r);
  }

  async preflight(isBurn = false) {
    await this.e.checkCluster();
    let r = await this.load();
    const st = await this.e.chainState(r);
    if (!st) throw new Error("wallet is not initialized on chain yet");
    r = await this.adopt(r, st);
    if (!r.active) throw new Inactive("This copy of the wallet is not active here yet. Choose Use on this device first.");
    if (hex(st.root) !== r.root || hex(st.pubSeed) !== r.pub_seed) throw new Error("on-chain root differs from this wallet, refusing to sign");
    if (r.inflight && !isBurn) {
      const note = await this._ack(st);
      if (note.state !== "expired" && note.state !== "landed") throw new Error(note.message);
    }
    return { r: await this.load(), st };
  }

  async status() {
    const r = await this.load();
    const st = await this.e.chainState(r);
    if (!st) return { state: "uninitialized", r, st };
    if (st.epoch > r.epoch && !this.ownRekey(r, st)) return { state: "inactive", r, st };
    if (st.epoch === r.epoch && !r.active) return { state: "inactive", r, st };
    return { state: "active", r, st };
  }

  async ackInflight(st) {
    try {
      return await this.lock(() => this._ack(st));
    } catch (e) {
      if (/busy/.test(e.message)) return { state: "busy" };
      throw e;
    }
  }

  async _ack(st) {
    const r = await this.load();
    const f = r.inflight;
    if (!f) return { state: "none" };
    const leaf = Number(f.leaf), expiry = Number(f.expiry);
    if (st && st.epoch === r.epoch && st.next > leaf) {
      delete r.inflight;
      await this.put(r);
      return { state: "landed", message: `an interrupted transaction (key ${leaf}) can no longer execute, but it may have gone through; check the balance before sending again` };
    }
    const slot = await this.e.rpc.slot();
    if (slot <= expiry + 2) {
      return { state: "pending", message: `an interrupted transaction (key ${leaf}) may still go through until slot ${expiry}; wait about a minute, refresh and check the balance before sending again` };
    }
    delete r.inflight;
    await this.put(r);
    return { state: "expired", message: `an interrupted transaction (key ${leaf}) expired without landing` };
  }

  async reserve(r, st, limit) {
    const leaf = Math.max(r.next_leaf, st.next);
    if (leaf >= limit) {
      throw new Error(limit === EXEC_LIMIT ? "this key tree is used up for transactions; rekey now" : "no keys left for a rekey on this tree; choose Use on this device to move to a new tree");
    }
    r.next_leaf = leaf + 1;
    await this.put(r);
    return leaf;
  }

  exec(inner, cuLimit = 400000, progress, tables = []) {
    return this.lock(() => this._exec(inner, cuLimit, progress, true, tables));
  }

  async _exec(inner, cuLimit, progress, burnOnFail, tables = [], isBurn = false) {
    const { r, st } = await this.preflight(isBurn);
    const aid = unhex(r.aid);
    const state = P.statePda(aid, this.e.program).key;
    const { outer, metas } = P.outerLayout(state, this.wallet, inner);
    const size = await this.execSize(inner, tables);
    if (size > TX_LIMIT) throw new Failed(`this transaction would be ${size} bytes, over the ${TX_LIMIT} byte limit; nothing was signed`);
    const price = await this.e.price(cuLimit, metas.filter((m) => m[2]).map((m) => m[0]));
    await this.e.payerCovers(2 * this.e.feeFor(cuLimit, price));
    const leaf = await this.reserve(r, st, isBurn ? SIGN_LIMIT : EXEC_LIMIT);
    const expiry = (await this.e.rpc.slot()) + EXPIRY_SLOTS;
    const prev = r.inflight;
    r.inflight = prev ? { leaf: Math.min(Number(prev.leaf), leaf), expiry: Math.max(Number(prev.expiry), expiry) } : { leaf, expiry };
    await this.put(r);
    let sig;
    try {
      const rnd = crypto.getRandomValues(new Uint8Array(P.R_LEN));
      const s = await this.e.compute.run("signExec", {
        master: this.master, epoch: r.epoch, leaves: unb64(r.leaves), pubSeed: unhex(r.pub_seed), leaf, program: this.e.program, aid, expiry, inner, r: rnd,
      }, progress);
      const data = P.buildExec(leaf, expiry, s.salt, rnd, s.sig, s.path, inner, outer);
      this.e.log(`leaf ${leaf}, ${s.cost} on-chain hash steps`);
      sig = await this.e.submit([this.e.program, metas, data], expiry, cuLimit, tables, price);
    } catch (err) {
      if (!err.sent) {
        const back = await this.load();
        if (prev) back.inflight = prev; else delete back.inflight;
        await this.put(back);
        throw err;
      }
      let after = null;
      try { after = await this.e.chainState(await this.load()); } catch { after = null; }
      if (after && after.epoch === r.epoch && after.next > leaf) {
        await this._clearIf(leaf);
        const f = new Failed(`${err.message}. The wallet's key counter moved past this transaction, so it may have gone through; check the balance before sending again`);
        f.maybeLanded = true;
        throw f;
      }
      if (err.expired) {
        await this._clearIf(leaf);
        throw new Failed("the transaction expired without landing; it can no longer execute");
      }
      if (burnOnFail) await this.burnIfLive(leaf);
      throw err;
    }
    await this._clearIf(leaf);
    return sig;
  }

  async _clearIf(leaf) {
    const r = await this.load();
    if (!r.inflight) return;
    const st = await this.e.chainState(r).catch(() => null);
    if (Number(r.inflight.leaf) === leaf || (st && st.epoch === r.epoch && st.next > Number(r.inflight.leaf))) {
      delete r.inflight;
      await this.put(r);
    }
  }

  async burnIfLive(leaf) {
    const st = await this.e.chainState(await this.load());
    if (st.next > leaf) return;
    this.e.log(`burning key ${leaf} so the failed signature can never execute`);
    try {
      await this._exec([], 200000, null, false, [], true);
      this.e.log(`key ${leaf} burned`);
    } catch (e) {
      this.e.log(`could not burn key ${leaf} (${e.message}). Do not send again until the wallet shows this transaction as settled.`);
    }
  }

  async execSize(inner, tables = []) {
    const state = P.statePda(unhex((await this.load()).aid), this.e.program).key;
    const { outer, metas } = P.outerLayout(state, this.wallet, inner);
    const data = P.buildExec(0, 0, 0, new Uint8Array(P.R_LEN), new Uint8Array(SIG_LEN), new Uint8Array(PATH_LEN), inner, outer);
    return this.e.txSize([this.e.program, metas, data], 400000, tables);
  }

  sendSol(to, lamports, progress) {
    const inner = [[SYSTEM, [[this.wallet, true, true], [to, false, true]], concat(u32(2), u64(lamports))]];
    return this.exec(inner, 400000, progress);
  }

  rekey(progress) {
    return this.lock(async () => {
      const { r, st } = await this.preflight();
      await this.pendingRekey(r, st);
      return this._rekey(r, st, await this.reserve(r, st, SIGN_LIMIT), progress);
    });
  }

  takeover(progress) {
    return this.lock(async () => {
      await this.e.checkCluster();
      let r = await this.load();
      const st = await this.e.chainState(r);
      if (!st) throw new Error("wallet is not initialized on chain yet");
      if (st.epoch < r.epoch) throw new Error("on-chain epoch is behind this wallet, refusing to sign");
      if (st.next + RESTORE_GAP >= LEAVES) throw new Error("the current key tree is too far used to take over safely; take over from the device that is active, or wait for it to rekey");
      if (st.epoch !== r.epoch) {
        const t = await this.e.compute.run("treeFor", { master: this.master, epoch: st.epoch, program: this.e.program, pubSeed: st.pubSeed }, progress && ((p) => progress(p * 0.4)));
        if (!eq(t.root, st.root)) throw new Error("on-chain tree is not derived from this wallet's words");
        Object.assign(r, { epoch: st.epoch, next_leaf: st.next, pub_seed: hex(t.pubSeed), root: hex(t.root), leaves: b64(t.leaves), active: false });
        delete r.inflight;
        delete r.rekeying;
        r = await this.put(r);
      }
      await this.pendingRekey(r, st);
      const used = r.takeover && r.takeover.epoch === st.epoch ? r.takeover.used : [];
      const lo = Math.max(TAKEOVER_FLOOR, st.next + RESTORE_GAP, r.next_leaf > TAKEOVER_FLOOR ? r.next_leaf : 0);
      const free = [];
      for (let l = lo; l < LEAVES; l++) if (!used.includes(l)) free.push(l);
      if (!free.length) throw new Error("no unused takeover keys left on this tree; take over from the device that is active, or wait for it to rekey");
      const leaf = free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length];
      r.takeover = { epoch: st.epoch, used: [...used, leaf] };
      await this.put(r);
      return this._rekey(r, st, leaf, progress && ((p) => progress(0.4 + p * 0.6)));
    });
  }

  async pendingRekey(r, st) {
    const m = r.rekeying;
    if (m && Number(m.epoch) === st.epoch + 1 && (await this.e.rpc.slot()) <= Number(m.expiry) + 2)
      throw new Error("an earlier rekey from this copy may still land; wait about a minute, then try again");
  }

  async _rekey(r, st, leaf, progress) {
    const expiry = (await this.e.rpc.slot()) + EXPIRY_SLOTS;
    const state = P.statePda(unhex(r.aid), this.e.program).key;
    const metas = [[state, false, true], [this.wallet, false, false]];
    const price = await this.e.price(400000, [state]);
    await this.e.payerCovers(this.e.feeFor(400000, price));
    const newPubSeed = M.chainSeeded(this.e.program, st.epoch + 1) ? crypto.getRandomValues(new Uint8Array(16)) : undefined;
    r.rekeying = { epoch: st.epoch + 1, leaf, expiry };
    if (newPubSeed) r.rekeying.pub_seed = hex(newPubSeed);
    await this.put(r);
    const rnd = crypto.getRandomValues(new Uint8Array(P.R_LEN));
    const aid = unhex(r.aid);
    const s = await this.e.compute.run("signRekey", {
      master: this.master, epoch: r.epoch, leaves: unb64(r.leaves), pubSeed: unhex(r.pub_seed), newPubSeed, leaf, program: this.e.program, aid, expiry, r: rnd,
    }, progress);
    const data = P.buildRekey(leaf, expiry, s.salt, rnd, s.sig, s.path, s.newPubSeed, s.newRoot);
    let sig;
    try {
      sig = await this.e.submit([this.e.program, metas, data], expiry, 400000, [], price);
    } catch (err) {
      if (!M.chainSeeded(this.e.program, st.epoch + 1)) throw err;
      const after = await this.e.chainState(await this.load()).catch(() => null);
      if (!(after && after.epoch === st.epoch + 1 && eq(after.root, s.newRoot))) throw err;
      sig = "landed";
    }
    const fresh = await this.load();
    Object.assign(fresh, { epoch: r.epoch + 1, next_leaf: 0, pub_seed: hex(s.newPubSeed), root: hex(s.newRoot), leaves: b64(s.newLeaves), active: true });
    delete fresh.rekeying;
    delete fresh.inflight;
    delete fresh.takeover;
    await this.put(fresh);
    return sig;
  }

  words() { return M.toWords(this.master); }
}
