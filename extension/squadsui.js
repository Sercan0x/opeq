import * as Q from "./lib/squads.js";
import { pubkey, b58encode, eq, SYSTEM } from "./lib/solana.js";

const LIST_MAX = 20;
const CU_VOTE = 200000;
let x = null;
let open = null;

const short = (k) => { const s = typeof k === "string" ? k : b58encode(k); return `${s.slice(0, 6)}…${s.slice(-6)}`; };
const sol = (l) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });
const listKey = () => `opeq:sq:${x.session().id}`;
const me = () => x.session().wallet;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function loadList() {
  const v = await x.kv.get(listKey());
  return (Array.isArray(v) ? v : []).filter((a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)).slice(0, LIST_MAX);
}

async function saveList(list) { await x.kv.set(listKey(), list.slice(0, LIST_MAX)); }

async function readAccount(key) {
  const a = await x.rpc().account(key);
  const ref = x.engine().refRpc;
  if (ref) {
    const b = await ref.account(key).catch(() => undefined);
    if (b === undefined) throw new Error("the second network source did not answer. Try again in a minute");
    const same = (!a && !b) || (a && b && eq(a.owner, b.owner) && eq(a.data, b.data));
    if (!same) throw new Error("two network sources disagree about this Squads account, so nothing is shown as safe to sign. Try again in a minute");
  }
  return a;
}

async function loadMultisig(addr) {
  const ms = pubkey(addr);
  const a = await readAccount(ms);
  if (!a) throw new Error("there is no account at that address on this network");
  if (!eq(a.owner, Q.PROGRAM)) throw new Error("that address is not a Squads v4 multisig. Use the multisig address from the Squads settings page, not the vault address");
  const info = Q.unpackMultisig(a.data);
  return { ms, info, state: Q.lockState(info, me()) };
}

const SCAN_MAX = 3000n;

async function approvedLeft(v) {
  const last = v.info.transactionIndex;
  const first = last > SCAN_MAX ? last - SCAN_MAX + 1n : 1n;
  const idx = [];
  for (let i = first; i <= last; i++) idx.push(i);
  const keys = idx.map((i) => b58encode(Q.proposalPda(v.ms, i)));
  const owner = b58encode(Q.PROGRAM);
  const found = new Set();
  for (const r of [x.rpc(), x.engine().refRpc].filter(Boolean)) {
    for (let i = 0; i < keys.length; i += 100) {
      const part = keys.slice(i, i + 100);
      const res = await r.call("getMultipleAccounts", [part, { encoding: "base64", dataSlice: { offset: 48, length: 1 }, commitment: "confirmed" }]);
      if (!res || !Array.isArray(res.value) || res.value.length !== part.length) throw new Error("the RPC returned a malformed account list");
      res.value.forEach((a, j) => { if (a && a.owner === owner && atob(a.data[0]).charCodeAt(0) === 3) found.add(idx[i + j]); });
    }
  }
  return { list: [...found].sort((a, b) => (a < b ? -1 : 1)), partial: first > 1n };
}

const perms = (p) => [p & Q.PERM_INITIATE ? "propose" : "", p & Q.PERM_VOTE ? "vote" : "", p & Q.PERM_EXECUTE ? "execute" : ""].filter(Boolean).join(", ") || "no rights";

function voters(info, change) {
  let list = info.members.map((m) => ({ key: m.key, perms: m.perms }));
  let threshold = info.threshold;
  for (const c of change) {
    if (c.kind === "add") list = [...list.filter((m) => !eq(m.key, c.key)), { key: c.key, perms: c.perms }];
    if (c.kind === "remove") list = list.filter((m) => !eq(m.key, c.key));
    if (c.kind === "threshold") threshold = c.threshold;
  }
  const meIn = list.some((m) => eq(m.key, me()) && (m.perms & Q.PERM_VOTE));
  const others = list.filter((m) => !eq(m.key, me()) && (m.perms & Q.PERM_VOTE)).length;
  return { unlocked: !meIn || others >= threshold, others, threshold };
}

function words(t, v) {
  if (t.kind === "vault") {
    const vault = Q.vaultPda(v.ms, t.vaultIndex);
    const out = [];
    if (t.message.lookups.length) out.push({ title: "Uses address lookup tables", rows: [], notes: ["Some accounts of this transaction live in lookup tables and cannot be shown here. Approve only if you checked it in Squads."], risky: true, check: [] });
    for (const ix of t.message.ixs) {
      const d = Q.describeIx(ix, vault);
      if (d.kind === "pay" && d.fromVault) out.push({ title: `Send ${sol(d.lamports)} SOL from vault ${t.vaultIndex}`, rows: [["To", b58encode(d.to), true]], check: [b58encode(d.to)], payee: d.to });
      else if (d.kind === "pay") out.push({ title: `Send ${sol(d.lamports)} SOL from ${short(d.from)}`, rows: [["From", b58encode(d.from), true], ["To", b58encode(d.to), true]], check: [b58encode(d.to)], risky: true });
      else if (d.kind === "token") out.push({ title: `Send ${d.amount} token units${d.decimals !== null ? ` (${d.decimals} decimals)` : ""}`, rows: [["To token account", b58encode(d.dest), true], ["From token account", b58encode(d.source), true], ...(d.mint ? [["Mint", b58encode(d.mint), true]] : [])], notes: ["Check the receiving token account and the token in Squads before you approve."], check: [b58encode(d.dest)], risky: true });
      else {
        const metas = d.metas.map((m, i) => [`Account ${i + 1}${m.key && eq(m.key, vault) ? " (the vault)" : ""}${m.signer ? ", signs" : ""}${m.writable ? ", writable" : ""}`, m.key ? b58encode(m.key) : "(from a lookup table)", true]);
        const data = d.data.length ? `${Array.from(d.data.slice(0, 300), (b) => b.toString(16).padStart(2, "0")).join("")}${d.data.length > 300 ? `… (first 300 of ${d.data.length} bytes)` : ""}` : "(empty)";
        out.push({ title: "Program call that cannot be shown in plain words", rows: [["Program", b58encode(d.program), true], ...metas, ["Data", data, true]], risky: true, check: [b58encode(d.program)] });
      }
    }
    if (!t.message.ixs.length) out.push({ title: "Does nothing (no instructions)", rows: [] });
    return out;
  }
  if (t.kind === "config") {
    const after = voters(v.info, t.actions);
    const out = t.actions.map((c) => {
      if (c.kind === "add") return { title: `Add member with rights: ${perms(c.perms)}`, rows: [["Member", b58encode(c.key), true]], check: [b58encode(c.key)] };
      if (c.kind === "remove") return { title: eq(c.key, me()) ? "Remove YOUR OPEQ address from the multisig" : "Remove member", rows: [["Member", b58encode(c.key), true]], risky: eq(c.key, me()) };
      if (c.kind === "threshold") return { title: `Change approvals needed from ${v.info.threshold} to ${c.threshold}`, rows: [], risky: c.threshold < v.info.threshold };
      if (c.kind === "timelock") return { title: `Set the time lock to ${c.seconds} seconds`, rows: [] };
      if (c.kind === "limit") return { title: "Add a spending limit", rows: [["Mint", eq(c.mint, SYSTEM) ? "SOL" : b58encode(c.mint), true], ["Amount", String(c.amount)], ["Vault", String(c.vaultIndex)], ...c.members.map((m, i) => [`Can spend ${i + 1}`, b58encode(m), true])], notes: ["A spending limit lets members move funds without any vote, so OPEQ would not protect that amount."], risky: true };
      if (c.kind === "unlimit") return { title: "Remove a spending limit", rows: [["Spending limit", b58encode(c.key), true]] };
      return { title: c.key ? "Change who gets rent back" : "Stop collecting rent back", rows: c.key ? [["Rent collector", b58encode(c.key), true]] : [] };
    });
    if (after.unlocked) out.push({ title: "This change removes the OPEQ lock", rows: [], notes: [`After it, the other members could approve alone (${after.others} can vote, ${after.threshold} needed). Approve only if your team really wants to stop using OPEQ.`], risky: true });
    return out;
  }
  if (t.kind === "batch") return [{ title: "A batch of transactions that cannot be shown here", rows: [], notes: ["Check every transaction of the batch in Squads before you approve."], risky: true }];
  return [{ title: "An unknown kind of Squads transaction", rows: [], risky: true }];
}

export function hide() {
  if (!x) return;
  open = null;
  x.$("sq-view").classList.add("hidden");
  x.$("sq-box").classList.remove("hidden");
}

function showView(on) {
  x.$("sq-view").classList.toggle("hidden", !on);
  x.$("sq-box").classList.toggle("hidden", on);
  x.$("sv-list-box").classList.toggle("hidden", on || !x.$("sv-view").classList.contains("hidden"));
}

export async function refresh() {
  if (!x || !x.session()) return;
  x.$("sq-me").textContent = b58encode(me());
  if (open) return showMultisig(open);
  showView(false);
  const box = x.$("sq-list");
  box.textContent = "";
  const list = await loadList();
  for (const a of list) {
    const line = el("div", "ms-line");
    const row = el("button", "ms-row");
    row.type = "button";
    const meta = el("span", "ms-meta", "…");
    row.append(el("span", "mono", short(a)), meta);
    row.addEventListener("click", () => x.guard(() => showMultisig(a)));
    const rm = el("button", "ms-rm", "Remove");
    rm.type = "button";
    rm.addEventListener("click", () => x.guard(async () => {
      if (!(await x.ask({ ...x.tag(), title: "Remove this Squads multisig from the list?", rows: [["Multisig", a, true]], notes: [{ text: "Only this list changes. The multisig, its members and its funds stay as they are." }] }, "Remove"))) return;
      await saveList((await loadList()).filter((b) => b !== a));
      await refresh();
    }));
    line.append(row, rm);
    box.append(line);
    loadMultisig(a).then((v) => { meta.textContent = v.state.locked ? `lock set, ${v.info.threshold} of ${v.info.members.length}` : "not locked"; }).catch(() => { meta.textContent = "could not read"; });
  }
}

async function showMultisig(addr) {
  const v = await loadMultisig(addr);
  open = addr;
  showView(true);
  x.$("sq-addr").textContent = addr;
  const vault = Q.vaultPda(v.ms, 0);
  x.$("sq-vault").textContent = b58encode(vault);
  x.$("sq-bal").textContent = `${sol(await x.rpc().balance(vault))} SOL`;
  x.$("sq-thr").textContent = `${v.info.threshold} of ${v.info.members.length}`;
  const st = x.$("sq-state");
  st.textContent = "";
  const left = await approvedLeft(v);
  const issues = [...v.state.issues];
  for (const i of left.list) issues.push(`Transaction #${i} is already approved and can still run without your vote. Ask the members to execute or cancel it in Squads before you rely on the lock.`);
  if (left.partial) issues.push(`Only the last ${SCAN_MAX} transactions were checked for earlier approvals.`);
  if (!issues.length) {
    st.append(el("p", "lock-ok", "Locked. Nothing in this multisig moves without your OPEQ vote."));
    st.append(el("p", "hint", "OPEQ cannot see spending limits or token delegates. Open Squads and make sure this multisig has no spending limits and its token accounts have no delegates, because both move funds without any vote."));
  } else for (const i of issues) st.append(el("p", "lock-bad", i));
  const mb = x.$("sq-members");
  mb.textContent = "";
  for (const m of v.info.members) mb.append(el("p", "mono ms-owner" + (eq(m.key, me()) ? " me" : ""), `${b58encode(m.key)}${eq(m.key, me()) ? " (you)" : ""}: ${perms(m.perms)}`));
  const box = x.$("sq-props");
  box.textContent = "";
  const last = v.info.transactionIndex;
  const first = last > BigInt(Q.SHOW) ? last - BigInt(Q.SHOW) + 1n : 1n;
  if (last < 1n) { box.append(el("p", "hint", "No transactions yet.")); return; }
  for (let i = last; i >= first; i--) {
    try { const c = await card(v, i); if (c) box.append(c); }
    catch (e) { box.append(el("p", "err", `Transaction #${i} could not be shown: ${e.message}`)); }
  }
}

async function loadItem(v, index) {
  const [pa, ta] = await Promise.all([readAccount(Q.proposalPda(v.ms, index)), readAccount(Q.transactionPda(v.ms, index))]);
  if (!pa || !eq(pa.owner, Q.PROGRAM)) return null;
  const p = Q.unpackProposal(pa.data);
  if (!eq(p.ms, v.ms) || p.index !== index) throw new Error("malformed Squads proposal");
  const t = ta && eq(ta.owner, Q.PROGRAM) ? Q.unpackTransaction(ta.data, v.ms) : { kind: "unknown" };
  return { p, t, raw: [pa.data, ta ? ta.data : null] };
}

async function card(v, index) {
  const it = await loadItem(v, index);
  if (!it) return null;
  const { p, t } = it;
  const stale = index <= v.info.staleIndex;
  const live = p.status === "active" && !stale;
  const voted = p.approved.some((k) => eq(k, me())) ? "approved" : p.rejected.some((k) => eq(k, me())) ? "rejected" : null;
  const c = el("div", "ms-prop" + (live ? "" : " done"));
  const state = stale && p.status === "active" ? "void, settings changed since" : p.status === "active" ? `${p.approved.length} of ${v.info.threshold} approvals` : p.status;
  c.append(el("p", "ms-prop-head", `#${index}: ${state}`));
  const w = words(t, v);
  for (const x1 of w) c.append(el("p", "ms-prop-title" + (x1.risky ? " warn" : ""), x1.title), ...x1.rows.map(([k, val]) => el("p", "mono ms-prop-row", `${k}: ${val}`)));
  if (voted) c.append(el("p", "hint", `You ${voted} this.`));
  if (live && !voted && v.state.voter) {
    const row = el("div", "row tight");
    for (const [label, cls, kind] of [["Approve", "btn-solid", "approve"], ["Reject", "btn-line", "reject"]]) {
      const b = el("button", `btn btn-sm ${cls}`, label);
      b.type = "button";
      b.addEventListener("click", () => later(() => vote(v, index, it, kind)));
      row.append(b);
    }
    c.append(row);
  }
  return c;
}

async function later(fn) {
  for (let i = 0; i < 120 && x.busy(); i++) await new Promise((r) => setTimeout(r, 250));
  return x.guard(fn);
}

async function vote(v0, index, it0, kind) {
  if (open !== b58encode(v0.ms)) throw new Error("the multisig on screen changed. Refresh and try again");
  const v = await loadMultisig(open);
  if (!v.state.voter) throw new Error("your OPEQ address cannot vote in this multisig");
  const it = await loadItem(v, index);
  if (!it || !eq(it.raw[1] || new Uint8Array(0), it0.raw[1] || new Uint8Array(0))) throw new Error("the transaction changed since it was shown. Refresh and check it again");
  if (it.p.status !== "active" || index <= v.info.staleIndex) throw new Error("this proposal is no longer open. Refresh to see its state");
  if (it.p.approved.some((k) => eq(k, me())) || it.p.rejected.some((k) => eq(k, me()))) throw new Error("you already voted on this proposal");
  const w = words(it.t, v);
  if (kind === "approve") for (const a of new Set(w.flatMap((t) => t.check || []))) await x.lookalike(a);
  const notes = [{ text: "Signed with one quantum-resistant one-time key from your wallet." }];
  if (kind === "approve") {
    notes.push({ text: "Check every line above. Your OPEQ vote is what lets this Squads transaction run.", warn: true });
    for (const t of w) for (const n of t.notes || []) notes.push({ text: n, warn: true });
    if (w.some((t) => t.risky)) notes.push({ text: "This transaction does something OPEQ marks as risky. Approve only if you know exactly what it does.", warn: true });
    for (const t of w) {
      if (!t.payee || eq(t.payee, me())) continue;
      try { const warn = await x.checkRecipient(t.payee); if (warn) notes.push({ text: warn.trim(), warn: true }); }
      catch (e) { notes.push({ text: `Do not approve: ${e.message}.`, warn: true }); }
    }
  } else notes.push({ text: "Rejecting counts against this proposal. Once enough members reject, it can never run." });
  const ix = Q.voteIx(kind, v.ms, me(), Q.proposalPda(v.ms, index));
  const plan = await x.planTopup([ix], [], 0n);
  const label = kind === "approve" ? "Approve" : "Reject";
  const rows = [["Squads multisig", open, true], ...w.flatMap((t) => [["Action", t.title], ...t.rows]), ["Network fee", await x.fee(CU_VOTE)]];
  if (!(await x.ask({ ...x.tag(), title: `${label}: Squads transaction #${index}`, rows, notes: [...notes, ...(plan.note ? [{ text: plan.note.trim() }] : [])] }, label))) return;
  const sig = await x.run(`${label.toLowerCase()}, grinding the signature`, [ix], plan, { cu: CU_VOTE });
  x.log(`squads ${short(open)}: ${label.toLowerCase()} #${index}: ${sig}`, "ok");
  x.ok(kind === "approve" ? "approved; a member can now execute it in Squads" : "rejected");
  await showMultisig(open);
}

export function init(ctx) {
  x = ctx;
  x.$("sq-me-copy").addEventListener("click", (e) => x.copy(e.currentTarget, b58encode(me()), "member address copied"));
  x.$("sq-vault-copy").addEventListener("click", (e) => x.copy(e.currentTarget, x.$("sq-vault").textContent, "vault address copied"));
  x.$("sq-back").addEventListener("click", () => x.guard(async () => { open = null; await refresh(); }));
  x.$("sq-refresh").addEventListener("click", () => x.guard(() => showMultisig(open)));
  x.$("sq-add").addEventListener("click", () => x.guard(async () => {
    const a = x.$("sq-add-in").value.trim();
    const v = await loadMultisig(a);
    const list = await loadList();
    if (!list.includes(b58encode(v.ms))) {
      if (list.length >= LIST_MAX) throw new Error(`at most ${LIST_MAX} Squads multisigs`);
      await saveList([b58encode(v.ms), ...list]);
    }
    x.$("sq-add-in").value = "";
    x.ok(v.state.locked ? "added; this multisig is locked by your OPEQ vote" : "added; finish the lock steps shown in red");
    open = b58encode(v.ms);
    await refresh();
  }));
}
