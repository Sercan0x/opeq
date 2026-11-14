import { Rpc, b58decode, b58encode, SYSTEM, concat, u32, u64, eq } from "./web/lib/solana.js";
import * as S from "./web/lib/squads.js";

const RPC = process.env.OPEQ_DEVNET_RPC || "https://api.devnet.solana.com";
const MS = process.argv[2] || "7D2f43k2RTtn2qyq6YPb7APXRdd3QsUVZARNeKvjUXVN";
const rpc = new Rpc(RPC);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const u8 = (v) => new Uint8Array([v]);
const u16 = (v) => new Uint8Array([v & 255, v >> 8]);
let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

const ms = b58decode(MS);
const acc = async (k) => (await rpc.account(k)).data;
const real = {
  multisig: [await acc(ms), (d) => S.unpackMultisig(d)],
  proposal1: [await acc(S.proposalPda(ms, 1n)), (d) => S.unpackProposal(d)],
  proposal2: [await acc(S.proposalPda(ms, 2n)), (d) => S.unpackProposal(d)],
  vaultTx: [await acc(S.transactionPda(ms, 1n)), (d) => S.unpackTransaction(d, ms)],
  configTx: [await acc(S.transactionPda(ms, 2n)), (d) => S.unpackTransaction(d, ms)],
};
ok(Object.values(real).every(([d, f]) => { try { f(d); return true; } catch { return false; } }), "the real devnet accounts decode");

for (const [name, [data, f]] of Object.entries(real)) {
  let bad = 0, crashed = 0, slow = 0;
  for (let cut = 0; cut < data.length; cut++) {
    try { const r = f(data.slice(0, cut)); if (name.endsWith("Tx") && r.kind === "unknown") continue; if (cut < 8) bad++; } catch (e) { if (!(e instanceof Error)) crashed++; }
  }
  for (let i = 0; i < 4000; i++) {
    const d = data.slice();
    for (let k = 0, n = 1 + rnd(6); k < n; k++) d[8 + rnd(d.length - 8)] = rnd(256);
    const t0 = performance.now();
    try { f(d); } catch (e) { if (!(e instanceof Error) || !/Squads|malformed|unknown/.test(e.message)) crashed++; }
    if (performance.now() - t0 > 50) slow++;
  }
  ok(bad === 0 && crashed === 0 && slow === 0, `fuzz ${name}: every truncation and 4000 random corruptions either decode or fail with a clean error, none hang`);
}

const cross = [["multisig", (d) => S.unpackMultisig(d)], ["proposal", (d) => S.unpackProposal(d)]];
let confused = 0;
for (const [n, f] of cross) for (const [m, [d]] of Object.entries(real)) { if ((n === "multisig" && m === "multisig") || (n === "proposal" && m.startsWith("proposal"))) continue; try { f(d); confused++; } catch {} }
ok(confused === 0, "an account of one kind is never read as another kind (discriminator check)");
ok((() => { try { S.unpackTransaction(real.vaultTx[0], new Uint8Array(32).fill(7)); return false; } catch { return true; } })(), "a transaction from another multisig is refused");

const vault = S.vaultPda(ms, 0);
const dest = new Uint8Array(32).fill(9), table = new Uint8Array(32).fill(5);
const vtx = (keys, ixs, lookups) => concat(new Uint8Array(S.DISC.vaultTx), ms, new Uint8Array(32).fill(1), u64(9n), u8(255), u8(0), u8(255), u32(0),
  u8(1), u8(1), u8(keys.length - 2), u32(keys.length), ...keys,
  u32(ixs.length), ...ixs.map(([p, a, d]) => concat(u8(p), u32(a.length), Uint8Array.from(a), u32(d.length), d)),
  u32(lookups.length), ...lookups.map(([t, w, r]) => concat(t, u32(w.length), Uint8Array.from(w), u32(r.length), Uint8Array.from(r))));
const pay = concat(u32(2), u64(1_000_000_000n));
const hidden = S.unpackTransaction(vtx([vault, SYSTEM], [[1, [0, 2], pay]], [[table, [0], []]]), ms);
const dh = S.describeIx(hidden.message.ixs[0], vault);
ok(hidden.message.lookups.length === 1 && dh.kind === "call" && dh.metas[1].known === false, "a SOL payment whose receiver hides in a lookup table is NOT shown as a plain payment");
const plain = S.unpackTransaction(vtx([vault, dest, SYSTEM], [[2, [0, 1], pay]], []), ms);
const dp = S.describeIx(plain.message.ixs[0], vault);
ok(dp.kind === "pay" && dp.fromVault && eq(dp.to, dest) && dp.lamports === 1_000_000_000n, "a plain payment is shown with the right receiver and amount");
const three = S.unpackTransaction(vtx([vault, dest, SYSTEM], [[2, [0, 1, 1], pay]], []), ms);
ok(S.describeIx(three.message.ixs[0], vault).kind === "call", "a system call with extra accounts is not shown as a plain payment");
const other = S.unpackTransaction(vtx([vault, dest, SYSTEM], [[2, [1, 0], pay]], []), ms);
const dO = S.describeIx(other.message.ixs[0], vault);
ok(dO.kind === "pay" && !dO.fromVault, "a payment that does not come from the vault is marked as such (the UI flags it)");
const assign = S.unpackTransaction(vtx([vault, dest, SYSTEM], [[2, [0], concat(u32(1), dest)]], []), ms);
ok(S.describeIx(assign.message.ixs[0], vault).kind === "call", "a system 'assign' (hand the vault to another program) is not shown as a payment");
let refused = 0;
for (const badIx of [[9, [0], pay], [2, [0, 7], pay]]) { try { S.unpackTransaction(vtx([vault, dest, SYSTEM], [badIx], []), ms); } catch { refused++; } }
ok(refused === 2, "instructions pointing at accounts that do not exist are refused");
let flagsBad = 0;
try { S.unpackTransaction(concat(new Uint8Array(S.DISC.vaultTx), ms, new Uint8Array(32), u64(1n), u8(1), u8(0), u8(1), u32(0), u8(2), u8(3), u8(0), u32(2), vault, dest, u32(0), u32(0)), ms); } catch { flagsBad++; }
ok(flagsBad === 1, "a message with impossible signer counts is refused");

const me = new Uint8Array(32).fill(3), a = new Uint8Array(32).fill(4), b = new Uint8Array(32).fill(6);
const info = (members, threshold, auth = SYSTEM) => ({ members, threshold, configAuthority: auth });
ok(S.lockState(info([{ key: me, perms: 2 }, { key: a, perms: 7 }, { key: b, perms: 7 }], 3), me).locked, "lock: 3 of 3 with OPEQ voting is locked");
ok(!S.lockState(info([{ key: me, perms: 2 }, { key: a, perms: 7 }, { key: b, perms: 7 }], 2), me).locked, "lock: 2 of 3 is NOT locked, the other two can approve alone");
ok(S.lockState(info([{ key: me, perms: 2 }, { key: a, perms: 7 }, { key: b, perms: 5 }], 2), me).locked, "lock: a member without the Vote permission does not count toward bypassing");
ok(!S.lockState(info([{ key: me, perms: 5 }, { key: a, perms: 7 }], 2), me).locked, "lock: OPEQ without the Vote permission is NOT a lock");
ok(!S.lockState(info([{ key: me, perms: 2 }, { key: a, perms: 7 }], 2, a), me).locked, "lock: a config authority breaks the lock");
ok(!S.lockState(info([{ key: a, perms: 7 }, { key: b, perms: 7 }], 2), me).locked, "lock: a multisig without the OPEQ address is not locked");

const ix = S.voteIx("approve", ms, me, S.proposalPda(ms, 1n));
ok(eq(ix[0], S.PROGRAM) && ix[1][1][1] === true && eq(ix[1][1][0], me) && ix[1][0][2] === false, "the vote instruction is signed by the OPEQ address only, the multisig is read-only");
let unknownVote = false;
try { S.voteIx("execute", ms, me, ms); } catch { unknownVote = true; }
ok(unknownVote, "only approve and reject can be built, never execute or cancel");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
