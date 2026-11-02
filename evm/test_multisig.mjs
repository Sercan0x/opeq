import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { EvmChain } from "../web/lib/evmwallet.js";
import { MemoryStore } from "../web/lib/vaultstore.js";
import { localCompute } from "../web/lib/compute.js";
import { sha256 } from "../web/lib/sha256.js";
import { bytesToHex } from "../web/lib/evmtx.js";
import { encodeErc20Transfer } from "../web/lib/evmwots.js";
import * as M from "../web/lib/evmmultisig.js";

const RPC = process.argv[2] || "http://127.0.0.1:8551";
const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CHAIN = { chainId: 31337, name: "Local test", symbol: "ETH", rpc: RPC };
const enc = new TextEncoder();
const cast = (cmd, ...a) => execFileSync(process.env.HOME + "/.foundry/bin/cast", [cmd, "--rpc-url", RPC, ...a], { encoding: "utf8" }).trim();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  ", m); } else { fail++; console.log("  FAIL", m); } };
async function throws(p, re, m) {
  try { await p; ok(false, m + " (did not throw)"); } catch (e) { ok(re.test(e.message), `${m}: ${e.message.slice(0, 110)}`); }
}

const macKey = await crypto.subtle.importKey("raw", sha256(enc.encode("mac")), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const people = [];
console.log("three OPEQ accounts");
for (const name of ["alice", "bob", "carol"]) {
  const c = new EvmChain({ chain: CHAIN, store: new MemoryStore(), macKey, vaultId: name, master: sha256(enc.encode("multisig test " + name)), compute: localCompute });
  await c.loadIdentity(null);
  cast("send", c.feeAddress, "--value", "3ether", "--private-key", ANVIL0);
  const s = await c.setup(null);
  ok(s.state === "ready", `${name} ready at ${c.account}`);
  people.push(c);
}
const [A, B, C] = people;
const owners = people.map((p) => p.account);
const dest = "0x000000000000000000000000000000000000d00d";

console.log("factory");
const fac = M.factoryAddress();
if ((await A.rpc.code(fac)) === "0x") await A.sendTx("0x4e59b44847b379578588920ca78fbf26c0b4956c", M.factoryDeployData(), 0n, 6000000n);
ok((await A.rpc.code(fac)) !== "0x", `multisig factory at ${fac}`);

console.log("create vault");
const nonce = sha256(enc.encode("vault nonce"));
const want = M.vaultAddress(A.account, owners, 2, nonce);
const predicted = cast("call", fac, "predict(address,address[],uint8,bytes32)(address)", A.account, `[${owners.join(",")}]`, "2", bytesToHex(nonce));
ok(predicted.toLowerCase() === want, "local vault address matches the factory's own prediction");
const rc = await A.execute([M.createCall(owners, 2, nonce)]);
ok((await A.rpc.code(want)) !== "0x", `vault created (gas ${rc.gasUsed})`);
const vA = new M.Vault(A, want), vB = new M.Vault(B, want);
let info = await vA.read();
ok(info.owners.join() === owners.join() && info.threshold === 2 && info.proposals === 0, "vault reads back owners and threshold");
cast("send", want, "--value", "2ether", "--private-key", ANVIL0);

console.log("pay 0.5 ETH with 2 of 3");
const pay = [{ to: dest, value: 5n * 10n ** 17n, data: new Uint8Array(0) }];
const now = Number(cast("block", "latest", "--field", "timestamp"));
const r1 = await A.execute([M.proposeCall(want, pay, now + M.DEFAULT_LIFETIME_S)]);
ok(true, `proposed (gas ${r1.gasUsed})`);
let p = await vB.proposal(0);
ok(p.live && p.approvals === 1 && p.proposer === A.account, "bob sees a live proposal from alice with 1 approval");
const d = M.describe(p.calls[0], want);
ok(d.kind === "pay" && d.to === dest && d.value === 5n * 10n ** 17n, "bob's wallet decodes it as a 0.5 ETH payment to the right address");
await throws(B.execute([M.executeCall(want, 0, pay)]), /would fail on chain|Nothing was signed/, "executing with one approval is refused before signing");
const r2 = await B.execute([M.idCall(want, "approve", 0, (await vB.proposal(0)).callsHash)]);
ok(await vB.approvedBy(0, B.account), `bob approved (gas ${r2.gasUsed})`);
const r3 = await B.execute([M.executeCall(want, 0, pay)]);
ok(BigInt(cast("balance", dest)) === 5n * 10n ** 17n, `paid (gas ${r3.gasUsed})`);
p = await vA.proposal(0);
ok(p.executed && !p.live, "proposal marked executed");
await throws(C.execute([M.executeCall(want, 0, pay)]), /would fail on chain|Nothing was signed/, "replay refused before signing");

console.log("token payment");
const tokenAddr = cast("send", "--private-key", ANVIL0, "--create", JSON.parse(readFileSync(new URL("./out/Harness.sol/MockToken.json", import.meta.url))).bytecode.object, "--json");
const token = JSON.parse(tokenAddr).contractAddress;
cast("send", token, "mint(address,uint256)", want, "1000000", "--private-key", ANVIL0);
const tpay = [{ to: token, value: 0n, data: encodeErc20Transfer(dest, 250000n) }];
await C.execute([M.proposeCall(want, tpay, now + 3600)]);
p = await vA.proposal(1);
const td = M.describe(p.calls[0], want);
ok(td.kind === "token" && td.token === token.toLowerCase() && td.to === dest && td.amount === 250000n, "token transfer decoded for the approver");
await A.execute([M.idCall(want, "approve", 1, (await vA.proposal(1)).callsHash)]);
await A.execute([M.executeCall(want, 1, tpay)]);
ok(BigInt(cast("call", token, "balanceOf(address)(uint256)", dest).split(" ")[0]) === 250000n, "token paid");

console.log("owner change");
const two = [A.account, B.account];
const change = [M.setOwnersCall(want, two, 2)];
await A.execute([M.proposeCall(want, change, now + 3600)]);
p = await vB.proposal(2);
const od = M.describe(p.calls[0], want);
ok(od.kind === "owners" && od.owners.join() === two.join() && od.threshold === 2, "owner change decoded");
await B.execute([M.idCall(want, "approve", 2, (await vB.proposal(2)).callsHash)]);
await B.execute([M.executeCall(want, 2, change)]);
info = await vA.read();
ok(info.owners.length === 2 && !info.owners.includes(C.account), "carol removed");
await throws(C.execute([M.proposeCall(want, pay, now + 3600)]), /would fail on chain|Nothing was signed/, "removed owner cannot propose");

console.log("guards");
await throws(new M.Vault(A, A.account).read(), /not the OPEQ shared vault/, "an OPEQ account address is not accepted as a vault");
await throws(new M.Vault(A, dest).read(), /no shared vault/, "an empty address is not accepted as a vault");
const rogue = cast("send", "--private-key", ANVIL0, "--create", JSON.parse(readFileSync(new URL("./out/OpeqMultisig.sol/OpeqMultisig.json", import.meta.url))).bytecode.object + execFileSync(process.env.HOME + "/.foundry/bin/cast", ["abi-encode", "f(address[],uint8)", `[${owners.join(",")}]`, "1"], { encoding: "utf8" }).trim().slice(2), "--json");
await throws(new M.Vault(A, JSON.parse(rogue).contractAddress).read(), /not created by the OPEQ shared vault factory/, "a vault deployed outside the factory is refused even with identical code");
const smuggle = { to: want, value: 0n, data: Uint8Array.from(Buffer.from(M.setOwnersCall(want, [A.account, B.account], 2).data.slice(0, 4).reduce((h, b) => h + b.toString(16).padStart(2, "0"), "") + "00000000000000000000000000000000000000000000000000000000000000a0" + "0000000000000000000000000000000000000000000000000000000000000001" + "0000000000000000000000000000000000000000000000000000000000000002" + A.account.slice(2).padStart(64, "0") + B.account.slice(2).padStart(64, "0") + "0000000000000000000000000000000000000000000000000000000000000001" + C.account.slice(2).padStart(64, "0"), "hex")) };
ok(M.describe(smuggle, want).kind === "contract", "a non-standard owner change is shown as a risky contract call, not as an owner list");
ok(M.describe({ to: dest, value: 0n, data: Uint8Array.of(0xa9, 0x05, 0x9c, 0xbb, 1, 2) }, want).kind === "contract", "malformed token data does not throw");
await throws(Promise.resolve().then(() => M.checkOwners([A.account, A.account], 1)), /twice/, "duplicate owner refused");
await throws(Promise.resolve().then(() => M.checkOwners([A.account], 2)), /between 1 and 1/, "threshold above owner count refused");

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
