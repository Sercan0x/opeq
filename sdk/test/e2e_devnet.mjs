import { readFileSync } from "node:fs";
import { Vault, MemoryStore, NETWORKS, verifySolanaInstruction, b58encode, b58decode, hex } from "../index.js";
import { Engine } from "../src/lib/engine.js";
import { localCompute } from "../src/lib/compute.js";
import { Rpc, SYSTEM, compact, concat, u32, u64 } from "../src/lib/solana.js";

const RPC = process.env.OPEQ_DEVNET_RPC || "https://api.devnet.solana.com";
const funderFile = process.argv[2];
if (!funderFile) { console.log("usage: node test/e2e_devnet.mjs <funded devnet keypair json>"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };

async function signer(file) {
  const k = JSON.parse(readFileSync(file, "utf8"));
  const pkcs8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...k.slice(0, 32)]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  pkcs8.fill(0);
  const pub = Uint8Array.from(k.slice(32));
  return {
    key: () => pub,
    async sign(tx) {
      const message = tx.slice(1 + 64);
      return concat(new Uint8Array(compact(1)), new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message)), message);
    },
  };
}

const rpc = new Rpc(RPC);
const funder = new Engine({ rpc, program: NETWORKS.devnet.program, store: new MemoryStore(), compute: localCompute, payer: await signer(funderFile) });
funder.genesis = NETWORKS.devnet.genesis;

async function fund(to, lamports) {
  const ix = [SYSTEM, [[funder.payer.key(), true, true], [b58decode(to), false, true]], concat(u32(2), u64(lamports))];
  return funder.submit(ix, (await rpc.slot()) + 150, 2000, [], 0);
}

async function innerOf(sig, program) {
  for (let i = 0; i < 20; i++) {
    const tx = await rpc.call("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (tx) {
      const m = tx.transaction.message;
      const keys = [...m.accountKeys, ...((tx.meta.loadedAddresses || {}).writable || []), ...((tx.meta.loadedAddresses || {}).readonly || [])];
      const ix = m.instructions.find((x) => keys[x.programIdIndex] === program);
      return { data: b58decode(ix.data), keys: ix.accounts.map((a) => keys[a]) };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("transaction not found");
}

try {
  const vault = new Vault({ rpcUrl: RPC, network: "devnet", store: new MemoryStore() });
  const { id } = await vault.create("devnet test password");
  const acct = await vault.open(id, "devnet test password");
  const fee = await acct.feeKey();
  console.log("     wallet", acct.address, "fee key", fee);
  await fund(fee, 30_000_000);
  ok((await acct.status()).state === "uninitialized", "a new wallet starts uninitialized");
  await acct.activate();
  ok((await acct.status()).state === "active", "activate put the key root on chain");
  await fund(acct.address, 20_000_000);
  const dest = b58encode(crypto.getRandomValues(new Uint8Array(32)));
  const s1 = await acct.status();
  const sig = await acct.send(dest, 1_000_000);
  console.log("     send", sig);
  ok((await rpc.balance(b58decode(dest))) === 1_000_000, "a quantum-signed send delivered 0.001 SOL");
  const s2 = await acct.status();
  ok(s2.keysLeft === s1.keysLeft - 1, "the send used exactly one key");
  const st = await acct.vault.engine.chainState(await acct.s.load());
  const { data, keys } = await innerOf(sig, NETWORKS.devnet.program);
  const leaf = verifySolanaInstruction(data, keys, { pubSeed: st.pubSeed, root: st.root, aid: (await acct.s.load()).aid, epoch: st.epoch }, "devnet");
  ok(leaf === s1.nextLeaf, "the landed transaction verifies offline against the on-chain root");
  await acct.rekey();
  const s3 = await acct.status();
  ok(s3.epoch === s2.epoch + 1 && s3.state === "active", "rekey moved the wallet to a new key tree");
  await acct.execute([{ programId: b58encode(SYSTEM), keys: [{ pubkey: acct.address, isSigner: true, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }], data: hex(concat(u32(2), u64(500_000))) }]);
  ok((await rpc.balance(b58decode(dest))) === 1_500_000, "a raw instruction signed after the rekey also landed");
  acct.close();
} catch (e) {
  fail++;
  console.log("FAIL", e.message);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
