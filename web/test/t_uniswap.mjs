import * as U from "../lib/uniswap.js";
import { bytesToHex } from "../lib/evmtx.js";

const RPC = process.argv[2] || "http://127.0.0.1:8551";
const CHAIN = 8453;
const ME = "0x00000000000000000000000000000000000a11ce";
const USDC = U.UNI[CHAIN].stable;
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
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
ok(true, "pinned router and quoter code match on the fork");
let r = await swap(U.ETH, USDC, 10n ** 16n, "ETH to USDC");
ok(r.okSent && r.got >= r.min && r.got > 0n, "ETH to USDC delivers at least the minimum");
const usdc = await bal(USDC);
r = await swap(USDC, U.ETH, usdc / 2n, "USDC to ETH");
ok(r.okSent && r.got > 0n, "USDC to ETH unwraps native ETH to the account");
ok((await allowance(USDC)) === 0n, "router allowance is back to zero after the swap");
r = await swap(USDC, CBBTC, usdc / 4n, "USDC to cbBTC");
ok(r.okSent && r.got >= r.min && r.got > 0n, `USDC to cbBTC works (${r.best.route.fees.length}-hop route)`);
{
  const amt = usdc / 8n;
  const two = U.routes(CHAIN, USDC, CBBTC).filter((x) => x.fees.length === 2);
  try { U.swapCalls({ chainId: CHAIN, account: ME, tokenIn: USDC, tokenOut: CBBTC, amountIn: 1n, amountOutMin: 1n, route: { tokens: [U.UNI[CHAIN].weth, CBBTC], fees: [500] }, deadline: 1n }); ok(false, "mismatched route refused"); } catch { ok(true, "a route that does not start with the token paid is refused"); }
  const qs = (await Promise.all(two.map(async (route) => { try { return { route, out: BigInt((await call(U.UNI[CHAIN].quoter, U.quoteData(route, amt))).slice(0, 66)) }; } catch { return null; } }))).filter(Boolean).sort((a, b) => (b.out > a.out ? 1 : -1));
  const best = qs[0];
  const min = U.minOut(best.out, 100);
  const before = await bal(CBBTC);
  const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const sent = await send(U.swapCalls({ chainId: CHAIN, account: ME, tokenIn: USDC, tokenOut: CBBTC, amountIn: amt, amountOutMin: min, route: best.route, deadline: now + 600n }));
  ok(BigInt(await rpc("eth_call", [{ to: U.UNI[CHAIN].weth, data: "0x70a08231" + "0".repeat(24) + U.UNI[CHAIN].router.slice(2) }, "latest"])) === 0n, "no WETH is left in the router after a 2-hop swap");
  const got = (await bal(CBBTC)) - before;
  console.log(`  forced 2-hop USDC to WETH to cbBTC fees ${best.route.fees.join("/")}: quote ${best.out}, min ${min}, got ${got}`);
  ok(sent && got >= min && got > 0n, "a 2-hop route through WETH delivers at least the minimum");
  const past = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp) - 10n;
  const late = await send(U.swapCalls({ chainId: CHAIN, account: ME, tokenIn: U.ETH, tokenOut: USDC, amountIn: 10n ** 14n, amountOutMin: 1n, route: { tokens: [U.UNI[CHAIN].weth, USDC], fees: [500] }, deadline: past }));
  ok(!late, "a swap past its deadline reverts");
}
const ethBefore = await bal(U.ETH), usdcBefore = await bal(USDC);
r = await swap(U.ETH, USDC, 10n ** 15n, "ETH to USDC with an impossible minimum", { mult: 2n });
ok(!r.okSent && (await bal(USDC)) === usdcBefore, "a minimum above what the pool gives reverts and moves nothing");
try { U.routes(CHAIN, U.ETH, U.ETH); ok(false, "same token refused"); } catch { ok(true, "same token refused"); }
{
  const r = [{ route: { tokens: ["a", "b"], fees: [500] }, out: 1000n }, { route: { tokens: ["a", "b"], fees: [3000] }, out: 900n }];
  const lie = r.map((x) => ({ ...x, out: (x.out * 80n) / 100n }));
  try { U.pickBest(r, lie); ok(false, "deflated quote refused"); } catch (e) { ok(e instanceof U.Disagree, "one source quoting 20% lower is refused, not used"); }
  try { U.pickBest(r, [{ ...r[0], out: null }, r[1]]); ok(false, "blanked route refused"); } catch (e) { ok(e instanceof U.Disagree, "one source hiding the best pool is refused, not used to change the route"); }
  const near = U.pickBest(r, r.map((x) => ({ ...x, out: x.out - 2n })));
  ok(near.out === 998n && near.route.fees[0] === 500, "sources within 0.5% agree and the lower of the two is used");
  ok(U.impactBps(950n, 1000n, 100n, 100n) === 500n && U.impactBps(1000n, 1000n, 1n, 1n) === 0n, "price impact is measured against a small reference amount");
}
try { U.minOut(100n, 500); ok(false, "slippage cap"); } catch { ok(true, "slippage above 3% refused"); }
try { U.swapCalls({ chainId: CHAIN, account: ME, tokenIn: USDC, tokenOut: U.ETH, amountIn: 1n, amountOutMin: 0n, route: { tokens: [USDC, U.UNI[CHAIN].weth], fees: [500] }, deadline: 1n }); ok(false, "zero minimum"); } catch { ok(true, "zero minimum refused"); }
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
