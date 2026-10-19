import { sha256 } from "./sha256.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const enc = new TextEncoder();

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return new Uint8Array(out);
}

export function pubkey(s) {
  const b = b58decode(s);
  if (b.length !== 32) throw new Error(`not a 32 byte address: ${s}`);
  return b;
}

export const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

const P = (1n << 255n) - 19n;
function modpow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
const D = ((-121665n * modpow(121666n, P - 2n, P)) % P + P) % P;

export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y = (y & ((1n << 255n) - 1n)) % P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  if (v === 0n) return false;
  const x2 = (u * modpow(v, P - 2n, P)) % P;
  return x2 === 0n || modpow(x2, (P - 1n) / 2n, P) === 1n;
}

export function findPda(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(...seeds, new Uint8Array([bump]), program, enc.encode("ProgramDerivedAddress"));
    if (!isOnCurve(h)) return { key: h, bump };
  }
  throw new Error("no program address found");
}

export function compact(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (n) out.push(b | 0x80);
    else { out.push(b); return out; }
  }
}

export function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
export function u64(v) {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << 64n) throw new Error("value out of u64 range");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export const SYSTEM = new Uint8Array(32);
export const COMPUTE_BUDGET = pubkey("ComputeBudget111111111111111111111111111111");

export function compileV0(payer, ixs, blockhash, tables = []) {
  const key = (k) => b58encode(k);
  const metas = new Map([[key(payer), { k: payer, s: true, w: true }]]);
  const order = [key(payer)];
  const programs = new Set();
  for (const [prog, accs] of ixs) {
    for (const [k, s, w] of accs) {
      const id = key(k);
      if (metas.has(id)) { const m = metas.get(id); m.s ||= s; m.w ||= w; }
      else { metas.set(id, { k, s, w }); order.push(id); }
    }
    programs.add(key(prog));
    if (!metas.has(key(prog))) { metas.set(key(prog), { k: prog, s: false, w: false }); order.push(key(prog)); }
  }
  const where = new Map();
  tables.forEach((t, ti) => t.addresses.forEach((a, i) => { if (!where.has(key(a))) where.set(key(a), [ti, i]); }));
  const isStatic = (id) => metas.get(id).s || programs.has(id) || !where.has(id);
  const rank = (id) => (id === key(payer) ? 0 : 1) * 4 + (metas.get(id).s ? 0 : 2) + (metas.get(id).w ? 0 : 1);
  const statics = order.filter(isStatic).sort((a, b) => rank(a) - rank(b) || order.indexOf(a) - order.indexOf(b));
  const loaded = order.filter((id) => !isStatic(id));
  const lookups = [], loadedW = [], loadedR = [];
  tables.forEach((t, ti) => {
    const wi = loaded.filter((id) => where.get(id)[0] === ti && metas.get(id).w);
    const ri = loaded.filter((id) => where.get(id)[0] === ti && !metas.get(id).w);
    if (wi.length || ri.length) {
      lookups.push([t.key, wi.map((id) => where.get(id)[1]), ri.map((id) => where.get(id)[1])]);
      loadedW.push(...wi);
      loadedR.push(...ri);
    }
  });
  const all = [...statics, ...loadedW, ...loadedR];
  const idx = new Map(all.map((k, i) => [k, i]));
  const nsig = statics.filter((k) => metas.get(k).s).length;
  const roSigned = statics.filter((k) => metas.get(k).s && !metas.get(k).w).length;
  const roUnsigned = statics.filter((k) => !metas.get(k).s && !metas.get(k).w).length;
  const body = [new Uint8Array([0x80, nsig, roSigned, roUnsigned, ...compact(statics.length)]), ...statics.map((k) => metas.get(k).k), blockhash, new Uint8Array(compact(ixs.length))];
  for (const [prog, accs, data] of ixs) {
    body.push(new Uint8Array([idx.get(key(prog)), ...compact(accs.length), ...accs.map((a) => idx.get(key(a[0]))), ...compact(data.length)]));
    body.push(data);
  }
  body.push(new Uint8Array(compact(lookups.length)));
  for (const [t, wi, ri] of lookups) body.push(t, new Uint8Array([...compact(wi.length), ...wi, ...compact(ri.length), ...ri]));
  return { message: concat(...body), signers: statics.slice(0, nsig) };
}

export function unsignedTx(message, nsig) {
  return concat(new Uint8Array(compact(nsig)), new Uint8Array(64 * nsig), message);
}

export class Rpc {
  constructor(url) { this.url = url; this.id = 0; }

  async call(method, params = []) {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      let res;
      try {
        res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: ctl.signal,
        });
      } catch (e) {
        if (method !== "sendTransaction" && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
        throw new Error(`network error talking to the RPC (${method})`);
      } finally {
        clearTimeout(timer);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const j = await res.json();
      if (j.error) {
        const e = new Error(String(j.error.message || "RPC error").slice(0, 200));
        const logs = j.error.data && j.error.data.logs;
        e.data = { logs: Array.isArray(logs) ? logs.filter((l) => typeof l === "string").slice(0, 60) : [] };
        e.fromRpc = true;
        throw e;
      }
      return j.result;
    }
  }

  async account(k) {
    const v = (await this.call("getAccountInfo", [b58encode(k), { encoding: "base64", commitment: "confirmed" }])).value;
    if (!v) return null;
    return { owner: pubkey(v.owner), lamports: v.lamports, executable: v.executable === true, data: Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0)) };
  }

  async balance(k) { return (await this.call("getBalance", [b58encode(k), { commitment: "confirmed" }])).value; }
  async slot() { return this.call("getSlot", [{ commitment: "confirmed" }]); }
  async blockhash() { return b58decode((await this.call("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash); }
  async rent(size) { return this.call("getMinimumBalanceForRentExemption", [size]); }

  async lookupTable(addr) {
    const acc = await this.account(addr);
    if (!acc) throw new Error("lookup table not found");
    if (b58encode(acc.owner) !== "AddressLookupTab1e1111111111111111111111111") throw new Error("account is not an address lookup table");
    const addresses = [];
    for (let o = 56; o + 32 <= acc.data.length; o += 32) addresses.push(acc.data.slice(o, o + 32));
    return { key: addr, addresses };
  }

  async tokenAccounts(owner) {
    const out = [];
    for (const prog of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
      const r = await this.call("getTokenAccountsByOwner", [b58encode(owner), { programId: prog }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const a of Array.isArray(r && r.value) ? r.value.slice(0, 200) : []) {
        try {
          const info = a.account.data.parsed.info;
          const amt = info.tokenAmount.amount, dec = info.tokenAmount.decimals;
          if (typeof amt !== "string" || !/^\d{1,20}$/.test(amt) || !Number.isInteger(dec) || dec < 0 || dec > 18) continue;
          if (BigInt(amt) >= 1n << 64n) continue;
          pubkey(a.pubkey); pubkey(info.mint);
          out.push({ account: a.pubkey, program: prog, mint: info.mint, amount: BigInt(amt), decimals: dec });
        } catch {}
      }
    }
    return out;
  }

  async tokenAmount(acc) {
    const amt = (await this.call("getTokenAccountBalance", [b58encode(acc), { commitment: "confirmed" }])).value.amount;
    if (typeof amt !== "string" || !/^\d{1,20}$/.test(amt)) throw new Error("the RPC returned an invalid token amount");
    return BigInt(amt);
  }

  async sendRaw(tx) {
    const b64 = btoa(String.fromCharCode(...tx));
    return this.call("sendTransaction", [b64, { encoding: "base64", preflightCommitment: "confirmed" }]);
  }

  async status(sig) {
    return (await this.call("getSignatureStatuses", [[sig], { searchTransactionHistory: true }])).value[0];
  }
}
