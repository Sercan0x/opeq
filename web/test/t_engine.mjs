import { Engine, Session, Inactive, EXEC_LIMIT, RESTORE_GAP } from "../lib/engine.js";
import { MemoryStore, withLock } from "../lib/vaultstore.js";
import { localCompute } from "../lib/compute.js";
import * as P from "../lib/protocol.js";
import * as M from "../lib/mnemonic.js";
import { pubkey, unhex, hex, concat, u32, u64, SYSTEM, u64 as U64 } from "../lib/solana.js";
import { SIG_LEN, PATH_LEN } from "../lib/wots.js";

const held = new Set();
globalThis.navigator = { locks: { async request(name, opts, fn) {
  if (held.has(name)) {
    if (opts.ifAvailable) return fn(null);
    while (held.has(name)) await new Promise((r) => setTimeout(r, 5));
  }
  held.add(name);
  try { return await fn({ name }); } finally { held.delete(name); }
} } };

const PROGRAM = process.env.OPEQ_TEST_PROGRAM || "424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN";
const prog = pubkey(PROGRAM);
let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) failures++; };
const throws = async (fn, re, name) => {
  try { await fn(); ok(false, `${name} (no error)`); }
  catch (e) { ok(re.test(e.message) || re.test(e.constructor.name), `${name}: ${e.message.slice(0, 90)}`); }
};

const chain = { slot: 5000, state: null, signed: [], mode: "land", feeBal: 10 ** 9, rent: 1503360, price: 0 };
function stateData() {
  const s = chain.state, d = new Uint8Array(88);
  d.set(new TextEncoder().encode("OPEQST01")); d.set(s.aid, 8); d.set(s.pubSeed, 40); d.set(s.root, 56);
  new DataView(d.buffer).setUint32(72, s.next, true); new DataView(d.buffer).setUint32(76, s.epoch, true);
  return d;
}
function apply(ix) {
  const d = ix[2], dv = new DataView(d.buffer, d.byteOffset);
  const tag = d[0], leaf = dv.getUint32(1, true), expiry = Number(dv.getBigUint64(5, true));
  const sig = hex(d.slice(P.SIG_OFF, P.SIG_OFF + SIG_LEN));
  chain.signed.push({ leaf, epoch: chain.state.epoch, tag, sig });
  if (expiry < chain.slot || expiry > chain.slot + 300) return "expiry";
  if (tag === P.IX_EXEC) {
    if (leaf < chain.state.next || leaf >= P.EXEC_LEAF_LIMIT) return "leaf";
    chain.state.next = leaf + 1;
    return null;
  }
  if (tag === P.IX_REKEY) {
    const off = P.SIG_OFF + SIG_LEN + PATH_LEN;
    chain.state.pubSeed = d.slice(off, off + 16);
    chain.state.root = d.slice(off + 16, off + 32);
    chain.state.epoch += 1;
    chain.state.next = 0;
    return null;
  }
  return "tag";
}

function mkRpc(e) {
  return {
    async account(k) { return chain.state && hex(k) === hex(P.statePda(chain.state.aid, prog).key) ? { owner: prog, lamports: 1, data: stateData() } : null; },
    async slot() { return chain.slot; },
    async blockhash() { return new Uint8Array(32); },
    async balance() { return chain.feeBal; },
    async rent() { return chain.rent; },
    async sendRaw() {
      const ix = e._cur;
      if (chain.mode === "neterr-landed") { apply(ix); throw new Error("network error talking to the RPC (sendTransaction)"); }
      if (chain.mode === "neterr") { const x = new Error("network error talking to the RPC (sendTransaction)"); throw x; }
      if (chain.mode === "neterr-once") { chain.mode = "land"; throw new Error("network error talking to the RPC (sendTransaction)"); }
      if (chain.mode === "drop") return "dropped";
      const err = apply(ix);
      if (err) { const x = new Error(`simulation failed: ${err}`); x.data = { logs: [] }; throw x; }
      return "sig" + chain.signed.length;
    },
    async status(sig) {
      if (sig === "dropped") { chain.slot += 400; return null; }
      return { confirmationStatus: "confirmed" };
    },
    async call() { return []; },
  };
}

function mkEngine(store) {
  const e = new Engine({ rpc: null, program: PROGRAM, store, compute: localCompute, payer: { key: () => new Uint8Array(32).fill(9), sign: async (tx) => tx } });
  e.rpc = mkRpc(e);
  const orig = Engine.prototype.submit;
  e.submit = function (ix, ...rest) { this._cur = ix; return orig.call(this, ix, ...rest); };
  e.priceFor = async () => chain.price;
  return e;
}

function dupLeaves() {
  const by = new Map();
  for (const s of chain.signed) {
    const k = `${s.epoch}:${s.leaf}`;
    if (!by.has(k)) by.set(k, new Set());
    by.get(k).add(s.sig);
  }
  return [...by].filter(([, v]) => v.size > 1).map(([k]) => k);
}

const pw = "correct horse battery";
const bob = new Uint8Array(32).fill(3);
const pay = (s, lam) => [[SYSTEM, [[s.wallet, true, true], [bob, false, true]], concat(u32(2), u64(lam))]];

const storeA = new MemoryStore();
const A = mkEngine(storeA);
const { record, words } = await A.create(pw);
await A.save(record);
chain.state = { aid: unhex(record.aid), pubSeed: unhex(record.pub_seed), root: unhex(record.root), next: 0, epoch: 0 };
const sA = await A.unlock(record, pw);

for (let i = 0; i < 3; i++) await sA.exec(pay(sA, 1000 + i));
ok(chain.state.next === 3, "created copy is active and signs");

const storeB = new MemoryStore();
const B = mkEngine(storeB);
const recB = await B.recover(words.join(" "), pw);
await B.save(recB);
const sB = await B.unlock(recB, pw);
await throws(() => sB.exec(pay(sB, 1)), /Inactive|not active/, "recovered copy refuses to sign before takeover");
ok(chain.signed.length === 3, "nothing signed by the inactive copy");

chain.mode = "drop";
await throws(() => sA.exec(pay(sA, 77)), /expired/, "dropped tx reports expiry");
chain.mode = "land";
await sB.takeover();
ok(chain.state.epoch === 1, "takeover rekey moved the chain to tree 1");
ok((await storeB.get(recB.id)).active === true, "taking-over copy is active");
await sB.exec(pay(sB, 5));
await throws(() => sA.exec(pay(sA, 6)), /Inactive|another device/, "old copy stops signing after takeover");
ok((await storeA.get(record.id)).active === false, "old copy marked inactive");
ok(dupLeaves().length === 0, "no leaf signed twice across two copies");

const sig0 = chain.signed.length;
chain.feeBal = 1000;
await throws(() => sB.exec(pay(sB, 9)), /cannot pay|nothing was signed/, "empty fee payer: refused before signing");
ok(chain.signed.length === sig0, "empty fee payer: no signature produced");
const rB = await storeB.get(recB.id);
chain.feeBal = 10 ** 9;
await sB.exec(pay(sB, 9));
ok((await storeB.get(recB.id)).next_leaf === rB.next_leaf + 1, "empty fee payer did not consume a leaf");

const big = [[SYSTEM, [[sB.wallet, true, true], [bob, false, true]], new Uint8Array(1100)]];
await throws(() => sB.exec(big), /over the 1232 byte limit/, "oversized tx refused before signing");

chain.price = -18446744069709552000;
await sB.exec(pay(sB, 10));
chain.price = 2 ** 40;
await sB.exec(pay(sB, 11));
chain.price = 0.5;
await sB.exec(pay(sB, 12));
chain.price = 0;
ok(true, "hostile priority fees are clamped (negative, huge, fractional)");
await throws(async () => U64(-1n), /out of u64/, "u64 rejects negative");
await throws(async () => U64(1n << 64n), /out of u64/, "u64 rejects 2^64");

chain.mode = "neterr-landed";
await throws(() => sB.exec(pay(sB, 13)), /may have gone through/, "network error but landed: user told it may have gone through");
chain.mode = "neterr-once";
const before = chain.state.next;
await throws(() => sB.exec(pay(sB, 14)), /network error/, "network error, not landed: burn runs");
ok(chain.state.next > before, "burn consumed the exposed leaf on chain");
ok(!(await storeB.get(recB.id)).inflight, "inflight cleared only after burn landed");

chain.mode = "neterr";
const sigCount = chain.signed.length;
const realBurn = Session.prototype.burnIfLive;
sB.burnIfLive = async () => {};
await throws(() => sB.exec(pay(sB, 15)), /network error/, "network error and burn impossible");
sB.burnIfLive = realBurn;
ok(!!(await storeB.get(recB.id)).inflight, "inflight kept while the exposed signature could still land");
chain.mode = "land";
await throws(() => sB.exec(pay(sB, 16)), /may still go through/, "next send blocked until the exposed tx expires");
chain.slot += 400;
await sB.exec(pay(sB, 17));
ok(chain.signed.length > sigCount, "after expiry the wallet signs again");

const r1 = await storeB.get(recB.id);
const stale = structuredClone(r1);
await sB.exec(pay(sB, 18));
await throws(() => storeB.put(stale), /backwards/, "store refuses to roll the key counter back");

let acked = null;
await withLock(`opeq:${sB.id}`, async () => { acked = await sB.ackInflight(null); }, { wait: true }).catch(() => {});
ok(acked && (acked.state === "busy" || acked.state === "none"), "ackInflight never writes while another context holds the lock");

const recB2 = await B.recover(words.join(" "), pw, null, await storeB.get(recB.id));
ok(recB2.next_leaf >= (await storeB.get(recB.id)).next_leaf, "re-recovery keeps the higher local key counter");

chain.state.next = EXEC_LIMIT;
const r2 = await storeB.get(recB.id);
r2.next_leaf = EXEC_LIMIT;
await sB.put(r2);
await throws(() => sB.exec(pay(sB, 19)), /rekey now/, `exec stops at ${EXEC_LIMIT} so a takeover always fits`);
await sB.rekey();
ok(chain.state.epoch === 2 && chain.state.next === 0, "rekey from the reserve works");

if (!M.isLegacy(prog)) {
  const marker = sB;
  chain.mode = "neterr";
  await throws(() => marker.rekey(), /network error/, "rekey whose broadcast fails leaves a rekeying marker");
  chain.mode = "land";
  ok(!!(await storeB.get(recB.id)).rekeying, "marker is still recorded");
  const storeC = new MemoryStore();
  const Cc = mkEngine(storeC);
  const recC = await Cc.recover(words.join(" "), pw);
  await Cc.save(recC);
  const sC = await Cc.unlock(recC, pw);
  await sC.takeover();
  ok((await storeC.get(recC.id)).active === true, "new device took over");
  await throws(() => marker.exec(pay(marker, 21)), /Inactive|another device/, "C1: stale marker does not adopt another device's takeover");
  ok((await storeB.get(recB.id)).active === false, "old copy stays inactive");
  await sC.exec(pay(sC, 22));
  const storeD = new MemoryStore();
  const Dd = mkEngine(storeD);
  const recD = await Dd.recover(words.join(" "), pw);
  await Dd.save(recD);
  const sD = await Dd.unlock(recD, pw);
  const both = await Promise.allSettled([sC.rekey(), sD.takeover()]);
  const actives = [(await storeC.get(recC.id)).active, (await storeD.get(recD.id)).active].filter(Boolean).length;
  ok(actives <= 1, `C3: after a rekey/takeover race at most one copy is active (${both.map((x) => x.status).join(",")})`);
  const winner = (await storeC.get(recC.id)).active ? sC : sD, loser = winner === sC ? sD : sC;
  await throws(() => loser.exec(pay(loser, 23)), /Inactive|another device|not active/, "C3: the losing copy refuses to sign");
  await winner.exec(pay(winner, 24));
  const r0 = await (winner === sC ? storeC : storeD).get(winner.id);
  const flip = structuredClone(await (loser === sC ? storeC : storeD).get(loser.id));
  if (flip.epoch === r0.epoch) {
    flip.active = true;
    await throws(() => (loser === sC ? storeC : storeD).put(flip), /re-activate/, "store refuses to re-activate a copy without a rekey");
  }
}

chain.rent = 50 * 10 ** 9;
const C = mkEngine(new MemoryStore());
const { record: rc } = await C.create(pw);
const saved = chain.state;
chain.state = null;
await throws(async () => (await C.initIx(rc))(), /implausible rent/, "lying rent is refused at activation");
chain.state = saved;

ok(dupLeaves().length === 0, `no leaf signed twice in the whole run (${chain.signed.length} signatures)`);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
