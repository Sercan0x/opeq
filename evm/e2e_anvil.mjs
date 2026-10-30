import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as E from "../web/lib/evmwots.js";
import * as S from "../web/lib/secp256k1.js";
import { signTx1559, hexToBytes, bytesToHex, create2Address } from "../web/lib/evmtx.js";
import { sha256 } from "../web/lib/sha256.js";
import { keccak256 } from "../web/lib/keccak.js";

const RPC = process.argv[2] || "http://127.0.0.1:8546";
const DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const FACTORY_SALT = new Uint8Array(32);
const enc = new TextEncoder();
const FUND = BigInt(process.env.OPEQ_EVM_FUND_WEI || 10n ** 18n);
const AMOUNT = BigInt(process.env.OPEQ_EVM_SEND_WEI || 10n ** 17n);

let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}

const masterFile = process.env.OPEQ_EVM_MASTER_FILE;
const master = masterFile ? Uint8Array.from(Buffer.from(readFileSync(masterFile.replace(/^~/, homedir()), "utf8").trim(), "hex")) : sha256(enc.encode("opeq evm anvil e2e master"));
if (master.length !== 32) throw new Error("master must be 32 bytes");
const feeKey = S.feeKeyFromMaster(master);
const fee = S.addressOf(feeKey);
const chainId = Number(await rpc("eth_chainId"));

async function send(to, data, value = 0n, label) {
  const nonce = Number(await rpc("eth_getTransactionCount", [fee, "pending"]));
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas);
  const tip = 1_000_000n;
  const gas = BigInt(await rpc("eth_estimateGas", [{ from: fee, to, data: bytesToHex(data), value: "0x" + value.toString(16) }])) * 12n / 10n;
  const { raw, hash } = signTx1559({ chainId, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gas, to, value, data }, feeKey);
  const sent = await rpc("eth_sendRawTransaction", [raw]);
  if (sent !== hash) throw new Error("hash mismatch");
  let rc = null;
  while (!(rc = await rpc("eth_getTransactionReceipt", [hash]))) await new Promise((r) => setTimeout(r, 100));
  if (rc.status !== "0x1") throw new Error(label + " reverted");
  console.log(label.padEnd(34), "gas", Number(rc.gasUsed).toString().padStart(8), " calldata", data.length, " tx", hash);
  return rc;
}

const balance = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
const now = async () => Number((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);

console.log("fee key address", fee, "chain", chainId);
if ((await balance(fee)) === 0n) throw new Error("fund the fee key first");

const factoryInit = hexToBytes(JSON.parse(readFileSync(new URL("./out/OpeqFactory.sol/OpeqFactory.json", import.meta.url))).bytecode.object);
const factory = create2Address(DEPLOYER, FACTORY_SALT, factoryInit);
if ((await rpc("eth_getCode", [factory, "latest"])) === "0x") {
  const d = new Uint8Array(32 + factoryInit.length);
  d.set(FACTORY_SALT); d.set(factoryInit, 32);
  await send(DEPLOYER, d, 0n, "deploy factory (CREATE2)");
}
console.log("factory", factory);

let t0 = Date.now();
const identity = E.deriveIdentityTree(master);
console.log("identity tree built in", Date.now() - t0, "ms");
await send(factory, E.encodeCreate(identity.pubSeed, identity.root), 0n, "create account");
const predicted = await rpc("eth_call", [{ to: factory, data: bytesToHex(Uint8Array.of(...keccak256(enc.encode("predict(bytes16,bytes16)")).slice(0, 4), ...E.encodeCreate(identity.pubSeed, identity.root).slice(4))) }, "latest"]);
const account = "0x" + predicted.slice(26);
console.log("account", account);
await send(account, new Uint8Array(0), FUND, "fund account");

const pubSeed1 = crypto.getRandomValues(new Uint8Array(16));
t0 = Date.now();
const tree = E.deriveChainTree(master, chainId, 1, pubSeed1);
console.log("chain tree built in", Date.now() - t0, "ms");
const slot = E.chainSlot(chainId);
const rnd0 = crypto.getRandomValues(new Uint8Array(16));
const dl0 = (await now()) + 600;
const g0 = E.grind(E.rekeyHasher(rnd0, chainId, account, 0, slot, dl0, tree.pubSeed, tree.root));
await send(account, E.encodeRekey(tree.pubSeed, tree.root, slot, dl0, g0.salt, rnd0, identity.sign(slot, g0.digest)), 0n, `bootstrap rekey (slot ${slot}, ${g0.cost} steps)`);

const BOB = process.env.OPEQ_EVM_TO || fee;
const calls = [{ to: BOB, value: AMOUNT, data: new Uint8Array(0) }];
const rnd1 = crypto.getRandomValues(new Uint8Array(16));
const dl1 = (await now()) + 600;
t0 = Date.now();
const g1 = E.grind(E.execHasher(rnd1, chainId, account, 1, 0, dl1, calls));
const grindMs = Date.now() - t0;
const cd = E.encodeExecute(calls, 0, dl1, g1.salt, rnd1, tree.sign(0, g1.digest));
await send(account, cd, 0n, `send (${g1.cost} steps, grind ${grindMs}ms)`);
console.log("account balance", (await balance(account)).toString());

let replayed = false;
try { await send(account, cd, 0n, "replay"); replayed = true; } catch {}
console.log("replay", replayed ? "ACCEPTED (bad)" : "rejected");
