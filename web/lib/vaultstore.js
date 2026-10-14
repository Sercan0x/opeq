import { hex, unhex } from "./solana.js";

const PBKDF2_ITER = 600000;
const enc = new TextEncoder();
const AAD = enc.encode("opeq/web-vault/v1");

function canonical(x) {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (x && typeof x === "object") {
    return "{" + Object.keys(x).filter((k) => k !== "mac").sort().map((k) => JSON.stringify(k) + ":" + canonical(x[k])).join(",") + "}";
  }
  return JSON.stringify(x);
}

export function macKeyFrom(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function deriveKeys(password, salt, iter) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, 512));
  const aes = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const macRaw = bits.slice(32);
  const mac = await macKeyFrom(macRaw);
  bits.fill(0);
  return { aes, mac, macRaw };
}

export async function seal(master, password, aid) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keys = await deriveKeys(password, salt, PBKDF2_ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array([...aid, ...AAD]) }, keys.aes, master));
  return { blob: { kdf: "pbkdf2-sha256", iter: PBKDF2_ITER, salt: hex(salt), iv: hex(iv), ct: hex(ct) }, macKey: keys.mac, macRaw: keys.macRaw };
}

export async function unlock(blob, password, aid) {
  if (blob.kdf !== "pbkdf2-sha256" || blob.iter < 100000 || blob.iter > 10000000) throw new Error("unknown wallet encryption format");
  const keys = await deriveKeys(password, unhex(blob.salt), blob.iter);
  try {
    const master = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(blob.iv), additionalData: new Uint8Array([...aid, ...AAD]) }, keys.aes, unhex(blob.ct)));
    return { master, macKey: keys.mac, macRaw: keys.macRaw };
  } catch {
    throw new Error("wrong password");
  }
}

export async function signRecord(macKey, record) {
  record.mac = hex(new Uint8Array(await crypto.subtle.sign("HMAC", macKey, enc.encode(canonical(record)))));
  return record;
}

export async function checkRecord(macKey, record) {
  const ok = await crypto.subtle.verify("HMAC", macKey, unhex(record.mac || "00"), enc.encode(canonical(record)));
  if (!ok) throw new Error("wallet record was modified outside opeq, refusing to sign");
}

export function checkForward(old, r) {
  if (!old) return;
  if (r.epoch < old.epoch || (r.epoch === old.epoch && r.next_leaf < old.next_leaf)) {
    throw new Error("refusing to move the one-time key counter backwards");
  }
}

export class MemoryStore {
  constructor() { this.m = new Map(); }
  async all() { return [...this.m.values()].map((r) => structuredClone(r)); }
  async get(id) { return this.m.has(id) ? structuredClone(this.m.get(id)) : null; }
  async put(r) { checkForward(this.m.get(r.id), r); this.m.set(r.id, structuredClone(r)); }
  async del(id) { this.m.delete(id); }
}

export class IdbStore {
  constructor(name = "opeq") { this.name = name; }

  db() {
    if (!this._db) {
      this._db = new Promise((res, rej) => {
        const req = indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("vaults", { keyPath: "id" });
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    }
    return this._db;
  }

  async tx(mode, fn) {
    const db = await this.db();
    return new Promise((res, rej) => {
      const t = mode === "readwrite" ? db.transaction("vaults", mode, { durability: "strict" }) : db.transaction("vaults", mode);
      const out = fn(t.objectStore("vaults"));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("wallet storage write was aborted"));
    });
  }

  all() { return this.tx("readonly", (s) => s.getAll()); }
  get(id) { return this.tx("readonly", (s) => s.get(id)).then((r) => r || null); }
  async put(r) {
    const db = await this.db();
    return new Promise((res, rej) => {
      const t = db.transaction("vaults", "readwrite", { durability: "strict" });
      const s = t.objectStore("vaults");
      let refused = null;
      const g = s.get(r.id);
      g.onsuccess = () => {
        try { checkForward(g.result, r); s.put(r); } catch (e) { refused = e; t.abort(); }
      };
      t.oncomplete = () => res();
      t.onerror = () => rej(refused || t.error);
      t.onabort = () => rej(refused || t.error || new Error("wallet storage write was aborted"));
    });
  }
  del(id) { return this.tx("readwrite", (s) => s.delete(id)); }
}

export async function withLock(name, fn, { wait = false } = {}) {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(name, { mode: "exclusive", ifAvailable: !wait }, async (lock) => {
      if (!lock) throw new Error("this wallet is busy in another tab, finish there first");
      return fn();
    });
  }
  if (typeof document !== "undefined") {
    throw new Error("this browser is missing the Web Locks API, which opeq needs to sign safely; use an up-to-date browser");
  }
  return fn();
}
