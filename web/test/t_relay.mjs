import * as R from "../lib/relay.js";
import { pubkey } from "../lib/solana.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };
const throws = (f, re, m) => { try { f(); ok(false, m + " (did not throw)"); } catch (e) { ok(re.test(e.message), `${m}: ${e.message}`); } };

const EVM_USER = "0x5900cd41f56caefea86b3ec07fe09bcb9ba39d06";
const SOL_USER = "5Tdzw7ytncu1LgF9cTdbc6oqzEJ9EVQgnGy8JWrfrsn4";
const user = (id) => (R.isSolana(id) ? SOL_USER : EVM_USER);
const now = () => Math.floor(Date.now() / 1000);

ok(R.destinations(R.SOLANA_ID).join() === "1,4663,8453,42161", "Solana bridges to all four EVM networks");
ok(R.kinds(4663, 8453).join() === "native", "Robinhood bridges ETH only");
ok(R.kinds(8453, R.SOLANA_ID).join() === "native,usdc", "Base to Solana offers ETH/SOL and USDC");
ok(R.kinds(8453, 8453).length === 0, "no bridge to the same network");
throws(() => R.request({ from: 4663, to: 8453, kind: "usdc", amount: 1n, user: EVM_USER, recipient: EVM_USER, slippageBps: 100 }), /not supported/, "unsupported asset refused");
throws(() => R.request({ from: 8453, to: 42161, kind: "native", amount: 1n, user: EVM_USER, recipient: EVM_USER, slippageBps: 900 }), /slippage/, "slippage above the cap refused");
throws(() => R.request({ from: 8453, to: R.SOLANA_ID, kind: "native", amount: 1n, user: EVM_USER, recipient: EVM_USER, slippageBps: 100 }), /address/, "an EVM address as a Solana receiver refused");

const ROUTES = [
  [8453, 42161, "native", 1000000000000000n],
  [8453, 42161, "usdc", 5000000n],
  [8453, R.SOLANA_ID, "native", 1000000000000000n],
  [R.SOLANA_ID, 8453, "native", 10000000n],
  [R.SOLANA_ID, 42161, "usdc", 5000000n],
  [4663, 8453, "native", 1000000000000000n],
  [1, 8453, "native", 3000000000000000n],
];
const live = [];
for (const [from, to, kind, amount] of ROUTES) {
  const req = R.request({ from, to, kind, amount, user: user(from), recipient: user(to), slippageBps: 100 });
  let q;
  try { q = await R.quote(req); } catch (e) { console.log("SKIP", from, to, kind, e.message); continue; }
  let c;
  try { c = R.check(q, req, now()); ok(true, `${R.NAMES[from]} -> ${R.NAMES[to]} ${kind}: quote passes (expected ${c.expected}, min ${c.min})`); }
  catch (e) { ok(false, `${R.NAMES[from]} -> ${R.NAMES[to]} ${kind}: ${e.message}`); continue; }
  const asset = R.ASSETS[from][kind];
  const mine = R.isSolana(from)
    ? R.solanaIx(pubkey(user(from)), kind === "native" ? null : pubkey(asset.address), amount, c.orderId)
    : R.evmCalls(user(from), asset.address, amount, c.orderId);
  ok(R.matchesApi(q, from, mine), `${R.NAMES[from]} -> ${R.NAMES[to]} ${kind}: our own deposit equals Relay's byte for byte`);
  live.push({ q, req });
}

const clone = (x) => JSON.parse(JSON.stringify(x));
if (live.length) {
  const { q, req } = live.find((l) => !R.isSolana(l.req.originChainId)) || live[0];
  const tamper = (label, f, re) => { const t = clone(q); f(t); throws(() => R.check(t, req, now()), re, label); };
  tamper("payment to another receiver", (t) => { t.protocol.v2.orderData.output.payments[0].recipient = "0x000000000000000000000000000000000000dead"; }, /pays someone else/);
  tamper("refund to another address", (t) => { t.protocol.v2.orderData.inputs[0].refunds[0].recipient = "0x000000000000000000000000000000000000dead"; }, /refund/);
  tamper("unknown deposit contract", (t) => { t.protocol.v2.paymentDetails.depository = "0x000000000000000000000000000000000000dead"; }, /deposit contract/);
  tamper("deposit amount changed", (t) => { t.protocol.v2.paymentDetails.amount = "1"; }, /amount/);
  tamper("destination network changed", (t) => { t.protocol.v2.orderData.output.chainId = "ethereum"; }, /destination/);
  tamper("extra destination calls", (t) => { t.protocol.v2.orderData.output.calls = [{ to: "0x01" }]; }, /extra calls/);
  tamper("minimum below slippage", (t) => { const p = t.protocol.v2.orderData.output.payments[0]; p.minimumAmount = (BigInt(p.expectedAmount) / 2n).toString(); }, /slippage/);
  tamper("different output asset", (t) => { t.protocol.v2.orderData.output.payments[0].currency = "0x000000000000000000000000000000000000dead"; }, /different asset/);
  tamper("expired order", (t) => { t.protocol.v2.orderData.output.deadline = now() - 1; }, /expires/);
  tamper("extra order fees", (t) => { t.protocol.v2.orderData.fees = [{ recipient: "0x000000000000000000000000000000000000dead", amount: "1" }]; }, /extra fees/);
  tamper("refund in another asset", (t) => { t.protocol.v2.orderData.inputs[0].refunds[0].currency = "0x000000000000000000000000000000000000dead"; }, /another asset/);
  tamper("no refund on the sending network", (t) => { const r = t.protocol.v2.orderData.inputs[0].refunds; t.protocol.v2.orderData.inputs[0].refunds = r.filter((x) => x.chainId !== t.protocol.v2.paymentDetails.chainId); }, /sending network/);
  tamper("unknown order version", (t) => { t.protocol.v2.orderData.version = "v9"; }, /order format/);
  tamper("refund chain as a prototype key", (t) => { t.protocol.v2.orderData.inputs[0].refunds[0].chainId = "constructor"; }, /another network/);
  tamper("missing order data", (t) => { delete t.protocol; }, /no order data/);
  tamper("malformed amount", (t) => { t.protocol.v2.orderData.output.payments[0].expectedAmount = "1e30"; }, /malformed/);
  const t = clone(q);
  t.steps[t.steps.length - 1].items[0].data.data = t.steps[t.steps.length - 1].items[0].data.data.slice(0, -2) + "00";
  const c = R.check(q, req, now());
  ok(!R.matchesApi(t, req.originChainId, R.evmCalls(EVM_USER, req.originCurrency, BigInt(req.amount), c.orderId)), "a changed Relay deposit no longer matches ours");
}

const st = live.length && live[0].q.requestId ? await R.status(live[0].q.requestId).catch((e) => ({ status: "error " + e.message })) : null;
if (st) ok(typeof st.status === "string", `status endpoint answers (${st.status})`);
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
