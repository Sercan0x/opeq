import * as M from "./mnemonic.js";
import * as P from "./protocol.js";
import { TreeKey, leafPk } from "./wots.js";
import { eq } from "./solana.js";
import * as E from "./evmwots.js";

export function treeFor({ master, epoch, program, pubSeed }, progress) {
  const t = M.deriveTree(master, epoch, progress, program, pubSeed);
  return { pubSeed: t.pubSeed, root: t.root, leaves: t.leavesBytes() };
}

function loadTree(master, epoch, leaves, leaf, program, chainPubSeed) {
  const { skSeed, pubSeed } = M.treeSeeds(master, epoch, program, chainPubSeed);
  const tree = TreeKey.fromLeaves(skSeed, pubSeed, leaves);
  if (!eq(leafPk(skSeed, pubSeed, leaf), tree.levels[0][leaf])) throw new Error("secret seed does not match the stored tree, refusing to sign");
  return tree;
}

export function signExec(a, progress) {
  const tree = loadTree(a.master, a.epoch, a.leaves, a.leaf, a.program, a.pubSeed);
  const g = P.grind(P.execHasher(a.program, a.aid, a.epoch, a.leaf, a.expiry, a.inner, a.r), a.tries || P.GRIND_TRIES, progress);
  return { salt: g.salt, cost: g.cost, ...tree.sign(a.leaf, g.digest) };
}

export function signRekey(a, progress) {
  const tree = loadTree(a.master, a.epoch, a.leaves, a.leaf, a.program, a.pubSeed);
  const next = M.deriveTree(a.master, a.epoch + 1, progress && ((p) => progress(p * 0.9)), a.program, a.newPubSeed);
  const g = P.grind(P.rekeyHasher(a.program, a.aid, a.epoch, a.leaf, a.expiry, next.pubSeed, next.root, a.r), a.tries || P.GRIND_TRIES);
  return { salt: g.salt, ...tree.sign(a.leaf, g.digest), newPubSeed: next.pubSeed, newRoot: next.root, newLeaves: next.leavesBytes() };
}

function evmIdentity({ master }, progress) {
  const t = E.deriveIdentityTree(master, progress);
  return { pubSeed: t.pubSeed, root: t.root };
}

function evmBoot({ master, chainId, account }, progress) {
  const identity = E.deriveIdentityTree(master, progress && ((p) => progress(p * 0.5)));
  const b = E.bootstrapCall(master, chainId, account, identity, progress && ((p) => progress(0.5 + p * 0.5)));
  return { pubSeed: b.tree.pubSeed, root: b.tree.root, leaves: E.leavesBytes(b.tree), calldata: b.calldata, cost: b.cost };
}

function evmTree({ master, chainId, epoch, pubSeed }, progress) {
  const t = E.deriveChainTree(master, chainId, epoch, pubSeed, progress);
  return { root: t.root, leaves: E.leavesBytes(t) };
}

function evmLoad(a) {
  const { skSeed, pubSeed } = E.chainTreeSeeds(a.master, a.chainId, a.epoch, a.pubSeed);
  const tree = E.treeFromLeaves(skSeed, pubSeed, a.leaves);
  if (!eq(E.leafPk(skSeed, pubSeed, a.leaf), tree.levels[0][a.leaf])) throw new Error("secret seed does not match the stored EVM key tree, refusing to sign");
  if (!eq(tree.root, a.root)) throw new Error("stored EVM key tree does not match the root on chain, refusing to sign");
  return tree;
}

function evmSignExec(a, progress) {
  const tree = evmLoad(a);
  const g = E.grind(E.execHasher(a.rnd, a.chainId, a.account, a.epoch, a.leaf, a.deadline, a.calls), E.GRIND_TRIES, progress);
  return { calldata: E.encodeExecute(a.calls, a.leaf, a.deadline, g.salt, a.rnd, tree.sign(a.leaf, g.digest)), cost: g.cost };
}

function evmSignRekey(a, progress) {
  const tree = evmLoad(a);
  const next = E.deriveChainTree(a.master, a.chainId, a.epoch + 1, a.newPubSeed, progress && ((p) => progress(p * 0.9)));
  const g = E.grind(E.rekeyHasher(a.rnd, a.chainId, a.account, a.epoch, a.leaf, a.deadline, next.pubSeed, next.root), 1 << 14);
  return { calldata: E.encodeRekey(next.pubSeed, next.root, a.leaf, a.deadline, g.salt, a.rnd, tree.sign(a.leaf, g.digest)), cost: g.cost, newRoot: next.root, newLeaves: E.leavesBytes(next) };
}

export const OPS = { treeFor, signExec, signRekey, evmIdentity, evmBoot, evmTree, evmSignExec, evmSignRekey };

export const localCompute = {
  run: async (op, args, progress) => OPS[op](args, progress),
};
