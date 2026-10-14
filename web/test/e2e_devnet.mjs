import { readFileSync } from "fs";
import { createPrivateKey, sign as edSign } from "crypto";
import { Engine } from "../lib/engine.js";
import { localCompute } from "../lib/compute.js";
import { MemoryStore } from "../lib/vaultstore.js";
import * as P from "../lib/protocol.js";
import { Rpc, pubkey, b58encode, compileV0, unsignedTx, concat, u32, u64, SYSTEM } from "../lib/solana.js";

const raw = new Uint8Array(JSON.parse(readFileSync(new URL("../../devnet-key.json", import.meta.url))));
const seed = raw.slice(0, 32), payerPub = raw.slice(32);
const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
const sk = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
const payer = {
  key: () => payerPub,
  sign: async (tx) => {
    const msg = tx.slice(65);
    const out = new Uint8Array(tx); out.set(edSign(null, Buffer.from(msg), sk), 1); return out;
  },
};
const rpc = new Rpc("https://api.devnet.solana.com");
const engine = new Engine({ rpc, program: "424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN", store: new MemoryStore(), compute: localCompute, payer });
engine.log = (m) => console.log("   log:", m);
let fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fail++; };

const { record, words } = await engine.create("web-test-password-1");
await engine.save(record);
console.log("wallet", record.id);
ok("init", (await engine.init(record)).length > 20);
const s = await engine.unlock(await engine.store.get(record.id), "web-test-password-1");
const fund = [SYSTEM, [[payerPub, true, true], [s.wallet, false, true]], concat(u32(2), u64(30_000_000))];
await engine.submit(fund, (await rpc.slot()) + 150, 50000);
const bob = pubkey("AR7MtmqiWkrSqBfj6w196aQmdzRPoQ3juAnAZtqnuqzZ");
const b0 = await rpc.balance(s.wallet);
await s.sendSol(bob, 1_000_000);
ok("send 0.001 SOL", (await rpc.balance(s.wallet)) === b0 - 1_000_000);
const before = (await engine.chainState(record)).next;
try { await s.sendSol(bob, 5_000_000_000); ok("overdraft should fail", false); } catch (e) { console.log("   expected failure:", e.message.slice(0, 80)); }
const after = (await engine.chainState(record)).next;
ok(`failed send burned its leaf (next ${before} -> ${after})`, after >= before + 2);
let wrong = false; try { await engine.unlock(await engine.store.get(record.id), "nope-wrong-pw"); } catch { wrong = true; }
ok("wrong password rejected", wrong);
await s.rekey();
const st = await engine.chainState(record);
ok(`rekey (epoch ${st.epoch})`, st.epoch === 1);
await s.sendSol(bob, 1_000_000);
ok("send after rekey", true);
const rec = await engine.recover(words.join(" "), "recovered-pw-123");
ok(`recover finds tree ${rec.epoch}, counter ${rec.next_leaf}`, rec.id === record.id && rec.epoch === 1 && rec.next_leaf === (await engine.chainState(record)).next + 64);
const store2 = new MemoryStore(); await store2.put(rec);
const engine2 = new Engine({ rpc, program: "424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN", store: store2, compute: localCompute, payer });
const s2 = await engine2.unlock(rec, "recovered-pw-123");
await s2.sendSol(bob, 1_000_000);
ok("recovered vault sends", true);
console.log(fail ? `FAILED ${fail}` : "ALL PASSED");
