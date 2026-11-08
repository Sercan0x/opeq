import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Vault, MemoryStore, verifyEvmExecute, hexToBytes } from "../index.js";

const PORT = 18545 + Math.floor(Math.random() * 1000);
const URL_ = `http://127.0.0.1:${PORT}`;
const anvil = spawn(join(homedir(), ".foundry", "bin", "anvil"), ["--port", String(PORT), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };

async function rpc(method, params = []) {
  const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

try {
  for (let i = 0; i < 50; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const vault = new Vault({ rpcUrl: "http://127.0.0.1:1", network: "devnet", store: new MemoryStore() });
  const { id, words } = await vault.create("correct horse battery staple");
  ok(words.split(" ").length === 24, "a new vault gives 24 words");
  const acct = await vault.open(id, "correct horse battery staple");
  console.log("     building EVM key trees, this takes about a minute");
  const evm = await acct.evm(31337, { rpcUrl: URL_ });
  await rpc("anvil_setBalance", [evm.feeAddress, "0x56BC75E2D63100000"]);
  const steps = [];
  const state = await evm.setup(null, (s) => steps.push(s));
  ok(state === "ready", `setup finished (${steps.length} steps)`);
  await rpc("anvil_setBalance", [evm.address, "0xDE0B6B3A7640000"]);
  const bob = "0x0000000000000000000000000000000000000b0b";
  const before = BigInt(await rpc("eth_getBalance", [bob, "latest"]));
  let hash = null;
  const res = await evm.send(bob, 10n ** 16n, (h) => { hash = h; });
  const after = BigInt(await rpc("eth_getBalance", [bob, "latest"]));
  ok(after - before === 10n ** 16n, "a quantum-signed send moved 0.01 ETH");
  const tx = await rpc("eth_getTransactionByHash", [hash || res.hash]);
  ok(tx.to.toLowerCase() === evm.address.toLowerCase(), "the transaction went to the OPEQ account contract");
  const st = await evm.c.chainState();
  const v = verifyEvmExecute(hexToBytes(tx.input), { chainId: 31337, account: evm.address, epoch: st.epoch, pubSeed: hexToBytes(st.pubSeed), root: hexToBytes(st.root) });
  ok(!!v && v.calls[0].value === 10n ** 16n, "the sent transaction verifies offline against the on-chain key root");
  const s1 = await evm.status();
  await evm.send(bob, 1n);
  const s2 = await evm.status();
  ok(s2.keysLeft === s1.keysLeft - 1, "each signature uses up exactly one key");
  const rec = await vault.store.get(evm.c.key);
  await (async () => { try { await vault.store.put({ ...rec, next_leaf: rec.next_leaf - 1 }); ok(false, "store refuses an older key counter"); } catch (e) { ok(/backwards/.test(e.message), "store refuses an older key counter"); } })();
  const vault2 = new Vault({ rpcUrl: "https://api.devnet.solana.com", network: "devnet", store: new MemoryStore() });
  const r2 = await vault2.recover(words, "another password");
  const acct2 = await vault2.open(r2.id, "another password");
  const evm2 = await acct2.evm(31337, { rpcUrl: URL_ });
  ok(evm2.address === evm.address, "the same words give the same EVM account on a second device");
  ok((await evm2.status()).state === "other", "the second device does not sign until it takes over");
  await rpc("anvil_setBalance", [evm2.feeAddress, "0x56BC75E2D63100000"]);
  await evm2.useHere();
  ok((await evm2.status()).state === "ready", "the second device took over with a fresh key tree");
  await evm2.send(bob, 2n);
  ok(true, "the second device can send");
  await (async () => { try { await evm.send(bob, 1n); ok(false, "the first device stops signing after the takeover"); } catch (e) { ok(/not signing|Use on this device/.test(e.message), "the first device stops signing after the takeover"); } })();
  acct2.close();
  acct.close();
  await (async () => { try { await evm.send(bob, 1n); ok(false, "a closed account cannot sign"); } catch (e) { ok(/closed/.test(e.message), "a closed account cannot sign"); } })();
} catch (e) {
  fail++;
  console.log("FAIL", e.message);
} finally {
  anvil.kill("SIGTERM");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
