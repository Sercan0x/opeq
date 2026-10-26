(function () {
  const memory = new Map();
  const listeners = [];
  const LOCAL = "opeq.local:";
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const keysOf = (k) => (k == null ? null : typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k));
  const fire = (changes, name) => {
    for (const f of listeners.slice()) {
      try { f(changes, name); } catch (e) { setTimeout(() => { throw e; }); }
    }
  };

  function area(name, read, write, drop, all) {
    return {
      async get(k) {
        const out = {};
        for (const key of keysOf(k) || all()) {
          const v = read(key);
          if (v !== undefined) out[key] = v;
          else if (k && typeof k === "object" && !Array.isArray(k)) out[key] = k[key];
        }
        return out;
      },
      async set(items) {
        const changes = {};
        for (const [key, v] of Object.entries(items)) {
          changes[key] = { oldValue: read(key), newValue: copy(v) };
          write(key, copy(v));
        }
        fire(changes, name);
      },
      async remove(k) {
        const changes = {};
        for (const key of keysOf(k)) {
          const old = read(key);
          if (old === undefined) continue;
          drop(key);
          changes[key] = { oldValue: old };
        }
        if (Object.keys(changes).length) fire(changes, name);
      },
      async setAccessLevel() {},
    };
  }

  const local = area("local",
    (k) => { const s = localStorage.getItem(LOCAL + k); return s == null ? undefined : JSON.parse(s); },
    (k, v) => localStorage.setItem(LOCAL + k, JSON.stringify(v)),
    (k) => localStorage.removeItem(LOCAL + k),
    () => Object.keys(localStorage).filter((x) => x.startsWith(LOCAL)).map((x) => x.slice(LOCAL.length)));
  const session = area("session",
    (k) => copy(memory.get(k)),
    (k, v) => memory.set(k, v),
    (k) => memory.delete(k),
    () => [...memory.keys()]);

  globalThis.chrome = Object.freeze({
    storage: Object.freeze({ local, session, onChanged: Object.freeze({ addListener: (f) => listeners.push(f) }) }),
    alarms: Object.freeze({ create() {}, clear: async () => true }),
  });

  async function supported() {
    try {
      await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      return true;
    } catch {
      return false;
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (await supported()) return;
    const box = document.createElement("div");
    box.className = "usb-block";
    const h = document.createElement("h2");
    h.textContent = "Update your browser";
    const p = document.createElement("p");
    p.textContent = "OPEQ signs with Ed25519 and SHA-256 through Chrome or Edge, and the one on this computer is too old. Update it to version 137 or later, then open OPEQ again.";
    const a = document.createElement("a");
    a.className = "btn btn-solid";
    a.href = "https://www.google.com/chrome/";
    a.textContent = "Get Chrome";
    box.append(h, p, a);
    document.body.replaceChildren(box);
  });
})();
