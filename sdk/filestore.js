import { promises as fs, constants as C, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkForward } from "./src/lib/vaultstore.js";

const LOCK = ".lock";

const name = (id) => createHash("sha256").update(String(id)).digest("hex") + ".json";

const encode = (r) => JSON.stringify(r, (k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
const decode = (s) => JSON.parse(s, (k, v) => (v && typeof v === "object" && Object.keys(v).length === 1 && typeof v.$big === "string" ? BigInt(v.$big) : v));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function takeLock(dir) {
  const path = join(dir, LOCK);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return path;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
        throw new Error(`another process (pid ${pid}) is using this wallet folder; one-time keys must never be used from two places at once`);
      }
      unlinkSync(path);
    }
  }
  throw new Error("could not lock the wallet folder");
}

export class FileStore {
  static async open(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const s = new FileStore(dir, takeLock(dir));
    return s;
  }

  constructor(dir, lock) {
    if (!lock) throw new Error("use FileStore.open(dir)");
    this.dir = dir;
    this.lockPath = lock;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  live() { if (this.closed) throw new Error("this wallet store is closed"); }

  serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async read(file) {
    try { return decode(await fs.readFile(join(this.dir, file), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  async all() {
    this.live();
    const out = [];
    for (const f of await fs.readdir(this.dir)) if (f.endsWith(".json")) { const r = await this.read(f); if (r) out.push(r); }
    return out;
  }

  async get(id) { this.live(); return this.read(name(id)); }

  put(r) {
    this.live();
    return this.serial(async () => {
      const file = name(r.id);
      checkForward(await this.read(file), r);
      const tmp = join(this.dir, `.${file}.${process.pid}.tmp`);
      const h = await fs.open(tmp, "w", 0o600);
      try { await h.writeFile(encode(r)); await h.sync(); } finally { await h.close(); }
      await fs.rename(tmp, join(this.dir, file));
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
    await this.queue;
    this.closed = true;
    try { unlinkSync(this.lockPath); } catch {}
  }
}
