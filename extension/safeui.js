import { checkAddress, parseUnits, formatUnits, EXEC_GAS } from "./lib/evmwallet.js";
import { CREATE2_DEPLOYER } from "./lib/evmwots.js";
import * as G from "./lib/safeguard.js";
import { ACCOUNT_RUNTIME } from "./lib/evmcode.js";

const LIST_MAX = 20;
const INSTALL_GAS = 3200000n;
let x = null;
let open = null;

const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const listKey = () => `opeq:evm-safe:${x.chain().vaultId}:${x.chain().id}`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function loadList() {
  const list = await x.kv.get(listKey());
  return (Array.isArray(list) ? list : []).filter((a) => typeof a === "string" && /^0x[0-9a-f]{40}$/.test(a)).slice(0, LIST_MAX);
}

async function saveList(list) { await x.kv.set(listKey(), list.slice(0, LIST_MAX)); }

export function hideAll() {
  if (!x) return;
  x.hide("e-safe", true);
  x.hide("sf-v", true);
  open = null;
}

export async function refresh(ready) {
  if (!x) return;
  if (!ready) { hideAll(); return; }
  if (open) {
    try { await showSafe(open); return; }
    catch { open = null; x.hide("sf-v", true); }
  }
  x.hide("sf-v", true);
  x.hide("e-safe", false);
  const box = x.$("sf-list");
  box.textContent = "";
  for (const a of await loadList()) {
    const line = el("div", "ms-line");
    const row = el("button", "ms-row");
    row.type = "button";
    const meta = el("span", "ms-meta", "…");
    row.append(el("span", "mono", short(a)), meta);
    row.addEventListener("click", () => x.guard(() => showSafe(a)));
    const rm = el("button", "ms-rm", "Remove");
    rm.type = "button";
    rm.addEventListener("click", () => x.guard(async () => {
      if (!(await x.ask({ ...x.tag(), title: "Remove this Safe from the list?", rows: [["Safe", a, true]], notes: [{ text: "Only this list changes. The Safe, its guard and its funds stay as they are." }] }, "Remove"))) return;
      await saveList((await loadList()).filter((b) => b !== a));
      await refresh(true);
    }));
    line.append(row, rm);
    box.append(line);
    G.read(x.chain(), a).then((r) => {
      const st = G.lockState(r, x.chain().account);
      meta.textContent = r.guard && r.guard.recoveries.length ? "RECOVERY REQUESTED" : st.locked ? "locked" : "not locked";
    }).catch(() => { meta.textContent = "could not read"; });
  }
}

const days = (s) => `${Math.round(s / 86400)} days`;

async function showSafe(addr) {
  const c = x.chain();
  const r = await G.read(c, addr);
  open = addr;
  x.hide("e-ms", true);
  x.hide("ms-v", true);
  x.hide("e-safe", true);
  x.hide("sf-v", false);
  x.$("sf-v-addr").textContent = addr;
  x.$("sf-v-exp").href = x.explorer("address", addr);
  x.$("sf-bal").textContent = `${formatUnits(await c.rpc.balance(addr), 18)} ${c.chain.symbol}`;
  x.$("sf-thr").textContent = `${r.safe.threshold} of ${r.safe.owners.length}, Safe ${r.safe.version}`;
  const st = G.lockState(r, c.account);
  const box = x.$("sf-state");
  box.textContent = "";
  if (st.locked) box.append(el("p", "lock-ok", `Locked. Every Safe transaction needs ${r.guard.required} of ${r.guard.approvers.length} OPEQ approval${r.guard.approvers.length > 1 ? "s" : ""}. Owners alone can only start a recovery that waits ${days(r.guard.delay)}.`));
  else for (const i of st.issues) box.append(el("p", "lock-bad", i));
  if (st.locked) box.append(el("p", "hint", "The lock covers Safe transactions. Token allowances the Safe gave before the lock still work, so revoke any you do not need. A Safe that ran delegate calls in the past could also hide a module the lock cannot see; lock only Safes whose history you know."));
  await showRecoveries(r);
}

async function showRecoveries(r) {
  const box = x.$("sf-recs");
  box.textContent = "";
  if (!r.guard) return;
  const me = x.chain().account;
  const now = Math.floor(Date.now() / 1000);
  for (const q of r.guard.recoveries) {
    const expired = now > q.readyAt + 30 * 86400;
    const c = el("div", "ms-prop" + (expired ? " done" : ""));
    c.append(el("p", "ms-prop-head", expired ? "recovery request, expired" : now >= q.readyAt ? "recovery request, can run now" : "recovery request"));
    c.append(el("p", "ms-prop-title warn", "An owner asked to run a Safe transaction without OPEQ"));
    c.append(el("p", "mono ms-prop-row", `Safe transaction hash: ${q.hash}`));
    c.append(el("p", "hint", expired ? "It was not used in time and can no longer run." : `It can run from ${new Date(q.readyAt * 1000).toLocaleString()} unless an OPEQ approver cancels it. If your team did not plan a recovery, cancel it now.`));
    if (!expired && r.guard.approvers.includes(me)) {
      const row = el("div", "row tight");
      const b = el("button", "btn btn-sm btn-solid", "Cancel this recovery");
      b.type = "button";
      b.addEventListener("click", () => later(() => cancel(q.hash)));
      row.append(b);
      c.append(row);
    }
    box.append(c);
  }
}

async function later(fn) {
  for (let i = 0; i < 120 && x.busy(); i++) await new Promise((r) => setTimeout(r, 250));
  return x.guard(fn);
}

async function cancel(hash) {
  const c = x.chain();
  const r = await G.read(c, open);
  if (!r.guard || !r.guard.recoveries.some((q) => q.hash === hash)) throw new Error("that recovery request is gone already. Refresh to see the Safe now");
  if (!r.guard.approvers.includes(c.account)) throw new Error("your OPEQ account is not an approver of this Safe");
  if (!(await x.ask({ ...x.tag(), title: "Cancel the recovery request", rows: [["Safe", open, true], ["Safe transaction hash", hash, true], ["Network fee", await x.feeText(EXEC_GAS + G.CANCEL_GAS)]], notes: [{ text: "Signed with one quantum-resistant one-time key from your account." }, { text: "The request is removed and that transaction can then only run with OPEQ approval." }] }, "Cancel request"))) return;
  await c.execute([G.cancelCall(open, hash)], (h) => x.last("Cancel sent.", h));
  x.ok("recovery request cancelled");
  await showSafe(open);
}

function words(items, r) {
  const c = x.chain(), sym = c.chain.symbol, me = c.account;
  return items.map((d) => {
    if (d.kind === "pay") return { title: `Send ${formatUnits(d.value, 18, 18)} ${sym}`, rows: [["To", d.to, true]], check: [d.to], payee: d.to };
    if (d.kind === "token") return { title: `Send ${d.amount} units of a token`, rows: [["To", d.to, true], ["Token contract", d.token, true]], notes: ["Check the token contract and the amount in the Safe app. Anyone can create a token with any name."], check: [d.to], payee: d.to };
    if (d.kind === "allowance") return { title: `Allow ${d.spender} to take up to ${d.amount} units of a token`, rows: [["Spender", d.spender, true], ["Token contract", d.token, true]], notes: ["An allowance lets the spender move the Safe's tokens later without any further approval."], risky: true, check: [d.spender] };
    if (d.kind === "setGuard") return d.guard === G.guardAddress() ? { title: "Install the OPEQ guard", rows: [] } : { title: d.guard === G.ZERO ? "Remove the OPEQ lock (no guard)" : "Replace the OPEQ guard with another guard", rows: d.guard === G.ZERO ? [] : [["New guard", d.guard, true]], notes: ["After this, the owners can move funds without OPEQ."], risky: true };
    if (d.kind === "setFallback") return d.handler === G.ZERO ? { title: "Remove the fallback handler", rows: [] } : { title: "Set a fallback handler", rows: [["Handler", d.handler, true]], notes: ["The OPEQ guard blocks this, so the transaction will fail."], risky: true };
    if (d.kind === "enableModule") return { title: "Enable a module", rows: [["Module", d.module, true]], notes: ["The OPEQ guard blocks modules, so the transaction will fail."], risky: true };
    if (d.kind === "disableModule") return { title: "Disable a module", rows: [["Module", d.module, true]] };
    if (d.kind === "addOwner") return { title: `Add a Safe owner, signatures needed ${d.threshold}`, rows: [["New owner", d.owner, true]], check: [d.owner], risky: true };
    if (d.kind === "removeOwner") return { title: `Remove a Safe owner, signatures needed ${d.threshold}`, rows: [["Owner", d.owner, true]] };
    if (d.kind === "swapOwner") return { title: "Replace a Safe owner", rows: [["Old owner", d.from, true], ["New owner", d.owner, true]], check: [d.owner], risky: true };
    if (d.kind === "threshold") return { title: `Change owner signatures needed to ${d.threshold}`, rows: [] };
    if (d.kind === "configure") {
      const notes = [];
      if (!d.approvers.includes(me)) notes.push("Your OPEQ account would no longer be an approver.");
      if (r.guard && d.required < r.guard.required) notes.push(`OPEQ approvals needed would drop from ${r.guard.required} to ${d.required}.`);
      return { title: `Change the OPEQ guard settings: ${d.required} of ${d.approvers.length} approvals, recovery delay ${days(d.delay)}`, rows: d.approvers.map((a, i) => [`Approver ${i + 1}${a === me ? " (you)" : ""}`, a, true]), notes, risky: notes.length > 0, check: d.approvers.filter((a) => a !== me) };
    }
    if (d.kind === "delegate") return { title: "Delegate call: runs foreign code with full control over the Safe", rows: [["Contract", d.to, true], ["Data", d.size > 300 ? `${d.data.slice(0, 600)}… (${d.size} bytes)` : d.data, true]], notes: ["A delegate call can do anything with the Safe: take every asset, remove the lock, or hide a module that bypasses it for good. Approve only if you wrote or audited this exact contract."], risky: true, check: [d.to] };
    return { title: "Contract call that cannot be shown in plain words", rows: [["Contract", d.to, true], ["Value", `${formatUnits(d.value, 18, 18)} ${sym}`], ["Function", d.selector], ["Data", d.size > 300 ? `${d.data.slice(0, 600)}… (${d.size} bytes)` : d.data, true]], risky: true, check: [d.to] };
  });
}

function step(n, title, to, data, note) {
  const s = el("div", "sf-step");
  s.append(el("p", "ms-prop-head", `step ${n}`), el("p", "ms-prop-title", title));
  if (note) s.append(el("p", "hint", note));
  s.append(el("p", "mono ms-prop-row", `To: ${to}`), el("p", "mono ms-prop-row", `Data: ${data}`));
  const row = el("div", "row tight");
  for (const [label, text] of [["Copy To", to], ["Copy data", data]]) {
    const b = el("button", "btn btn-line btn-sm", label);
    b.type = "button";
    b.addEventListener("click", (e) => x.copy(e.currentTarget, text, `${label.slice(5)} copied`));
    row.append(b);
  }
  s.append(row);
  return s;
}

async function showSteps() {
  const c = x.chain();
  const r = await G.read(c, open);
  const extra = x.$("sf-appr").value.split(/[\s,]+/).filter(Boolean).map((a) => checkAddress(a).toLowerCase());
  const approvers = [...new Set([c.account, ...extra])];
  if (approvers.length > G.MAX_APPROVERS) throw new Error(`at most ${G.MAX_APPROVERS} approvers`);
  for (const a of approvers) {
    if (a === open) throw new Error("the Safe itself cannot be an approver");
    const code = await c.rpc.code(a);
    if (code === "0x") throw new Error(`${a} has not set up OPEQ on ${c.chain.name} yet. Ask them to press Set up first`);
    if (code.slice(2).toLowerCase() !== ACCOUNT_RUNTIME.toLowerCase()) throw new Error(`${a} is not an OPEQ account. Only OPEQ accounts can be approvers, so no approval relies on an ECDSA key`);
  }
  const rq = x.$("sf-req").value.trim() || "1";
  const required = /^\d+$/.test(rq) ? Number(rq) : NaN;
  if (!(required >= 1 && required <= approvers.length)) throw new Error(`OPEQ approvals needed must be between 1 and ${approvers.length}`);
  const dl = x.$("sf-delay").value.trim() || "7";
  const delay = /^\d+$/.test(dl) ? Number(dl) : NaN;
  if (!(delay >= G.MIN_DELAY_DAYS && delay <= G.MAX_DELAY_DAYS)) throw new Error(`the recovery delay must be between ${G.MIN_DELAY_DAYS} and ${G.MAX_DELAY_DAYS} days`);
  const box = x.$("sf-steps");
  box.textContent = "";
  const guard = G.guardAddress();
  if (!r.installed) {
    const s = el("div", "sf-step");
    s.append(el("p", "ms-prop-head", "first"), el("p", "ms-prop-title", `Install the OPEQ guard on ${c.chain.name}`), el("p", "hint", "This happens once per network, for everyone. Your gas key pays for it."));
    const row = el("div", "row tight");
    const b = el("button", "btn btn-solid btn-sm", "Install the guard");
    b.type = "button";
    b.addEventListener("click", () => later(install));
    row.append(b);
    s.append(row);
    box.append(s);
  }
  if (r.safe.modules.length) box.append(el("p", "lock-bad", `First disable the ${r.safe.modules.length} module${r.safe.modules.length > 1 ? "s" : ""} of this Safe in the Safe app settings. The guard refuses to work while any module is enabled.`));
  let n = 1;
  if (r.safe.fallback !== G.ZERO) box.append(step(n++, "Remove the fallback handler", open, G.setFallbackData(G.ZERO), "Without this, signed messages could bypass the lock. Some apps that ask the Safe to sign messages will stop working."));
  box.append(step(n++, `Save the guard settings: ${required} of ${approvers.length} OPEQ approvals, ${delay} day recovery delay`, guard, G.configureData(approvers, required, delay)));
  if (r.safe.guard.toLowerCase() !== guard) box.append(step(n++, "Turn the guard on", open, G.setGuardData(guard), "From this transaction on, nothing leaves the Safe without OPEQ approval."));
  box.append(el("p", "hint", "When the batch is waiting for signatures in the Safe app, it does not need OPEQ approval yet, because the guard is not on until the last step runs."));
}

async function install() {
  const c = x.chain();
  if ((await c.rpc.code(G.guardAddress())) !== "0x") { x.ok("the guard is already installed"); return showSteps(); }
  if (!(await x.ask({ ...x.tag(), title: `Install the OPEQ guard on ${c.chain.name}`, rows: [["Guard address", G.guardAddress(), true], ["Network fee", await x.feeText(INSTALL_GAS)]], notes: [{ text: "This puts the OPEQ guard contract on this network through the standard CREATE2 deployer. It happens once, for everyone." }, { text: "Beta: the guard has had internal reviews only.", warn: true }] }, "Install"))) return;
  await c.install(CREATE2_DEPLOYER, G.guardDeployData(), G.guardAddress(), (h) => x.last("Guard install sent.", h));
  if (!G.isGuardCode(await c.rpc.code(G.guardAddress()))) throw new Error("the code at the guard address is not the OPEQ guard. Do not use it");
  x.ok("guard installed");
  await showSafe(open);
  await showSteps();
}

async function approve() {
  const c = x.chain();
  const r = await G.read(c, open);
  if (!r.installed || !r.guard || !r.guard.required) throw new Error("this Safe has no OPEQ guard settings yet. Set up the lock first");
  if (!r.guard.approvers.includes(c.account)) throw new Error("your OPEQ account is not an approver of this Safe");
  const to = checkAddress(x.$("sf-to").value);
  const value = parseUnits(x.$("sf-val").value.trim() || "0", 18);
  const op = Number(x.$("sf-op").value);
  const tx = G.parseTx(to, value, x.$("sf-data").value, op);
  const nt = x.$("sf-nonce").value.trim();
  const nonce = nt ? (/^\d+$/.test(nt) ? BigInt(nt) : NaN) : r.safe.nonce;
  if (typeof nonce !== "bigint") throw new Error("the nonce must be a whole number");
  if (nonce < r.safe.nonce) throw new Error(`nonce ${nonce} was already used by this Safe. The next one is ${r.safe.nonce}`);
  const given = x.$("sf-hash").value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(given)) throw new Error("paste the Safe transaction hash from the Safe app");
  const hash = G.safeTxHash(c.id, open, tx, nonce);
  if (hash !== given) throw new Error("the Safe transaction hash does not match these details. Check To, Value, Data, Operation and Nonce again. If the Safe app set gas or refund values, OPEQ cannot approve that transaction");
  if (await G.approvedBy(c, open, hash, c.account)) throw new Error("you already approved this Safe transaction");
  const items = G.describe(tx, open);
  const w = words(items, r);
  for (const d of items) {
    if (d.kind !== "configure") continue;
    for (const a of d.approvers) {
      const code = await c.rpc.code(a);
      if (code.slice(2).toLowerCase() !== ACCOUNT_RUNTIME.toLowerCase()) w.push({ title: `${a} is not an OPEQ account`, rows: [], notes: ["The guard refuses approvers that are not OPEQ accounts, so this change will fail."], risky: true });
    }
  }
  for (const a of new Set(w.flatMap((t) => t.check || []))) await x.lookalike(a);
  const notes = [{ text: "Signed with one quantum-resistant one-time key from your account." }, { text: "Check every line above. Your approval lets the Safe owners run exactly this transaction, once.", warn: true }];
  for (const t of w) for (const n of t.notes || []) notes.push({ text: n, warn: true });
  if (w.some((t) => t.risky)) notes.push({ text: "This transaction does something OPEQ marks as risky. Approve only if you know exactly what it does.", warn: true });
  for (const t of w) {
    if (!t.payee || t.payee === c.account) continue;
    const warn = await x.recipient(t.payee).catch((e) => `Do not approve: ${e.message}.`);
    if (warn) notes.push({ text: warn, warn: true });
  }
  if (nonce > r.safe.nonce) notes.push({ text: `This is for nonce ${nonce}; the Safe is at ${r.safe.nonce}. It can run only after the transactions before it.` });
  const rows = [["Safe", open, true], ...w.flatMap((t) => [["Action", t.title], ...t.rows]), ["Safe transaction hash", hash, true], ["Nonce", String(nonce)], ["Network fee", await x.feeText(EXEC_GAS + G.APPROVE_GAS)]];
  if (!(await x.ask({ ...x.tag(), title: "Approve a Safe transaction", rows, notes }, "Approve"))) return;
  await c.execute([G.approveCall(open, hash)], (h) => x.last("Approval sent.", h));
  for (const id of ["sf-to", "sf-val", "sf-data", "sf-hash", "sf-nonce"]) x.$(id).value = "";
  x.ok("approved; a Safe owner can now execute it in the Safe app");
  await showSafe(open);
}

export function init(ctx) {
  x = ctx;
  x.$("sf-add-go").addEventListener("click", () => x.guard(async () => {
    const a = checkAddress(x.$("sf-add").value).toLowerCase();
    await G.read(x.chain(), a);
    const list = await loadList();
    if (!list.includes(a)) {
      if (list.length >= LIST_MAX) throw new Error(`at most ${LIST_MAX} Safes per network`);
      await saveList([a, ...list]);
    }
    x.$("sf-add").value = "";
    x.ok("Safe added");
    await showSafe(a);
  }));
  x.$("sf-steps-go").addEventListener("click", () => x.guard(showSteps));
  x.$("sf-ap-go").addEventListener("click", () => x.guard(approve));
  x.$("sf-v-refresh").addEventListener("click", () => x.guard(() => showSafe(open)));
  x.$("sf-v-close").addEventListener("click", () => { open = null; x.$("sf-steps").textContent = ""; x.guard(async () => { await x.refreshMain(); }); });
  x.$("sf-v-copy").addEventListener("click", (e) => x.copy(e.currentTarget, open, "Safe address copied"));
}
