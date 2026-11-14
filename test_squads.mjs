import { readFileSync } from "node:fs";
import { Vault, MemoryStore, b58encode, b58decode } from "./sdk/index.js";
import { Rpc, SYSTEM, compileV0, concat, u32, u64, compact, eq } from "./web/lib/solana.js";
import { sha256 } from "./web/lib/sha256.js";
import * as S from "./web/lib/squads.js";

const RPC = process.env.OPEQ_DEVNET_RPC || "https://api.devnet.solana.com";
const rpc = new Rpc(RPC);
const enc = new TextEncoder();
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const disc = (n) => sha256(enc.encode("global:" + n)).slice(0, 8);
const u8 = (v) => new Uint8Array([v]);
const u16 = (v) => new Uint8Array([v & 255, v >> 8]);

async function edKey(secret32) {
  const pkcs8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...secret32]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const pub = Uint8Array.from(Buffer.from(jwk.x, "base64url"));
  return { pub, sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, m)) };
}

async function send(ixs, signers, simulateOnly = false) {
  const budget = [b58decode("ComputeBudget111111111111111111111111111111"), [], concat(u8(2), u32(400000))];
  const { message, signers: need } = compileV0(signers[0].pub, [budget, ...ixs], await rpc.blockhash());
  const sigs = [];
  for (const k of need) {
    const kk = typeof k === "string" ? k : b58encode(k);
    const s = signers.find((x) => b58encode(x.pub) === kk);
    if (!s) throw new Error("missing signer " + kk);
    sigs.push(await s.sign(message));
  }
  const b64 = Buffer.from(concat(new Uint8Array(compact(need.length)), ...sigs, message)).toString("base64");
  if (simulateOnly) return (await rpc.call("simulateTransaction", [b64, { encoding: "base64", sigVerify: true, commitment: "confirmed" }])).value;
  const sig = await rpc.call("sendTransaction", [b64, { encoding: "base64", preflightCommitment: "confirmed" }]);
  for (let i = 0; i < 60; i++) {
    const st = (await rpc.call("getSignatureStatuses", [[sig]])).value[0];
    if (st && st.err) throw new Error("tx failed " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("not confirmed " + sig);
}

const sdkIx = ([p, metas, data]) => ({ programId: b58encode(p), keys: metas.map(([k, s, w]) => ({ pubkey: b58encode(k), isSigner: s, isWritable: w })), data });
const transfer = (from, to, lamports) => [SYSTEM, [[from, true, true], [to, false, true]], concat(u32(2), u64(lamports))];
const read = async (k) => (await rpc.account(k)).data;

const funderRaw = JSON.parse(readFileSync(new URL("./devnet-key.json", import.meta.url), "utf8"));
const E = await edKey(Uint8Array.from(funderRaw.slice(0, 32)));
console.log("     funder balance", (await rpc.balance(E.pub)) / 1e9, "SOL");
const createKey = await edKey(crypto.getRandomValues(new Uint8Array(32)));

const vault = new Vault({ rpcUrl: RPC, network: "devnet", store: new MemoryStore() });
const { id } = await vault.create("squads lock test");
const acct = await vault.open(id, "squads lock test");
const W = b58decode(acct.address);
console.log("     opeq account", acct.address);
await send([transfer(E.pub, b58decode(await acct.feeKey()), 40_000_000)], [E]);
await acct.activate();
ok((await acct.status()).state === "active", "OPEQ account active on devnet");

const ms = S.multisigPda(createKey.pub);
const config = (await import("./web/lib/solana.js")).findPda([enc.encode("multisig"), enc.encode("program_config")], S.PROGRAM).key;
const treasury = (await rpc.account(config)).data.slice(8 + 32 + 8, 8 + 32 + 8 + 32);
const members = [[E.pub, 7], [W, 2]].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
const createArgs = concat(u8(0), u16(2), u32(members.length), ...members.map(([k, m]) => concat(k, u8(m))), u32(0), u8(0), u8(0));
await send([[S.PROGRAM, [[config, false, false], [treasury, false, true], [ms, false, true], [createKey.pub, true, false], [E.pub, true, true], [SYSTEM, false, false]], concat(disc("multisig_create_v2"), createArgs)]], [E, createKey]);
console.log("     squads multisig", b58encode(ms));

const info = S.unpackMultisig(await read(ms));
ok(info.threshold === 2 && info.members.length === 2 && info.transactionIndex === 0n, "multisig account decodes: threshold 2, two members, no transactions");
ok(info.members.some((m) => eq(m.key, W) && m.perms === S.PERM_VOTE), "the OPEQ account is decoded as a vote-only member");
const st = S.lockState(info, W);
ok(st.locked && st.others === 1, "lock check: locked, the other member alone cannot reach the threshold");
const weak = S.lockState({ ...info, threshold: 1 }, W);
ok(!weak.locked && /Raise the threshold to 2/.test(weak.issues.join(" ")), "lock check flags a threshold the others can reach alone");
ok(!S.lockState({ ...info, configAuthority: E.pub }, W).locked, "lock check flags a config authority");

const sqVault = S.vaultPda(ms, 0);
await send([transfer(E.pub, sqVault, 20_000_000)], [E]);
const dest = crypto.getRandomValues(new Uint8Array(32));
const tx1 = S.transactionPda(ms, 1n), p1 = S.proposalPda(ms, 1n);
const ixData = concat(u32(2), u64(5_000_000));
const msg = concat(u8(1), u8(1), u8(1), u8(3), sqVault, dest, SYSTEM, u8(1), u8(2), u8(2), u8(0), u8(1), u16(ixData.length), ixData, u8(0));
await send([[S.PROGRAM, [[ms, false, true], [tx1, false, true], [E.pub, true, false], [E.pub, true, true], [SYSTEM, false, false]], concat(disc("vault_transaction_create"), concat(u8(0), u8(0), u32(msg.length), msg, u8(0)))]], [E]);
await send([[S.PROGRAM, [[ms, false, false], [p1, false, true], [E.pub, true, false], [E.pub, true, true], [SYSTEM, false, false]], concat(disc("proposal_create"), u64(1n), u8(0))]], [E]);

const t1 = S.unpackTransaction(await read(tx1), ms);
ok(t1.kind === "vault" && t1.vaultIndex === 0 && t1.message.ixs.length === 1 && t1.message.lookups.length === 0, "vault transaction decodes: one instruction, vault 0, no lookup tables");
const d1 = S.describeIx(t1.message.ixs[0], sqVault);
ok(d1.kind === "pay" && d1.fromVault && eq(d1.to, dest) && d1.lamports === 5_000_000n, "payment is described in plain words: 0.005 SOL from the Squads vault to the receiver");
let pr = S.unpackProposal(await read(p1));
ok(pr.status === "active" && pr.index === 1n && pr.approved.length === 0, "proposal decodes as active with no approvals");

await send([S.voteIx("approve", ms, E.pub, p1)], [E]);
const execIx = [S.PROGRAM, [[ms, false, false], [p1, false, true], [tx1, false, false], [E.pub, true, false], [sqVault, false, true], [dest, false, true], [SYSTEM, false, false]], disc("vault_transaction_execute")];
ok((await send([execIx], [E], true)).err !== null, "with only the normal member's vote, execute is rejected");

const sigA = await acct.execute([sdkIx(S.voteIx("approve", ms, W, p1))]);
console.log("     opeq approve tx", sigA);
pr = S.unpackProposal(await read(p1));
ok(pr.status === "approved" && pr.approved.some((k) => eq(k, W)), "OPEQ approval built by the wallet library is recorded, proposal approved");
await send([execIx], [E]);
ok((await rpc.balance(dest)) === 5_000_000, "execute moved 0.005 SOL out of the Squads vault");
pr = S.unpackProposal(await read(p1));
ok(pr.status === "executed", "proposal now decodes as executed");

const tx2 = S.transactionPda(ms, 2n), p2 = S.proposalPda(ms, 2n);
const actions = concat(u32(2), u8(1), W, u8(2), u16(1));
await send([[S.PROGRAM, [[ms, false, true], [tx2, false, true], [E.pub, true, false], [E.pub, true, true], [SYSTEM, false, false]], concat(disc("config_transaction_create"), actions, u8(0))]], [E]);
await send([[S.PROGRAM, [[ms, false, false], [p2, false, true], [E.pub, true, false], [E.pub, true, true], [SYSTEM, false, false]], concat(disc("proposal_create"), u64(2n), u8(0))]], [E]);
const t2 = S.unpackTransaction(await read(tx2), ms);
ok(t2.kind === "config" && t2.actions.length === 2 && t2.actions[0].kind === "remove" && eq(t2.actions[0].key, W) && t2.actions[1].kind === "threshold" && t2.actions[1].threshold === 1, "settings change decodes: remove the OPEQ member, threshold to 1");
await send([S.voteIx("approve", ms, E.pub, p2)], [E]);
const sigR = await acct.execute([sdkIx(S.voteIx("reject", ms, W, p2))]);
console.log("     opeq reject tx", sigR);
pr = S.unpackProposal(await read(p2));
ok(pr.status === "rejected" && pr.rejected.some((k) => eq(k, W)), "OPEQ rejects the attempt to remove the lock, proposal rejected");
const info2 = S.unpackMultisig(await read(ms));
ok(info2.transactionIndex === 2n && S.lockState(info2, W).locked, "multisig still locked after the rejected change");
acct.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
