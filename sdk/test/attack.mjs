import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import * as SDK from "../index.js";
import { FileStore } from "../filestore.js";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = join(here, "..");
const { wots: W, evmWots: E, mnemonic: M } = SDK.lowLevel;
const { unhex } = SDK;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
async function refused(fn, re, name) {
  try { await fn(); ok(false, `${name} (was accepted)`); }
  catch (e) { ok(re.test(e.message), `${name} (${e.message.slice(0, 80)})`); }
}
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "opeq-atk-")); chmodSync(d, 0o700); return d; };

const holder = `import { FileStore } from ${JSON.stringify(join(sdk, "filestore.js"))};
import { appendFileSync } from "node:fs";
const [dir, log] = process.argv.slice(1);
let s;
try { s = await FileStore.open(dir); } catch { process.exit(0); }
const t0 = performance.timeOrigin + performance.now();
await new Promise((r) => setTimeout(r, 150));
const t1 = performance.timeOrigin + performance.now();
appendFileSync(log, t0 + " " + t1 + "\\n");
await s.close();`;

{
  let worst = 0;
  for (let trial = 0; trial < 10; trial++) {
    const dir = scratch(), log = join(dir, "..", `atk-log-${process.pid}-${trial}`);
    writeFileSync(join(dir, ".lock"), "999999999 " + "cd".repeat(16));
    await Promise.all(Array.from({ length: 12 }, () => new Promise((res) => spawn(process.execPath, ["--input-type=module", "-e", holder, dir, log], { stdio: "ignore" }).on("exit", res))));
    const spans = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number)) : [];
    for (const [a0, a1] of spans) worst = Math.max(worst, spans.filter(([b0, b1]) => b0 < a1 && a0 < b1).length);
    rmSync(dir, { recursive: true, force: true }); rmSync(log, { force: true });
  }
  ok(worst <= 1, `12 processes racing for a stale lock, 10 rounds: never more than one holder (max at once: ${worst})`);
}

{
  const dir = scratch();
  writeFileSync(join(dir, ".lock"), "");
  await refused(() => FileStore.open(dir), /another process/, "an empty lock file counts as busy, not stale");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = scratch();
  const a = await FileStore.open(dir);
  await a.put({ id: "x", epoch: 0, next_leaf: 1, active: true });
  writeFileSync(join(dir, ".lock"), `${process.pid} ${"ef".repeat(16)}`);
  await refused(() => a.put({ id: "x", epoch: 0, next_leaf: 2, active: true }), /no longer holds/, "a store whose lock was replaced stops before writing");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = scratch();
  const a = await FileStore.open(dir);
  const closing = a.close();
  await refused(() => a.put({ id: "y", epoch: 0, next_leaf: 1, active: true }), /closed/, "a write sent while the store closes is refused");
  await closing;
  ok(!existsSync(join(dir, ".lock")), "close releases the lock");
  const b = await FileStore.open(dir);
  await a.close();
  ok(existsSync(join(dir, ".lock")), "closing an old store twice does not delete another holder's lock");
  await b.close();
  rmSync(dir, { recursive: true, force: true });
}

{
  const base = scratch();
  const open = join(base, "open");
  mkdirSync(open); chmodSync(open, 0o777);
  await refused(() => FileStore.open(open), /other users/, "a wallet folder other users can write is refused");
  const real = join(base, "real"); mkdirSync(real, { mode: 0o700 });
  const link = join(base, "link"); symlinkSync(real, link);
  await refused(() => FileStore.open(link), /not a link/, "a wallet folder that is a symlink is refused");
  const s = await FileStore.open(real);
  const loot = join(base, "loot.json");
  writeFileSync(loot, JSON.stringify({ id: "z", epoch: 0, next_leaf: 0, active: true }));
  const { createHash } = await import("node:crypto");
  symlinkSync(loot, join(real, createHash("sha256").update("z").digest("hex") + ".json"));
  await refused(() => s.get("z"), /link/, "a record planted as a symlink is not read");
  await refused(() => s.put({ id: "z", epoch: 0, next_leaf: 1, active: true }), /link/, "a write over a planted symlink is refused");
  await s.close();
  rmSync(base, { recursive: true, force: true });
}

{
  const v = M.deriveTree(unhex("11".repeat(32)), 0, null, SDK.b58decode(SDK.NETWORKS.devnet.program));
  const d = unhex("0a0b0c0d0e0f10111213141516171819");
  const { sig, path } = v.sign(5, d);
  const base = { pubSeed: v.pubSeed, root: v.root, leaf: 5, digest: d, signature: sig, path };
  ok(SDK.verifyWots(base) === true, "a real signature verifies");
  const ds = W.digits(d), forged = new Uint8Array(sig), f = new Uint8Array(18);
  for (let c = 0; c < 16; c++) {
    const up = Math.min(255, ds[c] + 7);
    forged.set(W.chainRun(v.pubSeed, 5, c, sig.subarray(c * 16, c * 16 + 16), ds[c], up - ds[c]), c * 16);
    f[c] = up;
  }
  f[16] = ds[16]; f[17] = ds[17];
  ok(SDK.verifyWots({ ...base, digest: f, signature: forged }) === false, "the 18-byte digest forgery is rejected");
  ok(SDK.verifyWots({ ...base, leaf: 2 ** 32 + 5 }) === false, "a leaf above the tree size is rejected");
  ok(SDK.verifyWots({ ...base, leaf: 5.9 }) === false, "a fractional leaf is rejected");
  ok(SDK.verifyWots({ ...base, signature: sig.slice(0, 100) }) === false, "a short signature is rejected");
  ok(SDK.verifyWots({ ...base, path: "zz" }) === false, "garbage input returns false instead of throwing");
  ok(SDK.verifySolanaInstruction(new Uint8Array(400), ["not base58!"], { pubSeed: v.pubSeed, root: v.root, aid: new Uint8Array(32), epoch: 0 }, "devnet") === null, "garbage Solana input returns null instead of throwing");
}

{
  const vault = new SDK.Vault({ rpcUrl: "http://127.0.0.1:1", network: "devnet", store: new SDK.MemoryStore() });
  const a1 = await vault.create("first password");
  const a2 = await vault.create("second password");
  const A = await vault.open(a1.id, "first password"), B = await vault.open(a2.id, "second password");
  const fa = await A.feeKey(), fb = await B.feeKey();
  ok(A.e !== B.e && A.e.payer.address === fa && B.e.payer.address === fb, "two accounts from one vault keep separate fee keys");
  B.close();
  ok(A.e.payer && A.e.payer.address === fa, "closing one account does not touch the other's fee key");
  const other = SDK.b58encode(new Uint8Array(32).fill(9));
  await refused(() => A.execute([{ programId: other, keys: [{ pubkey: other, isSigner: true, isWritable: true }], data: "00" }]), /only the OPEQ account/, "an instruction asking another key to sign is refused before any key is used");
  await refused(() => A.execute([{ programId: other, keys: [], data: { type: "Buffer", data: [1, 2] } }]), /data must be/, "JSON-serialized Buffer data is refused, not sent empty");
  await refused(() => A.execute([{ programId: other, keys: [], data: [0xa9, 0x105] }]), /data must be/, "byte values above 255 are refused, not wrapped");
  await refused(() => A.execute([{ programId: other, keys: [], data: new Uint16Array([0xa9, 0x1ff]) }]), /data must be/, "a Uint16Array is refused, not truncated");
  await refused(() => A.execute([{ programId: other, keys: [], data: "abc" }]), /even number/, "odd-length hex is refused");
  await refused(() => A.execute([{ programId: other, keys: [], data: "" }], { computeUnits: 2e6 }), /computeUnits/, "an impossible compute limit is refused");
  for (const bad of [-1n, 0, 1.5, "1e9", true, "0x10"]) await refused(() => A.send(other, bad), /lamports/, `lamports ${String(bad)} is refused`);
  console.log("     building an EVM identity (about 10 seconds)");
  const evm = await A.evm(31337, { rpcUrl: "http://127.0.0.1:1" });
  for (const bad of [-1n, 1n << 256n, true, 1.5]) await refused(() => evm.execute([{ to: "0x" + "22".repeat(20), value: bad }]), /value/, `EVM value ${String(bad)} is refused`);
  await refused(() => evm.send("0x" + "22".repeat(20), 0n), /wei/, "an EVM send of zero is refused");
  await refused(() => evm.execute([{ to: "0x" + "22".repeat(20), value: 0n, data: { type: "Buffer", data: [] } }]), /data must be/, "EVM call data must be real bytes");
  await refused(() => A.evm(8453, { rpcUrl: "https://mainnet.base.org", checkUrl: "https://mainnet.base.org/x" }), /different provider/, "the second EVM RPC must be another provider");
  await refused(() => A.evm(8453, { rpcUrl: "http://example.com", checkUrl: "https://mainnet.base.org" }), /https/, "a plain-http EVM RPC is refused");
  A.close();
  await refused(() => A.send(other, 1n), /closed/, "a closed account cannot sign");
}

await refused(async () => new SDK.Vault({ rpcUrl: "https://a.example", network: "mainnet", store: new SDK.MemoryStore() }), /checkRpcUrl/, "mainnet needs a second Solana RPC");
await refused(async () => new SDK.Vault({ rpcUrl: "https://a.example", checkRpcUrl: "https://A.example/2", network: "mainnet", store: new SDK.MemoryStore() }), /different provider/, "the second Solana RPC must be another provider");
await refused(async () => new SDK.Vault({ rpcUrl: "http://a.example", network: "devnet", store: new SDK.MemoryStore() }), /https/, "a plain-http Solana RPC is refused");

{
  const master = unhex("33".repeat(32)), account = "0x" + "44".repeat(20), ps = unhex("0102030405060708090a0b0c0d0e0f10");
  console.log("     building an EVM key tree (about 10 seconds)");
  const t = E.deriveChainTree(master, 31337, account, 1, ps);
  const calls = [{ to: "0x0000000000000000000000000000000000000b0b", value: 5n, data: new Uint8Array(0) }];
  const rnd = unhex("aa".repeat(16));
  const g = E.grind(E.execHasher(rnd, 31337, account, 1, 2, 1900000000n, calls), 64);
  const cd = E.encodeExecute(calls, 2, 1900000000n, g.salt, rnd, t.sign(2, g.digest));
  const ctx = { chainId: 31337, account, epoch: 1, pubSeed: ps, root: t.root };
  ok(SDK.verifyEvmExecute(cd, ctx) !== null, "a canonical EVM execute verifies");
  const callsAt = 4 + 192;
  const toAt = callsAt + 32 + 32;
  const dirty = cd.slice(); dirty[toAt] = 0xff;
  ok(SDK.verifyEvmExecute(dirty, ctx) === null, "dirty upper address bytes are rejected like the contract's ABI decoder does");
  const rndLow = cd.slice(); rndLow[4 + 128 + 20] = 1;
  ok(SDK.verifyEvmExecute(rndLow, ctx) === null, "bytes in the unused half of the randomizer word are rejected");
  const tail = new Uint8Array(cd.length + 32); tail.set(cd);
  ok(SDK.verifyEvmExecute(tail, ctx) === null, "trailing bytes are rejected");
  ok(SDK.verifyEvmExecute(cd, { ...ctx, pubSeed: "zz" }) === null, "garbage EVM context returns null instead of throwing");
}

{
  const stray = join(sdk, "examples", "stray-wallet.json");
  writeFileSync(stray, "{}");
  const r = spawnSync("python3", [join(sdk, "..", "build_sdk.py"), "--pack", "--out", join(tmpdir(), `opeq-atk-${process.pid}.tgz`)], { encoding: "utf8" });
  rmSync(stray, { force: true });
  ok(r.status !== 0 && /refusing to pack/.test(r.stdout + r.stderr), "a wallet file left in examples/ cannot be packed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
