import * as E from "./evmwots.js";
import { keccak256 } from "./keccak.js";
import { bytesToHex, hexToBytes } from "./evmtx.js";

const enc = new TextEncoder();
const { word, addressWord, addressBytes, concat, dynBytes } = E;
const sel = (sig) => keccak256(enc.encode(sig)).slice(0, 4);

export const ETH = "eth";
export const FEES = [100, 500, 3000, 10000];
export const MAX_SLIPPAGE_BPS = 300;
export const DEADLINE_S = 600;
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

export const UNI = {
  1: {
    router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", routerHash: "0x6ec798e80f3a19de650826338677604e54d6664f44a33b53a20b22b1939f402e",
    quoter: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e", quoterHash: "0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b",
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
  8453: {
    router: "0x2626664c2603336e57b271c5c0b26f421741e481", routerHash: "0x38bd640f47df62b2fd5a6755a63f4976ad847dc9b946ae0d145d21d16bb124e4",
    quoter: "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a", quoterHash: "0xceb5b8bc35e09fc64b1c48c6b920e0d2e37d5710e4f3ef214e1a81f75acee51e",
    weth: "0x4200000000000000000000000000000000000006", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  42161: {
    router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", routerHash: "0x209f9820ed7257d51c2f96ee837e8ec057b44774899f4be16fc45bd30cbb16f6",
    quoter: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e", quoterHash: "0xd8162b13ba57ce21a146063b10658bda0a3fd15c99f768c86283fce6640858a5",
    weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  4663: {
    router: "0xcaf681a66d020601342297493863e78c959e5cb2", routerHash: "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc",
    quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7", quoterHash: "0x3db0868d945e9304c9bc6a8b2181948109ea617647142f3c4083e14393496a28",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", usdc: null,
  },
};

const SEL = {
  quoteSingle: sel("quoteExactInputSingle((address,address,uint256,uint24,uint160))"),
  quotePath: sel("quoteExactInput(bytes,uint256)"),
  exactInputSingle: sel("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"),
  exactInput: sel("exactInput((bytes,address,uint256,uint256))"),
  unwrap: sel("unwrapWETH9(uint256,address)"),
  multicall: sel("multicall(uint256,bytes[])"),
  approve: sel("approve(address,uint256)"),
  allowance: sel("allowance(address,address)"),
};

export const supported = (chainId) => Object.prototype.hasOwnProperty.call(UNI, chainId);

function cfg(chainId) {
  if (!supported(chainId)) throw new Error("swaps are not available on this network");
  return UNI[chainId];
}

function token(chainId, t) {
  if (t === ETH) return cfg(chainId).weth;
  if (typeof t !== "string" || !/^0x[0-9a-f]{40}$/.test(t)) throw new Error("bad token address");
  return t;
}

function fee3(f) {
  if (!FEES.includes(f)) throw new Error("bad pool fee");
  return Uint8Array.of((f >> 16) & 255, (f >> 8) & 255, f & 255);
}

export function encodePath(tokens, fees) {
  if (tokens.length !== fees.length + 1 || fees.length < 1 || fees.length > 2) throw new Error("bad route");
  const parts = [addressBytes(tokens[0])];
  fees.forEach((f, i) => parts.push(fee3(f), addressBytes(tokens[i + 1])));
  return concat(...parts);
}

export function routes(chainId, tokenIn, tokenOut) {
  const a = token(chainId, tokenIn), b = token(chainId, tokenOut);
  if (a === b) throw new Error("pick two different tokens");
  const weth = cfg(chainId).weth;
  const out = FEES.map((f) => ({ tokens: [a, b], fees: [f] }));
  if (a !== weth && b !== weth) for (const f1 of FEES) for (const f2 of FEES) out.push({ tokens: [a, weth, b], fees: [f1, f2] });
  return out;
}

export function quoteData(route, amountIn) {
  if (route.fees.length === 1) {
    return concat(SEL.quoteSingle, addressWord(route.tokens[0]), addressWord(route.tokens[1]), word(amountIn), word(route.fees[0]), word(0));
  }
  return concat(SEL.quotePath, word(64), word(amountIn), dynBytes(encodePath(route.tokens, route.fees)));
}

function firstWord(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{64,}$/.test(hex)) throw new Error("bad quote");
  return BigInt(hex.slice(0, 66));
}

export async function bestQuote(chainId, tokenIn, tokenOut, amountIn, call) {
  if (typeof amountIn !== "bigint" || amountIn <= 0n) throw new Error("enter an amount above zero");
  const c = cfg(chainId);
  const rs = routes(chainId, tokenIn, tokenOut);
  const got = await Promise.all(rs.map(async (r) => {
    try { return { route: r, out: firstWord(await call(c.quoter, quoteData(r, amountIn))) }; } catch { return null; }
  }));
  const ok = got.filter((g) => g && g.out > 0n).sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : x.route.fees.length - y.route.fees.length));
  if (!ok.length) throw new Error("Uniswap has no pool for this pair on this network");
  return ok[0];
}

export async function confirmQuote(chainId, best, amountIn, call) {
  const again = firstWord(await call(cfg(chainId).quoter, quoteData(best.route, amountIn)));
  const lo = again < best.out ? again : best.out, hi = again < best.out ? best.out : again;
  if ((hi - lo) * 1000n > hi * 5n) throw new Error("the two network sources give different prices for this swap. Nothing was signed; try again in a moment");
  return lo;
}

export function minOut(expected, slippageBps) {
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) throw new Error("bad slippage");
  return (expected * BigInt(10000 - slippageBps)) / 10000n;
}

function bytesArray(items) {
  const bodies = items.map((b) => dynBytes(b));
  const heads = [];
  let off = 32 * items.length;
  for (const b of bodies) { heads.push(word(off)); off += b.length; }
  return concat(word(items.length), ...heads, ...bodies);
}

export function swapData({ route, recipient, amountIn, amountOutMin }) {
  if (route.fees.length === 1) {
    return concat(SEL.exactInputSingle, addressWord(route.tokens[0]), addressWord(route.tokens[1]), word(route.fees[0]), addressWord(recipient), word(amountIn), word(amountOutMin), word(0));
  }
  return concat(SEL.exactInput, word(32), word(128), addressWord(recipient), word(amountIn), word(amountOutMin), dynBytes(encodePath(route.tokens, route.fees)));
}

export function swapCalls({ chainId, account, tokenIn, tokenOut, amountIn, amountOutMin, route, deadline, allowance = 0n }) {
  const c = cfg(chainId);
  if (amountOutMin <= 0n) throw new Error("the minimum to receive is zero");
  const ethOut = tokenOut === ETH;
  const inner = [swapData({ route, recipient: ethOut ? ADDRESS_THIS : account, amountIn, amountOutMin })];
  if (ethOut) inner.push(concat(SEL.unwrap, word(amountOutMin), addressWord(account)));
  const swap = { to: c.router, value: tokenIn === ETH ? amountIn : 0n, data: concat(SEL.multicall, word(deadline), word(64), bytesArray(inner)) };
  if (tokenIn === ETH) return [swap];
  const approve = (n) => ({ to: tokenIn, value: 0n, data: concat(SEL.approve, addressWord(c.router), word(n)) });
  return [...(allowance > 0n ? [approve(0n)] : []), approve(amountIn), swap, approve(0n)];
}

export function allowanceData(owner, spender) {
  return concat(SEL.allowance, addressWord(owner), addressWord(spender));
}

export function codeHash(codeHex) {
  return bytesToHex(keccak256(hexToBytes(codeHex)));
}

export async function checkContracts(chainId, getCode) {
  const c = cfg(chainId);
  for (const [a, h, name] of [[c.router, c.routerHash, "router"], [c.quoter, c.quoterHash, "quoter"]]) {
    if (codeHash(await getCode(a)) !== h) throw new Error(`the Uniswap ${name} on this network is not the code this wallet expects. Nothing was signed`);
  }
}

export function routeText(route, symbol) {
  const names = route.tokens.map(symbol);
  return route.fees.map((f, i) => `${names[i]} → ${names[i + 1]} (${f / 10000}%)`).join(", ");
}
