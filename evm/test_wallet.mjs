import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EvmChain, checkAddress, parseUnits, formatUnits } from "../web/lib/evmwallet.js";
import { MemoryStore } from "../web/lib/vaultstore.js";
import { localCompute } from "../web/lib/compute.js";
import { sha256 } from "../web/lib/sha256.js";
import * as E from "../web/lib/evmwots.js";
import { encodeErc20Transfer } from "../web/lib/evmwots.js";

const RPC = process.argv[2] || "http://127.0.0.1:8549";
const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CHAIN = { chainId: 31337, name: "Local test", symbol: "ETH", rpc: RPC };
const enc = new TextEncoder();
const cast = (cmd, ...a) => execFileSync(process.env.HOME + "/.foundry/bin/cast", [cmd, "--rpc-url", RPC, ...a], { encoding: "utf8" }).trim();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  ", m); } else { fail++; console.log("  FAIL", m); } };
async function throws(p, re, m) {
  try { await p; ok(false, m + " (did not throw)"); } catch (e) { ok(re.test(e.message), `${m}: ${e.message.slice(0, 110)}`); }
}

const master = sha256(enc.encode("opeq evm wallet test master"));
const macKey = await crypto.subtle.importKey("raw", sha256(enc.encode("mac")), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const device = (store) => new EvmChain({ chain: CHAIN, store, macKey, vaultId: "vaultA", master: master.slice(), compute: localCompute });

const storeA = new MemoryStore(), storeB = new MemoryStore();
const A = device(storeA);
const steps = [];

console.log("helpers");
ok(checkAddress("0x52908400098527886E0F7030069857D2E4169EE7") === "0x52908400098527886e0f7030069857d2e4169ee7", "checksummed address accepted");
await throws(Promise.resolve().then(() => checkAddress("0x52908400098527886E0F7030069857D2E4169Ee7")), /checksum/, "bad checksum rejected");
await throws(Promise.resolve().then(() => checkAddress("0x0000000000000000000000000000000000000000")), /zero address/, "zero address rejected");
ok(parseUnits("0.01", 18) === 10n ** 16n && formatUnits(1234500000000000000n, 18) === "1.2345", "amount parse and format");
await throws(Promise.resolve().then(() => parseUnits("1.1234567", 6)), /decimals/, "too many decimals rejected");

console.log("identity");
let t0 = Date.now();
await A.loadIdentity(null);
console.log("  identity tree", Date.now() - t0, "ms, account", A.account);
const A2 = device(storeA);
t0 = Date.now();
await A2.loadIdentity(null);
ok(A2.account === A.account && Date.now() - t0 < 1000, "saved identity gives the same account without rebuilding");
const idRec = await storeA.get("vaultA:evm:id");
storeA.m.set("vaultA:evm:id", { ...idRec, root: "0x" + "ab".repeat(16) });
await throws(device(storeA).loadIdentity(null), /modified outside opeq/, "identity record edited outside opeq is refused");
storeA.m.set("vaultA:evm:id", idRec);
const other = new EvmChain({ chain: CHAIN, store: storeA, macKey, vaultId: "vaultA", master: sha256(enc.encode("other words")), compute: localCompute });
await throws(other.loadIdentity(null), /does not match/, "identity saved for other words is refused");

console.log("setup");
let s = await A.status();
ok(s.state === "setup", "fresh account needs setup");
await throws(A.setup(null), /gas key needs about/, "setup with an empty gas key explains what to fund");
cast("send", A.feeAddress, "--value", "2ether", "--private-key", ANVIL0);
cast("send", A.account, "--value", "1ether", "--private-key", ANVIL0);
ok((await A.status()).bal === 10n ** 18n, "funds arrive at the account address before it exists");
t0 = Date.now();
s = await A.setup(null, (m) => steps.push(m));
console.log("  setup took", Date.now() - t0, "ms:", steps.join(" / "));
ok(s.state === "ready" && s.st.epoch === 1 && s.left === E.EXEC_LIMIT, "account ready on its own tree, 1008 keys left");
const again = await localCompute.run("evmBoot", { master: master.slice(), chainId: CHAIN.chainId, account: A.account });
const again2 = await localCompute.run("evmBoot", { master: master.slice(), chainId: CHAIN.chainId, account: A.account });
ok(Buffer.from(again.calldata).equals(Buffer.from(again2.calldata)), "bootstrap signature is identical on every retry");

console.log("send ETH");
const poor = new EvmChain({ chain: CHAIN, store: storeA, macKey, vaultId: "vaultA", master: master.slice(), compute: localCompute });
await poor.loadIdentity(null);
poor.feeAddress = "0x00000000000000000000000000000000000dead1";
const leafBefore = (await poor.status()).r.next_leaf;
await throws(poor.execute([{ to: "0x000000000000000000000000000000000000b0b5", value: 1n, data: new Uint8Array(0) }]), /Nothing was signed/, "empty gas key stops the send before signing");
ok((await poor.status()).r.next_leaf === leafBefore, "no key was used up by the refused send");
const bob = "0x000000000000000000000000000000000000b0b5";
let hashSeen = null;
const r1 = await A.execute([{ to: bob, value: 10n ** 17n, data: new Uint8Array(0) }], (h) => (hashSeen = h));
ok(hashSeen === r1.hash, "hash reported before confirmation");
ok(BigInt(cast("balance", bob)) === 10n ** 17n, `bob got 0.1 ETH (gas ${r1.gasUsed})`);
s = await A.status();
ok(s.r.next_leaf === 1 && s.st.next === 1 && s.left === E.EXEC_LIMIT - 1, "counter moved locally and on chain");

console.log("interrupted signing burns the key, never reuses it");
const realSend = A.sendTx.bind(A);
A.sendTx = async () => { throw new Error("simulated crash after signing"); };
await throws(A.execute([{ to: bob, value: 1n, data: new Uint8Array(0) }]), /simulated crash/, "send interrupted after the signature was made");
A.sendTx = realSend;
s = await A.status();
ok(s.r.next_leaf === 2 && s.st.next === 1, "leaf 1 stays burned in the local record");
await A.execute([{ to: bob, value: 1n, data: new Uint8Array(0) }]);
s = await A.status();
ok(s.st.next === 3, "next send skipped to leaf 2 and the chain accepted it");

console.log("ERC-20");
const tokArt = JSON.parse(readFileSync(new URL("./out/Harness.sol/MockToken.json", import.meta.url)));
const deployed = JSON.parse(cast("send", "--private-key", ANVIL0, "--json", "--create", tokArt.bytecode.object));
const token = deployed.contractAddress;
cast("send", token, "mint(address,uint256)", A.account, "1000", "--private-key", ANVIL0);
const tk = await A.token(token);
ok(tk.balance === 1000n, `token read: balance ${tk.balance}, decimals ${tk.decimals}, symbol ${tk.symbol}`);
await A.execute([{ to: token, value: 0n, data: encodeErc20Transfer(bob, 250n) }]);
ok((await A.token(token)).balance === 750n, "token transfer signed and landed");
await throws(A.token(bob), /no contract/, "token lookup on an address with no contract is refused");

console.log("tampered local record");
const raw = await storeA.get(A.key);
storeA.m.set(A.key, { ...raw, next_leaf: 0 });
await throws(A.execute([{ to: bob, value: 1n, data: new Uint8Array(0) }]), /modified outside opeq/, "counter rolled back outside opeq is refused");
storeA.m.set(A.key, raw);
await throws(storeA.put({ ...raw, next_leaf: 0 }), /backwards/, "store refuses to move the counter backwards");

console.log("second device");
const B = device(storeB);
await B.loadIdentity(null);
s = await B.status();
ok(s.state === "other", "a recovered copy does not sign until Use on this device");
await throws(B.execute([{ to: bob, value: 1n, data: new Uint8Array(0) }]), /Use on this device/, "send from the second device is refused");
t0 = Date.now();
await B.takeover(null);
s = await B.status();
ok(s.state === "ready" && s.st.epoch === 2, `takeover moved the account to the second device's tree (${Date.now() - t0} ms)`);
ok((await A.status()).state === "other", "first device sees it is no longer the signer");
await throws(A.execute([{ to: bob, value: 1n, data: new Uint8Array(0) }]), /Use on this device/, "first device refuses to sign");
await B.execute([{ to: bob, value: 5n, data: new Uint8Array(0) }]);
ok((await B.status()).st.next === 1, "second device sends");

console.log("rekey");
const before = (await B.status()).st.root;
await B.rekey(null);
s = await B.status();
ok(s.state === "ready" && s.st.epoch === 3 && s.st.root !== before && s.left === E.EXEC_LIMIT, "rekey moved to a fresh tree, same address");
await B.execute([{ to: bob, value: 7n, data: new Uint8Array(0) }]);
ok((await B.status()).st.next === 1, "send after rekey");

console.log("wrong network");
const W = new EvmChain({ chain: { ...CHAIN, chainId: 84532, name: "Base Sepolia" }, store: storeA, macKey, vaultId: "vaultA", master: master.slice(), compute: localCompute, rpcUrl: RPC });
await W.loadIdentity(null);
await throws(W.execute([]), /not Base Sepolia/, "RPC on another chain is refused before signing");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
