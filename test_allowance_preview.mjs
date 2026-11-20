import * as V from "./web/lib/solvault.js";
import * as Q from "./web/lib/squads.js";
import { TOKEN, TOKEN22, decodeTokenAuthority, authorityWords, delegatedSpends, readMint, readTokenAccount, x402Payment, checkRequirements } from "./web/lib/agent.js";
import { concat, u64, b58encode, pubkey, b58encode as e } from "./web/lib/solana.js";

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("ok  ", n); } else { fail++; console.log("FAIL", n); } };
const k = (n) => new Uint8Array(32).fill(n);
const vault = k(1), src = k(2), mint = k(3), spender = k(4), other = k(5), newOwner = k(6);
const flags = (s, w) => (s ? V.M_SIGNER : 0) | (w ? V.M_WRITABLE : 0);
const sv = (prog, metas, data) => V.describe([prog, metas.map(([key, s, w]) => [key, flags(s, w)]), data], { program: k(9), opeqProgram: k(8), vault });
const sq = (prog, metas, data) => Q.describeIx({ program: prog, metas: metas.map(([key, s, w]) => ({ key, known: true, signer: s, writable: w })), data }, vault);

const approve = concat(new Uint8Array([4]), u64(5_000_000n));
const approveChecked = concat(new Uint8Array([13]), u64(5_000_000n), new Uint8Array([6]));
const revoke = new Uint8Array([5]);
const setOwner = concat(new Uint8Array([6, 2, 1]), newOwner);
const dropClose = new Uint8Array([6, 3, 0]);

for (const [name, f] of [["Solana vault", sv], ["Squads", sq]]) {
  const a = f(TOKEN, [[src, false, true], [spender, false, false], [vault, true, false]], approve);
  ok(a.kind === "allowance" && a.amount === 5_000_000n && b58encode(a.delegate) === b58encode(spender) && a.decimals === null, `${name}: Approve is read as an allowance with spender and amount`);
  const w = authorityWords(a, vault);
  ok(/^Allow .* to take up to 5000000 token units from the vault \(token not named\)$/.test(w.title) && w.risky && w.check[0] === b58encode(spender) && w.check.includes(b58encode(src)), `${name}: the review headline says who may take how much, and the spender is checked for look-alikes`);
  const c = f(TOKEN22, [[src, false, true], [mint, false, false], [spender, false, false], [vault, true, false]], approveChecked);
  ok(c.kind === "allowance" && c.decimals === 6 && b58encode(c.mint) === b58encode(mint), `${name}: ApproveChecked on Token-2022 carries mint and decimals`);
  const r = f(TOKEN, [[src, false, true], [vault, true, false]], revoke);
  ok(r.kind === "revoke" && !authorityWords(r, vault).risky, `${name}: Revoke is shown plainly and not as risky`);
  const o = f(TOKEN, [[src, false, true], [vault, true, false]], setOwner);
  const ow = authorityWords(o, vault);
  ok(o.kind === "authority" && o.type === 2 && ow.risky && /own the token account/.test(ow.title), `${name}: handing a token account to a new owner is a risky headline`);
  const d = f(TOKEN, [[src, false, true], [vault, true, false]], dropClose);
  ok(d.kind === "authority" && d.next === null && /^Remove the right to close/.test(authorityWords(d, vault).title), `${name}: removing the close authority is described`);
  const foreign = authorityWords(f(TOKEN, [[src, false, true], [spender, false, false], [other, true, false]], approve), vault);
  ok(/a token account \(token not named\)$/.test(foreign.title) && foreign.notes.some((n) => /not owned by this vault/.test(n)), `${name}: an allowance on someone else's account says so`);
  const big = authorityWords(f(TOKEN, [[src, false, true], [spender, false, false], [vault, true, false]], concat(new Uint8Array([4]), u64((1n << 64n) - 1n))), vault);
  ok(big.notes.some((n) => /unlimited/.test(n)), `${name}: an unlimited allowance is called out`);
}

let malformed = 0;
for (const data of [new Uint8Array([4]), concat(new Uint8Array([4]), u64(1n), new Uint8Array([0])), new Uint8Array([5, 0]), new Uint8Array([6, 2, 1]), concat(new Uint8Array([6, 2, 0]), newOwner), new Uint8Array([13, 1])]) {
  if (decodeTokenAuthority(TOKEN, [src, spender, vault, mint], data) === null) malformed++;
}
ok(malformed === 6, "malformed token authority data is not decoded into a friendly headline");
ok(decodeTokenAuthority(pubkey("11111111111111111111111111111111"), [src, spender, vault], approve) === null, "the same bytes under another program are not read as an allowance");
ok(sv(TOKEN, [[src, false, true], [spender, false, false]], approve).kind === "contract", "an Approve missing its owner account stays a raw program call");

const txOf = (ixs, keys, err = null) => ({ blockTime: 1, meta: { err, loadedAddresses: { writable: [], readonly: [] } }, transaction: { message: { accountKeys: keys.map(e), instructions: ixs } } });
const keys = [k(20), src, k(21), spender, vault, TOKEN, mint];
const tc = { programIdIndex: 5, accounts: [1, 6, 2, 3], data: e(concat(new Uint8Array([12]), u64(1_500_000n), new Uint8Array([6]))) };
const sp = delegatedSpends(txOf([tc], keys), src, vault);
ok(sp.length === 1 && sp[0].agent === e(spender) && sp[0].amount === 1_500_000n && sp[0].decimals === 6, "a delegate's TransferChecked out of the wallet's token account is listed as an agent payment");
ok(delegatedSpends(txOf([{ ...tc, accounts: [1, 6, 2, 4] }], keys), src, vault).length === 0, "a transfer the wallet signed itself is not an agent payment");
ok(delegatedSpends(txOf([tc], keys, { InstructionError: [0, "x"] }), src, vault).length === 0, "a failed transaction is not listed");
ok(delegatedSpends(txOf([tc], keys), k(30), vault).length === 0, "spends from another token account are ignored");
const plain = { programIdIndex: 5, accounts: [1, 2, 3], data: e(concat(new Uint8Array([3]), u64(7n))) };
ok(delegatedSpends(txOf([plain], keys), src, vault)[0].amount === 7n, "a plain Transfer by the delegate is listed too");
ok(delegatedSpends({ transaction: { message: { accountKeys: [1, 2], instructions: [] } }, meta: { err: null } }, src, vault).length === 0, "malformed RPC data is ignored");

const pd = authorityWords(decodeTokenAuthority(TOKEN22, [mint, vault], concat(new Uint8Array([6, 8, 1]), newOwner)), vault);
ok(/permanent delegate/.test(pd.title) && pd.rows[0][0] === "Token mint" && pd.risky && pd.notes.some((n) => /every holder/.test(n)), "a Token-2022 permanent delegate change is named and flagged on the mint");
const closeNote = authorityWords(decodeTokenAuthority(TOKEN, [src, vault], concat(new Uint8Array([6, 3, 1]), newOwner)), vault);
ok(closeNote.notes.some((n) => /wrapped SOL/.test(n)), "the close authority note warns about wrapped SOL balances");
const tokAcc = new Uint8Array(165); tokAcc[45] = 1; tokAcc[108] = 1;
ok((() => { try { readMint({ owner: TOKEN, data: tokAcc }); return false; } catch { return true; } })(), "a token account is not accepted as a mint");
const mintAcc = new Uint8Array(82); mintAcc[44] = 6; mintAcc[45] = 1;
ok(readMint({ owner: TOKEN, data: mintAcc }).decimals === 6, "a real mint still reads");
ok((() => { try { readTokenAccount({ owner: TOKEN22, data: new Uint8Array(170) }); return false; } catch { return true; } })(), "a Token-2022 account without the account type byte is refused");
const req = { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", amount: "100", asset: e(mint), payTo: e(other), maxTimeoutSeconds: 60, extra: { feePayer: e(k(40)) } };
ok((() => { try { checkRequirements({ ...req, extra: { ...req.extra, splits: {} } }); return false; } catch { return true; } })(), "any splits field is refused, not only arrays");
const ag = { pub: spender, sign: async () => new Uint8Array(64) };
const rej = async (o, re) => { try { await x402Payment({ rpc: null, requirements: req, agent: ag, owner: vault, ...o }); return false; } catch (x) { return re.test(x.message); } };
ok(await rej({}, /asset.*maxAmount/), "a payment without the agent's token and per-payment cap is refused");
ok(await rej({ asset: k(41), maxAmount: 1000n }, /not set up to pay with/), "a service asking for another token is refused");
ok(await rej({ asset: mint, maxAmount: 1000n, genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }, /another Solana network/), "a service asking for devnet while the agent is on mainnet is refused");
ok(await rej({ asset: mint, maxAmount: 99n }, /more than the 99/), "the per-payment cap is enforced");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
