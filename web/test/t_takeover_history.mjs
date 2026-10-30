import { Session } from "../lib/engine.js";
import * as P from "../lib/protocol.js";
import { b58encode } from "../lib/solana.js";

const program = new Uint8Array(32).fill(7);
const state = new Uint8Array(32).fill(9);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

function chainWith(total, failedAt) {
  const sigs = Array.from({ length: total }, (_, i) => ({ signature: `sig${i}`, err: failedAt.has(i) ? { InstructionError: [0, "x"] } : null }));
  const calls = [];
  const rpc = {
    async call(method, params) {
      calls.push(method);
      if (method === "getSignaturesForAddress") {
        const o = params[1];
        const start = o.before ? sigs.findIndex((s) => s.signature === o.before) + 1 : 0;
        return sigs.slice(start, start + o.limit);
      }
      if (method === "getTransaction") {
        const i = Number(params[0].slice(3));
        const leaf = failedAt.get(i);
        const data = Uint8Array.of(P.IX_REKEY, leaf & 255, (leaf >> 8) & 255, 0, 0);
        return { transaction: { message: { accountKeys: [b58encode(program)], instructions: [{ programIdIndex: 0, data: b58encode(data) }] } }, meta: {} };
      }
      throw new Error("unexpected " + method);
    },
  };
  return { rpc, calls };
}

const run = (rpc) => Session.prototype.failedLeaves.call({ e: { rpc, program } }, state);

{
  const { rpc } = chainWith(1500, new Map([[1200, 900]]));
  const got = await run(rpc);
  ok(got.includes(900), "a failed takeover 1200 transactions back is still found (the old 300 window missed it)");
}
{
  const { rpc } = chainWith(5000, new Map([[10, 800]]));
  let err = null;
  try { await run(rpc); } catch (e) { err = e; }
  ok(err && /too much history/.test(err.message), "history longer than the scan refuses instead of guessing");
}
{
  const failedAt = new Map(Array.from({ length: 301 }, (_, i) => [i, 800 + (i % 200)]));
  const { rpc } = chainWith(400, failedAt);
  let err = null;
  try { await run(rpc); } catch (e) { err = e; }
  ok(err && /too many failed/.test(err.message), "a flood of failed transactions refuses instead of guessing");
}
{
  const { rpc } = chainWith(20, new Map());
  ok((await run(rpc)).length === 0, "a short clean history gives no used keys");
}
console.log(fail ? `${fail} FAILED` : "ALL PASSED");
process.exit(fail ? 1 : 0);
