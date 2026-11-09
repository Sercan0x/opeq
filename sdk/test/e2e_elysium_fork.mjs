import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Vault, MemoryStore, verifyEvmExecute, hexToBytes } from "../index.js";

const FORK = process.argv[2] || "https://rpc.elysium.kinetiq.xyz";
const CHAIN = 99901;
const PORT = 19545 + Math.floor(Math.random() * 1000);
const A = `http://127.0.0.1:${PORT}`, B = `http://localhost:${PORT}`;
const anvil = spawn(join(homedir(), ".foundry", "bin", "anvil"), ["--port", String(PORT), "--fork-url", FORK, "--silent"], { stdio: "ignore" });
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };

async function rpc(method, params = []) {
  const r = await fetch(A, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

try {
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
  ok(Number(await rpc("eth_chainId")) === CHAIN, "the fork reports Elysium's chain id 99901");
  const vault = new Vault({ rpcUrl: "http://127.0.0.1:1", network: "devnet", store: new MemoryStore() });
  const { id, words } = await vault.create("elysium fork test");
  const acct = await vault.open(id, "elysium fork test");
  console.log("     building EVM key trees, this takes about a minute");
  const evm = await acct.evm(CHAIN, { rpcUrl: A, checkUrl: B });
  ok(/^0x[0-9a-f]{40}$/.test(evm.address), "the account has an address before setup");
  const evmBase = await acct.evm(8453, { rpcUrl: "https://mainnet.base.org", checkUrl: "https://base-rpc.publicnode.com" });
  ok(evmBase.address === evm.address, "the Elysium address is the same as the Base address");
  evmBase.close();
  await rpc("anvil_setBalance", [evm.feeAddress, "0x56BC75E2D63100000"]);
  const steps = [];
  const state = await evm.setup(null, (s) => steps.push(s));
  ok(state === "ready", `setup finished on the Elysium fork, factory installed (${steps.length} steps)`);
  ok((await rpc("eth_getCode", [evm.address, "latest"])).length > 2, "the OPEQ account contract exists on Elysium");
  await rpc("anvil_setBalance", [evm.address, "0xDE0B6B3A7640000"]);
  const bob = "0x0000000000000000000000000000000000000b0b";
  const before = BigInt(await rpc("eth_getBalance", [bob, "latest"]));
  let hash = null;
  const res = await evm.send(bob, 10n ** 16n, (h) => { hash = h; });
  const after = BigInt(await rpc("eth_getBalance", [bob, "latest"]));
  ok(after - before === 10n ** 16n, "a quantum-signed send moved 0.01 HYPE");
  const tx = await rpc("eth_getTransactionByHash", [hash || res.hash]);
  const st = await evm.c.chainState();
  const v = verifyEvmExecute(hexToBytes(tx.input), { chainId: CHAIN, account: evm.address, epoch: st.epoch, pubSeed: hexToBytes(st.pubSeed), root: hexToBytes(st.root) });
  ok(!!v && v.calls[0].value === 10n ** 16n, "the send verifies offline against the on-chain key root");
  ok(verifyEvmExecute(hexToBytes(tx.input), { chainId: 8453, account: evm.address, epoch: st.epoch, pubSeed: hexToBytes(st.pubSeed), root: hexToBytes(st.root) }) === null, "the Elysium signature does not verify for Base");
  const usdc = "0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65";
  const dec = await rpc("eth_call", [{ to: usdc, data: "0x313ce567" }, "latest"]);
  ok(Number(dec) === 6, "Relay's USDC on Elysium has 6 decimals");
  const s1 = await evm.status();
  await evm.rekey();
  const s2 = await evm.status();
  ok(s2.state === "ready" && (await evm.c.chainState()).epoch === st.epoch + 1, "rekey moved the account to a fresh key tree");
  await evm.send(bob, 1n);
  ok(BigInt(await rpc("eth_getBalance", [bob, "latest"])) === after + 1n, "a send after the rekey works");
  ok(s1.state === "ready", "status stayed ready through the run");
  evm.close();
  acct.close();
} catch (e) {
  fail++;
  console.log("FAIL", e.message);
} finally {
  anvil.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
