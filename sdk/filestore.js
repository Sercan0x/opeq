import { promises as fs, constants as C, openSync, writeSync, closeSync, readFileSync, unlinkSync, linkSync, lstatSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { checkForward } from "./src/lib/vaultstore.js";

const LOCK = ".lock";
const TAKEOVER = ".takeover";
const NOFOLLOW = C.O_NOFOLLOW || 0;

const name = (id) => createHash("sha256").update(String(id)).digest("hex") + ".json";

const encode = (r) => JSON.stringify(r, (k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
const decode = (s) => JSON.parse(s, (k, v) => (v && typeof v === "object" && Object.keys(v).length === 1 && typeof v.$big === "string" ? BigInt(v.$big) : v));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function readLock(path) {
  try { return readFileSync(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

function pidOf(text) {
  const m = /^(\d+) [0-9a-f]{32}$/.exec(text || "");
  return m ? Number(m[1]) : null;
}

function exclusive(path, text) {
  const fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

function checkDir(dir) {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("the wallet folder must be a real folder, not a link");
  if (typeof process.getuid === "function") {
    if (st.uid !== process.getuid()) throw new Error("the wallet folder belongs to another user");
    if (st.mode & 0o077) throw new Error(`the wallet folder can be read or changed by other users (mode ${(st.mode & 0o777).toString(8)}); run chmod 700 on it`);
  }
}

function takeLock(dir) {
  const path = join(dir, LOCK);
  const mine = `${process.pid} ${randomBytes(16).toString("hex")}`;
  const tmp = join(dir, `.lock-${randomBytes(8).toString("hex")}`);
  exclusive(tmp, mine);
  try {
    try { linkSync(tmp, path); return mine; } catch (e) { if (e.code !== "EEXIST") throw e; }
    const held = readLock(path);
    const pid = pidOf(held);
    if (pid === null || alive(pid)) {
      throw new Error(`another process${pid ? ` (pid ${pid})` : ""} is using this wallet folder; one-time keys must never be used from two places at once`);
    }
    const tk = join(dir, TAKEOVER);
    try { exclusive(tk, mine); } catch (e) {
      if (e.code === "EEXIST") throw new Error(`another process is taking over this wallet folder. If none is running, delete ${tk}`);
      throw e;
    }
    try {
      const again = readLock(path);
      if (again !== held) throw new Error("the wallet folder lock changed while taking it over; try again");
      unlinkSync(path);
      try { linkSync(tmp, path); } catch (e) {
        if (e.code === "EEXIST") throw new Error("another process took this wallet folder first");
        throw e;
      }
      return mine;
    } finally { try { unlinkSync(tk); } catch {} }
  } finally { try { unlinkSync(tmp); } catch {} }
}

export class FileStore {
  static async open(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    checkDir(dir);
    return new FileStore(dir, takeLock(dir));
  }

  constructor(dir, token) {
    if (!token) throw new Error("use FileStore.open(dir)");
    this.dir = dir;
    this.token = token;
    this.lockPath = join(dir, LOCK);
    this.closed = false;
    this.queue = Promise.resolve();
  }

  live() {
    if (this.closed) throw new Error("this wallet store is closed");
    if (readLock(this.lockPath) !== this.token) {
      this.closed = true;
      throw new Error("this process no longer holds the wallet folder lock; stopping before any key is used");
    }
  }

  serial(fn) {
    const run = this.queue.then(() => { this.live(); return fn(); });
    this.queue = run.catch(() => {});
    return run;
  }

  async read(file) {
    let h;
    try { h = await fs.open(join(this.dir, file), C.O_RDONLY | NOFOLLOW); }
    catch (e) { if (e.code === "ENOENT") return null; if (e.code === "ELOOP") throw new Error("a wallet record is a link, refusing to read it"); throw e; }
    try {
      if (!(await h.stat()).isFile()) throw new Error("a wallet record is not a regular file");
      return decode(await h.readFile("utf8"));
    } finally { await h.close(); }
  }

  async all() {
    this.live();
    const out = [];
    for (const f of await fs.readdir(this.dir)) if (/^[0-9a-f]{64}\.json$/.test(f)) { const r = await this.read(f); if (r) out.push(r); }
    return out;
  }

  async get(id) { this.live(); return this.read(name(id)); }

  put(r) {
    this.live();
    return this.serial(async () => {
      const file = name(r.id);
      checkForward(await this.read(file), r);
      const tmp = join(this.dir, `.${randomBytes(12).toString("hex")}.tmp`);
      const h = await fs.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o600);
      try { await h.writeFile(encode(r)); await h.sync(); } finally { await h.close(); }
      try { await fs.rename(tmp, join(this.dir, file)); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
      const d = await fs.open(this.dir, "r");
      try { await d.sync(); } catch {} finally { await d.close(); }
    });
  }

  del(id) {
    this.live();
    return this.serial(async () => { await fs.rm(join(this.dir, name(id)), { force: true }); });
  }

  async close() {
    if (this.closed) return;
    const pending = this.queue;
    this.queue = this.queue.then(() => { throw new Error("this wallet store is closed"); });
    this.queue.catch(() => {});
    await pending;
    this.closed = true;
    if (readLock(this.lockPath) === this.token) { try { unlinkSync(this.lockPath); } catch {} }
  }
}
