import { keccak256 } from "./keccak.js";
import { sign, addressOf, toBig, toBytes32 } from "./secp256k1.js";
import { hexToBytes, bytesToHex, signTx1559 } from "./evmtx.js";

const U256 = 1n << 256n;
const enc = new TextEncoder();
const sel = (s) => keccak256(enc.encode(s)).slice(0, 4);
export const SEL = {
  approve: sel("approve(address,uint256)"),
  allowance: sel("allowance(address,address)"),
  transferFrom: sel("transferFrom(address,address,uint256)"),
  balanceOf: sel("balanceOf(address)"),
  decimals: sel("decimals()"),
};
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const low = (a) => {
  if (typeof a !== "string" || !ADDR.test(a)) throw new Error("not an EVM address");
  return a.toLowerCase();
};
const word = (v) => toBytes32(BigInt(v));
const addrWord = (a) => { const w = new Uint8Array(32); w.set(hexToBytes(low(a)), 12); return w; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const amount = (v) => { if (typeof v !== "bigint" || v < 0n || v >= U256) throw new Error("amount out of range"); return v; };

export function approveCall(token, spender, value) {
  return { to: low(token), value: 0n, data: cat(SEL.approve, addrWord(spender), word(amount(value))) };
}
export function allowanceData(owner, spender) { return bytesToHex(cat(SEL.allowance, addrWord(owner), addrWord(spender))); }
export function balanceData(who) { return bytesToHex(cat(SEL.balanceOf, addrWord(who))); }
export function transferFromData(from, to, value) { return cat(SEL.transferFrom, addrWord(from), addrWord(to), word(amount(value))); }

export function decodeApprove(data) {
  const d = typeof data === "string" ? hexToBytes(data) : data;
  if (d.length !== 68 || !SEL.approve.every((b, i) => d[i] === b) || d.slice(4, 16).some((b) => b !== 0)) return null;
  return { spender: bytesToHex(d.slice(16, 36)), value: toBig(d.slice(36, 68)) };
}

const uint = (hex) => { if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error("the RPC returned a malformed number"); return BigInt(hex); };
export async function readAllowance(rpc, token, owner, spender, block = "latest") { return uint(await rpc.call("eth_call", [{ to: low(token), data: allowanceData(owner, spender) }, block])); }
export async function readBalance(rpc, token, who, block = "latest") { return uint(await rpc.call("eth_call", [{ to: low(token), data: balanceData(who) }, block])); }

const DOMAIN_T = keccak256(enc.encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const AUTH_T = keccak256(enc.encode("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"));

export function authorizationDigest({ name, version, chainId, token, from, to, value, validAfter, validBefore, nonce }) {
  for (const v of [chainId, validAfter, validBefore]) amount(BigInt(v));
  const domain = keccak256(cat(DOMAIN_T, keccak256(enc.encode(name)), keccak256(enc.encode(version)), word(chainId), addrWord(token)));
  const n = hexToBytes(nonce);
  if (n.length !== 32) throw new Error("the nonce must be 32 bytes");
  const struct = keccak256(cat(AUTH_T, addrWord(from), addrWord(to), word(amount(value)), word(validAfter), word(validBefore), n));
  return keccak256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
}

export class EvmAgentKey {
  #priv;
  constructor(priv) {
    if (typeof priv !== "bigint" || priv <= 0n) throw new Error("bad agent key");
    this.#priv = priv;
    this.address = addressOf(priv);
    Object.freeze(this);
  }
  static fromSecret(secret) {
    const s = typeof secret === "string" ? hexToBytes(secret.startsWith("0x") ? secret : "0x" + secret) : Uint8Array.from(secret);
    if (s.length !== 32) throw new Error("an agent secret is 32 bytes");
    return new EvmAgentKey(toBig(s));
  }
  static generate() { return EvmAgentKey.fromSecret(crypto.getRandomValues(new Uint8Array(32))); }
  signDigest(h) { const { r, s, recovery } = sign(h, this.#priv); return bytesToHex(cat(toBytes32(r), toBytes32(s), Uint8Array.of(27 + recovery))); }
  signTx(tx) { return signTx1559(tx, this.#priv); }
  secretHex() { return bytesToHex(toBytes32(this.#priv)).slice(2); }
  toJSON() { return { address: this.address }; }
}

export function checkEvmRequirements(r, chainId) {
  if (!r || typeof r !== "object") throw new Error("payment requirements are missing");
  if (r.scheme !== "exact") throw new Error("only the x402 exact scheme is supported");
  if (r.network !== `eip155:${chainId}`) throw new Error("the service asks for payment on another network than the one this agent uses");
  const value = typeof r.amount === "string" && /^[0-9]{1,77}$/.test(r.amount) ? BigInt(r.amount) : -1n;
  if (value < 1n || value >= U256) throw new Error("the requested amount is not a valid whole number");
  const x = r.extra || {};
  if (x.assetTransferMethod !== undefined && x.assetTransferMethod !== "eip3009") throw new Error("only EIP-3009 payments are supported");
  if (typeof x.name !== "string" || typeof x.version !== "string" || x.name.length > 64 || x.version.length > 16) throw new Error("the token's signing domain is missing");
  const t = r.maxTimeoutSeconds;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 1 || t > 3600) throw new Error("maxTimeoutSeconds must be a whole number from 1 to 3600");
  if (!x.name.trim() || !x.version.trim()) throw new Error("the token's signing domain is missing");
  return { value, asset: low(r.asset), payTo: low(r.payTo), name: x.name, version: x.version, timeout: t };
}

export async function x402EvmPayment({ rpc, chainId, requirements, agent, asset, maxAmount, now, resource }) {
  if (!(agent instanceof EvmAgentKey)) throw new Error("agent must be an EvmAgentKey");
  if (typeof maxAmount !== "bigint" || maxAmount < 1n) throw new Error("pass a per-payment cap (maxAmount)");
  const q = checkEvmRequirements(requirements, chainId);
  if (q.asset !== low(asset)) throw new Error("the service asks to be paid in a token this agent is not set up to pay with");
  if (q.value > maxAmount) throw new Error(`the service asks for ${q.value} base units, more than the ${maxAmount} this agent may pay at once`);
  if (q.payTo === agent.address) throw new Error("the service asks the agent to pay itself");
  if (Number(await rpc.call("eth_chainId", [])) !== chainId) throw new Error("the RPC is on another network");
  const bal = await readBalance(rpc, q.asset, agent.address);
  if (bal < q.value) throw new Error(`the agent holds ${bal}, less than the requested ${q.value}; pull more from the OPEQ account first`);
  const t = BigInt(Math.floor(now ?? Date.now() / 1000));
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const auth = { from: agent.address, to: q.payTo, value: q.value, validAfter: t - 60n, validBefore: t + BigInt(q.timeout), nonce };
  const signature = agent.signDigest(authorizationDigest({ name: q.name, version: q.version, chainId, token: q.asset, ...auth }));
  const payload = { x402Version: 2, accepted: requirements, payload: { signature, authorization: { from: auth.from, to: auth.to, value: String(auth.value), validAfter: String(auth.validAfter), validBefore: String(auth.validBefore), nonce } } };
  if (resource) payload.resource = resource;
  return { payload, amount: q.value };
}

export async function pullFromOwner({ rpc, chainId, agent, token, owner, value, onHash }) {
  if (!(agent instanceof EvmAgentKey)) throw new Error("agent must be an EvmAgentKey");
  const left = await readAllowance(rpc, token, owner, agent.address);
  if (left < value) throw new Error(`the OPEQ account allows this agent ${left}, less than ${value}`);
  const data = transferFromData(owner, agent.address, value);
  const [pending, latest] = await Promise.all(["pending", "latest"].map((t) => rpc.call("eth_getTransactionCount", [agent.address, t])));
  if (Number(pending) > Number(latest)) throw new Error("an earlier transaction from the agent is still pending; wait for it before pulling again");
  const nonce = Number(latest);
  const block = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  if (!block || !block.baseFeePerGas) throw new Error("the RPC did not report a base fee");
  let prio = 1000000n;
  try { const p = BigInt(await rpc.call("eth_maxPriorityFeePerGas", [])); if (p > prio) prio = p; } catch {}
  const base = BigInt(block.baseFeePerGas);
  const gas = BigInt(await rpc.call("eth_estimateGas", [{ from: agent.address, to: low(token), data: bytesToHex(data) }])) * 13n / 10n;
  const tx = agent.signTx({ chainId, nonce, maxPriorityFeePerGas: prio, maxFeePerGas: base * 2n + prio, gas, to: low(token), value: 0n, data });
  const hash = await rpc.call("eth_sendRawTransaction", [tx.raw]);
  if (onHash) onHash(hash);
  for (let i = 0; i < 90; i++) {
    const rc = await rpc.call("eth_getTransactionReceipt", [hash]);
    if (rc) { if (rc.status !== "0x1") throw new Error("the pull from the OPEQ account failed on chain"); return hash; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const e = new Error(`the pull ${hash} was not confirmed in time; it may still go through, so do not pull again until it settles`);
  e.hash = hash;
  throw e;
}

export function encodeHeader(payload) { return btoa(unescape(encodeURIComponent(JSON.stringify(payload)))); }
