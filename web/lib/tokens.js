import { sha256 } from "./sha256.js";
import { SYSTEM, concat, findPda, pubkey, u32, u64 } from "./solana.js";

const enc = new TextEncoder();

export const TOKEN = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN22 = pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROG = pubkey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const WSOL = pubkey("So11111111111111111111111111111111111111112");

export const DEMO = {
  name: "DEMO",
  alt: pubkey("CAFA9MNVo9eAfyTh3YY8FdDTEi46Hya25L8pmHHTX8Te"),
  mint: pubkey("B3N9yeWD9TavqS4shQhzz9eVmPWF2q35xcDXzvQqwMNB"),
  decimals: 6,
  cpmm: pubkey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"),
  cfg: pubkey("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy"),
  pool: pubkey("EPVZM9AdgMu2JNfnJwu9pNMz4mJnxb3LrvwxhuhiZydE"),
  auth: pubkey("CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq"),
  solVault: pubkey("FH91RDvvZ6rii3PHsVjceQsLVBRC5qyxg2N17y4yisyz"),
  tokenVault: pubkey("7xtqB82vJAyoLa7QmiwXSDwyfFi9eAY8qrPB44VVxxbM"),
  obs: pubkey("7TGEAXLNrfyajkZvd5qVAaKWzb8yBPiQzxvN311jmbpd"),
  tradeFee: 2500n,
};

export const KNOWN = new Map([[DEMO.mint.join(","), "DEMO"], [WSOL.join(","), "wSOL"]]);
export const KNOWN_MAINNET = new Map([[WSOL.join(","), "wSOL"],
  [pubkey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").join(","), "USDC"],
  [pubkey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB").join(","), "USDT"],
  [pubkey("9tpHqTJ2d8jMZJjZzsf9MCfnCEmbAjsqjPJ56PzSpump").join(","), "OPEQ"]]);

const METAPLEX = pubkey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function readStr(d, o, max) {
  if (o + 4 > d.length) return null;
  const n = (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  if (n > max || o + 4 + n > d.length) return null;
  return [new TextDecoder("utf-8", { fatal: false }).decode(d.slice(o + 4, o + 4 + n)), o + 4 + n];
}

export function cleanLabel(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").replace(/[^A-Za-z0-9 $._-]/g, "").replace(/\s+/g, " ").trim().slice(0, 12);
}

export function metaplexLabel(d) {
  if (!d || d.length < 70 || d[0] !== 4) return "";
  const name = readStr(d, 65, 64);
  if (!name) return "";
  const sym = readStr(d, name[1], 32);
  return cleanLabel(sym && sym[0]) || cleanLabel(name[0]);
}

export function token22Label(d) {
  const m = mintExtensions(d).get(19);
  if (!m) return "";
  const name = readStr(m, 64, 200);
  if (!name) return "";
  const sym = readStr(m, name[1], 64);
  return cleanLabel(sym && sym[0]) || cleanLabel(name[0]);
}

export async function tokenLabel(rpc, mint, tokenProgram) {
  if (tokenProgram.join(",") === TOKEN22.join(",")) {
    const acc = await rpc.account(mint);
    const l = acc ? token22Label(acc.data) : "";
    if (l) return l;
  }
  const acc = await rpc.account(findPda([enc.encode("metadata"), METAPLEX, mint], METAPLEX).key);
  return acc && acc.owner.join(",") === METAPLEX.join(",") ? metaplexLabel(acc.data) : "";
}

export function mintExtensions(data) {
  const out = new Map();
  if (data.length <= 166 || data[165] !== 1) return out;
  for (let i = 166; i + 4 <= data.length;) {
    const type = data[i] | (data[i + 1] << 8), len = data[i + 2] | (data[i + 3] << 8);
    if (type === 0) break;
    const body = data.slice(i + 4, i + 4 + len);
    if (type !== 14 || data.slice(i + 36, i + 68).some((b) => b !== 0)) out.set(type, body);
    i += 4 + len;
  }
  return out;
}

const nonzero = (b) => b.some((x) => x !== 0);

export async function mintWarnings(rpc, mint, tokenProgram) {
  if (tokenProgram.join(",") !== TOKEN22.join(",")) return "";
  const acc = await rpc.account(mint);
  if (!acc) throw new Error("token mint not found");
  const ext = mintExtensions(acc.data);
  if (ext.has(14)) throw new Error("this token runs extra program code on every transfer (transfer hook), which this wallet does not support yet");
  if (ext.has(9)) throw new Error("this token cannot be transferred (non-transferable)");
  if (ext.has(26) && ext.get(26)[32] === 1) throw new Error("transfers of this token are paused by its issuer right now");
  let w = "";
  const fee = ext.get(1);
  if (fee && (fee.length < 108 || nonzero(fee.slice(88, 90)) || nonzero(fee.slice(106, 108)))) w += "\nThis token charges a transfer fee, so the receiver gets less than the amount sent.";
  if (ext.has(12) && nonzero(ext.get(12).slice(0, 32))) w += "\nThis token has a permanent delegate that can move or burn anyone's balance of it.";
  if (ext.has(6) && ext.get(6)[0] === 2) w += "\nNew accounts for this token start frozen. If the receiver has no account yet, the transfer may fail.";
  if (ext.has(25) || ext.has(10)) w += "\nThis token's displayed balance is scaled by its issuer; the amount here is the raw amount and other wallets may show a different number.";
  return w;
}

export function ata(owner, mint, tokenProgram = TOKEN) {
  return findPda([owner, tokenProgram, mint], ATA_PROG).key;
}

export function createAtaIdempotent(payer, owner, mint, tokenProgram = TOKEN) {
  return [ATA_PROG, [[payer, true, true], [ata(owner, mint, tokenProgram), false, true], [owner, false, false],
    [mint, false, false], [SYSTEM, false, false], [tokenProgram, false, false]], new Uint8Array([1])];
}

export function transferChecked(tokenProgram, src, mint, dst, owner, amount, decimals) {
  return [tokenProgram, [[src, false, true], [mint, false, false], [dst, false, true], [owner, true, false]],
    concat(new Uint8Array([12]), u64(amount), new Uint8Array([decimals]))];
}

export function syncNative(account) {
  return [TOKEN, [[account, false, true]], new Uint8Array([17])];
}

export function closeAccount(account, dest, owner) {
  return [TOKEN, [[account, false, true], [dest, false, true], [owner, true, false]], new Uint8Array([9])];
}

export function solTransfer(from, to, lamports) {
  return [SYSTEM, [[from, true, true], [to, false, true]], concat(u32(2), u64(lamports))];
}

function anchorDisc(name) {
  return sha256(enc.encode(`global:${name}`)).slice(0, 8);
}

export function parseAmount(text, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("this token reports an unsupported number of decimals");
  const t = text.trim();
  const ok = decimals ? new RegExp(`^\\d{1,20}(\\.\\d{1,${decimals}})?$`).test(t) : /^\d{1,20}$/.test(t);
  if (!ok) throw new Error(`enter an amount with at most ${decimals} decimals`);
  const [w, f = ""] = t.split(".");
  const v = BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (v <= 0n) throw new Error("amount must be more than zero");
  if (v >= 1n << 64n) throw new Error("amount is too large");
  return v;
}

export function formatAmount(v, decimals) {
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : 0;
  const s = v.toString().padStart(d + 1, "0");
  const whole = s.slice(0, s.length - d) || "0";
  let frac = d ? s.slice(s.length - d) : "";
  while (frac.endsWith("0")) frac = frac.slice(0, -1);
  return frac ? `${whole}.${frac}` : whole;
}

export async function quote(rpc, solToToken, amountIn) {
  const [solRes, tokRes] = await Promise.all([rpc.tokenAmount(DEMO.solVault), rpc.tokenAmount(DEMO.tokenVault)]);
  const [rin, rout] = solToToken ? [solRes, tokRes] : [tokRes, solRes];
  const afterFee = (amountIn * (1000000n - DEMO.tradeFee)) / 1000000n;
  return (rout * afterFee) / (rin + afterFee);
}

export function swapInner(wallet, feePayer, solToToken, amountIn, minOut) {
  const wsolAta = ata(wallet, WSOL);
  const tokAta = ata(wallet, DEMO.mint);
  const inner = [createAtaIdempotent(feePayer, wallet, WSOL), createAtaIdempotent(feePayer, wallet, DEMO.mint)];
  if (solToToken) inner.push(solTransfer(wallet, wsolAta, amountIn), syncNative(wsolAta));
  const [inAcc, outAcc, inVault, outVault, inMint, outMint] = solToToken
    ? [wsolAta, tokAta, DEMO.solVault, DEMO.tokenVault, WSOL, DEMO.mint]
    : [tokAta, wsolAta, DEMO.tokenVault, DEMO.solVault, DEMO.mint, WSOL];
  inner.push([DEMO.cpmm, [
    [wallet, true, false], [DEMO.auth, false, false], [DEMO.cfg, false, false], [DEMO.pool, false, true],
    [inAcc, false, true], [outAcc, false, true], [inVault, false, true], [outVault, false, true],
    [TOKEN, false, false], [TOKEN, false, false], [inMint, false, false], [outMint, false, false], [DEMO.obs, false, true],
  ], concat(anchorDisc("swap_base_input"), u64(amountIn), u64(minOut))]);
  inner.push(closeAccount(wsolAta, wallet, wallet));
  return inner;
}
