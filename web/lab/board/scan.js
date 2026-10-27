try { sessionStorage.setItem("opeq:inside", "1"); } catch {}
import { Rpc, b58decode, isOnCurve, pubkey } from "../../lib/solana.js";
import { KNOWN_MAINNET, TOKEN, TOKEN22, tokenLabel } from "../../lib/tokens.js";

const RPC = "https://rpc.opeq.io";
const PRICE = "https://lite-api.jup.ag/price/v3?ids=";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";
const SHOWN = 6;
const LABELS = 10;

const rpc = new Rpc(RPC);
const $ = (id) => document.getElementById(id);
let last = null;

function parse(text) {
  const s = text.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error("That does not look like a Solana address.");
  let b;
  try { b = b58decode(s); } catch { throw new Error("That does not look like a Solana address."); }
  if (b.length !== 32) throw new Error("That does not look like a Solana address.");
  return { text: s, bytes: b };
}

async function prices(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 50) {
    try {
      const r = await fetch(PRICE + mints.slice(i, i + 50).join(","), { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const j = await r.json();
      for (const [m, v] of Object.entries(j || {})) if (v && typeof v.usdPrice === "number" && isFinite(v.usdPrice)) out.set(m, v.usdPrice);
    } catch {}
  }
  return out;
}

const usd = (v) => "$" + v.toLocaleString("en-US", v >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const units = (amount, decimals) => {
  const n = Number(amount) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 4 : 6 });
};
const shortMint = (m) => m.slice(0, 4) + "…" + m.slice(-4);

async function holdings(addr) {
  const [lamports, accounts] = await Promise.all([rpc.balance(addr), rpc.tokenAccounts(addr)]);
  const byMint = new Map();
  for (const a of accounts) {
    if (a.amount === 0n) continue;
    const k = a.mint;
    const prev = byMint.get(k);
    byMint.set(k, { mint: k, program: a.program, decimals: a.decimals, amount: (prev ? prev.amount : 0n) + a.amount });
  }
  const list = [...byMint.values()];
  const px = await prices([SOL_MINT, ...list.map((t) => t.mint)]);
  const rows = [];
  if (lamports > 0) rows.push({ sym: "SOL", amount: units(lamports, 9), usd: px.has(SOL_MINT) ? (lamports / 1e9) * px.get(SOL_MINT) : null });
  for (const t of list) rows.push({ t, sym: null, amount: units(t.amount, t.decimals), usd: px.has(t.mint) ? (Number(t.amount) / 10 ** t.decimals) * px.get(t.mint) : null });
  rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  for (const r of rows.slice(0, LABELS)) {
    if (!r.t) continue;
    const known = KNOWN_MAINNET.get(pubkey(r.t.mint).join(","));
    if (known) { r.sym = known; continue; }
    try { r.sym = await tokenLabel(rpc, pubkey(r.t.mint), pubkey(r.t.program)); } catch {}
  }
  for (const r of rows) if (!r.sym) r.sym = r.t ? shortMint(r.t.mint) : "SOL";
  const total = rows.reduce((s, r) => s + (r.usd || 0), 0);
  const unpriced = rows.filter((r) => r.usd === null).length;
  return { rows, total, unpriced };
}

function render(kind, title, say, h) {
  const box = $("result");
  box.classList.remove("hidden", "risk", "safe", "plain");
  box.classList.add(kind);
  $("r-tag").textContent = kind === "risk" ? "PUBLIC KEY EXPOSED" : kind === "safe" ? "NO PUBLIC KEY BEHIND THIS ADDRESS" : "TOKEN ACCOUNT";
  $("r-title").textContent = title;
  $("r-say").textContent = say;
  const list = $("r-assets");
  list.textContent = "";
  $("r-more").textContent = "";
  $("r-total").classList.toggle("hidden", !h);
  if (!h) return;
  $("r-usd").textContent = usd(h.total);
  $("r-usd-note").textContent = kind === "risk" ? "behind this public key" : "held by this address";
  for (const r of h.rows.slice(0, SHOWN)) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    const sym = document.createElement("span"); sym.className = "sym"; sym.textContent = r.sym;
    const amt = document.createElement("span"); amt.className = "amt"; amt.textContent = r.amount;
    left.append(sym, amt);
    const right = document.createElement("span"); right.className = "usd"; right.textContent = r.usd === null ? "no price" : usd(r.usd);
    li.append(left, right);
    list.append(li);
  }
  const rest = h.rows.length - SHOWN;
  const notes = [];
  if (rest > 0) notes.push(`and ${rest} more token${rest === 1 ? "" : "s"}`);
  if (h.unpriced) notes.push(`${h.unpriced} without a market price, not counted in the total`);
  if (!h.rows.length) notes.push("This address holds nothing right now.");
  $("r-more").textContent = notes.join(". ").replace(/^and/, "And");
}

async function check(e) {
  e.preventDefault();
  $("err").textContent = "";
  let a;
  try { a = parse($("addr").value); } catch (x) { $("err").textContent = x.message; return; }
  const go = $("go");
  go.disabled = true; go.textContent = "Checking";
  try {
    if (isOnCurve(a.bytes)) {
      const h = await holdings(a.bytes);
      render("risk", "This address is a public key.",
        "Anyone can read it, and a large enough quantum computer could work out the private key from it, then move everything below without your seed phrase. Moving to a hash-based wallet closes that door.", h);
      last = { kind: "risk", total: h.total };
    } else {
      const acc = await rpc.account(a.bytes);
      const owner = acc ? acc.owner.join(",") : null;
      if (owner === TOKEN.join(",") || owner === TOKEN22.join(",")) {
        render("plain", "This is a token account, not a wallet.", "Token accounts belong to a wallet. Paste the wallet address that owns it to see its exposure.", null);
        last = null;
      } else {
        const h = await holdings(a.bytes);
        const sys = !acc || owner === pubkey(SYSTEM).join(",");
        render("safe", "There is no private key behind this address.",
          sys ? "It is a program address, the kind OPEQ wallets use. Coins here move only when the program that controls it says so. In OPEQ that program checks hash-based one-time signatures, which have no public key to break."
              : "It is controlled by a program, not by a key of its own. How safe it is depends on that program and on whoever it accepts signatures from.", h);
        last = { kind: "safe", total: h.total };
      }
    }
  } catch (x) {
    $("err").textContent = "Could not reach Solana right now. Try again in a moment.";
    $("result").classList.add("hidden");
  } finally {
    go.disabled = false; go.textContent = "Check";
  }
}

async function copy() {
  if (!last) return;
  const text = last.kind === "risk"
    ? `My Solana wallet holds ${usd(last.total)} behind a public key that a large quantum computer could break. Check yours: https://opeq.io/scan`
    : `This Solana address has no public key for a quantum computer to break. Check yours: https://opeq.io/scan`;
  try { await navigator.clipboard.writeText(text); $("r-copy").textContent = "Copied"; setTimeout(() => { $("r-copy").textContent = "Copy result"; }, 1600); } catch {}
}

$("probe").addEventListener("submit", check);
$("r-copy").addEventListener("click", copy);
