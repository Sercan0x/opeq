import * as V from "./lib/solvault.js";
import * as P from "./lib/protocol.js";
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
  if (!a) throw new Error("there is no shared vault at that address on this network");
  if (!eq(a.owner, prog())) throw new Error("that address is not an OPEQ shared vault, refusing to use it");
  const info = V.unpackMs(a.data);
  const vault = V.vaultPda(ms, prog()).key;
  if (!eq(V.createProgramAddress([new TextEncoder().encode("v"), ms, Uint8Array.of(info.vbump)], prog()), vault)) throw new Error("malformed shared vault account");
  const balance = BigInt(await x.rpc().balance(vault));
  return { ms, vault, info, balance };
}

async function loadProposal(v, id) {
  const key = V.proposalPda(v.ms, id, prog()).key;
  const a = await readAccount(key);
  if (!a || !eq(a.owner, prog())) return null;
  const p = V.unpackProposal(a.data);
  if (!eq(p.ms, v.ms) || p.id !== id) throw new Error("malformed proposal account");
  const ixs = V.decodeStored(p.data, v.vault);
  return { ...p, key, ixs, lamports: a.lamports };
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
  if (d.kind === "pay") return { title: `Send ${sol(d.lamports)} SOL`, rows: [["To", b58encode(d.to), true]], check: [b58encode(d.to)] };
  if (d.kind === "token") {
    const notes = d.mayHaveFee ? ["This token program can take a transfer fee, so the receiver may get less."] : [];
    return { title: `Send ${d.amount} token units (${d.decimals} decimals)`, rows: [["Token account", b58encode(d.dest), true], ["Mint", b58encode(d.mint), true]], notes, risky: true };
  }
  if (d.kind === "owners") {
    const me = x.session().wallet, cur = new Set(v.info.owners.map(b58encode));
    const rows = d.wallets.map((w, i) => [`Owner ${i + 1}${eq(w, me) ? " (you)" : cur.has(b58encode(w)) ? "" : " (NEW)"}`, b58encode(w), true]);
    const removed = v.info.owners.filter((o) => !d.wallets.some((w) => eq(w, o)));
    for (const o of removed) rows.push([`Removed${eq(o, me) ? " (you)" : ""}`, b58encode(o), true]);
    const added = d.wallets.filter((w) => !cur.has(b58encode(w)));
    const notes = [];
    if (added.length) notes.push(`${added.length} new owner${added.length > 1 ? "s" : ""} would get control over this vault. Confirm each new owner directly.`);
    if (removed.length) notes.push(removed.some((o) => eq(o, me)) ? "You would be removed and lose all control over this vault." : `${removed.length} current owner${removed.length > 1 ? "s" : ""} would be removed.`);
    if (d.threshold < v.info.threshold) notes.push(`Approvals needed would drop from ${v.info.threshold} to ${d.threshold}.`);
    return { title: `Change owners: from ${v.info.threshold} of ${v.info.n} to ${d.threshold} of ${d.wallets.length}`, rows, notes, risky: added.length > 0 || removed.length > 0 || d.threshold < v.info.threshold, check: added.map(b58encode) };
  }
  if (d.kind === "threshold") {
    const notes = d.threshold < v.info.threshold ? [`Approvals needed would drop from ${v.info.threshold} to ${d.threshold}.`] : [];
    return { title: `Change approvals needed from ${v.info.threshold} to ${d.threshold}`, rows: [], notes, risky: d.threshold < v.info.threshold };
  }
  return { title: "Program call that cannot be shown in plain words", rows: [["Program", b58encode(d.program), true], ["Accounts", String(d.metas.length)], ["Data", Array.from(d.data, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 600) || "(empty)", true]], risky: true, check: [b58encode(d.program)] };
}

export function hide() {
  if (!x) return;
  open = null;
  x.$("sv-list-box").classList.remove("hidden");
  x.$("sv-view").classList.add("hidden");
}

export async function refresh() {
  if (!x || !x.session()) return;
  x.$("sv-id").textContent = b58encode(await myAid());
  if (open) return showVault(open);
  hide();
  const box = x.$("sv-list");
  box.textContent = "";
  const list = await loadList();
  if (!list.length) { box.append(el("p", "hint", "No shared vaults yet.")); return; }
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
  const ob = x.$("sv-owners");
  ob.textContent = "";
  for (const o of v.info.owners) ob.append(el("p", "mono ms-owner" + (eq(o, me) ? " me" : ""), eq(o, me) ? `${b58encode(o)} (you)` : b58encode(o)));
  const box = x.$("sv-props");
  box.textContent = "";
  if (!v.info.next) { box.append(el("p", "hint", "No proposals yet.")); return; }
  const now = await nowOnChain();
  const from = Math.max(0, v.info.next - shown);
  for (let id = v.info.next - 1; id >= from; id--) {
    try { const c = await card(v, id, now); if (c) box.append(c); }
    catch (e) { box.append(el("p", "err", `Proposal #${id} could not be shown: ${e.message}`)); }
  }
  if (from > 0) {
    const more = el("button", "btn btn-line btn-sm", `Show ${Math.min(SHOW, from)} older proposals`);
    more.type = "button";
    more.addEventListener("click", () => x.guard(async () => { shown += SHOW; await showVault(addr); }));
    box.append(more);
  }
}

async function card(v, id, now) {
  const p = await loadProposal(v, id);
  if (!p) return null;
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
  const v = await loadVault(open);
  const p = await loadProposal(v, p0.id);
  if (!p || !eq(p.hash, p0.hash)) throw new Error("the proposal changed since it was shown. Refresh and check it again");
  const now = await nowOnChain();
  if (kind !== "close" && !liveOf(p, v.info, now)) throw new Error("this proposal is no longer open. Refresh to see its state");
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
  const plan = await x.planTopup([ix], [], 0n);
  if (!(await x.ask({ ...x.tag(), title: `${label}: proposal #${p.id}`, rows: [["Vault", open, true], ...rows, ["Network fee", await x.fee(CU_VAULT)]], notes: [...notes, ...(plan.note ? [{ text: plan.note.trim() }] : [])] }, label))) return;
  const sig = await x.run(`${label.toLowerCase()}, grinding the signature`, [ix], plan, { cu: CU_VAULT });
  x.log(`vault ${short(open)}: ${label.toLowerCase()} #${p.id}: ${sig}`, "ok");
  x.ok(`${label.toLowerCase()} done`);
  await showVault(open);
}

export function init(ctx) {
  x = ctx;
  x.$("sv-id-copy").addEventListener("click", (e) => x.guard(async () => x.copy(e.currentTarget, b58encode(await myAid()), "owner ID copied")));
  x.$("sv-copy").addEventListener("click", (e) => x.copy(e.currentTarget, open, "vault address copied"));
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
      if (!aid || aid.length !== 32) throw new Error(`${t.slice(0, 12)}… is not an owner ID. Ask each owner to copy it from their Vaults tab`);
      if (eq(aid, mine) || others.some((o) => eq(o.aid, aid))) continue;
      const st = await x.rpc().account(P.statePda(aid, opeq()).key);
      if (!st || !eq(st.owner, opeq())) throw new Error(`the wallet with owner ID ${short(t)} is not active on this network yet. It must be activated first`);
      others.push(V.ownerFromId(aid, opeq()));
    }
    if (!others.length) throw new Error("add at least one other owner ID");
    const owners = [V.ownerFromId(mine, opeq()), ...others];
    if (owners.length > V.MAX_OWNERS) throw new Error(`a shared vault holds at most ${V.MAX_OWNERS} owners`);
    const t = x.$("sv-thr-in").value.trim();
    const threshold = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!(threshold >= 1 && threshold <= owners.length)) throw new Error(`the number of approvals must be between 1 and ${owners.length}`);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const ms = V.msPda(s.wallet, nonce, prog()).key;
    const vault = V.vaultPda(ms, prog()).key;
    const ix = V.createIx(prog(), s.wallet, ms, nonce, threshold, owners);
    const rent = await x.rpc().rent(V.MS_LEN);
    const plan = await x.planTopup([ix], [], BigInt(rent));
    if (!(await x.ask({ ...x.tag(), title: `Create a ${threshold} of ${owners.length} shared vault`,
      rows: [["Vault address", b58encode(ms), true], ["Deposit address", b58encode(vault), true], ...owners.map((o, i) => [`Owner ${i + 1}${i === 0 ? " (you)" : ""}`, b58encode(o.wallet), true]), ["Account rent", `${sol(rent)} SOL from your wallet`], ["Network fee", await x.fee(CU_VAULT)]],
      notes: [{ text: `Moving funds will need ${threshold} of these ${owners.length} owners to approve, each from their own OPEQ wallet.` }, { text: "Funds go to the deposit address. Share the vault address with the other owners so they can add it." }, { text: "Beta: the shared vault program has had internal reviews only. Start with small amounts.", warn: true }, ...(plan.note ? [{ text: plan.note.trim() }] : [])] }, "Create"))) return;
    const sig = await x.run("creating the vault, grinding the signature", [ix], plan, { cu: CU_VAULT, spend: BigInt(rent) });
    x.log(`shared vault ${short(ms)} created: ${sig}`, "ok");
    await saveList([b58encode(ms), ...(await loadList()).filter((a) => a !== b58encode(ms))]);
    x.$("sv-owners-in").value = x.$("sv-thr-in").value = "";
    x.ok("shared vault created");
    open = b58encode(ms);
    await refresh();
  }));

  x.$("sv-add").addEventListener("click", () => x.guard(async () => {
    const a = x.$("sv-add-in").value.trim();
    const v = await loadVault(a);
    if (!v.info.owners.some((o) => eq(o, x.session().wallet))) throw new Error("this wallet is not an owner of that vault");
    const list = await loadList();
    if (!list.includes(b58encode(v.ms))) {
      if (list.length >= LIST_MAX) throw new Error(`at most ${LIST_MAX} shared vaults`);
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
    if (lamports < 890880 && !(await x.rpc().account(to))) throw new Error("the receiving address is empty, so Solana needs at least 0.00089 SOL to create it");
    const stored = V.encodeStored([[SYSTEM, [[v.vault, V.M_SIGNER | V.M_WRITABLE], [to, V.M_WRITABLE]], concat(u32(2), u64(lamports))]]);
    const prop = V.proposalPda(v.ms, v.info.next, prog()).key;
    const expires = (await nowOnChain()) + V.DEFAULT_LIFETIME;
    const ix = V.proposeIx(prog(), x.session().wallet, v.ms, prop, expires, stored);
    const rent = await x.rpc().rent(V.PR_OFF_DATA + stored.length);
    const plan = await x.planTopup([ix], [], BigInt(rent));
    const notes = [{ text: `This only proposes the payment. It moves funds after ${v.info.threshold} of ${v.info.n} owners approve; your proposal counts as your approval. It stays open for 7 days.` }, { text: "The rent comes back to you when you close the proposal after it is done." }];
    if (warn) notes.push({ text: warn.trim(), warn: true });
    if (plan.note) notes.push({ text: plan.note.trim() });
    if (!(await x.ask({ ...x.tag(), title: `Propose sending ${sol(lamports)} SOL`, rows: [["Vault", open, true], ["To", b58encode(to), true], ["Proposal rent", `${sol(rent)} SOL from your wallet`], ["Network fee", await x.fee(CU_VAULT)]], notes }, "Propose"))) return;
    const sig = await x.run("proposing, grinding the signature", [ix], plan, { cu: CU_VAULT, spend: BigInt(rent) });
    x.log(`vault ${short(open)}: proposed ${sol(lamports)} SOL to ${short(to)}: ${sig}`, "ok");
    await x.remember(b58encode(to));
    x.$("sv-to").value = x.$("sv-amt").value = "";
    x.ok("proposed; the other owners can approve it in their wallets");
    await showVault(open);
  }));
}
