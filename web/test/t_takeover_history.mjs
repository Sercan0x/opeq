import { Session } from "../lib/engine.js";
import * as P from "../lib/protocol.js";
import { TreeKey } from "../lib/wots.js";
import { b58encode } from "../lib/solana.js";
import { sha256 } from "../lib/sha256.js";

const enc = new TextEncoder();
const program = new Uint8Array(32).fill(7);
const state = new Uint8Array(32).fill(9);
const other = new Uint8Array(32).fill(11);
const aid = sha256(enc.encode("aid")).slice(0, 32);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

const tree = TreeKey.generate(sha256(enc.encode("sk")), sha256(enc.encode("pub")).slice(0, 16));
const cur = { epoch: 3, pubSeed: tree.pubSeed, root: tree.root, aid };
const keys = [b58encode(new Uint8Array(32).fill(5)), ...[program, state, other].map(b58encode)];
const outer = [program, state, other];

function rekeyIx(leaf, epoch, signed = true) {
  const r = new Uint8Array(16).fill(leaf & 255), expiry = 5000n, salt = 7;
  const np = new Uint8Array(16).fill(1), nr = new Uint8Array(16).fill(2);
  const d = P.salted(P.rekeyHasher(program, aid, epoch, leaf, expiry, np, nr, r), salt);
  const { sig, path } = signed ? tree.sign(leaf, d) : { sig: new Uint8Array(288).fill(3), path: new Uint8Array(160).fill(4) };
  return P.buildRekey(leaf, expiry, salt, r, sig, path, np, nr);
}

function execIx(leaf) {
  const r = new Uint8Array(16).fill(9), expiry = 6000n, salt = 11;
  const inner = [[other, [[state, false, true]], Uint8Array.of(1, 2, 3)]];
  const d = P.salted(P.execHasher(program, aid, cur.epoch, leaf, expiry, inner, r), salt);
  const { sig, path } = tree.sign(leaf, d);
  return P.buildExec(leaf, expiry, salt, r, sig, path, inner, outer);
}

function chainWith(total, failed) {
  const sigs = Array.from({ length: total }, (_, i) => ({ signature: `sig${i}`, err: failed.has(i) ? { InstructionError: [0, "x"] } : null }));
  const rpc = {
    async call(method, params) {
      if (method === "getSignaturesForAddress") {
        const o = params[1];
        const start = o.before ? sigs.findIndex((s) => s.signature === o.before) + 1 : 0;
        return sigs.slice(start, start + o.limit);
      }
      if (method === "getTransaction") {
        const ixs = failed.get(Number(params[0].slice(3)));
        const top = ixs.filter((d) => !d.inner).map((d) => ({ programIdIndex: 1, accounts: [1, 2, 3], data: b58encode(d) }));
        const inner = ixs.filter((d) => d.inner).map((d) => ({ programIdIndex: 1, accounts: [1, 2, 3], data: b58encode(d) }));
        return { transaction: { message: { accountKeys: keys, instructions: top } }, meta: { innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [] } };
      }
      throw new Error("unexpected " + method);
    },
  };
  return rpc;
}

const self = (rpc) => ({ e: { rpc, program, pace: 0 }, scanFailed: Session.prototype.scanFailed });
const run = async (rpc) => { const r = await Session.prototype.failedLeaves.call(self(rpc), state, cur); if (!r.complete) { const e = new Error(r.leaves.length ? "partial" : "incomplete scan"); e.result = r; throw e; } return r.leaves; };

{
  const got = await run(chainWith(1500, new Map([[1200, [rekeyIx(900, cur.epoch)]]])));
  ok(got.join() === "900", "a signed failed takeover 1200 transactions back is found");
}
{
  const junk = [rekeyIx(901, cur.epoch, false), rekeyIx(902, cur.epoch, false), rekeyIx(903, cur.epoch, false)];
  const got = await run(chainWith(50, new Map([[3, junk], [4, [Uint8Array.of(P.IX_REKEY, 0x90, 3, 0, 0)]]])));
  ok(got.length === 0, "unsigned or truncated look-alike instructions are ignored, so they cannot shrink the free keys");
}
{
  const got = await run(chainWith(50, new Map([[5, [rekeyIx(904, cur.epoch - 1)]]])));
  ok(got.length === 0, "a signature made for another epoch does not count against this tree");
}
{
  const got = await run(chainWith(50, new Map([[6, [execIx(905)]]])));
  ok(got.join() === "905", "a signed failed transfer is found too");
}
{
  const flood = new Map(Array.from({ length: 3001 }, (_, i) => [i, [rekeyIx(906, cur.epoch, false)]]));
  let err = null;
  try { await run(chainWith(3500, flood)); } catch (e) { err = e; }
  ok(err && err.result && !err.result.complete, "an extreme flood is reported as an incomplete scan, so the user is asked instead of being locked out");
}
{
  let err = null;
  try { await run(chainWith(100000, new Map())); } catch (e) { err = e; }
  ok(err && err.result && !err.result.complete, "history beyond 100 pages is reported as incomplete, not silently treated as complete");
}
{
  const viaCpi = rekeyIx(907, cur.epoch);
  viaCpi.inner = true;
  const got = await run(chainWith(50, new Map([[7, [viaCpi]]])));
  ok(got.join() === "907", "a signed takeover hidden inside another program's call (CPI) is found too");
}
console.log(fail ? `${fail} FAILED` : "ALL PASSED");
process.exit(fail ? 1 : 0);
