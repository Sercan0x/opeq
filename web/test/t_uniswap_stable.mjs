import * as U from "../lib/uniswap.js";
import { bytesToHex } from "../lib/evmtx.js";

const RPC = process.argv[2] || "http://127.0.0.1:8551";
const CHAIN = Number(process.argv[3] || 4663);
const ME = "0x00000000000000000000000000000000000a11ce";
const USDG = U.UNI[CHAIN].stable, SYM = U.UNI[CHAIN].stableSymbol;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };
let id = 0;
async function rpc(method, params) {
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
}
const call = (to, data) => rpc("eth_call", [{ to, data: bytesToHex(data) }, "latest"]);
const bal = async (t) => t === U.ETH ? BigInt(await rpc("eth_getBalance", [ME, "latest"])) : BigInt(await rpc("eth_call", [{ to: t, data: "0x70a08231" + "0".repeat(24) + ME.slice(2) }, "latest"]));
const allowance = async (t) => BigInt(await call(t, U.allowanceData(ME, U.UNI[CHAIN].router)));
const sim = async (calls, tout) => U.decodeSim(await rpc("eth_call", U.simParams(ME, calls, tout)));
async function send(calls) {
  for (const c of calls) {
    const h = await rpc("eth_sendTransaction", [{ from: ME, to: c.to, value: "0x" + c.value.toString(16), data: bytesToHex(c.data), gas: "0x" + (1500000).toString(16) }]);
    let r = null;
    for (let i = 0; i < 60 && !r; i++) { r = await rpc("eth_getTransactionReceipt", [h]); if (!r) await new Promise((z) => setTimeout(z, 500)); }
    if (!r || r.status !== "0x1") return false;
  }
  return true;
}
async function swap(tin, tout, amount, label, { mult = 1n } = {}) {
  const best = U.pickBest(await U.quoteAll(CHAIN, tin, tout, amount, call), await U.quoteAll(CHAIN, tin, tout, amount, call));
  const min = U.minOut(best.out, 100) * mult;
  const before = await bal(tout);
  const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const calls = U.swapCalls({ chainId: CHAIN, account: ME, tokenIn: tin, tokenOut: tout, amountIn: amount, amountOutMin: min, route: best.route, deadline: now + 600n });
  const sm = await sim(calls, tout);
  console.log(`  sim: ok ${sm.ok}, gas ${sm.gas}, received ${sm.after - sm.before}`);
  if (mult === 1n) ok(sm.ok && sm.after - sm.before >= min, `${label}: the test run passes and shows at least the minimum arriving`);
  else ok(!sm.ok, `${label}: the test run fails before anything is signed`);
  const okSent = await send(calls);
  const got = (await bal(tout)) - before;
  console.log(`  ${label}: route ${best.route.tokens.length - 1} hop(s) fees ${best.route.fees.join("/")}, quote ${best.out}, min ${min}, got ${got}, mined ${okSent}`);
  return { okSent, got, min, best };
}

await rpc("anvil_impersonateAccount", [ME]);
await rpc("anvil_setBalance", [ME, "0x" + (10n ** 18n).toString(16)]);
await U.checkContracts(CHAIN, (a) => rpc("eth_getCode", [a, "latest"]), (to, data) => call(to, data));
ok(true, `chain ${CHAIN}: router and quoter match their pinned code and WETH`);
const sym = Buffer.from((await call(USDG, Uint8Array.from(Buffer.from("95d89b41", "hex")))).slice(2), "hex");
ok(sym.subarray(64, 64 + sym[63]).toString() === SYM, `the pinned stablecoin reports the symbol ${SYM}`);
let r = await swap(U.ETH, USDG, 10n ** 16n, `ETH to ${SYM}`);
ok(r.okSent && r.got >= r.min && r.got > 0n, `ETH to ${SYM} delivers at least the minimum`);
const usdg = await bal(USDG);
r = await swap(USDG, U.ETH, usdg / 2n, `${SYM} to ETH`);
ok(r.okSent && r.got > 0n, `${SYM} to ETH unwraps native ETH to the account`);
ok((await allowance(USDG)) === 0n, "router allowance is back to zero after the swap");
console.log(fail ? `FAILED ${fail}` : `ALL PASSED ${pass}`);
process.exit(fail ? 1 : 0);
