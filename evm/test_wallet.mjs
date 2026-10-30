import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EvmChain, checkAddress, parseUnits, formatUnits } from "../web/lib/evmwallet.js";
import { MemoryStore } from "../web/lib/vaultstore.js";
import { localCompute } from "../web/lib/compute.js";
import { sha256 } from "../web/lib/sha256.js";
import * as E from "../web/lib/evmwots.js";
import { encodeErc20Transfer } from "../web/lib/evmwots.js";

const BOOT_PIN = "674e4c0c56ea2b9094d2a26395b3cb63fd60336757e8c06f4840764e52613500";
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

console.log("gas key top-up");
ok((await A.topupPlan(0n)) === 0n, "no top-up while the gas key holds enough");
cast("rpc", "anvil_setBalance", A.feeAddress, "0x" + (2n * 10n ** 15n).toString(16));
const top = await A.topupPlan(10n ** 16n);
const accBefore = (await A.status()).bal;
ok(top > 0n && top <= (accBefore - 10n ** 16n) / 4n, `top-up planned: ${formatUnits(top, 18, 8)} ETH, at most a quarter of what is left`);
const feeBefore = BigInt(cast("balance", A.feeAddress));
const rt = await A.execute([{ to: bob, value: 10n ** 16n, data: new Uint8Array(0) }, { to: A.feeAddress, value: top, data: new Uint8Array(0) }]);
const feeAfter = BigInt(cast("balance", A.feeAddress));
ok(feeAfter > feeBefore && feeAfter - feeBefore < top, `gas key refilled inside the same transaction (gas ${rt.gasUsed})`);
ok((await A.topupPlan(0n)) === 0n, "no further top-up needed");
cast("rpc", "anvil_setBalance", A.feeAddress, "0x" + (2n * 10n ** 18n).toString(16));

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

console.log("takeover retries never reuse a key");
const C = device(new MemoryStore());
await C.loadIdentity(null);
const realC = C.sendTx.bind(C);
C.sendTx = async () => { throw new Error("simulated stuck takeover"); };
const picked = [];
for (let i = 0; i < 8; i++) {
  await throws(C.takeover(null), /simulated stuck/, `takeover attempt ${i + 1} interrupted`);
  picked.push((await C.store.get(C.key)).used.at(-1));
}
ok(new Set(picked).size === 8 && picked.every((l) => l >= 1016 && l < 1024), `8 retries used 8 different takeover keys: ${picked.join(",")}`);
await throws(C.takeover(null), /used all its takeover keys/, "9th retry refuses instead of reusing a key");
C.sendTx = realC;
const Bs = await B.status();
ok(Bs.state === "ready", "the real signer is unaffected by the stuck takeovers");

console.log("owner rekey stays below the takeover range");
const own = await B.store.get(B.key);
await B.store.put({ ...own, next_leaf: 1015 });
await B.put({ ...(await B.store.get(B.key)) });
const leafSeen = [];
const realB = B._rekey.bind(B);
B._rekey = async (r, leaf) => { leafSeen.push(leaf); throw new Error("stop"); };
await throws(B.rekey(null), /stop/, "owner rekey at the edge");
await throws(B.rekey(null), /no keys left/, "owner rekey refuses to enter the takeover range");
ok(leafSeen.join() === "1015", `owner rekey used leaf ${leafSeen.join()}`);
B._rekey = realB;

console.log("bootstrap: only the copy whose own bootstrap lands signs");
const master2 = sha256(enc.encode("opeq evm wallet test master 2"));
const dev2 = (store) => new EvmChain({ chain: CHAIN, store, macKey, vaultId: "vault2", master: master2.slice(), compute: localCompute });
const X = dev2(new MemoryStore()), Y = dev2(new MemoryStore());
await X.loadIdentity(null); await Y.loadIdentity(null);
cast("send", X.feeAddress, "--value", "1ether", "--private-key", ANVIL0);
const realX = X.sendTx.bind(X);
X.sendTx = async (to, data, value, gas, onHash) => { if (to === X.account && data.length > 400) throw new Error("simulated lost bootstrap"); return realX(to, data, value, gas, onHash); };
await throws(X.setup(null), /lost bootstrap/, "X's bootstrap never reached the chain");
X.sendTx = realX;
ok((await X.store.get(X.key)).pending_boot === true, "X keeps its epoch-1 record pending");
await Y.setup(null);
ok((await Y.status()).state === "ready", "Y's bootstrap landed, Y signs");
ok((await X.status()).state === "other", "X does not sign on the shared epoch-1 tree, it must take over");
const boot = await localCompute.run("evmBoot", { master: master.slice(), chainId: CHAIN.chainId, account: A.account });
const { createHash } = await import("node:crypto");
const pin = createHash("sha256").update(boot.calldata).digest("hex");
ok(pin === BOOT_PIN, `bootstrap calldata pinned (${pin.slice(0, 16)}…): changing it would let one slot key sign two messages`);

console.log("someone else submits the signed transaction first");
cast("send", Y.account, "--value", "1ether", "--private-key", ANVIL0);
const realSendB = Y.sendTx.bind(B);
Y.sendTx = async (to, data, value, gas, onHash) => {
  if (to !== Y.account) return realSendB(to, data, value, gas, onHash);
  const before = BigInt(cast("balance", bob));
  cast("send", Y.account, "0x" + Buffer.from(data).toString("hex"), "--private-key", ANVIL0);
  const e = new Error("the transaction failed on chain (0xabc)"); e.hash = "0xabc"; e.reverted = true; Y._frontrunPaid = BigInt(cast("balance", bob)) - before; throw e;
};
const fr = await Y.execute([{ to: bob, value: 11n, data: new Uint8Array(0) }]);
Y.sendTx = realSendB;
ok(fr.byOther === true && Y._frontrunPaid === 11n, "a front-run copy is reported as done, not as failed");

console.log("wrong network");
const W = new EvmChain({ chain: { ...CHAIN, chainId: 84532, name: "Base Sepolia" }, store: storeA, macKey, vaultId: "vaultA", master: master.slice(), compute: localCompute, rpcUrl: RPC });
await W.loadIdentity(null);
await throws(W.execute([]), /not Base Sepolia/, "RPC on another chain is refused before signing");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
