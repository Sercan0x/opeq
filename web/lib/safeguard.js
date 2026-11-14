import { keccak256 } from "./keccak.js";
import { bytesToHex, hexToBytes } from "./evmtx.js";
import { CREATE2_DEPLOYER, word, addressWord, addressBytes, concat } from "./evmwots.js";
import { GUARD_INIT, GUARD_RUNTIME } from "./safeguardcode.js";
import { ACCOUNT_RUNTIME } from "./evmcode.js";

const enc = new TextEncoder();
const sel = (sig) => keccak256(enc.encode(sig)).slice(0, 4);
const hx = (b) => bytesToHex(b);
const lower = (a) => a.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
const SENTINEL = "0x0000000000000000000000000000000000000001";

export const GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n;
export const FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5n;
export const MIN_DELAY_DAYS = 7;
export const MAX_DELAY_DAYS = 90;
export const MAX_APPROVERS = 16;
export const APPROVE_GAS = 90000n;
export const CANCEL_GAS = 70000n;

export const PROXY_CODE_HASHES = new Set([
  "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000",
  "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  "0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f",
]);

export const SINGLETONS = Object.freeze({
  "0xd9db270c1b5e3bd161e8c8503c55ceabee709552": "1.3.0",
  "0x3e5c63644e683549055b9be8653de26e0b4cd36e": "1.3.0",
  "0x69f4d1788e39c87893c980c06edf4b7f686e2938": "1.3.0",
  "0xfb1bffc9d739b8d520daf37df666da4c687191ea": "1.3.0",
  "0x41675c099f32341bf84bfc5382af534df5c7461a": "1.4.1",
  "0x29fcb43b46531bca003ddc8fcb67ffe91900c762": "1.4.1",
  "0xff51a5898e281db6dfc7855790607438df2ca44b": "1.5.0",
  "0xedd160febbd92e350d4d398fb636302fccd67c7e": "1.5.0",
});

export const MULTISEND_CALL_ONLY = new Set([
  "0x40a2accbd92bca938b02010e17a5b8929b49130d",
  "0x9641d764fc13c8b624c04430c7356c1c7c8102e2",
]);

const S = {
  masterCopy: Uint8Array.of(0xa6, 0x19, 0x48, 0x6e),
  getOwners: sel("getOwners()"),
  getThreshold: sel("getThreshold()"),
  nonce: sel("nonce()"),
  getStorageAt: sel("getStorageAt(uint256,uint256)"),
  getModules: sel("getModulesPaginated(address,uint256)"),
  setGuard: sel("setGuard(address)"),
  setFallbackHandler: sel("setFallbackHandler(address)"),
  addOwner: sel("addOwnerWithThreshold(address,uint256)"),
  removeOwner: sel("removeOwner(address,address,uint256)"),
  swapOwner: sel("swapOwner(address,address,address)"),
  changeThreshold: sel("changeThreshold(uint256)"),
  enableModule: sel("enableModule(address)"),
  disableModule: sel("disableModule(address,address)"),
  multiSend: sel("multiSend(bytes)"),
  transfer: sel("transfer(address,uint256)"),
  tokenApprove: sel("approve(address,uint256)"),
  configure: sel("configure(address[],uint8,uint32)"),
  approve: sel("approve(address,bytes32)"),
  cancelRecovery: sel("cancelRecovery(address,bytes32)"),
  requestRecovery: sel("requestRecovery(address,bytes32)"),
  config: sel("config(address)"),
  approverSet: sel("approverSet(address)"),
  approved: sel("approved(address,bytes32,address)"),
  pendingRecoveries: sel("pendingRecoveries(address)"),
};

const SAFE_TX_TYPEHASH = hexToBytes("0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8");
const DOMAIN_TYPEHASH = hexToBytes("0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218");
const GUARD_INIT_BYTES = hexToBytes("0x" + GUARD_INIT);

export function guardAddress() {
  return hx(keccak256(Uint8Array.of(0xff), addressBytes(CREATE2_DEPLOYER), new Uint8Array(32), keccak256(GUARD_INIT_BYTES)).slice(12));
}

export function guardDeployData() {
  return concat(new Uint8Array(32), GUARD_INIT_BYTES);
}

export function isGuardCode(code) {
  return lower(code.replace(/^0x/, "")) === lower(GUARD_RUNTIME);
}

function words(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 64) throw new Error("malformed answer from the network");
  return { at: (i) => { if (i < 0 || i >= h.length / 64) throw new Error("malformed answer from the network"); return BigInt("0x" + h.slice(64 * i, 64 * i + 64)); }, n: h.length / 64 };
}

function addr(v) {
  if (v >> 160n) throw new Error("malformed address in the answer from the network");
  return "0x" + v.toString(16).padStart(40, "0");
}

function array(w, offWord, max, f) {
  const off = w.at(offWord);
  if (off % 32n) throw new Error("malformed answer from the network");
  const at = Number(off / 32n);
  const n = w.at(at);
  if (n > BigInt(max)) throw new Error("malformed answer from the network");
  return Array.from({ length: Number(n) }, (_, i) => f(w.at(at + 1 + i)));
}

const call = (s, ...args) => hx(concat(s, ...args));

export function safeTxHash(chainId, safe, tx, nonce) {
  const domain = keccak256(concat(DOMAIN_TYPEHASH, word(chainId), addressWord(safe)));
  const struct = keccak256(concat(SAFE_TX_TYPEHASH, addressWord(tx.to), word(tx.value), keccak256(tx.data), word(tx.operation), word(0), word(0), word(0), addressWord(ZERO), addressWord(ZERO), word(nonce)));
  return hx(keccak256(Uint8Array.of(0x19, 0x01), domain, struct));
}

export async function readSafeAt(rpc, safe, block = "latest") {
  const code = await rpc.code(safe, block);
  if (code === "0x") throw new Error("there is no Safe at that address on this network");
  if (!PROXY_CODE_HASHES.has(hx(keccak256(hexToBytes(code))))) throw new Error("that address is not a standard Safe account, refusing to use it");
  const single = addr(words(await rpc.ethCall(safe, hx(S.masterCopy), block)).at(0));
  const version = SINGLETONS[single];
  if (!version) throw new Error("this Safe runs a Safe version OPEQ does not support (supported: 1.3.0, 1.4.1, 1.5.0)");
  const slot = (s) => rpc.ethCall(safe, call(S.getStorageAt, word(s), word(1)), block);
  const [o, t, n, g, f, m] = await Promise.all([
    rpc.ethCall(safe, hx(S.getOwners), block),
    rpc.ethCall(safe, hx(S.getThreshold), block),
    rpc.ethCall(safe, hx(S.nonce), block),
    slot(GUARD_SLOT), slot(FALLBACK_SLOT),
    rpc.ethCall(safe, call(S.getModules, addressWord(SENTINEL), word(10)), block),
  ]);
  const owners = array(words(o), 0, 64, addr);
  const threshold = Number(words(t).at(0));
  if (!owners.length || threshold < 1 || threshold > owners.length) throw new Error("malformed Safe settings from the network");
  const gw = words(g), fw = words(f);
  return {
    address: lower(safe), version, singleton: single, owners, threshold,
    nonce: words(n).at(0),
    guard: addr(gw.at(2)), fallback: addr(fw.at(2)),
    modules: array(words(m), 0, 10, addr),
  };
}

export async function readGuardAt(rpc, guard, safe, block = "latest") {
  const [c, a, r] = await Promise.all([
    rpc.ethCall(guard, call(S.config, addressWord(safe)), block),
    rpc.ethCall(guard, call(S.approverSet, addressWord(safe)), block),
    rpc.ethCall(guard, call(S.pendingRecoveries, addressWord(safe)), block),
  ]);
  const cw = words(c), rw = words(r);
  const approvers = array(words(a), 0, MAX_APPROVERS, addr);
  const codes = await Promise.all(approvers.map((x) => rpc.code(x, block)));
  const hashes = array(rw, 0, 16, (v) => "0x" + v.toString(16).padStart(64, "0"));
  const ready = array(rw, 1, 16, (v) => Number(v));
  if (hashes.length !== ready.length) throw new Error("malformed answer from the network");
  return {
    required: Number(cw.at(0)), delay: Number(cw.at(1)),
    approvers,
    opeq: codes.map((c) => lower(c.replace(/^0x/, "")) === lower(ACCOUNT_RUNTIME)),
    recoveries: hashes.map((h, i) => ({ hash: h, readyAt: ready[i] })),
  };
}

const same = (a, b) => JSON.stringify(a, (k, v) => typeof v === "bigint" ? v.toString() : v) === JSON.stringify(b, (k, v) => typeof v === "bigint" ? v.toString() : v);

export async function read(chain, safe) {
  const guard = guardAddress();
  const one = async (rpc, block) => {
    const s = await readSafeAt(rpc, safe, block);
    const installed = (await rpc.code(guard, block)) !== "0x";
    const g = installed ? await readGuardAt(rpc, guard, safe, block) : null;
    return { safe: s, guard: g, installed };
  };
  const a = await chain.at((b) => one(chain.rpc, b));
  if (chain.check) {
    const b = await one(chain.check, "latest").catch(() => null);
    const key = (x) => ({ o: x.safe.owners, t: x.safe.threshold, g: x.safe.guard, f: x.safe.fallback, m: x.safe.modules, i: x.installed, c: x.guard && { r: x.guard.required, d: x.guard.delay, a: x.guard.approvers, q: x.guard.opeq } });
    if (!b || !same(key(a), key(b))) throw new Error("two independent network sources disagree about this Safe, so nothing is shown as safe to sign. Try again in a minute");
    if (a.guard && b.guard) {
      const seen = new Set(a.guard.recoveries.map((r) => r.hash));
      for (const r of b.guard.recoveries) if (!seen.has(r.hash)) a.guard.recoveries.push(r);
    }
    if (b.safe.nonce > a.safe.nonce) a.safe.nonce = b.safe.nonce;
  }
  return a;
}

export async function approvedBy(chain, safe, hash, who) {
  const data = call(S.approved, addressWord(safe), hexToBytes(hash), addressWord(who));
  const a = words(await chain.rpc.ethCall(guardAddress(), data)).at(0) !== 0n;
  if (chain.check) {
    const b = await chain.check.ethCall(guardAddress(), data).then((r) => words(r).at(0) !== 0n).catch(() => null);
    if (b !== a) throw new Error("two independent network sources disagree about your approval. Try again in a minute");
  }
  return a;
}

export function lockState(r, me) {
  const issues = [];
  const guard = guardAddress();
  if (!r.installed) issues.push("The OPEQ guard is not installed on this network yet.");
  if (r.safe.guard === ZERO) issues.push("The Safe has no guard, so the owners can move funds without OPEQ.");
  else if (lower(r.safe.guard) !== lower(guard)) issues.push(`The Safe uses a different guard (${r.safe.guard}), not the OPEQ guard.`);
  if (r.safe.fallback !== ZERO) issues.push("The Safe still has a fallback handler. It must be removed first, or signed messages could bypass the lock.");
  if (r.safe.modules.length) issues.push(`The Safe has ${r.safe.modules.length} module${r.safe.modules.length > 1 ? "s" : ""} enabled. Modules move funds without the guard, so they must be removed.`);
  if (!r.guard || !r.guard.required) issues.push("The OPEQ guard has no settings for this Safe yet.");
  else {
    if (!r.guard.approvers.includes(lower(me))) issues.push("Your OPEQ account is not one of the approvers in the guard settings.");
    const plain = r.guard.approvers.filter((a, i) => !r.guard.opeq[i]);
    if (plain.length) issues.push(`${plain.length} approver${plain.length > 1 ? "s are" : " is"} not an OPEQ account (${plain.join(", ")}), so a normal key could approve.`);
  }
  return { locked: issues.length === 0, issues };
}

export const configureData = (approvers, required, delayDays) => hx(concat(S.configure, word(96), word(required), word(delayDays * 86400), word(approvers.length), ...approvers.map(addressWord)));
export const setGuardData = (g) => hx(concat(S.setGuard, addressWord(g)));
export const setFallbackData = (h) => hx(concat(S.setFallbackHandler, addressWord(h)));
export const approveCall = (safe, hash) => ({ to: guardAddress(), value: 0n, data: concat(S.approve, addressWord(safe), hexToBytes(hash)) });
export const cancelCall = (safe, hash) => ({ to: guardAddress(), value: 0n, data: concat(S.cancelRecovery, addressWord(safe), hexToBytes(hash)) });

const eqSel = (d, s) => d.length >= 4 && d[0] === s[0] && d[1] === s[1] && d[2] === s[2] && d[3] === s[3];

function argWords(d) {
  const body = d.slice(4);
  if (body.length % 32) return null;
  const w = [];
  for (let i = 0; i < body.length; i += 32) w.push(BigInt(hx(body.slice(i, i + 32))));
  return w;
}

function decodeMultiSend(data) {
  const w = argWords(data);
  if (!w || w.length < 2 || w[0] !== 32n) return null;
  const len = Number(w[1]);
  const packed = data.slice(4 + 64, 4 + 64 + len);
  if (packed.length !== len) return null;
  const out = [];
  let o = 0;
  while (o < packed.length) {
    if (o + 85 > packed.length) return null;
    const operation = packed[o];
    const to = hx(packed.slice(o + 1, o + 21));
    const value = BigInt(hx(packed.slice(o + 21, o + 53)));
    const n = Number(BigInt(hx(packed.slice(o + 53, o + 85))));
    const d = packed.slice(o + 85, o + 85 + n);
    if (d.length !== n || operation !== 0 || /^0x0{40}$/.test(to)) return null;
    out.push({ to, value, data: d, operation });
    o += 85 + n;
    if (out.length > 50) return null;
  }
  return out;
}

export function describe(tx, safe) {
  const d = tx.data, to = lower(tx.to), g = lower(guardAddress());
  if (tx.operation === 1) {
    if (MULTISEND_CALL_ONLY.has(to) && eqSel(d, S.multiSend) && tx.value === 0n) {
      const inner = decodeMultiSend(d);
      if (inner) return inner.flatMap((t) => describe(t, safe));
    }
    return [{ kind: "delegate", to, data: hx(d), size: d.length }];
  }
  if (tx.operation !== 0) return [{ kind: "delegate", to, data: hx(d), size: d.length }];
  if (!d.length) return [{ kind: "pay", to, value: tx.value }];
  const w = argWords(d);
  if (w && to === lower(safe) && tx.value === 0n) {
    const a = (v) => { try { return addr(v); } catch { return null; } };
    if (eqSel(d, S.setGuard) && w.length === 1 && a(w[0])) return [{ kind: "setGuard", guard: a(w[0]) }];
    if (eqSel(d, S.setFallbackHandler) && w.length === 1 && a(w[0])) return [{ kind: "setFallback", handler: a(w[0]) }];
    if (eqSel(d, S.enableModule) && w.length === 1 && a(w[0])) return [{ kind: "enableModule", module: a(w[0]) }];
    if (eqSel(d, S.disableModule) && w.length === 2 && a(w[1])) return [{ kind: "disableModule", module: a(w[1]) }];
    if (eqSel(d, S.addOwner) && w.length === 2 && a(w[0])) return [{ kind: "addOwner", owner: a(w[0]), threshold: w[1] }];
    if (eqSel(d, S.removeOwner) && w.length === 3 && a(w[1])) return [{ kind: "removeOwner", owner: a(w[1]), threshold: w[2] }];
    if (eqSel(d, S.swapOwner) && w.length === 3 && a(w[1]) && a(w[2])) return [{ kind: "swapOwner", from: a(w[1]), owner: a(w[2]) }];
    if (eqSel(d, S.changeThreshold) && w.length === 1) return [{ kind: "threshold", threshold: w[0] }];
  }
  if (w && to === g && tx.value === 0n && eqSel(d, S.configure) && w.length >= 4 && w[0] === 96n) {
    const n = Number(w[3]);
    if (n >= 1 && n <= MAX_APPROVERS && w.length === 4 + n && w.slice(4).every((v) => !(v >> 160n))) return [{ kind: "configure", required: Number(w[1]), delay: Number(w[2]), approvers: w.slice(4).map(addr) }];
  }
  if (w && tx.value === 0n && eqSel(d, S.transfer) && w.length === 2 && !(w[0] >> 160n)) return [{ kind: "token", token: to, to: addr(w[0]), amount: w[1] }];
  if (w && tx.value === 0n && eqSel(d, S.tokenApprove) && w.length === 2 && !(w[0] >> 160n)) return [{ kind: "allowance", token: to, spender: addr(w[0]), amount: w[1] }];
  return [{ kind: "contract", to, value: tx.value, selector: hx(d.slice(0, 4)), data: hx(d), size: d.length }];
}

export function parseTx(toText, valueWei, dataText, operation) {
  const data = hexToBytes(String(dataText || "0x").trim() || "0x");
  if (operation !== 0 && operation !== 1) throw new Error("operation must be call or delegatecall");
  return { to: lower(toText), value: valueWei, data, operation };
}

export { ZERO, S as SELECTORS };
