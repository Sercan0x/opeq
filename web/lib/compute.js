import * as M from "./mnemonic.js";
import * as P from "./protocol.js";
import { TreeKey, leafPk } from "./wots.js";
import { eq } from "./solana.js";

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

export const OPS = { treeFor, signExec, signRekey };

export const localCompute = {
  run: async (op, args, progress) => OPS[op](args, progress),
};
