import { writeFileSync } from "node:fs";
import * as E from "../web/lib/evmwots.js";
import { sha256 } from "../web/lib/sha256.js";

const ACCOUNT = process.argv[2];
const CHAIN_ID = 31337;
const NOW = 1_800_000_000;
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const enc = new TextEncoder();

const master = sha256(enc.encode("opeq evm test vector master"));
let t0 = Date.now();
const identity = E.deriveIdentityTree(master);
const treeMs = Date.now() - t0;
const tree = E.deriveChainTree(master, CHAIN_ID, ACCOUNT, 1, sha256(enc.encode("opeq evm test pub seed 1")).slice(0, 16));
const next = E.deriveChainTree(master, CHAIN_ID, ACCOUNT, 2, sha256(enc.encode("opeq evm test pub seed 2")).slice(0, 16));
const rnd = sha256(enc.encode("opeq evm test rnd")).slice(0, 16);
const slot = E.chainSlot(CHAIN_ID);
const g0 = E.grind(E.rekeyHasher(rnd, CHAIN_ID, ACCOUNT, 0, slot, deadline0(), tree.pubSeed, tree.root), 4096);
const cd0 = E.encodeRekey(tree.pubSeed, tree.root, slot, deadline0(), g0.salt, rnd, identity.sign(slot, g0.digest));
function deadline0() { return NOW + 600; }
const deadline = NOW + 600;
const bob = "0x0000000000000000000000000000000000000b0b";
const carol = "0x00000000000000000000000000000000000ca401";

const v1calls = [{ to: bob, value: 10n ** 18n, data: new Uint8Array(0) }];
t0 = Date.now();
const g1 = E.grind(E.execHasher(rnd, CHAIN_ID, ACCOUNT, 1, 0, deadline, v1calls), 1 << 17);
const grindMs = Date.now() - t0;
const p1 = tree.sign(0, g1.digest);
if (!E.rootFromProof(tree.pubSeed, 0, g1.digest, p1).every((v, i) => v === tree.root[i])) throw new Error("JS self-check failed");
const cd1 = E.encodeExecute(v1calls, 0, deadline, g1.salt, rnd, p1);

const v2calls = [
  { to: bob, value: 25n * 10n ** 16n, data: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]) },
  { to: carol, value: 25n * 10n ** 16n, data: new Uint8Array(37).map((_, i) => i * 7) },
];
const g2 = E.grind(E.execHasher(rnd, CHAIN_ID, ACCOUNT, 1, 3, deadline, v2calls), 4096);
const cd2 = E.encodeExecute(v2calls, 3, deadline, g2.salt, rnd, tree.sign(3, g2.digest));

const g3 = E.grind(E.rekeyHasher(rnd, CHAIN_ID, ACCOUNT, 1, 4, deadline, next.pubSeed, next.root), 4096);
const cd3 = E.encodeRekey(next.pubSeed, next.root, 4, deadline, g3.salt, rnd, tree.sign(4, g3.digest));

const g4 = E.grind(E.execHasher(rnd, CHAIN_ID, ACCOUNT, 2, 0, deadline, v1calls), 4096);
const cd4 = E.encodeExecute(v1calls, 0, deadline, g4.salt, rnd, next.sign(0, g4.digest));

const sol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

library Fixture {
    address internal constant ACCOUNT = ${ACCOUNT};
    uint256 internal constant NOW = ${NOW};
    bytes16 internal constant PUB_SEED = bytes16(${hex(identity.pubSeed)});
    bytes16 internal constant ROOT = bytes16(${hex(identity.root)});
    bytes16 internal constant CHAIN_ROOT = bytes16(${hex(tree.root)});
    bytes16 internal constant NEXT_PUB_SEED = bytes16(${hex(next.pubSeed)});
    bytes16 internal constant NEXT_ROOT = bytes16(${hex(next.root)});
    bytes16 internal constant DIGEST1 = bytes16(${hex(g1.digest)});
    uint256 internal constant STEPS1 = ${g1.cost};
    bytes internal constant CALL0 = hex"${Buffer.from(cd0).toString("hex")}";
    bytes internal constant CALL1 = hex"${Buffer.from(cd1).toString("hex")}";
    bytes internal constant CALL2 = hex"${Buffer.from(cd2).toString("hex")}";
    bytes internal constant CALL3 = hex"${Buffer.from(cd3).toString("hex")}";
    bytes internal constant CALL4 = hex"${Buffer.from(cd4).toString("hex")}";
}
`;
writeFileSync(new URL("./test/Fixture.sol", import.meta.url), sol);
console.log(JSON.stringify({ treeMs, grindMs, steps1: g1.cost, salt1: g1.salt, calldata1: cd1.length }));
