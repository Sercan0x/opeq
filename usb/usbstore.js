import { checkForward } from "./lib/vaultstore.js";

const KIND = "opeq-usb-wallet";
const IO_LOCK = "opeq:usb-io";
const SESSION_ONLY = new Set(["opeq:rpc"]);

function empty() {
  return { kind: KIND, v: 1, records: {}, local: {} };
}

function parse(text) {
  const damaged = "The wallet file on the USB is damaged. Rename data\\opeq-wallet.json on the stick, open OPEQ again and recover the wallet from its 24 words.";
  if (!text.trim()) throw new Error(damaged);
  let d;
  try { d = JSON.parse(text); } catch { throw new Error(damaged); }
  if (!d || d.kind !== KIND || d.v !== 1 || typeof d.records !== "object" || typeof d.local !== "object") {
    throw new Error("this file is not an OPEQ USB wallet");
  }
  return d;
}

function io(fn) {
  if (!(globalThis.navigator && navigator.locks)) throw new Error("this browser is missing the Web Locks API, which OPEQ needs to write the USB safely");
  return navigator.locks.request(IO_LOCK, { mode: "exclusive" }, fn);
}

export class UsbFile {
  constructor(token) {
    this.token = token;
    this.cache = empty();
  }

  async open() {
    this.cache = await this.read();
    return this;
  }

  async call(method, body) {
    let r;
    try {
      r = await fetch("/api/wallet", { method, cache: "no-store", signal: AbortSignal.timeout(15000), headers: { "x-opeq-token": this.token, ...(body ? { "content-type": "application/json" } : {}) }, body });
    } catch {
      throw new Error("the USB stopped answering; plug it back in and open OPEQ again");
    }
    if (r.status === 410) throw new Error("the USB was removed");
    if (!r.ok) throw new Error(`the USB refused the request (${r.status})`);
    return r;
  }

  async read() {
    const r = await this.call("GET");
    if (r.status === 204) return empty();
    return parse(await r.text());
  }

  async write(d) {
    await this.call("PUT", JSON.stringify(d));
    this.cache = d;
  }

  change(fn) {
    return io(async () => {
      const d = await this.read();
      fn(d);
      await this.write(d);
    });
  }

  async alive() {
    try {
      const r = await fetch("/api/alive", { cache: "no-store", signal: AbortSignal.timeout(4000), headers: { "x-opeq-token": this.token } });
      return r.ok;
    } catch {
      return false;
    }
  }
}

export class FileStore {
  constructor(file) { this.file = file; }

  async all() {
    const d = await this.file.read();
    return Object.values(d.records).map((r) => structuredClone(r));
  }

  async get(id) {
    const d = await this.file.read();
    return d.records[id] ? structuredClone(d.records[id]) : null;
  }

  put(r) {
    return this.file.change((d) => {
      checkForward(d.records[r.id], r);
      d.records[r.id] = structuredClone(r);
    });
  }

  del(id) {
    return this.file.change((d) => { delete d.records[id]; });
  }
}

export class LocalArea {
  constructor(file) {
    this.file = file;
    this.session = new Map();
  }

  async get(keys) {
    const d = await this.file.read();
    const list = keys == null ? Object.keys(d.local) : Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) {
      if (SESSION_ONLY.has(k)) { if (this.session.has(k)) out[k] = structuredClone(this.session.get(k)); }
      else if (k in d.local) out[k] = structuredClone(d.local[k]);
    }
    return out;
  }

  async set(items) {
    const kept = {};
    for (const [k, v] of Object.entries(items)) {
      if (SESSION_ONLY.has(k)) this.session.set(k, structuredClone(v)); else kept[k] = v;
    }
    if (Object.keys(kept).length) await this.file.change((d) => { Object.assign(d.local, structuredClone(kept)); });
  }

  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.session.delete(k);
    await this.file.change((d) => { for (const k of list) delete d.local[k]; });
  }
}

export async function info(token) {
  const r = await fetch("/api/info", { cache: "no-store", signal: AbortSignal.timeout(8000), headers: { "x-opeq-token": token } });
  if (!r.ok) throw new Error("the USB did not answer; close this window and double-click OPEQ again");
  return r.json();
}

export class LastSeen {
  constructor(file) { this.file = file; }
  getItem(k) { const v = this.file.cache.local["ls:" + k]; return typeof v === "string" ? v : null; }
  setItem(k, v) { this.file.change((d) => { d.local["ls:" + k] = String(v); }).catch(() => {}); }
  removeItem(k) { this.file.change((d) => { delete d.local["ls:" + k]; }).catch(() => {}); }
}

export function watch(file, onGone, every = 1500) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (!(await file.alive())) { stopped = true; onGone(); return; }
    setTimeout(tick, every);
  };
  setTimeout(tick, every);
  return () => { stopped = true; };
}
