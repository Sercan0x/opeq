import { hex, unhex } from "./lib/solana.js";

const KEY = "opeq:session";
const area = () => (globalThis.chrome && chrome.storage && chrome.storage.session) || null;
const IDLE = 10 * 60 * 1000;

try { area() && area().setAccessLevel && area().setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); } catch {}

export async function save(id, master, macRaw) {
  const s = area();
  if (!s || !macRaw) return;
  await s.set({ [KEY]: { id, master: hex(master), mac: hex(macRaw), seen: Date.now() } });
}

export async function touch() {
  const s = area();
  if (!s) return;
  const v = (await s.get(KEY))[KEY];
  if (!v) return;
  if (Date.now() - v.seen > IDLE) { await s.remove(KEY); return; }
  v.seen = Date.now();
  await s.set({ [KEY]: v });
}

export async function load(maxIdle) {
  const s = area();
  if (!s) return null;
  const v = (await s.get(KEY))[KEY];
  if (!v) return null;
  if (Date.now() - v.seen > maxIdle) { await s.remove(KEY); return null; }
  return { id: v.id, master: unhex(v.master), macRaw: unhex(v.mac) };
}

export async function clear() {
  const s = area();
  if (s) await s.remove(KEY);
}
