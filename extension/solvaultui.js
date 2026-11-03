import * as V from "./lib/solvault.js";
import * as P from "./lib/protocol.js";
import * as T from "./lib/tokens.js";
import { pubkey, b58encode, b58decode, SYSTEM, eq, unhex, concat, u32, u64 } from "./lib/solana.js";

const LIST_MAX = 20;
const SHOW = 10;
const CU_VAULT = 400000;
let x = null;
let open = null;
let shown = SHOW;

const short = (k) => { const s = typeof k === "string" ? k : b58encode(k); return `${s.slice(0, 6)}…${s.slice(-6)}`; };
const sol = (l) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const prog = () => pubkey(x.NET.vault);
const opeq = () => x.engine().program;
const listKey = () => `opeq:sol-ms:${x.session().id}`;

async function loadList() {
  const v = await x.kv.get(listKey());
  return (Array.isArray(v) ? v : []).filter((a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)).slice(0, LIST_MAX);
}

async function saveList(list) { await x.kv.set(listKey(), list.slice(0, LIST_MAX)); }

async function myAid() { return unhex((await x.session().load()).aid); }

async function readAccount(key) {
  const a = await x.rpc().account(key);
  const ref = x.engine().refRpc;
  if (ref) {
    const b = await ref.account(key).catch(() => undefined);
    if (b === undefined) throw new Error("the second network source did not answer. Try again in a minute");
    const same = (!a && !b) || (a && b && eq(a.owner, b.owner) && eq(a.data, b.data));
    if (!same) throw new Error("two network sources disagree about this vault, so nothing is shown as safe to sign. Try again in a minute");
  }
  return a;
}

async function loadVault(addr) {
  const ms = pubkey(addr);
  const a = await readAccount(ms);
  if (!a) throw new Error("there is no multisig at that address on this network");
  if (!eq(a.owner, prog())) throw new Error("that address is not an OPEQ multisig, refusing to use it");
  const info = V.unpackMs(a.data);
  const vault = V.vaultPda(ms, prog()).key;
  if (!eq(V.createProgramAddress([new TextEncoder().encode("v"), ms, Uint8Array.of(info.vbump)], prog()), vault)) throw new Error("malformed multisig account");
  const balance = BigInt(await x.rpc().balance(vault));
  return { ms, vault, info, balance, msLamports: BigInt(a.lamports) };
}

async function loadProposal(v, key) {
  const a = await readAccount(key);
  if (!a || !eq(a.owner, prog()) || !a.data || a.data.length < 8) return null;
  const p = V.unpackProposal(a.data);
  if (!eq(p.ms, v.ms)) throw new Error("malformed proposal account");
  const ixs = V.decodeStored(p.data, v.vault, v.ms);
  return { ...p, key, ixs, lamports: a.lamports };
}

const mineKey = (ms) => `opeq:sol-msp:${x.session().id}:${b58encode(ms)}`;

async function mineList(ms) {
  const v = await x.kv.get(mineKey(ms));
  return (Array.isArray(v) ? v : []).filter((a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)).slice(0, 50);
}

async function rememberMine(ms, key, add) {
  const list = (await mineList(ms)).filter((k) => k !== key);
  await x.kv.set(mineKey(ms), add ? [key, ...list].slice(0, 50) : list);
}

function myNext(v) {
  const idx = v.info.owners.findIndex((o) => eq(o, x.session().wallet));
  return V.proposalPda(v.ms, x.session().wallet, v.info.config, v.info.seqs[idx], prog()).key;
}

async function nowOnChain() {
  const r = x.rpc();
  const t = await r.call("getBlockTime", [await r.slot()]).catch(() => null);
  return Number(t || Math.floor(Date.now() / 1000));
}

function approvals(p, info) {
  let n = 0;
  for (let i = 0; i < info.n; i++) if (p.approvals & (1 << i)) n++;
  return n;
}

function liveOf(p, info, now) {
  return p.flags === 0 && p.config === info.config && now <= p.expires;
}

async function words(ix, v) {
  const d = V.describe(ix, { program: prog(), opeqProgram: opeq(), vault: v.vault });
  if (d.kind === "pay") return { title: `Send ${sol(d.lamports)} SOL`, rows: [["To", b58encode(d.to), true]], check: [b58encode(d.to)], payee: d.to };
  if (d.kind === "token") {
    const notes = d.mayHaveFee ? ["This token program can take a transfer fee, so the receiver may get less."] : [];
    const acc = await readAccount(d.dest).catch(() => null);
    const real = acc && (eq(acc.owner, d.program)) && acc.data && acc.data.length >= 165 && eq(acc.data.slice(0, 32), d.mint);
    const owner = real ? acc.data.slice(32, 64) : null;
    const standard = real && eq(T.ata(owner, d.mint, d.program), d.dest);
    const opt = (off) => real && acc.data[off] === 1 && acc.data[off + 1] === 0 && acc.data[off + 2] === 0 && acc.data[off + 3] === 0 ? acc.data.slice(off + 4, off + 36) : null;
    const delegate = opt(72), closer = opt(129);
    const holder = real ? b58encode(owner) : "unknown";
    if (!real) notes.push("The receiving token account does not exist yet or is not an account of this token. Do not approve unless you know why.");
    else if (!standard) notes.push("The receiving account is not the holder's standard token account. Whoever set it up may be able to change who receives the tokens before the proposal is executed. Do not approve unless the holder gave you this exact account.");
    if (closer && !eq(closer, owner)) notes.push(`Someone other than the holder (${short(closer)}) can close the receiving account and re-open it for someone else. Do not approve.`);
    if (delegate) notes.push(`The receiving account has a delegate (${short(delegate)}) who can move tokens out of it.`);
    if (real && acc.data[108] === 2) notes.push("The receiving account is frozen, so the transfer will fail.");
    return { title: `Send ${d.amount} token units (${d.decimals} decimals)`, rows: [["Token account", b58encode(d.dest), true], [standard ? "Held by" : "Held by (not verified)", holder, true], ["Mint", b58encode(d.mint), true]], notes, risky: true, check: [b58encode(d.dest), ...(standard ? [holder] : [])] };
  }
  if (d.kind === "owners") {
    const me = x.session().wallet, cur = new Set(v.info.owners.map(b58encode));
    const rows = d.wallets.flatMap((w, i) => [[`Owner ${i + 1}${eq(w, me) ? " (you)" : cur.has(b58encode(w)) ? "" : " (NEW)"}`, b58encode(w), true], ["Owner ID", b58encode(d.owners[i].aid), true]]);
    const removed = v.info.owners.filter((o) => !d.wallets.some((w) => eq(w, o)));
    for (const o of removed) rows.push([`Removed${eq(o, me) ? " (you)" : ""}`, b58encode(o), true]);
    const added = d.wallets.filter((w) => !cur.has(b58encode(w)));
    const addedIds = d.owners.filter((o, i) => !cur.has(b58encode(d.wallets[i]))).map((o) => o.aid);
    const notes = [];
    for (const aid of addedIds) {
      const st = await readAccount(P.statePda(aid, opeq()).key).catch(() => null);
      if (!st || !eq(st.owner, opeq())) notes.push(`The new owner with owner ID ${short(aid)} is not an active OPEQ wallet on this network.`);
    }
    if (added.length) notes.push(`${added.length} new owner${added.length > 1 ? "s" : ""} would get control over this vault. Compare each new owner ID with the one that person gave you directly.`);
    if (removed.length) notes.push(removed.some((o) => eq(o, me)) ? "You would be removed and lose all control over this vault." : `${removed.length} current owner${removed.length > 1 ? "s" : ""} would be removed.`);
    if (d.threshold < v.info.threshold) notes.push(`Approvals needed would drop from ${v.info.threshold} to ${d.threshold}.`);
    return { title: `Change owners: from ${v.info.threshold} of ${v.info.n} to ${d.threshold} of ${d.wallets.length}`, rows, notes, risky: added.length > 0 || removed.length > 0 || d.threshold < v.info.threshold, check: [...added, ...addedIds].map(b58encode) };
  }
  if (d.kind === "threshold") {
    const notes = d.threshold < v.info.threshold ? [`Approvals needed would drop from ${v.info.threshold} to ${d.threshold}.`] : [];
    return { title: `Change approvals needed from ${v.info.threshold} to ${d.threshold}`, rows: [], notes, risky: d.threshold < v.info.threshold };
  }
  const metaRows = d.metas.map((m, i) => [`Account ${i + 1}${eq(m.key, v.vault) ? " (the vault)" : ""}${m.signer ? ", signs" : ""}${m.writable ? ", writable" : ""}`, b58encode(m.key), true]);
  return { title: "Program call that cannot be shown in plain words", rows: [["Program", b58encode(d.program), true], ...metaRows, ["Data", d.data.length ? `${Array.from(d.data.slice(0, 300), (b) => b.toString(16).padStart(2, "0")).join("")}${d.data.length > 300 ? `… (first 300 of ${d.data.length} bytes shown)` : ""}` : "(empty)", true]], risky: true, check: [b58encode(d.program), ...d.metas.filter((m) => !eq(m.key, v.vault)).map((m) => b58encode(m.key))] };
}

export function hide() {
  if (!x) return;
  open = null;
  x.$("sv-list-box").classList.remove("hidden");
  x.$("sv-view").classList.add("hidden");
  for (const id of ["sv-id", "sv-list", "sv-addr", "sv-deposit", "sv-owners", "sv-props", "sv-ok", "sv-err"]) x.$(id).textContent = "";
  x.$("sv-stuck").classList.add("hidden");
}

export async function refresh() {
  if (!x || !x.session()) return;
  const id = b58encode(await myAid());
  if (open) { x.$("sv-id").textContent = id; return showVault(open); }
  hide();
  x.$("sv-id").textContent = id;
  const box = x.$("sv-list");
  box.textContent = "";
  const list = await loadList();
  if (!list.length) { box.append(el("p", "hint", "No multisigs yet.")); return; }
  for (const a of list) {
    const line = el("div", "ms-line");
    const row = el("button", "ms-row");
    row.type = "button";
    const meta = el("span", "ms-meta", "…");
    row.append(el("span", "mono", short(a)), meta);
    row.addEventListener("click", () => x.guard(() => showVault(a)));
    const rm = el("button", "ms-rm", "Remove");
    rm.type = "button";
    rm.addEventListener("click", () => x.guard(async () => {
      if (!(await x.ask({ ...x.tag(), title: "Remove this vault from the list?", rows: [["Vault", a, true]], notes: [{ text: "Only this list changes. The vault and its funds stay on chain; add it again any time." }] }, "Remove"))) return;
      await saveList((await loadList()).filter((b) => b !== a));
      await refresh();
    }));
    line.append(row, rm);
    box.append(line);
    loadVault(a).then((v) => { meta.textContent = `${v.info.threshold} of ${v.info.n}, ${sol(v.balance)} SOL`; }).catch(() => { meta.textContent = "could not read"; });
  }
}

async function showVault(addr) {
  const v = await loadVault(addr);
  const me = x.session().wallet;
  if (!v.info.owners.some((o) => eq(o, me))) throw new Error("this wallet is not an owner of that vault");
  if (open !== addr) shown = SHOW;
  open = addr;
  x.$("sv-list-box").classList.add("hidden");
  x.$("sv-view").classList.remove("hidden");
  x.$("sv-addr").textContent = addr;
  x.$("sv-deposit").textContent = b58encode(v.vault);
  x.$("sv-bal").textContent = `${sol(v.balance)} SOL`;
  x.$("sv-thr").textContent = `${v.info.threshold} of ${v.info.n}`;
  const stuck = v.msLamports - BigInt(await x.rpc().rent(V.MS_LEN)) - 2n;
  x.$("sv-stuck").classList.toggle("hidden", stuck < 1000000n);
  if (stuck > 0n) x.$("sv-stuck-text").textContent = `${sol(stuck)} SOL was sent to the multisig ID instead of the deposit address. Anyone can move it into the vault.`;
  const ob = x.$("sv-owners");
  ob.textContent = "";
  for (const o of v.info.owners) ob.append(el("p", "mono ms-owner" + (eq(o, me) ? " me" : ""), eq(o, me) ? `${b58encode(o)} (you)` : b58encode(o)));
  const box = x.$("sv-props");
  box.textContent = "";
  const keys = new Map();
  let more = false;
  v.info.owners.forEach((o, i) => {
    const s = v.info.seqs[i];
    if (s > shown) more = true;
    for (let k = s - 1; k >= Math.max(0, s - shown); k--) { const key = V.proposalPda(v.ms, o, v.info.config, k, prog()).key; keys.set(b58encode(key), key); }
  });
  for (const k of await mineList(v.ms)) if (!keys.has(k)) keys.set(k, pubkey(k));
  const found = [];
  for (const [name, key] of keys) {
    try { const p = await loadProposal(v, key); if (p) found.push(p); else if ((await mineList(v.ms)).includes(name)) await rememberMine(v.ms, name, false); }
    catch (e) { box.append(el("p", "err", `Proposal ${short(name)} could not be shown: ${e.message}`)); }
  }
  if (!found.length) { box.append(el("p", "hint", "No proposals yet.")); return; }
  found.sort((a, b) => b.id - a.id);
  const now = await nowOnChain();
  for (const p of found) {
    try { box.append(await card(v, p, now)); }
    catch (e) { box.append(el("p", "err", `Proposal #${p.id} could not be shown: ${e.message}`)); }
  }
  const from = more ? 1 : 0;
  if (from > 0) {
    const older = el("button", "btn btn-line btn-sm", "Show older proposals");
    older.type = "button";
    older.addEventListener("click", () => x.guard(async () => { shown += SHOW; await showVault(addr); }));
    box.append(older);
  }
}

async function card(v, p, now) {
  const id = p.id;
  const me = x.session().wallet;
  const idx = v.info.owners.findIndex((o) => eq(o, me));
  const mine = idx >= 0 && !!(p.approvals & (1 << idx));
  const live = liveOf(p, v.info, now);
  const w = await Promise.all(p.ixs.map((ix) => words(ix, v)));
  const c = el("div", "ms-prop" + (live ? "" : " done"));
  const state = p.flags & 1 ? "executed" : p.flags & 2 ? "cancelled" : p.config !== v.info.config ? "void, owners changed" : now > p.expires ? "expired" : `${approvals(p, v.info)} of ${v.info.threshold} approvals`;
  c.append(el("p", "ms-prop-head", `#${id}: ${state}`));
  for (const t of w) c.append(el("p", "ms-prop-title" + (t.risky ? " warn" : ""), t.title), ...t.rows.map(([k, val]) => el("p", "mono ms-prop-row", `${k}: ${val}`)));
  c.append(el("p", "hint", `Proposed by ${eq(p.proposer, me) ? "you" : short(p.proposer)}${live ? `, open until ${new Date(p.expires * 1000).toLocaleString()}` : ""}`));
  const row = el("div", "row tight");
  const btn = (label, cls, kind) => { const b = el("button", `btn btn-sm ${cls}`, label); b.type = "button"; b.addEventListener("click", () => later(() => act(v, p, kind))); row.append(b); };
  if (live) {
    if (approvals(p, v.info) >= v.info.threshold) btn("Execute", "btn-solid", "execute");
    else if (!mine) btn("Approve", "btn-solid", "approve");
    if (mine) btn("Revoke my approval", "btn-line", "revoke");
    if (eq(p.proposer, me)) btn("Cancel", "btn-line", "cancel");
  } else if (eq(p.proposer, me) && p.lamports > 0) btn(`Close, get ${sol(p.lamports)} SOL rent back`, "btn-line", "close");
  if (row.children.length) c.append(row);
  return c;
}

async function later(fn) {
  for (let i = 0; i < 120 && x.busy(); i++) await new Promise((r) => setTimeout(r, 250));
  return x.guard(fn);
}

async function act(v0, p0, kind) {
  if (open !== b58encode(v0.ms)) throw new Error("the vault on screen changed. Refresh and try again");
  const v = await loadVault(b58encode(v0.ms));
  const p = await loadProposal(v, p0.key);
  if (!p || !eq(p.hash, p0.hash)) throw new Error("the proposal changed since it was shown. Refresh and check it again");
  const now = await nowOnChain();
  if (kind !== "close" && !liveOf(p, v.info, now)) throw new Error("this proposal is no longer open. Refresh to see its state");
  const myIdx = v.info.owners.findIndex((o) => eq(o, x.session().wallet));
  const iApproved = myIdx >= 0 && !!(p.approvals & (1 << myIdx));
  if (kind === "approve" && iApproved) throw new Error("you already approved this proposal");
  if (kind === "revoke" && !iApproved) throw new Error("you have not approved this proposal");
  const w = await Promise.all(p.ixs.map((ix) => words(ix, v)));
  if (kind === "approve" || kind === "execute") for (const a of new Set(w.flatMap((t) => t.check || []))) await x.lookalike(a);
  const me = x.session().wallet;
  let ix;
  if (kind === "approve" || kind === "revoke") ix = V.voteIx(prog(), kind === "approve" ? V.IX_APPROVE : V.IX_REVOKE, me, v.ms, p.key, p.id, p.hash);
  else if (kind === "cancel") ix = V.cancelIx(prog(), me, v.ms, p.key, p.id);
  else if (kind === "close") ix = V.closeIx(prog(), me, v.ms, p.key, p.id);
  else ix = V.executeIx(prog(), me, v.ms, p.key, v.vault, p.id, p.ixs);
  const label = { approve: "Approve", revoke: "Revoke", cancel: "Cancel proposal", execute: "Execute", close: "Close" }[kind];
  const notes = [{ text: "Signed with one quantum-resistant one-time key from your wallet." }];
  if (kind === "approve") notes.push({ text: "Check every line above. Your approval counts toward moving the vault's funds exactly like this.", warn: true });
  if (kind === "execute") notes.push({ text: "This moves the vault's funds now. It needs no further approvals." });
  if (kind === "approve" || kind === "execute") for (const t of w) for (const n of t.notes || []) notes.push({ text: n, warn: true });
  if (w.some((t) => t.risky)) notes.push({ text: "This proposal does something OPEQ marks as risky. Approve only if you know exactly what it does.", warn: true });
  const rows = kind === "close" ? [] : w.flatMap((t) => [["Action", t.title], ...t.rows]);
  if (kind === "approve" || kind === "execute") {
    for (const t of w) {
      if (!t.payee) continue;
      if (eq(t.payee, v.vault) || eq(t.payee, v.ms)) { notes.push({ text: "The payment goes back to this vault itself.", warn: true }); continue; }
      if (eq(t.payee, me)) { notes.push({ text: "The payment goes to your own wallet." }); continue; }
      try { const warn = await x.checkRecipient(t.payee); if (warn) notes.push({ text: warn.trim(), warn: true }); }
      catch (e) { notes.push({ text: `Do not approve: ${e.message}.`, warn: true }); }
    }
    const size = await x.execSize([V.executeIx(prog(), me, v.ms, p.key, v.vault, p.id, p.ixs)]).catch(() => 0);
    if (size > 1232) notes.push({ text: `This proposal can never be executed: the transaction would be ${size} bytes, over Solana's 1232 byte limit. Cancel it and propose something smaller.`, warn: true });
  }
  const plan = await x.planTopup([ix], [], 0n);
  if (!(await x.ask({ ...x.tag(), title: `${label}: proposal #${p.id}`, rows: [["Vault", open, true], ...rows, ["Network fee", await x.fee(CU_VAULT)]], notes: [...notes, ...(plan.note ? [{ text: plan.note.trim() }] : [])] }, label))) return;
  const sig = await x.run(`${label.toLowerCase()}, grinding the signature`, [ix], plan, { cu: CU_VAULT });
  x.log(`vault ${short(open)}: ${label.toLowerCase()} #${p.id}: ${sig}`, "ok");
  if (kind === "close") await rememberMine(v.ms, b58encode(p.key), false);
  x.ok(`${label.toLowerCase()} done`);
  await showVault(open);
}

async function fits(v, prop, stored) {
  const ixs = V.decodeStored(stored, v.vault, v.ms);
  const size = await x.execSize([V.executeIx(prog(), x.session().wallet, v.ms, prop, v.vault, v.info.next, ixs)]);
  if (size > 1232) throw new Error(`this proposal could never be executed: the transaction would be ${size} bytes, over Solana's 1232 byte limit`);
}

export function init(ctx) {
  x = ctx;
  x.$("sv-id-copy").addEventListener("click", (e) => x.guard(async () => x.copy(e.currentTarget, b58encode(await myAid()), "owner ID copied")));
  x.$("sv-copy").addEventListener("click", (e) => x.copy(e.currentTarget, open, "multisig ID copied"));
  x.$("sv-sweep").addEventListener("click", () => x.guard(async () => {
    const v = await loadVault(open);
    const ix = V.sweepIx(prog(), v.ms, v.vault);
    const plan = await x.planTopup([ix], [], 0n);
    if (!(await x.ask({ ...x.tag(), title: "Move stuck SOL into the vault", rows: [["From multisig ID", open, true], ["To deposit address", b58encode(v.vault), true], ["Network fee", await x.fee(CU_VAULT)]], notes: [{ text: "This only moves SOL above the account's own rent into the vault. It needs no approvals and anyone can do it." }, ...(plan.note ? [{ text: plan.note.trim() }] : [])] }, "Move"))) return;
    const sig = await x.run("moving stuck SOL, grinding the signature", [ix], plan, { cu: CU_VAULT });
    x.log(`vault ${short(open)}: stuck SOL moved to the deposit address: ${sig}`, "ok");
    x.ok("moved into the vault");
    await showVault(open);
  }));
  x.$("sv-dep-copy").addEventListener("click", (e) => x.copy(e.currentTarget, x.$("sv-deposit").textContent, "deposit address copied"));
  x.$("sv-back").addEventListener("click", () => x.guard(async () => { open = null; await refresh(); }));
  x.$("sv-refresh").addEventListener("click", () => x.guard(() => showVault(open)));

  x.$("sv-create").addEventListener("click", () => x.guard(async () => {
    const s = x.session();
    if ((await loadList()).length >= LIST_MAX) throw new Error(`your list already holds ${LIST_MAX} vaults. Remove one first`);
    const mine = await myAid();
    const ids = x.$("sv-owners-in").value.split(/[\s,]+/).filter(Boolean);
    const others = [];
    for (const t of ids) {
      let aid;
      try { aid = b58decode(t); } catch { aid = null; }
      if (!aid || aid.length !== 32) throw new Error(`${t.slice(0, 12)}… is not an owner ID. Ask each owner to copy it from their Multisig tab`);
      if (eq(aid, mine) || others.some((o) => eq(o.aid, aid))) continue;
      const st = await x.rpc().account(P.statePda(aid, opeq()).key);
      if (!st || !eq(st.owner, opeq())) throw new Error(`the wallet with owner ID ${short(t)} is not active on this network yet. It must be activated first`);
      others.push(V.ownerFromId(aid, opeq()));
    }
    if (!others.length) throw new Error("add at least one other owner ID");
    const owners = [V.ownerFromId(mine, opeq()), ...others];
    if (owners.length > V.MAX_OWNERS) throw new Error(`a multisig holds at most ${V.MAX_OWNERS} owners`);
    const t = x.$("sv-thr-in").value.trim();
    const threshold = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!(threshold >= 1 && threshold <= owners.length)) throw new Error(`the number of approvals must be between 1 and ${owners.length}`);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const ms = V.msPda(s.wallet, nonce, prog()).key;
    const vault = V.vaultPda(ms, prog()).key;
    const ix = V.createIx(prog(), s.wallet, ms, nonce, threshold, owners);
    const rent = await x.rpc().rent(V.MS_LEN);
    const plan = await x.planTopup([ix], [], BigInt(rent));
    if (!(await x.ask({ ...x.tag(), title: `Create a ${threshold} of ${owners.length} multisig`,
      rows: [["Multisig ID", b58encode(ms), true], ["Deposit address", b58encode(vault), true], ...owners.map((o, i) => [`Owner ${i + 1}${i === 0 ? " (you)" : ""}`, `${b58encode(o.wallet)} (owner ID ${short(o.aid)})`, true]), ["Account rent", `${sol(rent)} SOL from your wallet`], ["Network fee", await x.fee(CU_VAULT)]],
      notes: [{ text: `Moving funds will need ${threshold} of these ${owners.length} owners to approve, each from their own OPEQ wallet.` }, { text: "Funds go to the deposit address only. Share the multisig ID with the other owners so they can add it; never send funds to the multisig ID." }, { text: "Beta: the multisig program has had internal reviews only. Start with small amounts.", warn: true }, ...(plan.note ? [{ text: plan.note.trim() }] : [])] }, "Create"))) return;
    const sig = await x.run("creating the vault, grinding the signature", [ix], plan, { cu: CU_VAULT, spend: BigInt(rent) });
    x.log(`multisig ${short(ms)} created: ${sig}`, "ok");
    await saveList([b58encode(ms), ...(await loadList()).filter((a) => a !== b58encode(ms))]);
    x.$("sv-owners-in").value = x.$("sv-thr-in").value = "";
    x.ok("multisig created");
    open = b58encode(ms);
    await refresh();
  }));

  x.$("sv-add").addEventListener("click", () => x.guard(async () => {
    const a = x.$("sv-add-in").value.trim();
    const v = await loadVault(a);
    if (!v.info.owners.some((o) => eq(o, x.session().wallet))) throw new Error("this wallet is not an owner of that vault");
    if (v.info.threshold <= v.info.n - 1 && !(await x.ask({ ...x.tag(), title: "Add this multisig?", rows: [["Multisig ID", b58encode(v.ms), true], ["Created by", b58encode(v.info.creator), true], ["Approvals needed", `${v.info.threshold} of ${v.info.n}`]], notes: [{ text: `The other owners can move this vault's funds without your approval: they need ${v.info.threshold} and there are ${v.info.n - 1} of them.`, warn: true }] }, "Add"))) return;
    const list = await loadList();
    if (!list.includes(b58encode(v.ms))) {
      if (list.length >= LIST_MAX) throw new Error(`at most ${LIST_MAX} multisigs`);
      await saveList([b58encode(v.ms), ...list]);
    }
    x.$("sv-add-in").value = "";
    x.ok("vault added");
    open = b58encode(v.ms);
    await refresh();
  }));

  x.$("sv-pay").addEventListener("click", () => x.guard(async () => {
    const v = await loadVault(open);
    const to = pubkey(x.$("sv-to").value.trim());
    if (eq(to, v.vault) || eq(to, v.ms)) throw new Error("that is the vault itself");
    if (!eq(to, x.session().wallet)) await x.lookalike(b58encode(to));
    const warn = eq(to, x.session().wallet) ? "" : await x.checkRecipient(to);
    const lamports = x.parseSol(x.$("sv-amt").value);
    if (BigInt(lamports) > v.balance) throw new Error(`the vault holds only ${sol(v.balance)} SOL`);
    const floor = BigInt(await x.rpc().rent(0));
    const left = v.balance - BigInt(lamports);
    if (left > 0n && left < floor) throw new Error(`this would leave ${sol(left)} SOL in the vault, below Solana's ${sol(floor)} SOL minimum, so it could never execute. Send all of it or leave at least ${sol(floor)} SOL`);
    if (lamports < 890880 && !(await x.rpc().account(to))) throw new Error("the receiving address is empty, so Solana needs at least 0.00089 SOL to create it");
    const stored = V.encodeStored([[SYSTEM, [[v.vault, V.M_SIGNER | V.M_WRITABLE], [to, V.M_WRITABLE]], concat(u32(2), u64(lamports))]]);
    const prop = myNext(v);
    const expires = (await nowOnChain()) + V.DEFAULT_LIFETIME;
    const ix = V.proposeIx(prog(), x.session().wallet, v.ms, prop, expires, stored);
    await fits(v, prop, stored);
    const rent = await x.rpc().rent(V.PR_OFF_DATA + stored.length);
    const plan = await x.planTopup([ix], [], BigInt(rent));
    const notes = [{ text: `This only proposes the payment. It moves funds after ${v.info.threshold} of ${v.info.n} owners approve; your proposal counts as your approval. It stays open for 7 days.` }, { text: "The rent comes back to you when you close the proposal after it is done." }];
    if (warn) notes.push({ text: warn.trim(), warn: true });
    if (plan.note) notes.push({ text: plan.note.trim() });
    if (!(await x.ask({ ...x.tag(), title: `Propose sending ${sol(lamports)} SOL`, rows: [["Vault", open, true], ["To", b58encode(to), true], ["Proposal rent", `${sol(rent)} SOL from your wallet`], ["Network fee", await x.fee(CU_VAULT)]], notes }, "Propose"))) return;
    const sig = await x.run("proposing, grinding the signature", [ix], plan, { cu: CU_VAULT, spend: BigInt(rent) });
    await rememberMine(v.ms, b58encode(prop), true);
    x.log(`vault ${short(open)}: proposed ${sol(lamports)} SOL to ${short(to)}: ${sig}`, "ok");
    await x.remember(b58encode(to));
    x.$("sv-to").value = x.$("sv-amt").value = "";
    x.ok("proposed; the other owners can approve it in their wallets");
    await showVault(open);
  }));

  x.$("sv-change").addEventListener("click", () => x.guard(async () => {
    const v = await loadVault(open);
    const t = x.$("sv-new-thr").value.trim();
    const threshold = /^\d+$/.test(t) ? Number(t) : NaN;
    const text = x.$("sv-new-owners").value.split(/[\s,]+/).filter(Boolean);
    let ixs;
    if (!text.length) {
      if (!(threshold >= 1 && threshold <= v.info.n)) throw new Error(`the number of approvals must be between 1 and ${v.info.n}`);
      if (threshold === v.info.threshold) throw new Error("that is already the number of approvals needed");
      ixs = [[prog(), [], V.setThresholdData(threshold)]];
    } else {
      const owners = [];
      for (const t of text) {
        let aid;
        try { aid = b58decode(t); } catch { aid = null; }
        if (!aid || aid.length !== 32) throw new Error(`${t.slice(0, 12)}… is not an owner ID`);
        if (owners.some((o) => eq(o.aid, aid))) continue;
        const st = await x.rpc().account(P.statePda(aid, opeq()).key);
        if (!st || !eq(st.owner, opeq())) throw new Error(`the wallet with owner ID ${short(t)} is not active on this network`);
        owners.push(V.ownerFromId(aid, opeq()));
      }
      if (owners.length > V.MAX_OWNERS) throw new Error(`a multisig holds at most ${V.MAX_OWNERS} owners`);
      if (!(threshold >= 1 && threshold <= owners.length)) throw new Error(`the number of approvals must be between 1 and ${owners.length}`);
      ixs = [[prog(), [], V.setOwnersData(threshold, owners)]];
    }
    const stored = V.encodeStored(ixs);
    const prop = myNext(v);
    await fits(v, prop, stored);
    const w = await Promise.all(ixs.map((ix) => words(ix, v)));
    const expires = (await nowOnChain()) + V.DEFAULT_LIFETIME;
    const ix = V.proposeIx(prog(), x.session().wallet, v.ms, prop, expires, stored);
    const rent = await x.rpc().rent(V.PR_OFF_DATA + stored.length);
    const plan = await x.planTopup([ix], [], BigInt(rent));
    const notes = [{ text: `This only proposes the change. It applies after ${v.info.threshold} of ${v.info.n} owners approve. Changing owners or approvals cancels every other open proposal.` }];
    for (const t of w) for (const n of t.notes || []) notes.push({ text: n, warn: true });
    if (plan.note) notes.push({ text: plan.note.trim() });
    if (!(await x.ask({ ...x.tag(), title: w[0].title, rows: [["Vault", open, true], ...w[0].rows, ["Proposal rent", `${sol(rent)} SOL from your wallet`], ["Network fee", await x.fee(CU_VAULT)]], notes }, "Propose"))) return;
    const sig = await x.run("proposing, grinding the signature", [ix], plan, { cu: CU_VAULT, spend: BigInt(rent) });
    await rememberMine(v.ms, b58encode(prop), true);
    x.log(`vault ${short(open)}: proposed ${w[0].title.toLowerCase()}: ${sig}`, "ok");
    x.$("sv-new-owners").value = x.$("sv-new-thr").value = "";
    x.ok("change proposed; the other owners can approve it in their wallets");
    await showVault(open);
  }));
}
