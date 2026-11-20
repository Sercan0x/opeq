import { readFileSync } from "node:fs";
import { Vault, MemoryStore, AgentKey, payX402, b58encode, b58decode } from "../index.js";
import { Rpc, SYSTEM, compact, concat, u32, u64 } from "../src/lib/solana.js";
import { TOKEN, ATA_PROG, ataOf } from "../src/lib/agent.js";

const RPC = process.env.OPEQ_DEVNET_RPC || "https://api.devnet.solana.com";
const FACILITATOR = process.env.X402_FACILITATOR || "";
const funderFile = process.argv[2];
if (!funderFile) { console.log("usage: node test/e2e_agent_devnet.mjs <funded devnet keypair json>   (set X402_FACILITATOR=https://x402.org/facilitator to settle for real)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const throws = async (f, re, n) => { try { await f(); ok(false, n + " (did not throw)"); } catch (e) { ok(re.test(e.message), `${n} (${e.message})`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signer(file) {
  const k = JSON.parse(readFileSync(file, "utf8"));
  const pkcs8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...k.slice(0, 32)]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  pkcs8.fill(0);
  const pub = Uint8Array.from(k.slice(32));
  return { key: () => pub, pub, sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, m)) };
}

const rpc = new Rpc(RPC);
const funderKey = await signer(funderFile);
const run = async (ixs, extra = []) => {
  const { compileV0 } = await import("../src/lib/solana.js");
  const all = [funderKey, ...extra];
  const { message, signers } = compileV0(funderKey.pub, ixs, await rpc.blockhash());
  const sigs = [];
  for (const s of signers) { const k = typeof s === "string" ? s : b58encode(s); sigs.push(await all.find((x) => b58encode(x.pub) === k).sign(message)); }
  const raw = concat(new Uint8Array(compact(sigs.length)), ...sigs, message);
  const sig = await rpc.call("sendTransaction", [btoa(String.fromCharCode(...raw)), { encoding: "base64", preflightCommitment: "confirmed" }]);
  for (let i = 0; i < 40; i++) { const st = (await rpc.call("getSignatureStatuses", [[sig]])).value[0]; if (st && st.err) throw new Error(JSON.stringify(st.err)); if (st && st.confirmationStatus !== "processed") return sig; await sleep(1500); }
  throw new Error("not confirmed");
};
const ataIx = (owner, mint) => [ATA_PROG, [[funderKey.pub, true, true], [ataOf(owner, mint), false, true], [owner, false, false], [mint, false, false], [SYSTEM, false, false], [TOKEN, false, false]], new Uint8Array([1])];

try {
  const vault = new Vault({ rpcUrl: RPC, network: "devnet", store: new MemoryStore() });
  const { id } = await vault.create("agent e2e password");
  const acct = await vault.open(id, "agent e2e password");
  const fee = await acct.feeKey();
  await run([[SYSTEM, [[funderKey.pub, true, true], [b58decode(fee), false, true]], concat(u32(2), u64(30_000_000n))]]);
  await acct.activate();
  const owner = b58decode(acct.address);
  const mintKp = await AgentKey.generate(), merchant = await AgentKey.generate();
  const mint = mintKp.pub;
  const rent = await rpc.rent(82);
  await run([
    [SYSTEM, [[funderKey.pub, true, true], [mint, true, true]], concat(u32(0), u64(BigInt(rent)), u64(82n), TOKEN)],
    [TOKEN, [[mint, false, true]], concat(new Uint8Array([20, 6]), funderKey.pub, new Uint8Array([0]))],
    ataIx(owner, mint), ataIx(merchant.pub, mint),
    [TOKEN, [[mint, false, true], [ataOf(owner, mint), false, true], [funderKey.pub, true, false]], concat(new Uint8Array([7]), u64(100_000_000n))],
  ], [mintKp]);

  const agent = await AgentKey.generate();
  const again = await AgentKey.fromSecret(agent.secretHex());
  ok(again.address === agent.address, "an agent key survives export and import of its secret");
  await throws(() => acct.allowAgent(acct.address, mint, 1n), /must not be the OPEQ account/, "the OPEQ account cannot be its own agent");
  await throws(() => acct.allowAgent(fee, mint, 1n), /must not be the fee key/, "the fee key cannot be the agent");
  await throws(() => acct.allowAgent(agent.address, mint, 0n), /out of range/, "a zero allowance is refused");
  await throws(() => acct.allowAgent(agent.address, merchant.address, 1n), /not a token mint/, "a non-mint address is refused");
  const before = await acct.status();
  const r = await acct.allowAgent(agent.address, mint, 5_000_000n);
  await sleep(2000);
  const a1 = await acct.agentAllowance(mint);
  ok(a1.agent === agent.address && a1.allowance === 5_000_000n && r.replaced === null, "allowAgent sets a 5 token allowance for the agent");

  const feePayer = FACILITATOR ? (await (await fetch(FACILITATOR + "/supported")).json()).kinds.find((k) => k.x402Version === 2 && k.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1").extra.feePayer : (await AgentKey.generate()).address;
  const reqs = (amt) => ({ scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", amount: String(amt), asset: b58encode(mint), payTo: merchant.address, maxTimeoutSeconds: 60, extra: { feePayer } });
  await throws(() => payX402({ rpcUrl: RPC, requirements: reqs(6_000_000n), agent, owner: acct.address, asset: mint, maxAmount: 10_000_000n }), /allowance left/, "the agent refuses a payment above its allowance before signing");
  await throws(() => payX402({ rpcUrl: RPC, requirements: reqs(2_000_000n), agent, owner: acct.address, asset: mint, maxAmount: 1_000_000n }), /more than the/, "the per-payment cap stops a pricey request");
  await throws(() => payX402({ rpcUrl: RPC, requirements: { ...reqs(1n), network: "eip155:8453" }, agent, owner: acct.address, asset: mint, maxAmount: 10n }), /not for a Solana network/, "non-Solana requirements are refused");
  await throws(() => payX402({ rpcUrl: RPC, requirements: { ...reqs(1n), extra: { feePayer: agent.address } }, agent, owner: acct.address, asset: mint, maxAmount: 10n }), /fee payer must be the facilitator/, "the agent never pays fees for a facilitator");
  await throws(() => payX402({ rpcUrl: RPC, requirements: reqs(1n), agent, owner: acct.address, asset: mint }), /maxAmount/, "a payment without a per-payment cap is refused");
  await throws(() => payX402({ rpcUrl: RPC, requirements: { ...reqs(1n), network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, agent, owner: acct.address, asset: mint, maxAmount: 10n }), /another Solana network/, "a mainnet request is refused on a devnet RPC");
  ok(JSON.stringify(agent) === JSON.stringify({ address: agent.address }) && !Object.keys(agent).some((x) => /secret|key/i.test(x)), "the agent secret does not leak through JSON or object keys");
  await throws(() => acct.allowAgent(acct.address.replace(/./, (c) => c), mint, 1n), /OPEQ account/, "self check still first");
  const p = await payX402({ rpcUrl: RPC, requirements: reqs(1_500_000n), agent, owner: acct.address, asset: mint, maxAmount: 2_000_000n, resource: { url: "https://example.com/opeq-sdk-test" } });
  ok(p.allowanceLeft === 3_500_000n && typeof p.header === "string", "payX402 builds a signed payment and its PAYMENT-SIGNATURE header");

  if (FACILITATOR) {
    const body = { x402Version: 2, paymentPayload: p.payload, paymentRequirements: p.payload.accepted };
    const post = async (path) => (await fetch(FACILITATOR + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const v = await post("/verify");
    ok(v.isValid === true && v.payer === agent.address, `the facilitator verifies the payment (${JSON.stringify(v)})`);
    const s = await post("/settle");
    ok(s.success === true && typeof s.transaction === "string" && s.transaction.length > 40, `the facilitator settles it on chain (${s.transaction})`);
    await sleep(3000);
    const a2 = await acct.agentAllowance(mint);
    ok(a2.allowance === 3_500_000n && a2.balance === 98_500_000n, "the payment left the OPEQ account and the allowance went down");
  } else console.log("skip  facilitator checks (set X402_FACILITATOR)");

  const other = await AgentKey.generate();
  const rr = await acct.allowAgent(other.address, mint, 1_000_000n);
  ok(rr.replaced === agent.address, "giving the allowance to a new agent reports the agent it replaced");
  await throws(() => payX402({ rpcUrl: RPC, requirements: reqs(100_000n), agent, owner: acct.address, asset: mint, maxAmount: 1_000_000n }), /no allowance/, "the replaced agent can no longer pay");
  const rv = await acct.revokeAgent(mint);
  await sleep(2000);
  ok(rv.revoked === other.address && (await acct.agentAllowance(mint)).agent === null, "revokeAgent removes the allowance");
  ok((await acct.revokeAgent(mint)).result === null, "revoking twice sends nothing");
  const after = await acct.status();
  ok(after.nextLeaf - before.nextLeaf <= 4, `payments use no one-time keys: ${after.nextLeaf - before.nextLeaf} used for two allowances and one revoke`);
  acct.close();
} catch (e) { fail++; console.log("FAIL", e.stack || e.message); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
