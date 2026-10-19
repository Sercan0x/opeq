import { hex, unhex } from "./lib/solana.js";

const KEY = "opeq:session";
const SEEN = "opeq:seen";
const area = () => (globalThis.chrome && chrome.storage && chrome.storage.session) || null;
const IDLE = 10 * 60 * 1000;

try { area() && area().setAccessLevel && area().setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); } catch {}

export async function save(id, master, macRaw) {
  const s = area();
  if (!s || !macRaw) return;
  await s.set({ [KEY]: { id, master: hex(master), mac: hex(macRaw) }, [SEEN]: Date.now() });
  try { chrome.alarms && chrome.alarms.create("opeq-idle", { periodInMinutes: 1 }); } catch {}
}

export async function touch() {
  const s = area();
  if (!s) return;
  const v = await s.get([KEY, SEEN]);
  if (!v[KEY]) return;
  if (!(Date.now() - v[SEEN] <= IDLE)) { await s.remove([KEY, SEEN]); return; }
  await s.set({ [SEEN]: Date.now() });
}

export async function load(maxIdle) {
  const s = area();
  if (!s) return null;
  const all = await s.get([KEY, SEEN]);
  const v = all[KEY];
  if (!v) return null;
  if (!(Date.now() - all[SEEN] <= maxIdle)) { await s.remove([KEY, SEEN]); return null; }
  return { id: v.id, master: unhex(v.master), macRaw: unhex(v.mac) };
}

export async function clear() {
  const s = area();
  if (s) await s.remove([KEY, SEEN]);
}
