import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as SDK from "../index.js";
import { FileStore } from "../filestore.js";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = join(here, "..");
const lib = join(sdk, "..", "web", "lib");
const { wots: W, evmWots: E, protocol: P, mnemonic: M } = SDK.lowLevel;
const { hex, unhex } = SDK;
let pass = 0, fail = 0;

function ok(cond, name) {
  if (cond) { pass++; console.log("ok  ", name); }
  else { fail++; console.log("FAIL", name); }
}

async function throws(fn, re, name) {
  try { await fn(); ok(false, name); }
  catch (e) { ok(re.test(e.message), `${name} (${e.message.slice(0, 70)})`); }
}

for (const f of readdirSync(join(sdk, "src", "lib"))) {
  ok(readFileSync(join(sdk, "src", "lib", f)).equals(readFileSync(join(lib, f))), `src/lib/${f} is the wallet's own file`);
}
ok(readFileSync(join(sdk, "src", "feekey.js")).equals(readFileSync(join(sdk, "..", "extension", "feekey.js"))), "src/feekey.js is the wallet's own file");

const { vectors } = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));
for (const v of vectors) {
  const net = v.network;
  const program = SDK.b58decode(SDK.NETWORKS[net].program);
  const master = M.fromWords(v.words);
  ok(hex(master) === v.master, `${net}: words decode to the reference master`);
  ok(M.toWords(unhex(v.master)).join(" ") === v.words, `${net}: master encodes to the reference words`);
  const t = M.deriveTree(master, 0, null, program);
  ok(hex(t.pubSeed) === v.pubSeed && hex(t.root) === v.root, `${net}: key tree root matches Python`);
  const acc = SDK.solanaAccountFor(unhex(v.pubSeed), unhex(v.root), net);
  ok(acc.id === v.aid && acc.wallet === v.wallet && acc.state === v.state, `${net}: account id, wallet and state addresses match Python`);
  const sig = { pubSeed: v.pubSeed, root: v.root, leaf: v.leaf, digest: v.digest, signature: v.signature, path: v.path };
  ok(SDK.verifyWots(sig), `${net}: Python signature verifies in JS`);
  const js = t.sign(v.leaf, unhex(v.digest));
  ok(hex(js.sig) === v.signature && hex(js.path) === v.path, `${net}: JS signature is byte-identical to Python`);
  const bad = unhex(v.signature); bad[5] ^= 1;
  ok(!SDK.verifyWots({ ...sig, signature: bad }), `${net}: a flipped signature byte is rejected`);
  ok(!SDK.verifyWots({ ...sig, leaf: v.leaf + 1 }), `${net}: the signature does not verify for another leaf`);

  const x = v.exec;
  const wallet = SDK.b58decode(v.wallet), state = SDK.b58decode(v.state), dest = SDK.b58decode(x.dest);
  const lam = new Uint8Array(12); lam[0] = 2; new DataView(lam.buffer).setBigUint64(4, BigInt(x.lamports), true);
  const inner = [[new Uint8Array(32), [[wallet, true, true], [dest, false, true]], lam]];
  const aid = unhex(v.aid);
  const d = P.salted(P.execHasher(program, aid, x.epoch, x.leaf, BigInt(x.expiry), inner, unhex(x.r)), x.salt);
  ok(hex(d) === x.digest, `${net}: exec digest matches Python`);
  const s2 = t.sign(x.leaf, d);
  const { outer } = P.outerLayout(state, wallet, inner);
  const data = P.buildExec(x.leaf, BigInt(x.expiry), x.salt, unhex(x.r), s2.sig, s2.path, inner, outer);
  const cur = { pubSeed: v.pubSeed, root: v.root, aid: v.aid, epoch: x.epoch };
  ok(SDK.verifySolanaInstruction(data, outer, cur, net) === x.leaf, `${net}: a full exec instruction verifies offline`);
  const t2 = data.slice(); t2[t2.length - 1] ^= 1;
  ok(SDK.verifySolanaInstruction(t2, outer, cur, net) === null, `${net}: changing the amount breaks the signature`);
  const other = outer.slice(); other[3] = SDK.b58decode(v.state);
  ok(SDK.verifySolanaInstruction(data, other, cur, net) === null, `${net}: swapping the destination account breaks the signature`);
  ok(SDK.verifySolanaInstruction(data, outer, { ...cur, epoch: 1 }, net) === null, `${net}: the signature does not verify under another epoch`);
  master.fill(0);
}

const em = unhex(vectors[0].master);
const account = "0x" + "11".repeat(20);
const ps = unhex("0102030405060708090a0b0c0d0e0f10");
console.log("     building an EVM key tree (about 10 seconds)");
const tree = E.deriveChainTree(em, 31337, account, 1, ps);
const calls = [{ to: "0x0000000000000000000000000000000000000b0b", value: 10n ** 15n, data: new Uint8Array(0) }, { to: "0x00000000000000000000000000000000000ca401", value: 0n, data: unhex("a9059cbb00ff") }];
const rnd = unhex("aa".repeat(16));
const g = E.grind(E.execHasher(rnd, 31337, account, 1, 3, 1800000600n, calls), 256);
const cd = E.encodeExecute(calls, 3, 1800000600n, g.salt, rnd, tree.sign(3, g.digest));
const ctx = { chainId: 31337, account, epoch: 1, pubSeed: ps, root: tree.root };
const got = SDK.verifyEvmExecute(cd, ctx);
ok(!!got && got.leaf === 3 && got.calls.length === 2 && got.calls[1].data.length === 6, "EVM execute calldata decodes and verifies offline");
ok(SDK.verifyEvmExecute(cd, { ...ctx, chainId: 8453 }) === null, "EVM signature is bound to its chain id");
ok(SDK.verifyEvmExecute(cd, { ...ctx, epoch: 2 }) === null, "EVM signature is bound to its epoch");
const cd2 = cd.slice(); cd2[4 + 192 + 32 + 64 + 32 + 31] ^= 1;
ok(SDK.verifyEvmExecute(cd2, ctx) === null, "changing an EVM call value breaks the signature");
ok(SDK.verifyEvmExecute(cd.slice(0, 100), ctx) === null, "truncated EVM calldata is rejected");

const dir = mkdtempSync(join(tmpdir(), "opeq-sdk-"));
try {
  const fs1 = await FileStore.open(dir);
  await fs1.put({ id: "a", epoch: 0, next_leaf: 5, active: true, pending: { nonce: 7n } });
  const back = await fs1.get("a");
  ok(back.next_leaf === 5 && back.pending.nonce === 7n, "FileStore keeps records, including big numbers");
  await throws(() => fs1.put({ id: "a", epoch: 0, next_leaf: 4, active: true }), /backwards/, "FileStore refuses to move the key counter back");
  await throws(() => fs1.put({ id: "a", epoch: 0, next_leaf: 6, active: false }).then(() => fs1.put({ id: "a", epoch: 0, next_leaf: 6, active: true })), /re-activate/, "FileStore refuses to re-activate a copy without a rekey");
  await throws(() => FileStore.open(dir), /another process/, "a second opener of the same folder is refused");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { FileStore } from ${JSON.stringify(join(sdk, "filestore.js"))}; try { await FileStore.open(${JSON.stringify(dir)}); console.log("opened"); } catch (e) { console.log(e.message); }`], { encoding: "utf8" });
  ok(/another process/.test(r.stdout), "another process cannot open the folder while it is in use");
  await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((n) => fs1.put({ id: "b", epoch: 0, next_leaf: n, active: true }).catch(() => null)));
  ok((await fs1.get("b")).next_leaf === 8, "parallel writes end on the highest counter");
  await fs1.close();
  writeFileSync(join(dir, ".lock"), "999999999");
  const fs2 = await FileStore.open(dir);
  ok((await fs2.get("a")).next_leaf === 6, "a stale lock from a dead process is taken over");
  await fs2.close();
} finally { rmSync(dir, { recursive: true, force: true }); }

let order = [];
await Promise.all([1, 2, 3].map((n) => navigator.locks.request("t", { mode: "exclusive" }, async () => { order.push(`in${n}`); await new Promise((r) => setTimeout(r, 10)); order.push(`out${n}`); })));
ok(order.join(",") === "in1,out1,in2,out2,in3,out3", "the Node lock runs signing jobs one at a time");
let busy = null;
await navigator.locks.request("u", { mode: "exclusive" }, async () => { busy = await navigator.locks.request("u", { mode: "exclusive", ifAvailable: true }, async (l) => l); });
ok(busy === null, "a busy wallet is reported instead of waited on");

await throws(async () => new SDK.Vault({ rpcUrl: "https://x", store: null }), /pass a store/, "a Vault needs a store");
await throws(async () => new SDK.Vault({ rpcUrl: "ftp://x", store: new SDK.MemoryStore() }), /http/, "a Vault needs an http(s) RPC");
ok(SDK.newWords().split(" ").length === 24 && SDK.checkWords(SDK.newWords()), "new words are 24 valid words");
await throws(async () => SDK.checkWords("abandon ".repeat(24)), /checksum|word/i, "words with a bad checksum are refused");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
