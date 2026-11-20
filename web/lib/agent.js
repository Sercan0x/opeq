import { compileV0, concat, compact, findPda, pubkey, b58encode, b58decode, eq, u32, u64, COMPUTE_BUDGET } from "./solana.js";

export const TOKEN = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN22 = pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROG = pubkey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MEMO = pubkey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const AGENT_CU_LIMIT = 40000;
export const AGENT_CU_PRICE = 1000n;

const U64 = 1n << 64n;
const enc = new TextEncoder();
const dv = (d) => new DataView(d.buffer, d.byteOffset, d.byteLength);

export function ataOf(owner, mint, program = TOKEN) {
  return findPda([owner, program, mint], ATA_PROG).key;
}

export function isTokenProgram(p) {
  return eq(p, TOKEN) || eq(p, TOKEN22);
}

export function readMint(acc) {
  const ok = acc && isTokenProgram(acc.owner) && (acc.data.length === 82 || (eq(acc.owner, TOKEN22) && acc.data.length > 165 && acc.data[165] === 1));
  if (!ok || acc.data[45] !== 1) throw new Error("that address is not a token mint");
  return { program: acc.owner, decimals: acc.data[44] };
}

export function readTokenAccount(acc) {
  const ok = acc && isTokenProgram(acc.owner) && (acc.data.length === 165 || (eq(acc.owner, TOKEN22) && acc.data.length > 165 && acc.data[165] === 2));
  if (!ok) throw new Error("that address is not a token account");
  const d = acc.data, v = dv(d);
  if (d[108] !== 1) throw new Error(d[108] === 2 ? "the token account is frozen" : "the token account is not initialized");
  const opt = (at) => (v.getUint32(at, true) === 1 ? d.slice(at + 4, at + 36) : null);
  return {
    program: acc.owner,
    mint: d.slice(0, 32),
    owner: d.slice(32, 64),
    amount: v.getBigUint64(64, true),
    delegate: opt(72),
    delegatedAmount: v.getBigUint64(121, true),
    closeAuthority: opt(129),
  };
}

export function approveIx(program, source, mint, delegate, owner, amount, decimals) {
  if (typeof amount !== "bigint" || amount < 1n || amount >= U64) throw new Error("allowance must be a whole number of base units above zero");
  return [program, [[source, false, true], [mint, false, false], [delegate, false, false], [owner, true, false]],
    concat(new Uint8Array([13]), u64(amount), new Uint8Array([decimals]))];
}

export function revokeIx(program, source, owner) {
  return [program, [[source, false, true], [owner, true, false]], new Uint8Array([5])];
}

export const AUTHORITY_TYPES = ["mint tokens", "freeze accounts", "own the token account", "close the token account",
  "set the token's transfer fee", "withdraw the token's withheld fees", "close the token mint", "change the token's interest rate",
  "move or burn anyone's balance of this token (permanent delegate)", "change confidential transfer settings", "change the token's transfer hook program",
  "change confidential transfer fee settings", "change the token's metadata pointer", "change the token's group pointer",
  "change the token's group member pointer", "change the token's scaled UI amount", "pause the token"];
const MINT_RIGHTS_DANGER = new Set([0, 1, 4, 6, 8, 10, 16]);

export function decodeTokenAuthority(program, keys, data) {
  if (!isTokenProgram(program) || !data.length) return null;
  const at = (i) => (i < keys.length ? keys[i] : null);
  const v = dv(data);
  if (data[0] === 4 && data.length === 9 && keys.length >= 3) return { kind: "allowance", program, source: at(0), mint: null, delegate: at(1), owner: at(2), amount: v.getBigUint64(1, true), decimals: null };
  if (data[0] === 13 && data.length === 10 && keys.length >= 4) return { kind: "allowance", program, source: at(0), mint: at(1), delegate: at(2), owner: at(3), amount: v.getBigUint64(1, true), decimals: data[9] };
  if (data[0] === 5 && data.length === 1 && keys.length >= 2) return { kind: "revoke", program, source: at(0), owner: at(1) };
  if (data[0] === 6 && keys.length >= 2 && (data.length === 3 || data.length === 35)) {
    const next = data[2] === 1 && data.length === 35 ? data.slice(3, 35) : data[2] === 0 && data.length === 3 ? null : undefined;
    if (next === undefined) return null;
    return { kind: "authority", program, target: at(0), current: at(1), type: data[1], what: AUTHORITY_TYPES[data[1]] || `authority type ${data[1]}`, next };
  }
  return null;
}

export function authorityWords(d, vault) {
  const s = (k) => (k ? b58encode(k) : "(unknown)");
  const fromVault = d.owner && vault && eq(d.owner, vault);
  if (d.kind === "allowance") {
    const amt = `${d.amount} token units${d.decimals !== null ? ` (${d.decimals} decimals)` : ""}`;
    return {
      title: `Allow ${s(d.delegate).slice(0, 6)}… to take up to ${amt} from ${fromVault ? "the vault" : "a token account"}${d.mint ? "" : " (token not named)"}`,
      rows: [["Spender", s(d.delegate), true], ["From token account", s(d.source), true], ["Account owner", s(d.owner), true], ...(d.mint ? [["Mint", s(d.mint), true]] : [])],
      notes: ["An allowance lets the spender move these tokens later without asking again, until it is used up or revoked. Only approve a spender you know.",
        ...(d.amount >= (1n << 63n) ? ["The amount is close to unlimited."] : []), ...(fromVault ? [] : ["The token account is not owned by this vault."]),
        ...(d.mint ? [] : ["This instruction does not name the token or its decimals. Check which token the source account holds before you approve."])],
      risky: true, check: [s(d.delegate), s(d.source)],
    };
  }
  if (d.kind === "revoke") return { title: `Remove the spending allowance on ${fromVault ? "a vault token account" : "a token account"}`, rows: [["Token account", s(d.source), true], ["Account owner", s(d.owner), true]], notes: [] };
  const change = d.next ? `Give the right to ${d.what} to ${s(d.next).slice(0, 6)}…` : `Remove the right to ${d.what}`;
  const onAccount = d.type === 2 || d.type === 3;
  const note = d.type === 2 ? "The new owner gets every token in this account."
    : d.type === 3 ? "Whoever can close the account can take its rent and reopen it for someone else. On a wrapped SOL account the close authority can take the whole balance."
    : d.type === 8 ? "A permanent delegate can move or burn every holder's balance of this token without asking."
    : d.type === 10 ? "A transfer hook program runs on every transfer of this token and can block or tax it."
    : "This changes who controls the token itself, for every holder.";
  return {
    title: change,
    rows: [[onAccount ? "Token account" : "Token mint", s(d.target), true], ["Current authority", s(d.current), true], ...(d.next ? [["New authority", s(d.next), true]] : [])],
    notes: [note, ...(d.next ? [] : ["This cannot be undone."])],
    risky: !!d.next || onAccount || MINT_RIGHTS_DANGER.has(d.type), check: [s(d.target), ...(d.next ? [s(d.next)] : [])],
  };
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

function spendOf(prog, d, a) {
  const v = dv(d);
  if (d[0] === 3 && d.length === 9 && a.length >= 3) return { src: a[0], dest: a[1], auth: a[2], amount: v.getBigUint64(1, true), decimals: null, kind: "paid" };
  if (d[0] === 12 && d.length === 10 && a.length >= 4) return { src: a[0], dest: a[2], auth: a[3], amount: v.getBigUint64(1, true), decimals: d[9], kind: "paid" };
  if (d[0] === 8 && d.length === 9 && a.length >= 3) return { src: a[0], dest: null, auth: a[2], amount: v.getBigUint64(1, true), decimals: null, kind: "burned" };
  if (d[0] === 15 && d.length === 10 && a.length >= 3) return { src: a[0], dest: null, auth: a[2], amount: v.getBigUint64(1, true), decimals: d[9], kind: "burned" };
  if (prog === b58encode(TOKEN22) && d[0] === 26 && d[1] === 1 && d.length === 19 && a.length >= 4) return { src: a[0], dest: a[2], auth: a[3], amount: v.getBigUint64(2, true), decimals: d[10], kind: "paid" };
  return null;
}

export function delegatedSpends(tx, account, owner) {
  if (!tx || !tx.transaction || !tx.meta || tx.meta.err) return [];
  const m = tx.transaction.message, la = tx.meta.loadedAddresses || {};
  const keys = [...(m.accountKeys || []), ...(la.writable || []), ...(la.readonly || [])];
  if (!keys.length || !keys.every((k) => typeof k === "string" && B58.test(k))) return [];
  const acc = b58encode(account), own = b58encode(owner);
  const ixs = [...(m.instructions || []), ...(Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions.flatMap((x) => (x && Array.isArray(x.instructions) ? x.instructions : [])) : [])];
  const out = [];
  for (const ix of ixs.slice(0, 256)) {
    if (!ix || !Number.isInteger(ix.programIdIndex) || !Array.isArray(ix.accounts) || typeof ix.data !== "string") continue;
    const prog = keys[ix.programIdIndex];
    if (prog !== b58encode(TOKEN) && prog !== b58encode(TOKEN22)) continue;
    let d; try { d = b58decode(ix.data); } catch { continue; }
    const a = ix.accounts.map((i) => keys[i]);
    if (a.some((x) => typeof x !== "string")) continue;
    const sp = spendOf(prog, d, a);
    if (!sp || sp.src !== acc || sp.auth === own) continue;
    out.push({ agent: sp.auth, dest: sp.dest, amount: sp.amount, decimals: sp.decimals, kind: sp.kind, time: Number.isFinite(tx.blockTime) ? tx.blockTime * 1000 : null });
  }
  return out;
}

const SVM = /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function checkRequirements(r) {
  if (!r || typeof r !== "object") throw new Error("payment requirements are missing");
  if (r.scheme !== "exact") throw new Error("only the x402 exact scheme is supported");
  if (typeof r.network !== "string" || !SVM.test(r.network)) throw new Error("the requirements are not for a Solana network");
  const amount = typeof r.amount === "string" && /^[0-9]{1,20}$/.test(r.amount) ? BigInt(r.amount) : -1n;
  if (amount < 1n || amount >= U64) throw new Error("the requested amount is not a valid whole number");
  const fee = r.extra && r.extra.feePayer;
  if (typeof fee !== "string") throw new Error("the requirements name no fee payer");
  if (r.extra.splits != null) throw new Error("split payments are not supported");
  if (r.extra.memo != null && (typeof r.extra.memo !== "string" || enc.encode(r.extra.memo).length > 256)) throw new Error("the memo is not valid");
  return { amount, mint: pubkey(r.asset), payTo: pubkey(r.payTo), feePayer: pubkey(fee), memo: r.extra.memo ?? null };
}

export async function x402Payment({ rpc, requirements, agent, owner, resource, maxAmount, asset, genesis, randomHex }) {
  const q = checkRequirements(requirements);
  if (asset == null || typeof maxAmount !== "bigint") throw new Error("pass the token this agent pays with (asset) and a per-payment cap (maxAmount)");
  if (!eq(q.mint, typeof asset === "string" ? pubkey(asset) : asset)) throw new Error("the service asks to be paid in a token this agent is not set up to pay with");
  if (genesis && requirements.network !== "solana:" + genesis.slice(0, 32)) throw new Error("the service asks for payment on another Solana network than the one this agent uses");
  if (q.amount > maxAmount) throw new Error(`the service asks for ${q.amount} base units, more than the ${maxAmount} this agent may pay at once`);
  const ownerKey = typeof owner === "string" ? pubkey(owner) : owner;
  if (eq(q.feePayer, agent.pub) || eq(q.feePayer, ownerKey)) throw new Error("the fee payer must be the facilitator, not the agent or the owner");
  const mint = readMint(await rpc.account(q.mint));
  const source = ataOf(ownerKey, q.mint, mint.program);
  const acc = readTokenAccount(await rpc.account(source));
  if (!eq(acc.owner, ownerKey) || !eq(acc.mint, q.mint)) throw new Error("the OPEQ account's token account does not match");
  if (!acc.delegate || !eq(acc.delegate, agent.pub)) throw new Error("this agent has no allowance on the OPEQ account for that token");
  if (acc.delegatedAmount < q.amount) throw new Error(`the allowance left (${acc.delegatedAmount}) is below the requested ${q.amount}`);
  if (acc.amount < q.amount) throw new Error("the OPEQ account holds less than the requested amount");
  const dest = ataOf(q.payTo, q.mint, mint.program);
  if (!(await rpc.account(dest))) throw new Error("the receiver has no token account for that token yet");
  const nonce = q.memo ?? (randomHex ? randomHex(16) : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const ixs = [
    [COMPUTE_BUDGET, [], concat(new Uint8Array([2]), u32(AGENT_CU_LIMIT))],
    [COMPUTE_BUDGET, [], concat(new Uint8Array([3]), u64(AGENT_CU_PRICE))],
    [mint.program, [[source, false, true], [q.mint, false, false], [dest, false, true], [agent.pub, true, false]],
      concat(new Uint8Array([12]), u64(q.amount), new Uint8Array([mint.decimals]))],
    [MEMO, [], enc.encode(nonce)],
  ];
  const { message, signers } = compileV0(q.feePayer, ixs, await rpc.blockhash());
  const order = signers.map((k) => (typeof k === "string" ? k : b58encode(k)));
  if (order.length !== 2 || order[0] !== b58encode(q.feePayer) || order[1] !== b58encode(agent.pub)) throw new Error("unexpected signer set");
  const raw = concat(new Uint8Array(compact(2)), new Uint8Array(64), await agent.sign(message), message);
  if (raw.length > 1232) throw new Error("payment transaction is too large");
  const transaction = btoa(String.fromCharCode(...raw));
  const payload = { x402Version: 2, accepted: requirements, payload: { transaction } };
  if (resource) payload.resource = resource;
  return { payload, amount: q.amount, source: b58encode(source), dest: b58encode(dest), allowanceLeft: acc.delegatedAmount - q.amount };
}

export function encodePaymentHeader(payload) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

export { b58decode };
