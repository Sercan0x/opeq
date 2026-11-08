const held = new Map();

function request(name, opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const ifAvailable = !!(opts && opts.ifAvailable);
  const prev = held.get(name);
  if (prev && ifAvailable) return Promise.resolve().then(() => fn(null));
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = (prev || Promise.resolve()).then(() => mine);
  held.set(name, chain);
  const run = (prev || Promise.resolve()).then(() => fn({ name, mode: "exclusive" }));
  return run.finally(() => {
    release();
    if (held.get(name) === chain) held.delete(name);
  });
}

export function installLocks() {
  if (typeof navigator !== "undefined" && navigator.locks) return false;
  const locks = Object.freeze({ request });
  if (typeof navigator === "undefined") {
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true, writable: false });
  } else {
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true, writable: false });
  }
  return true;
}
