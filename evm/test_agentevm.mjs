import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EvmAgentKey, approveCall, readAllowance, readBalance, x402EvmPayment, pullFromOwner, decodeApprove, authorizationDigest } from "../web/lib/agentevm.js";
import { bytesToHex } from "../web/lib/evmtx.js";

const NODE = process.env.ANVIL || "http://127.0.0.1:8561", CHAIN = 84532;
const CAST = process.env.CAST || join(homedir(), ".foundry", "bin", "cast");
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", FAC = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", SHOP = "0x0000000000000000000000000000000000005409";
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const throws = async (f, re, n) => { try { await f(); ok(false, n + " (no error)"); } catch (e) { ok(re.test(e.message), `${n} (${e.message.slice(0, 90)})`); } };
const rpc = { async call(method, params = []) { const r = await (await fetch(NODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; } };
const send = async (from, to, data, value = 0n) => { const h = await rpc.call("eth_sendTransaction", [{ from, to, data: typeof data === "string" ? data : bytesToHex(data), value: "0x" + value.toString(16) }]); for (;;) { const r = await rpc.call("eth_getTransactionReceipt", [h]); if (r) return r; await new Promise((x) => setTimeout(x, 100)); } };
const cd = (sig, ...a) => execFileSync(CAST, ["calldata", sig, ...a.map(String)]).toString().trim();

const art = JSON.parse(readFileSync(new URL("./out/TestUsd3009.sol/TestUsd3009.json", import.meta.url)));
const dep = await send(OWNER, null, art.bytecode.object);
const token = dep.contractAddress.toLowerCase();
await send(OWNER, token, cd("mint(address,uint256)", OWNER, 100_000_000));
const agent = EvmAgentKey.generate();
await send(OWNER, agent.address, "0x", 10n ** 16n);

const ap = approveCall(token, agent.address, 5_000_000n);
ok(decodeApprove(ap.data).spender === agent.address && decodeApprove(ap.data).value === 5_000_000n, "approve calldata round-trips through the decoder");
await send(OWNER, ap.to, ap.data);
ok((await readAllowance(rpc, token, OWNER, agent.address)) === 5_000_000n, "the owner's allowance to the agent reads back as 5");

const req = (amt, extra = {}) => ({ scheme: "exact", network: `eip155:${CHAIN}`, amount: String(amt), asset: token, payTo: SHOP, maxTimeoutSeconds: 120, extra: { name: "Test USD", version: "2", ...extra } });
const now = Number(BigInt((await rpc.call("eth_getBlockByNumber", ["latest", false])).timestamp));
await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: req(1_500_000), agent, asset: token, maxAmount: 2_000_000n, now }), /pull more/, "the agent cannot pay before it pulls funds");
await throws(() => pullFromOwner({ rpc, chainId: CHAIN, agent, token, owner: OWNER, value: 6_000_000n }), /allows this agent 5000000/, "the agent cannot pull more than the allowance");
await pullFromOwner({ rpc, chainId: CHAIN, agent, token, owner: OWNER, value: 3_000_000n });
ok((await readBalance(rpc, token, agent.address)) === 3_000_000n && (await readAllowance(rpc, token, OWNER, agent.address)) === 2_000_000n, "pulling 3 moves 3 to the agent and leaves 2 of the allowance");

const p = await x402EvmPayment({ rpc, chainId: CHAIN, requirements: req(1_500_000), agent, asset: token, maxAmount: 2_000_000n, now });
const a = p.payload.payload.authorization;
const sig = p.payload.payload.signature;
const r1 = await send(FAC, token, cd("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)", a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig));
ok(r1.status === "0x1" && (await readBalance(rpc, token, SHOP)) === 1_500_000n, "a third party settles the signed authorization on the token contract (EIP-712 digest matches)");
const r2 = await send(FAC, token, cd("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)", a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig)).catch(() => ({ status: "0x0" }));
ok(r2.status !== "0x1", "the same authorization cannot be settled twice");
const r3 = await send(FAC, token, cd("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)", a.from, a.to, "9000000", a.validAfter, a.validBefore, "0x" + "11".repeat(32), sig)).catch(() => ({ status: "0x0" }));
ok(r3.status !== "0x1", "a changed amount does not match the signature");

await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: req(1_000_000), agent, asset: token, maxAmount: 500_000n, now }), /more than the 500000/, "the per-payment cap is enforced");
await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: { ...req(1000), network: "eip155:8453" }, agent, asset: token, maxAmount: 10n ** 9n, now }), /another network/, "a request for another chain is refused");
await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: { ...req(1000), asset: SHOP }, agent, asset: token, maxAmount: 10n ** 9n, now }), /not set up to pay with/, "a request for another token is refused");
await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: req(1000, { assetTransferMethod: "permit2" }), agent, asset: token, maxAmount: 10n ** 9n, now }), /EIP-3009/, "Permit2 requests are refused");
await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: { ...req(1000), payTo: agent.address }, agent, asset: token, maxAmount: 10n ** 9n, now }), /pay itself/, "a request that pays the agent itself is refused");
await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: req(1000), agent, asset: token, now }), /maxAmount/, "a payment without a cap is refused");
await send(OWNER, token, approveCall(token, agent.address, 0n).data);
await throws(() => pullFromOwner({ rpc, chainId: CHAIN, agent, token, owner: OWNER, value: 1n }), /allows this agent 0/, "after the owner sets the allowance to zero the agent cannot pull");
await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: { ...req(1000), maxTimeoutSeconds: "60" }, agent, asset: token, maxAmount: 10n ** 9n, now }), /maxTimeoutSeconds/, "a string timeout is refused");
await throws(() => x402EvmPayment({ rpc, chainId: CHAIN, requirements: req(1000, { name: " " }), agent, asset: token, maxAmount: 10n ** 9n, now }), /signing domain/, "an empty token domain is refused");
ok(JSON.stringify(agent) === JSON.stringify({ address: agent.address }), "the agent secret does not leak through JSON");
ok(EvmAgentKey.fromSecret(agent.secretHex()).address === agent.address, "an agent key survives export and import");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
