import * as E from "./evmwots.js";
import { keccak256 } from "./keccak.js";
import { bytesToHex, hexToBytes } from "./evmtx.js";
import { pubkey, b58encode, concat, u64, SYSTEM, eq } from "./solana.js";
import { TOKEN, ATA_PROG, ata } from "./tokens.js";

const enc = new TextEncoder();
const { word, addressWord } = E;
const sel = (sig) => keccak256(enc.encode(sig)).slice(0, 4);

export const API = "https://api.relay.link";
export const SOLANA_ID = 792703809;
export const EVM_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
export const SOL_PROGRAM = pubkey("99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2");
export const SOL_DEPOSITORY = pubkey("Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc");
export const SOL_VAULT = pubkey("7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ");
export const MAX_SLIPPAGE_BPS = 300;

const DISC_NATIVE = Uint8Array.of(0x0d, 0x9e, 0x0d, 0xdf, 0x5f, 0xd5, 0x1c, 0x06);
const DISC_TOKEN = Uint8Array.of(0x0b, 0x9c, 0x60, 0xda, 0x27, 0xa3, 0xb4, 0x13);
const SEL = {
  depositNative: sel("depositNative(address,bytes32)"),
  depositErc20: sel("depositErc20(address,address,uint256,bytes32)"),
  approve: sel("approve(address,uint256)"),
};

export const NAMES = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 4663: "robinhood", [SOLANA_ID]: "solana" };
const ZERO = "0x0000000000000000000000000000000000000000";
export const ASSETS = {
  [SOLANA_ID]: {
    native: { symbol: "SOL", decimals: 9, address: "11111111111111111111111111111111" },
    usdc: { symbol: "USDC", decimals: 6, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  },
  1: { native: { symbol: "ETH", decimals: 18, address: ZERO }, usdc: { symbol: "USDC", decimals: 6, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" } },
  8453: { native: { symbol: "ETH", decimals: 18, address: ZERO }, usdc: { symbol: "USDC", decimals: 6, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" } },
  42161: { native: { symbol: "ETH", decimals: 18, address: ZERO }, usdc: { symbol: "USDC", decimals: 6, address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" } },
  4663: { native: { symbol: "ETH", decimals: 18, address: ZERO } },
};

export const isSolana = (id) => id === SOLANA_ID;

export function kinds(from, to) {
  if (from === to || !ASSETS[from] || !ASSETS[to]) return [];
  return Object.keys(ASSETS[from]).filter((k) => ASSETS[to][k]);
}

export function destinations(from) {
  return Object.keys(ASSETS).map(Number).filter((to) => kinds(from, to).length);
}

function sameAddress(chain, a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return isSolana(chain) ? a === b : a.toLowerCase() === b.toLowerCase();
}

function addressOk(chain, a) {
  if (typeof a !== "string") return false;
  if (isSolana(chain)) { try { return pubkey(a).length === 32; } catch { return false; } }
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

function big(v) {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new Error("the bridge quote has a malformed amount");
  return BigInt(v);
}

export function request({ from, to, kind, amount, user, recipient, slippageBps, appFee }) {
  if (!kinds(from, to).includes(kind)) throw new Error("this bridge route is not supported");
  if (!addressOk(from, user) || !addressOk(to, recipient)) throw new Error("bad bridge address");
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error("enter an amount above zero");
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) throw new Error("bad slippage");
  const body = {
    user, recipient, refundTo: user,
    originChainId: from, destinationChainId: to,
    originCurrency: ASSETS[from][kind].address, destinationCurrency: ASSETS[to][kind].address,
    amount: amount.toString(), tradeType: "EXACT_INPUT",
    slippageTolerance: String(slippageBps), includeProtocolData: true,
  };
  if (appFee && appFee.bps > 0) body.appFees = [{ recipient: appFee.recipient, fee: String(appFee.bps) }];
  return body;
}

export async function quote(req, { api = API, fetchFn = fetch, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${api}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: ctl.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(`the bridge did not give a quote${j && typeof j.message === "string" ? `: ${j.message.slice(0, 160)}` : ""}`);
    return j;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("the bridge did not answer in 20 seconds");
    throw e;
  } finally { clearTimeout(t); }
}

export function check(q, req, nowS) {
  const bad = (why) => { throw new Error(`the bridge quote failed a safety check (${why}). Nothing was signed`); };
  const from = req.originChainId, to = req.destinationChainId;
  const v2 = q && q.protocol && q.protocol.v2;
  if (!v2 || !v2.orderData || !v2.paymentDetails) bad("no order data");
  const pd = v2.paymentDetails, od = v2.orderData;
  if (pd.chainId !== NAMES[from]) bad("wrong origin network");
  const dep = isSolana(from) ? b58encode(SOL_PROGRAM) : EVM_DEPOSITORY;
  if (!sameAddress(from, pd.depository, dep)) bad("unknown deposit contract");
  if (!sameAddress(from, pd.currency, req.originCurrency)) bad("wrong asset");
  const amount = big(pd.amount);
  if (amount.toString() !== req.amount) bad("wrong amount");
  if (!/^0x[0-9a-fA-F]{64}$/.test(v2.orderId || "")) bad("bad order id");
  if (!Array.isArray(od.inputs) || od.inputs.length !== 1) bad("unexpected inputs");
  const inp = od.inputs[0];
  if (!inp.payment || inp.payment.chainId !== NAMES[from] || !sameAddress(from, inp.payment.currency, req.originCurrency) || big(inp.payment.amount) !== amount) bad("input does not match");
  if (v2.hubType !== "onchain" || od.version !== "v1") bad("unknown order format");
  if (!Array.isArray(od.fees) || od.fees.length) bad("the order pays extra fees");
  if (!Array.isArray(inp.refunds) || !inp.refunds.length) bad("no refund path");
  let originRefund = false;
  for (const rf of inp.refunds) {
    const chain = rf.chainId === NAMES[from] ? from : rf.chainId === NAMES[to] ? to : null;
    if (chain === null) bad("refund on another network");
    const mine = chain === from ? req.user : req.recipient;
    if (!sameAddress(chain, rf.recipient, mine)) bad("refund goes to someone else");
    if (!sameAddress(chain, rf.currency, chain === from ? req.originCurrency : req.destinationCurrency)) bad("refund in another asset");
    if (chain === from) originRefund = true;
  }
  if (!originRefund) bad("no refund on the sending network");
  const out = od.output;
  if (!out || out.chainId !== NAMES[to]) bad("wrong destination network");
  if (Array.isArray(out.calls) ? out.calls.length : out.calls) bad("the order runs extra calls");
  if (!Array.isArray(out.payments) || out.payments.length !== 1) bad("unexpected payments");
  const pay = out.payments[0];
  if (!sameAddress(to, pay.recipient, req.recipient)) bad("pays someone else");
  if (!sameAddress(to, pay.currency, req.destinationCurrency)) bad("pays a different asset");
  const expected = big(pay.expectedAmount), min = big(pay.minimumAmount);
  if (expected <= 0n || min <= 0n || min > expected) bad("bad output amounts");
  const slip = BigInt(req.slippageTolerance);
  if (min * 1000000n < expected * (1000000n - slip * 100n - 10n)) bad("the minimum is below your slippage limit");
  if (!Number.isFinite(out.deadline) || out.deadline < nowS + 60) bad("the order expires too soon");
  const d = q.details || {};
  if (d.recipient !== undefined && !sameAddress(to, d.recipient, req.recipient)) bad("details name another receiver");
  const app = q.fees && q.fees.app ? big(q.fees.app.amount || "0") : 0n;
  return {
    orderId: hexToBytes(v2.orderId), requestId: typeof q.requestId === "string" ? q.requestId : null,
    amount, expected, min, deadline: out.deadline, appFee: app,
    feeUsd: Number(q.fees && q.fees.relayer && q.fees.relayer.amountUsd) || null,
    seconds: Number(d.timeEstimate) || null,
  };
}

export function evmCalls(user, token, amount, orderId) {
  if (orderId.length !== 32) throw new Error("bad order id");
  if (token === ZERO) {
    return [{ to: EVM_DEPOSITORY, value: amount, data: concat(SEL.depositNative, addressWord(user), orderId) }];
  }
  return [
    { to: token, value: 0n, data: concat(SEL.approve, addressWord(EVM_DEPOSITORY), word(amount)) },
    { to: EVM_DEPOSITORY, value: 0n, data: concat(SEL.depositErc20, addressWord(user), addressWord(token), word(amount), orderId) },
  ];
}

export function solanaIx(wallet, mint, amount, orderId, tokenProgram = TOKEN) {
  if (orderId.length !== 32) throw new Error("bad order id");
  if (!mint) {
    return [SOL_PROGRAM, [[SOL_DEPOSITORY, false, false], [wallet, true, true], [wallet, false, false], [SOL_VAULT, false, true], [SYSTEM, false, false]], concat(DISC_NATIVE, u64(amount), orderId)];
  }
  return [SOL_PROGRAM, [
    [SOL_DEPOSITORY, false, false], [wallet, true, true], [wallet, false, false], [SOL_VAULT, false, false], [mint, false, false],
    [ata(wallet, mint, tokenProgram), false, true], [ata(SOL_VAULT, mint, tokenProgram), false, true],
    [tokenProgram, false, false], [ATA_PROG, false, false], [SYSTEM, false, false],
  ], concat(DISC_TOKEN, u64(amount), orderId)];
}

export function matchesApi(q, from, mine) {
  const items = (q.steps || []).flatMap((s) => (s.items || []).map((i) => ({ id: s.id, data: i.data })));
  const dep = items.find((i) => i.id === "deposit");
  if (!dep || !dep.data) return false;
  if (!isSolana(from)) {
    const last = mine[mine.length - 1];
    return typeof dep.data.to === "string" && dep.data.to.toLowerCase() === last.to && typeof dep.data.data === "string" && dep.data.data.toLowerCase() === bytesToHex(last.data) && BigInt(dep.data.value || "0") === last.value;
  }
  const ix = (dep.data.instructions || [])[0];
  if (!ix || (dep.data.instructions || []).length !== 1 || ix.programId !== b58encode(mine[0])) return false;
  const keys = ix.keys || [];
  if (keys.length !== mine[1].length) return false;
  for (let i = 0; i < keys.length; i++) {
    const [k, s, w] = mine[1][i];
    if (keys[i].pubkey !== b58encode(k) || !!keys[i].isSigner !== s || !!keys[i].isWritable !== w) return false;
  }
  return typeof ix.data === "string" && ix.data.toLowerCase() === Array.from(mine[2], (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function status(requestId, { api = API, fetchFn = fetch } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestId || "")) throw new Error("bad request id");
  const r = await fetchFn(`${api}/intents/status/v3?requestId=${requestId}`);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error("the bridge status is not available right now");
  return { status: String(j.status || "unknown"), inTx: j.inTxHashes || [], outTx: j.txHashes || [] };
}
