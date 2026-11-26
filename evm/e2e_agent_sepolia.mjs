import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Vault, MemoryStore, EvmAgentKey as SdkAgentKey, payX402Evm, pullForAgent } from "../sdk/index.js";
import { EvmRpc } from "../web/lib/evmwallet.js";
import { feeKeyFromMaster, addressOf } from "../web/lib/secp256k1.js";
import { signTx1559, hexToBytes, bytesToHex } from "../web/lib/evmtx.js";
import { keccak256 } from "../web/lib/keccak.js";
import { EvmAgentKey, approveCall, readAllowance, readBalance, x402EvmPayment, pullFromOwner } from "../web/lib/agentevm.js";

const CHAIN = 84532, RPC = "https://sepolia.base.org", CHECK = "https://base-sepolia-rpc.publicnode.com", FAC = process.env.X402_FACILITATOR || "https://x402.org/facilitator";
const STATE = process.env.STATE || join(tmpdir(), "opeq-sepolia-test-token.json");
const masterFile = process.argv[2];
if (!masterFile) { console.log("usage: node evm/e2e_agent_sepolia.mjs <file with a funded Base Sepolia master in hex>"); process.exit(2); }
const rpc = new EvmRpc(RPC);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const sel = (s) => keccak256(enc.encode(s)).slice(0, 4);
const word = (v) => { const b = new Uint8Array(32); let x = BigInt(v); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const aw = (a) => { const b = new Uint8Array(32); b.set(hexToBytes(a), 12); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

const master = hexToBytes("0x" + readFileSync(masterFile, "utf8").trim().replace(/^0x/, ""));
const fpriv = feeKeyFromMaster(master);
master.fill(0);
const funder = addressOf(fpriv);
async function fsend(to, data, value = 0n, gas = 200000n) {
  const nonce = Number(await rpc.call("eth_getTransactionCount", [funder, "pending"]));
  const base = BigInt((await rpc.call("eth_getBlockByNumber", ["latest", false])).baseFeePerGas);
  const tx = signTx1559({ chainId: CHAIN, nonce, maxPriorityFeePerGas: 1000000n, maxFeePerGas: base * 2n + 1000000n, gas, to, value, data }, fpriv);
  const h = await rpc.call("eth_sendRawTransaction", [tx.raw]);
  for (let i = 0; i < 90; i++) { const r = await rpc.call("eth_getTransactionReceipt", [h]); if (r) { if (r.status !== "0x1") throw new Error("funder tx failed " + h); return r; } await sleep(1500); }
  throw new Error("funder tx not confirmed " + h);
}
console.log("     funder", funder, "balance", Number(await rpc.balance(funder)) / 1e18, "ETH");

let token = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")).token : null;
if (!token || (await rpc.code(token)) === "0x") {
  const art = JSON.parse(readFileSync(new URL("./out/TestUsd3009.sol/TestUsd3009.json", import.meta.url)));
  const r = await fsend(null, hexToBytes(art.bytecode.object), 0n, 1500000n);
  token = r.contractAddress.toLowerCase();
  writeFileSync(STATE, JSON.stringify({ token }));
}
console.log("     test token", token);

const vault = new Vault({ rpcUrl: "https://api.devnet.solana.com", network: "devnet", store: new MemoryStore() });
const { id } = await vault.create("sepolia agent test");
const acct = await vault.open(id, "sepolia agent test");
const base = await acct.evm(CHAIN, { rpcUrl: RPC, checkUrl: CHECK });
console.log("     OPEQ account", base.address, "gas key", base.feeAddress);
await fsend(base.feeAddress, new Uint8Array(0), 6n * 10n ** 15n, 21000n);
console.log("     setting up the OPEQ account (builds key trees, about a minute)");
await base.setup();
ok((await rpc.code(base.address)) !== "0x", "the OPEQ account contract is deployed on Base Sepolia");
await fsend(token, cat(sel("mint(address,uint256)"), aw(base.address), word(20_000_000)));
ok((await readBalance(rpc, token, base.address)) === 20_000_000n, "the OPEQ account holds 20 test USD");

const agent = SdkAgentKey.generate();
const al = await base.allowAgent(agent.address, token, 5_000_000n);
ok(al.previous === 0n && (await base.agentAllowance(agent.address, token)) === 5_000_000n, "SDK allowAgent and agentAllowance work");
ok((await readAllowance(rpc, token, base.address, agent.address)) === 5_000_000n, "the OPEQ account allowed the agent 5 test USD with a hash-based signature");

await fsend(agent.address, new Uint8Array(0), 10n ** 15n, 21000n);
await pullForAgent({ rpcUrl: RPC, chainId: CHAIN, agent, token, owner: base.address, amount: 2_000_000n });
ok((await readBalance(rpc, token, agent.address)) === 2_000_000n, "the agent pulled 2 test USD under its allowance");

const shop = EvmAgentKey.generate().address;
const req = { scheme: "exact", network: `eip155:${CHAIN}`, amount: "1500000", asset: token, payTo: shop, maxTimeoutSeconds: 120, extra: { name: "Test USD", version: "2" } };
const p = await payX402Evm({ rpcUrl: RPC, chainId: CHAIN, requirements: req, agent, asset: token, maxAmount: 2_000_000n });
ok(typeof p.header === "string", "SDK payX402Evm builds the payment and its header");
const body = JSON.stringify({ x402Version: 2, paymentPayload: p.payload, paymentRequirements: req });
const post = async (path) => { const r = await fetch(FAC + path, { method: "POST", headers: { "content-type": "application/json" }, body }); const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300), status: r.status }; } };
const v = await post("/verify");
ok(v.isValid === true, `the x402.org facilitator verifies the agent's payment (${JSON.stringify(v).slice(0, 600)})`);
if (v.isValid) {
  const s = await post("/settle");
  ok(s.success === true, `the facilitator settles it (${JSON.stringify(s).slice(0, 200)})`);
  await sleep(4000);
  ok((await readBalance(rpc, token, shop)) === 1_500_000n, "the service received 1.5 test USD");
}
await base.revokeAgent(agent.address, token);
ok((await readAllowance(rpc, token, base.address, agent.address)) === 0n, "the OPEQ account removed the allowance");
acct.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
