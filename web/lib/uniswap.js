import * as E from "./evmwots.js";
import { keccak256 } from "./keccak.js";
import { bytesToHex, hexToBytes } from "./evmtx.js";

const enc = new TextEncoder();
const { word, addressWord, addressBytes, concat, dynBytes } = E;
const sel = (sig) => keccak256(enc.encode(sig)).slice(0, 4);

export const ETH = "eth";
export const FEES = [100, 500, 3000, 10000];
export const MAX_SLIPPAGE_BPS = 300;
export const DEADLINE_S = { 1: 300, 8453: 600, 42161: 600, 4663: 600 };
export const AGREE_BPS = 50n;
export const SIM_CODE = "0x608080604052600436101561001c575b50361561001a575f80fd5b005b5f3560e01c908163150b7a021461013c575063153291ab1461003e575f61000f565b346101385760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101385760043567ffffffffffffffff811161013857366023820112156101385780600401359067ffffffffffffffff8211610138573660248360051b830101116101385760207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06100eb60e093601f9560246100e4610204565b9201610399565b926040999597949992919251998a98151589528589015260408801526060870152608086015260c060a086015280519182918260c0880152018686015e5f85828601015201168101030190f35b5f80fd5b346101385760807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610138576101736101e1565b5061017c610204565b5060643567ffffffffffffffff8111610138573660238201121561013857806004013567ffffffffffffffff8111610138573691016024011161013857807f150b7a020000000000000000000000000000000000000000000000000000000060209252f35b6004359073ffffffffffffffffffffffffffffffffffffffff8216820361013857565b6024359073ffffffffffffffffffffffffffffffffffffffff8216820361013857565b91908110156102675760051b810135907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa181360301821215610138570190565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52603260045260245ffd5b90601f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0910116810190811067ffffffffffffffff8211176102d557604052565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b3d1561035a573d9067ffffffffffffffff82116102d5576040519161034f60207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f8401160184610294565b82523d5f602084013e565b606090565b9190820391821161036c57565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b91905f926060906103a9846104b5565b925a915f5b8281106103d2575050506103c66103cc915a9061035f565b936104b5565b90600195565b6103dd818484610227565b3573ffffffffffffffffffffffffffffffffffffffff81168103610138576020610408838686610227565b013590610416838686610227565b6040810135907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18136030182121561013857019081359167ffffffffffffffff831161013857602001918036038313610138575f938493826040519384928337810185815203925af1610487610302565b901561049657506001016103ae565b97509794955050506104aa91505a9061035f565b5f9493909291829190565b73ffffffffffffffffffffffffffffffffffffffff811615610551575f809160405160208101907f70a0823100000000000000000000000000000000000000000000000000000000825230602482015260248152610514604482610294565b51915afa610520610302565b9080610545575b1561054057602081805181010312610138576020015190565b505f90565b50602081511015610527565b50479056fea264697066735822122090ba1ee3a4fda7ca835ea57e08eee968d479db9a2942655c1d6bf4599243459164736f6c63430008210033";
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

export const UNI = {
  1: {
    router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", routerHash: "0x6ec798e80f3a19de650826338677604e54d6664f44a33b53a20b22b1939f402e",
    quoter: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e", quoterHash: "0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b",
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", stable: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", stableSymbol: "USDC",
  },
  8453: {
    router: "0x2626664c2603336e57b271c5c0b26f421741e481", routerHash: "0x38bd640f47df62b2fd5a6755a63f4976ad847dc9b946ae0d145d21d16bb124e4",
    quoter: "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a", quoterHash: "0xceb5b8bc35e09fc64b1c48c6b920e0d2e37d5710e4f3ef214e1a81f75acee51e",
    weth: "0x4200000000000000000000000000000000000006", stable: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", stableSymbol: "USDC",
  },
  42161: {
    router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", routerHash: "0x209f9820ed7257d51c2f96ee837e8ec057b44774899f4be16fc45bd30cbb16f6",
    quoter: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e", quoterHash: "0xd8162b13ba57ce21a146063b10658bda0a3fd15c99f768c86283fce6640858a5",
    weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", stable: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", stableSymbol: "USDC",
  },
  4663: {
    router: "0xcaf681a66d020601342297493863e78c959e5cb2", routerHash: "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc",
    quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7", quoterHash: "0x3db0868d945e9304c9bc6a8b2181948109ea617647142f3c4083e14393496a28",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", stable: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", stableSymbol: "USDG",
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
  refundETH: sel("refundETH()"),
  sweep: sel("sweepToken(address,uint256,address)"),
  weth9: sel("WETH9()"),
  sim: sel("sim((address,uint256,bytes)[],address)"),
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

export async function quoteAll(chainId, tokenIn, tokenOut, amountIn, call) {
  if (typeof amountIn !== "bigint" || amountIn <= 0n) throw new Error("enter an amount above zero");
  const c = cfg(chainId);
  return await Promise.all(routes(chainId, tokenIn, tokenOut).map(async (route) => {
    try { const out = firstWord(await call(c.quoter, quoteData(route, amountIn))); return { route, out: out > 0n ? out : null }; } catch { return { route, out: null }; }
  }));
}

export class Disagree extends Error {}

export function pickBest(...sources) {
  const n = sources[0].length;
  let best = null;
  for (let i = 0; i < n; i++) {
    const vals = sources.map((s) => s[i].out);
    if (vals.every((v) => v === null)) continue;
    if (vals.some((v) => v === null)) throw new Disagree("the two network sources do not agree on which Uniswap pools exist for this pair. Nothing was signed; try again in a moment");
    const hi = vals.reduce((m, v) => (v > m ? v : m)), lo = vals.reduce((m, v) => (v < m ? v : m));
    if ((hi - lo) * 10000n > hi * AGREE_BPS) throw new Disagree("the two network sources give different prices for this swap. Nothing was signed; try again in a moment");
    const route = sources[0][i].route;
    if (!best || lo > best.out || (lo === best.out && route.fees.length < best.route.fees.length)) best = { route, out: lo };
  }
  if (!best) throw new Error("Uniswap has no pool for this pair on this network");
  return best;
}

export function impactBps(out, amountIn, refOut, refIn) {
  if (!refOut || !refIn || refOut <= 0n || refIn <= 0n) return null;
  const v = 10000n - (out * refIn * 10000n) / (refOut * amountIn);
  return v > 0n ? v : 0n;
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

export function swapCalls({ chainId, account, tokenIn, tokenOut, amountIn, amountOutMin, route, deadline }) {
  const c = cfg(chainId);
  if (amountOutMin <= 0n) throw new Error("the minimum to receive is zero");
  if (route.tokens[0] !== token(chainId, tokenIn) || route.tokens[route.tokens.length - 1] !== token(chainId, tokenOut)) throw new Error("the route does not match the tokens");
  const inner = [swapData({ route, recipient: tokenOut === ETH ? ADDRESS_THIS : account, amountIn, amountOutMin })];
  if (tokenOut === ETH) inner.push(concat(SEL.unwrap, word(amountOutMin), addressWord(account)));
  if (route.tokens.length === 3) inner.push(concat(SEL.sweep, addressWord(c.weth), word(0), addressWord(account)));
  if (tokenIn === ETH) inner.push(SEL.refundETH);
  const swap = { to: c.router, value: tokenIn === ETH ? amountIn : 0n, data: concat(SEL.multicall, word(deadline), word(64), bytesArray(inner)) };
  if (tokenIn === ETH) return [swap];
  const approve = (n) => ({ to: tokenIn, value: 0n, data: concat(SEL.approve, addressWord(c.router), word(n)) });
  return [approve(0n), approve(amountIn), swap, approve(0n)];
}

export function simParams(account, calls, tokenOut, block = "latest", from = undefined) {
  const data = concat(SEL.sim, word(64), tokenOut === ETH ? word(0) : addressWord(tokenOut), E.encodeCalls(calls));
  return [{ ...(from ? { from } : {}), to: account, gas: "0x" + (8000000).toString(16), data: bytesToHex(data) }, block, { [account]: { code: SIM_CODE } }];
}

export function decodeSim(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{384,}$/.test(hex)) throw new Error("the swap test run gave no usable answer");
  const w = (i) => BigInt("0x" + hex.slice(2 + 64 * i, 66 + 64 * i));
  return { ok: w(0) === 1n, index: Number(w(1)), gas: w(2), before: w(3), after: w(4) };
}

export function allowanceData(owner, spender) {
  return concat(SEL.allowance, addressWord(owner), addressWord(spender));
}

export function codeHash(codeHex) {
  return bytesToHex(keccak256(hexToBytes(codeHex)));
}

export async function checkContracts(chainId, getCode, call) {
  const c = cfg(chainId);
  for (const [a, h, name] of [[c.router, c.routerHash, "router"], [c.quoter, c.quoterHash, "quoter"]]) {
    if (codeHash(await getCode(a)) !== h) throw new Error(`the Uniswap ${name} on this network is not the code this wallet expects. Nothing was signed`);
  }
  if (call) for (const a of [c.router, c.quoter]) {
    const r = await call(a, SEL.weth9);
    if (typeof r !== "string" || ("0x" + r.slice(-40)).toLowerCase() !== c.weth) throw new Error("Uniswap on this network uses a different WETH than this wallet expects. Nothing was signed");
  }
}

export function routeText(route, symbol) {
  const names = route.tokens.map(symbol);
  return route.fees.map((f, i) => `${names[i]} → ${names[i + 1]} (${f / 10000}%)`).join(", ");
}
