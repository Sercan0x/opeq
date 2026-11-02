import { checkAddress, parseUnits, formatUnits } from "./lib/evmwallet.js";
import { encodeErc20Transfer } from "./lib/evmwots.js";
import { ACCOUNT_RUNTIME } from "./lib/evmcode.js";
import { keccak256 } from "./lib/keccak.js";
import { bytesToHex } from "./lib/evmtx.js";
import * as M from "./lib/evmmultisig.js";

const enc = new TextEncoder();
const LIST_MAX = 20;
const SHOW = 10;
let x = null;
let open = null;
let view = null;

const ERRORS = Object.fromEntries([
  ["NotEnoughApprovals(uint256,uint256)", "this proposal does not have enough approvals yet"],
  ["NotLive()", "this proposal is no longer open: it was executed, cancelled, expired, or the owners changed since"],
  ["NotOwner()", "your account is not an owner of this vault"],
  ["AlreadyApproved()", "you already approved this proposal"],
  ["NotApproved()", "you have not approved this proposal"],
  ["NotProposer()", "only the owner who proposed it can cancel it"],
  ["BadExpiry()", "the proposal lifetime must be between now and 30 days"],
  ["CallsMismatch()", "the payment does not match what was approved"],
  ["CallFailed(uint256,bytes)", "the payment itself fails on chain, for example because the vault does not hold enough"],
  ["NotOpeqAccount(address)", "every owner must be an OPEQ account that is set up on this network"],
  ["DuplicateOwner(address)", "the same owner is listed twice"],
  ["BadThreshold()", "the number of approvals must be between 1 and the number of owners"],
  ["BadOwnerCount()", `a shared vault needs between 1 and ${M.MAX_OWNERS} owners`],
].map(([sig, text]) => [bytesToHex(keccak256(enc.encode(sig)).slice(0, 4)), text]));

function friendly(e) {
  const m = /0x[0-9a-f]{8}/i.exec(String(e && e.message));
  if (m && ERRORS[m[0].toLowerCase()]) e.message = `${ERRORS[m[0].toLowerCase()]}. Nothing was signed`;
  return e;
}

async function run(fn) {
  try { return await fn(); } catch (e) { throw friendly(e); }
}

const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const listKey = () => `opeq:evm-ms:${x.chain().vaultId}:${x.chain().id}`;

async function loadList() {
  const list = await x.kv.get(listKey());
  return (Array.isArray(list) ? list : []).filter((a) => typeof a === "string" && /^0x[0-9a-f]{40}$/.test(a)).slice(0, LIST_MAX);
}

async function saveList(list) {
  await x.kv.set(listKey(), list.slice(0, LIST_MAX));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function hideAll() {
  if (!x) return;
  x.hide("e-ms", true);
  x.hide("ms-v", true);
  open = null; view = null;
}

export async function refresh(ready) {
  if (!x) return;
  if (!ready) { hideAll(); return; }
  if (open) { x.hide("e-ms", true); await showVault(open); return; }
  x.hide("ms-v", true);
  x.hide("e-ms", false);
  const box = x.$("ms-list");
  box.textContent = "";
  const list = await loadList();
  if (!list.length) { box.append(el("p", "hint", "No shared vaults on this network yet.")); return; }
  for (const a of list) {
    const row = el("button", "ms-row");
    row.type = "button";
    row.append(el("span", "mono", short(a)), el("span", "ms-meta", "…"));
    row.addEventListener("click", () => x.guard(() => showVault(a)));
    box.append(row);
    new M.Vault(x.chain(), a).readAt(x.chain().rpc, "latest").then((v) => {
      row.lastChild.textContent = `${v.threshold} of ${v.owners.length}, ${formatUnits(v.balance, 18)} ${x.chain().chain.symbol}`;
    }).catch(() => { row.lastChild.textContent = "could not read"; });
  }
}

async function tokenInfo(addr, vault) {
  const t = await x.chain().token(addr);
  const raw = await x.chain().rpc.ethCall(t.address, "0x70a08231000000000000000000000000" + vault.slice(2));
  return { ...t, vaultBalance: BigInt(raw) };
}

async function words(call, vault) {
  const d = M.describe(call, vault);
  const sym = x.chain().chain.symbol;
  if (d.kind === "pay") return { title: `Send ${formatUnits(d.value, 18, 18)} ${sym}`, rows: [["To", d.to, true]], d };
  if (d.kind === "token") {
    const t = await x.chain().token(d.token).catch(() => null);
    const amt = t ? `${formatUnits(d.amount, t.decimals, t.decimals)} ${t.symbol} (unverified)` : `${d.amount} units of an unknown token`;
    return { title: `Send ${amt}`, rows: [["To", d.to, true], ["Token contract", d.token, true]], d };
  }
  if (d.kind === "owners") return { title: `Change owners: ${d.threshold} of ${d.owners.length}`, rows: d.owners.map((o, i) => [`Owner ${i + 1}`, o, true]), d };
  if (d.kind === "threshold") return { title: `Change approvals needed to ${d.threshold}`, rows: [], d };
  return { title: "Contract call that cannot be shown in plain words", rows: [["Contract", d.to, true], ["Value", `${formatUnits(d.value, 18, 18)} ${sym}`]], d, risky: true };
}

async function showVault(addr) {
  const c = x.chain();
  const v = new M.Vault(c, addr);
  const info = await v.read();
  const me = c.account;
  if (!info.owners.includes(me)) throw new Error("your account on this network is not an owner of that vault");
  open = addr; view = { v, info };
  x.hide("e-ms", true);
  x.hide("ms-v", false);
  x.$("ms-v-addr").textContent = addr;
  x.$("ms-v-exp").href = x.explorer("address", addr);
  x.$("ms-v-bal").textContent = `${formatUnits(info.balance, 18)} ${c.chain.symbol}`;
  x.$("ms-v-thr").textContent = `${info.threshold} of ${info.owners.length}`;
  const ob = x.$("ms-v-owners");
  ob.textContent = "";
  for (const o of info.owners) ob.append(el("p", "mono ms-owner" + (o === me ? " me" : ""), o === me ? `${o} (you)` : o));
  const sel = x.$("ms-asset"), keep = sel.value;
  sel.textContent = "";
  const opt = (val, t) => { const o = el("option", "", t); o.value = val; sel.append(o); };
  opt("native", `${c.chain.symbol} (${formatUnits(info.balance, 18)})`);
  for (const a of await x.tokens()) {
    const t = await tokenInfo(a, addr).catch(() => null);
    if (t) opt(t.address, `${t.symbol} ${t.address.slice(0, 6)}…${t.address.slice(-4)} (${formatUnits(t.vaultBalance, t.decimals, t.decimals)})`);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  await showProposals(v, info);
}

async function showProposals(v, info) {
  const box = x.$("ms-v-props");
  box.textContent = "";
  const me = x.chain().account;
  const from = Math.max(0, info.proposals - SHOW);
  if (!info.proposals) { box.append(el("p", "hint", "No proposals yet.")); return; }
  for (let id = info.proposals - 1; id >= from; id--) {
    let p;
    try { p = await v.proposal(id); } catch (e) { box.append(el("p", "err", `Proposal ${id}: ${e.message}`)); continue; }
    const mine = await v.approvedBy(id, me);
    const w = await Promise.all(p.calls.map((call) => words(call, v.address)));
    const card = el("div", "ms-prop" + (p.live ? "" : " done"));
    const state = p.executed ? "executed" : p.cancelled ? "cancelled" : p.config !== info.config ? "void, owners changed" : p.expires * 1000 < Date.now() ? "expired" : `${p.approvals} of ${info.threshold} approvals`;
    card.append(el("p", "ms-prop-head", `#${id}: ${state}`));
    for (const t of w) card.append(el("p", "ms-prop-title" + (t.risky ? " warn" : ""), t.title), ...t.rows.map(([k, val]) => el("p", "mono ms-prop-row", `${k}: ${val}`)));
    card.append(el("p", "hint", `Proposed by ${p.proposer === me ? "you" : short(p.proposer)}${p.live ? `, open until ${new Date(p.expires * 1000).toLocaleString()}` : ""}`));
    if (p.live) {
      const row = el("div", "row tight");
      const btn = (label, cls, fn) => { const b = el("button", `btn btn-sm ${cls}`, label); b.type = "button"; b.addEventListener("click", () => x.guard(fn)); row.append(b); };
      if (p.approvals >= info.threshold) btn("Execute", "btn-solid", () => act(v, p, w, "execute"));
      else if (!mine) btn("Approve", "btn-solid", () => act(v, p, w, "approve"));
      if (mine) btn("Revoke my approval", "btn-line", () => act(v, p, w, "revoke"));
      if (p.proposer === me) btn("Cancel", "btn-line", () => act(v, p, w, "cancel"));
      card.append(row);
    }
    box.append(card);
  }
}

async function act(v, p, w, kind) {
  const c = x.chain();
  const fresh = await v.proposal(p.id);
  if (fresh.callsHash !== p.callsHash) throw new Error("the proposal changed since it was shown. Refresh and check it again");
  const rows = w.flatMap((t) => [["Action", t.title], ...t.rows]);
  const label = { approve: "Approve", revoke: "Revoke", cancel: "Cancel proposal", execute: "Execute" }[kind];
  const notes = [{ text: "Signed with one quantum-resistant one-time key from your account." }];
  if (kind === "approve") notes.push({ text: "Check every line above. Your approval counts toward moving the vault's funds exactly like this.", warn: true });
  if (kind === "execute") notes.push({ text: "This sends the payment now. It needs no further approvals." });
  if (w.some((t) => t.risky)) notes.push({ text: "This proposal calls a contract in a way OPEQ cannot describe. Approve only if you know exactly what it does.", warn: true });
  if (!(await x.ask({ ...x.tag(), title: `${label}: proposal #${p.id}`, rows: [["Vault", v.address, true], ...rows, ["Network fee", await x.feeText(M.APPROVE_GAS + (kind === "execute" ? 120000n : 0n))]], notes }, label))) return;
  const call = kind === "execute" ? M.executeCall(v.address, p.id, fresh.calls) : M.idCall(v.address, kind, p.id);
  await run(() => c.execute([call], (h) => x.last(`${label} sent.`, h)));
  x.ok(kind === "execute" ? "executed" : kind === "approve" ? "approved" : kind === "revoke" ? "approval revoked" : "proposal cancelled");
  await x.refreshMain();
}

async function ownerCheck(c, a) {
  const code = await c.rpc.code(a);
  if (code === "0x") throw new Error(`${a} has not set up OPEQ on ${c.chain.name} yet. Ask them to press Set up first`);
  if (code.slice(2).toLowerCase() !== ACCOUNT_RUNTIME.toLowerCase()) throw new Error(`${a} is not an OPEQ account. Only OPEQ accounts can own a shared vault, so no owner relies on an ECDSA key`);
}

export function init(ctx) {
  x = ctx;
  x.$("ms-create").addEventListener("click", () => x.guard(async () => {
    const c = x.chain();
    const extra = x.$("ms-owners").value.split(/[\s,]+/).filter(Boolean).map(checkAddress);
    const owners = M.checkOwners([c.account, ...extra.filter((a) => a !== c.account)], Number(x.$("ms-thr").value.trim()));
    if (owners.length < 2) throw new Error("add at least one other owner");
    for (const a of owners) await ownerCheck(c, a);
    const threshold = Number(x.$("ms-thr").value.trim());
    const fac = M.factoryAddress();
    const fresh = (await c.rpc.code(fac)) === "0x";
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const addr = M.vaultAddress(c.account, owners, threshold, nonce);
    if (!(await x.ask({ ...x.tag(), title: `Create a ${threshold} of ${owners.length} shared vault`, rows: [["Vault address", addr, true], ...owners.map((o, i) => [`Owner ${i + 1}${o === c.account ? " (you)" : ""}`, o, true]), ["Network fee", await x.feeText((fresh ? 2600000n : 0n) + 2200000n)]],
      notes: [{ text: `Moving funds will need ${threshold} of these ${owners.length} owners to approve, each with their own OPEQ wallet.` }, ...(fresh ? [{ text: "The first transaction installs the OPEQ shared vault factory on this network, once for everyone." }] : []), { text: "Send the vault address to the other owners so they can add it in their wallet." }, { text: "Beta: the shared vault contract has had internal reviews only. Start with small amounts.", warn: true }] }, "Create"))) return;
    if (fresh) await c.sendTx("0x4e59b44847b379578588920ca78fbf26c0b4956c", M.factoryDeployData(), 0n, 2600000n, (h) => x.last("Factory install sent.", h));
    await run(() => c.execute([M.createCall(owners, threshold, nonce)], (h) => x.last("Vault creation sent.", h)));
    if ((await c.rpc.code(addr)) === "0x") throw new Error("the vault was not created; check the explorer and try again");
    await saveList([addr, ...(await loadList()).filter((a) => a !== addr)]);
    x.$("ms-owners").value = x.$("ms-thr").value = "";
    x.ok("shared vault created");
    open = addr;
    await refresh(true);
  }));

  x.$("ms-add-go").addEventListener("click", () => x.guard(async () => {
    const a = checkAddress(x.$("ms-add").value);
    const info = await new M.Vault(x.chain(), a).read();
    if (!info.owners.includes(x.chain().account)) throw new Error("your account on this network is not an owner of that vault");
    const list = await loadList();
    if (!list.includes(a)) {
      if (list.length >= LIST_MAX) throw new Error(`at most ${LIST_MAX} shared vaults per network`);
      await saveList([a, ...list]);
    }
    x.$("ms-add").value = "";
    x.ok("vault added");
    open = a;
    await refresh(true);
  }));

  x.$("ms-pay-go").addEventListener("click", () => x.guard(async () => {
    const c = x.chain();
    const { v, info } = view;
    const asset = x.$("ms-asset").value;
    const to = checkAddress(x.$("ms-to").value);
    if (to === v.address) throw new Error("that is the vault's own address");
    await x.lookalike(to);
    const warn = await x.recipient(to);
    let calls, title, rows = [["To", to, true]];
    const notes = [];
    if (asset === "native") {
      const val = parseUnits(x.$("ms-amt").value, 18);
      if (val > info.balance) throw new Error(`the vault holds only ${formatUnits(info.balance, 18)} ${c.chain.symbol}`);
      calls = [{ to, value: val, data: new Uint8Array(0) }];
      title = `Propose sending ${formatUnits(val, 18, 18)} ${c.chain.symbol}`;
    } else {
      const t = await tokenInfo(asset, v.address);
      if (to === t.address) throw new Error(`that is the ${t.symbol} token contract itself. Use the receiver's wallet address`);
      const val = parseUnits(x.$("ms-amt").value, t.decimals);
      if (val > t.vaultBalance) throw new Error(`the vault holds only ${formatUnits(t.vaultBalance, t.decimals, t.decimals)} ${t.symbol}`);
      calls = [{ to: t.address, value: 0n, data: encodeErc20Transfer(to, val) }];
      title = `Propose sending ${formatUnits(val, t.decimals, t.decimals)} ${t.symbol}`;
      rows.push(["Token contract", t.address, true]);
      notes.push({ text: "Anyone can create a token with any name. Check the token contract against the project's official site.", warn: true });
    }
    const now = Math.floor(Date.now() / 1000);
    notes.unshift({ text: `This only proposes the payment. It moves funds after ${info.threshold} of ${info.owners.length} owners approve; your proposal counts as your approval. It stays open for 7 days.` });
    if (warn) notes.push({ text: warn, warn: true });
    if (!(await x.ask({ ...x.tag(), title, rows: [["Vault", v.address, true], ...rows, ["Network fee", await x.feeText(M.PROPOSE_GAS)]], notes }, "Propose"))) return;
    await run(() => c.execute([M.proposeCall(v.address, calls, now + M.DEFAULT_LIFETIME_S)], (h) => x.last("Proposal sent.", h)));
    await x.remember(to);
    x.$("ms-to").value = x.$("ms-amt").value = "";
    x.ok("proposed; the other owners can approve it in their wallets");
    await x.refreshMain();
  }));

  x.$("ms-v-refresh").addEventListener("click", () => x.guard(() => showVault(open)));
  x.$("ms-v-close").addEventListener("click", () => { open = null; view = null; x.guard(() => refresh(true)); });
  x.$("ms-v-copy").addEventListener("click", (e) => x.copy(e.currentTarget, open, "vault address copied"));
}
