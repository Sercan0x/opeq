import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Vault, MemoryStore } from "../sdk/index.js";
import { EvmRpc } from "../web/lib/evmwallet.js";
import { bytesToHex } from "../web/lib/evmtx.js";
import * as G from "../web/lib/safeguard.js";
import { ACCOUNT_RUNTIME } from "../web/lib/evmcode.js";

const FORK = process.argv[2] || "https://mainnet.base.org";
const PORT = 22545 + Math.floor(Math.random() * 1000);
const A = `http://127.0.0.1:${PORT}`, B = `http://localhost:${PORT}`;
const CAST = join(homedir(), ".foundry", "bin", "cast");
const anvil = spawn(join(homedir(), ".foundry", "bin", "anvil"), ["--port", String(PORT), "--fork-url", FORK, "--silent"], { stdio: "ignore" });
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ATTACKER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const SECOND = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const ZERO = G.ZERO;
const SINGLE = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const MULTISEND = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526";
const WRITER = "0x00000000000000000000000000000000005eed01";
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };

async function rpc(method, params = []) {
  const r = await fetch(A, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const cd = (sig, ...args) => execFileSync(CAST, ["calldata", sig, ...args.map(String)]).toString().trim();
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
async function tx(from, to, data = "0x", value = 0n) {
  const h = await rpc("eth_sendTransaction", [{ from, to, data, value: "0x" + value.toString(16), gas: "0x1000000" }]);
  for (;;) { const r = await rpc("eth_getTransactionReceipt", [h]); if (r) return r.status === "0x1"; await new Promise((s) => setTimeout(s, 100)); }
}
const sigOwner = "0x" + OWNER.slice(2).padStart(64, "0") + "0".repeat(64) + "01";
const execFull = (safe, to, value, data, op, gasPrice, refund) => tx(OWNER, safe, cd("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", to, value, data, op, 0, 0, gasPrice, ZERO, refund, sigOwner));
const execSafe = (safe, to, value, data, op = 0) => execFull(safe, to, value, data, op, 0, ZERO);
const nonceOf = async (safe) => BigInt(await call(safe, cd("nonce()")));
const hashOf = async (safe, to, value, data, op = 0) => G.safeTxHash(8453, safe, G.parseTx(to, value, data, op), await nonceOf(safe));
const bal = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
const chain = (r) => ({ rpc: r, check: null, id: 8453, at: (fn) => fn("latest") });

async function makeSafe(salt) {
  const init = cd("setup(address[],uint256,address,bytes,address,address,uint256,address)", `[${OWNER}]`, 1, ZERO, "0x", HANDLER, ZERO, 0, ZERO);
  const create = cd("createProxyWithNonce(address,bytes,uint256)", SINGLE, init, salt);
  const safe = "0x" + (await call(FACTORY, create)).slice(26);
  await tx(OWNER, FACTORY, create);
  await tx(OWNER, safe, "0x", 10n ** 18n);
  return safe;
}

async function lock(safe, approvers, required) {
  await execSafe(safe, safe, 0, G.setFallbackData(ZERO));
  const a = await execSafe(safe, G.guardAddress(), 0, G.configureData(approvers, required, 7));
  const b = await execSafe(safe, safe, 0, G.setGuardData(G.guardAddress()));
  return a && b;
}

try {
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
  const r = new EvmRpc(A);
  const GUARD = G.guardAddress();
  await tx(OWNER, "0x4e59b44847b379578588920ca78fbf26c0b4956c", bytesToHex(G.guardDeployData()));
  ok(G.isGuardCode(await r.code(GUARD)), "guard installed on the Base fork");
  await rpc("anvil_setCode", [WRITER, "0x602035600035550000"]);
  await rpc("anvil_setCode", [SECOND, "0x" + ACCOUNT_RUNTIME]);
  await rpc("anvil_impersonateAccount", [SECOND]);
  await rpc("anvil_setBalance", [SECOND, "0xDE0B6B3A7640000"]);

  const vault = new Vault({ rpcUrl: "http://127.0.0.1:1", network: "devnet", store: new MemoryStore() });
  const { id } = await vault.create("attack round");
  const acct = await vault.open(id, "attack round");
  console.log("     building EVM key trees, about a minute");
  const base = await acct.evm(8453, { rpcUrl: A, checkUrl: B });
  await rpc("anvil_setBalance", [base.feeAddress, "0x56BC75E2D63100000"]);
  await base.setup();
  const OPEQ = base.address.toLowerCase();
  const approve = (safe, h) => base.execute([G.approveCall(safe, h)]);

  const S1 = await makeSafe(9001), S2 = await makeSafe(9002);
  ok(await lock(S1, [OPEQ], 1) && await lock(S2, [OPEQ], 1), "two Safes locked with the same OPEQ approver");
  const bob = "0x0000000000000000000000000000000000000b0b";

  const h1 = await hashOf(S1, bob, 10n ** 16n, "0x");
  await approve(S1, h1);
  ok(!(await execSafe(S2, bob, 10n ** 16n, "0x")), "A1 cross-Safe replay: an approval for Safe 1 does not move funds from Safe 2");
  ok(await execSafe(S1, bob, 10n ** 16n, "0x"), "A1 the approval still works on the Safe it was made for");

  const hFake = await hashOf(S1, ATTACKER, 10n ** 17n, "0x");
  ok(!(await tx(OWNER, GUARD, cd("approve(address,bytes32)", S1, hFake))), "A2 a Safe owner cannot approve on the guard");
  ok(!(await tx(ATTACKER, GUARD, cd("approve(address,bytes32)", S1, hFake))), "A2 an outsider cannot approve on the guard");

  await tx(ATTACKER, GUARD, G.configureData([ATTACKER], 1, 7));
  const st1 = await G.read(chain(r), S1);
  ok(st1.guard.approvers.length === 1 && st1.guard.approvers[0] === OPEQ, "A3 configure called by an outsider only touches the outsider's own settings, not the Safe's");
  ok(!(await execSafe(S1, GUARD, 0, G.configureData([ATTACKER], 1, 7))), "A4 owners cannot swap the OPEQ approver without OPEQ approval");
  ok(!(await execSafe(S1, S1, 0, G.setGuardData(ZERO))), "A4 owners cannot remove the guard without OPEQ approval");
  ok(!(await execSafe(S1, bob, 0, "0x", 1)), "A4 owners cannot run a delegate call without OPEQ approval");

  const modSlot = BigInt(execFileSync(CAST, ["index", "address", "0x0000000000000000000000000000000000000001", "1"]).toString().trim());
  const writeMod = "0x" + modSlot.toString(16).padStart(64, "0") + ATTACKER.slice(2).padStart(64, "0");
  await approve(S1, await hashOf(S1, WRITER, 0n, writeMod, 1));
  ok(!(await execSafe(S1, WRITER, 0, writeMod, 1)), "A5 even an OPEQ-approved delegate call cannot plant a module by writing storage");
  const writeFb = "0x" + G.FALLBACK_SLOT.toString(16).padStart(64, "0") + ATTACKER.slice(2).padStart(64, "0");
  await approve(S1, await hashOf(S1, WRITER, 0n, writeFb, 1));
  ok(!(await execSafe(S1, WRITER, 0, writeFb, 1)), "A5 even an OPEQ-approved delegate call cannot plant a fallback handler");
  ok(G.describe(G.parseTx(WRITER, 0n, writeFb, 1), S1)[0].kind === "delegate", "A5 the wallet shows such a call as a delegate call with full control");

  ok(await execSafe(S1, GUARD, 0, G.configureData([OPEQ, SECOND], 1, 7)) === false, "A6 setup: changing approvers needs OPEQ approval");
  const hc = await hashOf(S1, GUARD, 0n, G.configureData([OPEQ, SECOND], 1, 7));
  await approve(S1, hc);
  ok(await execSafe(S1, GUARD, 0, G.configureData([OPEQ, SECOND], 1, 7)), "A6 setup: OPEQ approved adding a second approver");
  const hs = await hashOf(S1, ATTACKER, 10n ** 17n, "0x");
  const hs2 = G.safeTxHash(8453, S1, G.parseTx(ATTACKER, 10n ** 17n, "0x", 0), (await nonceOf(S1)) + 1n);
  ok(await tx(SECOND, GUARD, cd("approve(address,bytes32)", S1, hs2)), "A6 the second approver pre-approves a payment for a later nonce");
  const hr = await hashOf(S1, GUARD, 0n, G.configureData([OPEQ], 1, 7));
  await approve(S1, hr);
  ok(await execSafe(S1, GUARD, 0, G.configureData([OPEQ], 1, 7)), "A6 the second approver is removed");
  ok(hs !== hs2, "A6 setup: the pre-approved hash is for the next nonce");
  ok(!(await execSafe(S1, ATTACKER, 10n ** 17n, "0x")), "A6 an approval from a removed approver no longer counts");

  ok(await (async () => { const h = await hashOf(S1, GUARD, 0n, G.configureData([OPEQ, SECOND], 2, 7)); await approve(S1, h); return execSafe(S1, GUARD, 0, G.configureData([OPEQ, SECOND], 2, 7)); })(), "A7 setup: 2 of 2 OPEQ approvals");
  const h7 = await hashOf(S1, bob, 1n, "0x");
  await approve(S1, h7);
  ok(!(await execSafe(S1, bob, 1n, "0x")), "A7 with 2 needed, one approval is not enough");
  await tx(SECOND, GUARD, cd("approve(address,bytes32)", S1, h7));
  ok(await execSafe(S1, bob, 1n, "0x"), "A7 with both approvals it runs");

  const h8 = await hashOf(S1, bob, 2n, "0x");
  await approve(S1, h8);
  await tx(SECOND, GUARD, cd("approve(address,bytes32)", S1, h8));
  const before = await bal(ATTACKER);
  await rpc("anvil_setBalance", [OWNER, "0x56BC75E2D63100000"]);
  ok(!(await execFull(S1, bob, 2n, "0x", 0, 1000000000, ATTACKER)), "A8 the same payment with a gas refund to an attacker is refused (the approval covers zero gas fields only)");
  ok((await bal(ATTACKER)) === before, "A8 the attacker received no refund");
  ok(await execSafe(S1, bob, 2n, "0x"), "A8 the approved zero-gas version still runs");

  const n = await nonceOf(S1);
  const hAhead = G.safeTxHash(8453, S1, G.parseTx(bob, 3n, "0x", 0), n + 1n);
  await approve(S1, hAhead);
  await tx(SECOND, GUARD, cd("approve(address,bytes32)", S1, hAhead));
  ok(!(await execSafe(S1, bob, 3n, "0x")), "A9 an approval for a later nonce cannot be used now");

  const pre = JSON.stringify((await G.read(chain(r), S1)).guard, (k, v) => typeof v === "bigint" ? String(v) : v);
  await tx(ATTACKER, GUARD, cd("checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)", bob, 0, "0x", 0, 0, 0, 0, ZERO, ZERO, "0x", ATTACKER));
  await tx(ATTACKER, GUARD, cd("checkAfterExecution(bytes32,bool)", hAhead, true));
  ok(pre === JSON.stringify((await G.read(chain(r), S1)).guard, (k, v) => typeof v === "bigint" ? String(v) : v), "A10 calling the guard's check functions from outside changes nothing for any Safe");
  ok(!(await tx(ATTACKER, GUARD, cd("cancelRecovery(address,bytes32)", S1, hAhead))), "A10 an outsider cannot cancel recovery requests");
  ok(!(await tx(OWNER, GUARD, cd("cancelRecovery(address,bytes32)", S1, hAhead))), "A10 an owner cannot cancel recovery requests either");

  ok(await tx(OWNER, GUARD, cd("requestRecovery(address,bytes32)", S2, "0x" + "00".repeat(31) + "01")), "A11 setup: owner may request recovery on Safe 2");
  const S2st = await G.read(chain(r), S2);
  const S1st = await G.read(chain(r), S1);
  ok(S2st.guard.recoveries.length === 1 && S1st.guard.recoveries.length === 0, "A11 a recovery request on one Safe never shows up on another");

  let refused = 0;
  for (const fake of ["0x4200000000000000000000000000000000000006", GUARD, OPEQ, bob]) { try { await G.readSafeAt(r, fake); } catch { refused++; } }
  ok(refused === 4, "A12 the wallet refuses addresses that are not real Safe proxies (WETH, the guard, an OPEQ account, an empty address)");

  const pack = (op, to, value, data) => op.toString(16).padStart(2, "0") + to.slice(2).toLowerCase() + value.toString(16).padStart(64, "0") + ((data.length - 2) / 2).toString(16).padStart(64, "0") + data.slice(2);
  const msData = (inner) => cd("multiSend(bytes)", "0x" + inner);
  ok(G.describe(G.parseTx("0x9641d764fc13c8B624c04430C7356C1C7C8102e2", 0n, msData(pack(1, WRITER, 0n, writeFb)), 1), S1)[0].kind === "delegate", "A13 a batch hiding a delegate call is not opened, it is flagged whole");
  ok(G.describe(G.parseTx(MULTISEND, 0n, msData(pack(0, bob, 5n, "0x")), 1), S1)[0].kind === "delegate", "A13 the full MultiSend (which allows delegate calls) is flagged, only MultiSendCallOnly is opened");
  ok(G.describe(G.parseTx("0x9641d764fc13c8B624c04430C7356C1C7C8102e2", 1n, msData(pack(0, bob, 5n, "0x")), 1), S1)[0].kind === "delegate", "A13 a batch call that carries value is flagged");
  const tok = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const tdata = cd("transfer(address,uint256)", bob, 5);
  ok(G.describe(G.parseTx(tok, 0n, tdata + "00".repeat(32), 0), S1)[0].kind === "contract", "A14 a token transfer with extra data appended is not shown as a plain transfer");
  ok(G.describe(G.parseTx(tok, 1n, tdata, 0), S1)[0].kind === "contract", "A14 a token transfer that also sends ETH is not shown as a plain transfer");
  ok(G.describe(G.parseTx(tok, 0n, tdata.slice(0, -2), 0), S1)[0].kind === "contract", "A14 a cut-off token transfer is not shown as a plain transfer");
  ok(G.describe(G.parseTx(bob, 0n, "0x00", 0), S1)[0].kind === "contract", "A14 a payment with hidden data is shown as a contract call");
  const ownerSwap = cd("swapOwner(address,address,address)", "0x0000000000000000000000000000000000000001", OWNER, ATTACKER);
  ok(G.describe(G.parseTx(S2, 0n, ownerSwap, 0), S1)[0].kind === "contract", "A14 an owner change aimed at a different Safe is not shown as a change of this Safe");
  let threw = 0;
  for (const bad of ["0xzz", "0x123", "nothex"]) { try { G.parseTx(bob, 0n, bad, 0); } catch { threw++; } }
  ok(threw === 3, "A15 malformed data is refused instead of being read as something else");
  ok(G.safeTxHash(8453, S1, G.parseTx(bob, 1n, "0x", 0), 5n) !== G.safeTxHash(1, S1, G.parseTx(bob, 1n, "0x", 0), 5n), "A16 the hash binds the chain, so an approval on Base is useless on Ethereum");

  const S3 = await makeSafe(9003);
  await execSafe(S3, S3, 0, G.setFallbackData(ZERO));
  ok(!(await execSafe(S3, GUARD, 0, G.configureData([OPEQ, ATTACKER], 1, 7))), "A17 the guard refuses a normal ECDSA address as approver, only OPEQ accounts");
  ok(await execSafe(S3, GUARD, 0, G.configureData([OPEQ, SECOND], 1, 7)), "A17 OPEQ accounts are accepted");
  const S4 = await makeSafe(9004);
  ok(await execSafe(S4, S4, 0, G.setGuardData(GUARD)), "A18 guard turned on in the wrong order (before settings, fallback still set)");
  ok(await execSafe(S4, bob, 1n, "0x"), "A18 the Safe is not frozen: without settings the guard lets transactions through");
  ok(await execSafe(S4, S4, 0, G.setFallbackData(ZERO)) && await execSafe(S4, GUARD, 0, G.configureData([OPEQ], 1, 7)), "A18 the owners can still finish the setup");
  ok(G.lockState(await G.read(chain(r), S4), OPEQ).locked && !(await execSafe(S4, bob, 1n, "0x")), "A18 after that the Safe is locked");
  const S5 = await makeSafe(9005);
  await lock(S5, [OPEQ, SECOND], 2);
  const n5 = await nonceOf(S5);
  const hz = G.safeTxHash(8453, S5, G.parseTx(ATTACKER, 10n ** 17n, "0x", 0), n5 + 2n);
  await tx(SECOND, GUARD, cd("approve(address,bytes32)", S5, hz));
  const c1 = G.configureData([OPEQ], 1, 7), c2 = G.configureData([OPEQ, SECOND], 1, 7);
  const hc1 = await hashOf(S5, GUARD, 0n, c1);
  await approve(S5, hc1); await tx(SECOND, GUARD, cd("approve(address,bytes32)", S5, hc1));
  ok(await execSafe(S5, GUARD, 0, c1), "A19 setup: second approver removed");
  await approve(S5, await hashOf(S5, GUARD, 0n, c2));
  ok(await execSafe(S5, GUARD, 0, c2), "A19 setup: second approver added back, 1 approval needed");
  ok(!(await execSafe(S5, ATTACKER, 10n ** 17n, "0x")), "A19 an approval made before the settings changed does not come back");
  ok(!(await G.approvedBy(chain(r), S5, hz, SECOND)), "A19 the wallet also reads it as not approved");
  const zeroTo = "00" + "0".repeat(40) + (0n).toString(16).padStart(64, "0") + (36).toString(16).padStart(64, "0") + G.setGuardData(ZERO).slice(2);
  ok(G.describe(G.parseTx("0x9641d764fc13c8B624c04430C7356C1C7C8102e2", 0n, msData(zeroTo), 1), S1)[0].kind === "delegate", "A20 a batch item sent to address zero (which MultiSend may turn into the Safe itself) is not opened, it is flagged whole");
  base.close();
  acct.close();
} catch (e) {
  fail++;
  console.log("FAIL", e.stack || e.message);
} finally {
  anvil.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
