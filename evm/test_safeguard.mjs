import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Vault, MemoryStore } from "../sdk/index.js";
import { EvmRpc } from "../web/lib/evmwallet.js";
import { bytesToHex } from "../web/lib/evmtx.js";
import * as G from "../web/lib/safeguard.js";

const FORK = process.argv[2] || "https://mainnet.base.org";
const PORT = 21545 + Math.floor(Math.random() * 1000);
const A = `http://127.0.0.1:${PORT}`, B = `http://localhost:${PORT}`;
const CAST = join(homedir(), ".foundry", "bin", "cast");
const anvil = spawn(join(homedir(), ".foundry", "bin", "anvil"), ["--port", String(PORT), "--fork-url", FORK, "--silent"], { stdio: "ignore" });
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const STRANGER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ZERO = G.ZERO;
const VERSIONS = {
  "1.4.1": { factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", single: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", fallback: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" },
  "1.3.0": { factory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2", single: "0x3E5c63644E683549055b9Be8653de26E0B4CD36E", fallback: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4" },
  "1.5.0": { factory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b", single: "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e", fallback: "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47" },
};
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
const execArgs = (to, value, data, op) => [to, value, data, op, 0, 0, 0, ZERO, ZERO];
const execSafe = (safe, to, value, data, op = 0) => tx(OWNER, safe, cd("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", ...execArgs(to, value, data, op), sigOwner));
const nonceOf = async (safe) => BigInt(await call(safe, cd("nonce()")));
const chainHash = async (safe, to, value, data, op = 0) => call(safe, cd("getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)", ...execArgs(to, value, data, op), await nonceOf(safe)));
const bal = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
const warp = async (s) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); };
const fakeChain = (r) => ({ rpc: r, check: null, id: 8453, at: (fn) => fn("latest") });

async function makeSafe(v, salt) {
  const c = VERSIONS[v];
  const init = cd("setup(address[],uint256,address,bytes,address,address,uint256,address)", `[${OWNER}]`, 1, ZERO, "0x", c.fallback, ZERO, 0, ZERO);
  const create = cd("createProxyWithNonce(address,bytes,uint256)", c.single, init, salt);
  const safe = "0x" + (await call(c.factory, create)).slice(26);
  await tx(OWNER, c.factory, create);
  await tx(OWNER, safe, "0x", 10n ** 18n);
  return safe;
}

try {
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
  ok(Number(await rpc("eth_chainId")) === 8453, "fork of Base mainnet with the real Safe contracts");
  const r = new EvmRpc(A), chain = fakeChain(r);
  const GUARD = G.guardAddress();

  ok(await tx(OWNER, "0x4e59b44847b379578588920ca78fbf26c0b4956c", bytesToHex(G.guardDeployData())), "guard installed through the standard CREATE2 deployer");
  ok(G.isGuardCode(await r.code(GUARD)), `guard landed at the predicted address ${GUARD} with the expected code`);

  const SAFE = await makeSafe("1.4.1", 4242);
  console.log("     safe", SAFE);
  let st = await G.read(chain, SAFE);
  ok(st.safe.version === "1.4.1" && st.safe.owners[0] === OWNER && st.safe.threshold === 1, "a normal Safe 1.4.1 is recognised (proxy code, singleton, owners)");
  ok(!G.lockState(st, OWNER).locked && G.lockState(st, OWNER).issues.length >= 3, "lock check: an unlocked Safe shows what is missing");
  let threw = false;
  try { await G.readSafeAt(r, "0x4200000000000000000000000000000000000006"); } catch { threw = true; }
  ok(threw, "a contract that is not a Safe proxy is refused");

  const vault = new Vault({ rpcUrl: "http://127.0.0.1:1", network: "devnet", store: new MemoryStore() });
  const { id } = await vault.create("safe guard test");
  const acct = await vault.open(id, "safe guard test");
  console.log("     building EVM key trees, about a minute");
  const base = await acct.evm(8453, { rpcUrl: A, checkUrl: B });
  await rpc("anvil_setBalance", [base.feeAddress, "0x56BC75E2D63100000"]);
  ok((await base.setup()) === "ready", "OPEQ account set up on the Base fork");
  const OPEQ = base.address.toLowerCase();
  const approveHash = (safe, h) => base.execute([G.approveCall(safe, h)]);

  const conf = G.configureData([OPEQ], 1, 7);
  ok(!(await execSafe(SAFE, GUARD, 0, conf)), "configure is refused while the Safe has a fallback handler");
  ok(await execSafe(SAFE, SAFE, 0, G.setFallbackData(ZERO)), "owner removed the fallback handler");
  ok(await execSafe(SAFE, GUARD, 0, conf), "guard configured with the wallet's calldata: OPEQ account approves, 7 day delay");
  ok(await execSafe(SAFE, SAFE, 0, G.setGuardData(GUARD)), "guard installed on the Safe with the wallet's calldata");
  st = await G.read(chain, SAFE);
  ok(G.lockState(st, OPEQ).locked, "lock check: locked");
  ok(st.guard.required === 1 && st.guard.delay === 7 * 86400 && st.guard.approvers[0] === OPEQ, "guard settings read back: 1 approver, 7 days");

  const bob = "0x0000000000000000000000000000000000000b0b";
  const pay = G.parseTx(bob, 10n ** 17n, "0x", 0);
  ok(!(await execSafe(SAFE, bob, 10n ** 17n, "0x")), "owner signature alone cannot move funds");
  const h1 = G.safeTxHash(8453, SAFE, pay, st.safe.nonce);
  ok(h1 === (await chainHash(SAFE, bob, 10n ** 17n, "0x")), "the wallet computes the same Safe transaction hash as the Safe contract");
  ok(G.describe(pay, SAFE)[0].kind === "pay", "payment described in plain words");
  ok(!(await tx(STRANGER, GUARD, bytesToHex(G.approveCall(SAFE, h1).data))), "a random address cannot approve");
  await approveHash(SAFE, h1);
  ok(await G.approvedBy(chain, SAFE, h1, OPEQ), "the OPEQ approval is on chain");
  ok(await execSafe(SAFE, bob, 10n ** 17n, "0x"), "owner + OPEQ approval: payment went through");
  ok((await bal(bob)) === 10n ** 17n, "bob received 0.1 ETH");
  ok(!(await execSafe(SAFE, bob, 10n ** 17n, "0x")), "the approval cannot be replayed");

  const ms = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
  const pack = (to, value, data) => "00" + to.slice(2).toLowerCase() + value.toString(16).padStart(64, "0") + ((data.length - 2) / 2).toString(16).padStart(64, "0") + data.slice(2);
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const tdata = cd("transfer(address,uint256)", bob, 5);
  const batch = cd("multiSend(bytes)", "0x" + pack(bob, 1000n, "0x") + pack(usdc, 0n, tdata));
  const bd = G.describe(G.parseTx(ms, 0n, batch, 1), SAFE);
  ok(bd.length === 2 && bd[0].kind === "pay" && bd[0].value === 1000n && bd[1].kind === "token" && bd[1].to === bob && bd[1].amount === 5n, "a Safe app batch (MultiSendCallOnly) is opened and each call described");
  ok(G.describe(G.parseTx(ms.replace("96", "97"), 0n, batch, 1), SAFE)[0].kind === "delegate", "delegatecall to anything else is flagged");
  ok(G.describe(G.parseTx(SAFE, 0n, G.setGuardData(ZERO), 0), SAFE)[0].kind === "setGuard", "removing the guard is recognised");
  const cdesc = G.describe(G.parseTx(GUARD, 0n, G.configureData([OPEQ, bob], 2, 30), 0), SAFE)[0];
  ok(cdesc.kind === "configure" && cdesc.required === 2 && cdesc.approvers.length === 2 && cdesc.delay === 30 * 86400, "guard settings change is decoded");

  const pay2 = G.parseTx(bob, 2n, "0x", 0);
  const h2 = G.safeTxHash(8453, SAFE, pay2, await nonceOf(SAFE));
  const mod = G.parseTx(SAFE, 0n, cd("enableModule(address)", STRANGER), 0);
  const hm = G.safeTxHash(8453, SAFE, mod, await nonceOf(SAFE));
  await approveHash(SAFE, hm);
  ok(!(await execSafe(SAFE, SAFE, 0, bytesToHex(mod.data))), "even an approved transaction cannot enable a module");

  const rm = G.parseTx(SAFE, 0n, G.setGuardData(ZERO), 0);
  const hr = G.safeTxHash(8453, SAFE, rm, await nonceOf(SAFE));
  ok(!(await tx(STRANGER, GUARD, cd("requestRecovery(address,bytes32)", SAFE, hr))), "a non-owner cannot start recovery");
  ok(await tx(OWNER, GUARD, cd("requestRecovery(address,bytes32)", SAFE, hr)), "owner started recovery (remove guard) without OPEQ");
  st = await G.read(chain, SAFE);
  ok(st.guard.recoveries.length === 1 && st.guard.recoveries[0].hash === hr, "the wallet sees the pending recovery request");
  ok(!(await execSafe(SAFE, SAFE, 0, bytesToHex(rm.data))), "recovery cannot run before the delay");
  await base.execute([G.cancelCall(SAFE, hr)]);
  st = await G.read(chain, SAFE);
  ok(st.guard.recoveries.length === 0, "OPEQ cancelled it with the wallet's call, the list is empty");
  await warp(8 * 86400);
  ok(!(await execSafe(SAFE, SAFE, 0, bytesToHex(rm.data))), "a cancelled recovery never runs");
  for (let i = 0; i < 16; i++) await tx(OWNER, GUARD, cd("requestRecovery(address,bytes32)", SAFE, "0x" + (i + 1).toString(16).padStart(64, "0")));
  st = await G.read(chain, SAFE);
  ok(st.guard.recoveries.length === 1, "one owner holds at most one recovery request, a new one replaces the old one (no slot spam)");
  await base.execute([G.cancelCall(SAFE, st.guard.recoveries[0].hash)]);
  st = await G.read(chain, SAFE);
  ok(st.guard.recoveries.length === 0, "the approver can clear it");
  await tx(OWNER, GUARD, cd("requestRecovery(address,bytes32)", SAFE, "0x" + (200).toString(16).padStart(64, "0")));
  await warp(38 * 86400);
  ok(await tx(OWNER, GUARD, cd("requestRecovery(address,bytes32)", SAFE, hr)), "after an old request expires, a new recovery can be requested");
  st = await G.read(chain, SAFE);
  ok(st.guard.recoveries.length === 1 && st.guard.recoveries[0].hash === hr, "only the new request is left");
  await warp(38 * 86400);
  ok(!(await execSafe(SAFE, SAFE, 0, bytesToHex(rm.data))), "a recovery not used within 30 days after it became ready expires");
  await tx(OWNER, GUARD, cd("requestRecovery(address,bytes32)", SAFE, hr));
  await warp(7 * 86400 + 1);
  ok(await execSafe(SAFE, SAFE, 0, bytesToHex(rm.data)), "an uncancelled recovery runs after 7 days");
  st = await G.read(chain, SAFE);
  ok(st.safe.guard === ZERO && st.guard.recoveries.length === 0, "guard removed and the used request left the list");
  ok(h2 !== hr, "hashes differ per nonce");

  for (const v of ["1.3.0", "1.5.0"]) {
    const s2 = await makeSafe(v, 5151);
    const r2 = await G.read(chain, s2);
    ok(r2.safe.version === v, `Safe ${v} recognised`);
    ok(await execSafe(s2, s2, 0, G.setFallbackData(ZERO)) && await execSafe(s2, GUARD, 0, conf) && await execSafe(s2, s2, 0, G.setGuardData(GUARD)), `Safe ${v}: fallback removed, guard configured and installed`);
    ok(G.lockState(await G.read(chain, s2), OPEQ).locked, `Safe ${v}: lock check says locked`);
    ok(!(await execSafe(s2, bob, 1n, "0x")), `Safe ${v}: owner alone cannot move funds`);
    const p = G.parseTx(bob, 1n, "0x", 0);
    const h = G.safeTxHash(8453, s2, p, await nonceOf(s2));
    ok(h === (await chainHash(s2, bob, 1n, "0x")), `Safe ${v}: wallet hash matches the contract`);
    await approveHash(s2, h);
    ok(await execSafe(s2, bob, 1n, "0x"), `Safe ${v}: owner + OPEQ approval goes through`);
  }
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
