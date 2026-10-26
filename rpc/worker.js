const METHODS = new Set([
  "getAccountInfo", "getBalance", "getMultipleAccounts", "getGenesisHash", "getLatestBlockhash", "getMinimumBalanceForRentExemption",
  "getRecentPrioritizationFees", "getSignatureStatuses", "getSlot", "getTokenAccountBalance", "getTokenAccountsByOwner",
  "sendTransaction", "simulateTransaction", "getSignaturesForAddress", "getTransaction",
]);
const MAX_BODY = 16384;
const FALLBACK = "https://api.mainnet-beta.solana.com";

function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin === "chrome-extension://ppddghgloaomicpgkpodjenaogmhhijj") return origin;
  if (origin === "http://127.0.0.1:47821") return origin;
  if (origin === "https://opeq.io" || origin === "https://www.opeq.io") return origin;
  return null;
}

function cors(origin) {
  const h = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const ok = allowedOrigin(origin);
  if (ok) {
    h["access-control-allow-origin"] = ok;
    h["access-control-allow-methods"] = "POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type";
    h["access-control-max-age"] = "86400";
    h["vary"] = "origin";
  }
  return h;
}

function fail(origin, status, code, message, id = null) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status, headers: { ...cors(origin), "content-type": "application/json" },
  });
}

function upstreams(env) {
  const list = String(env.UPSTREAM || "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("https://"));
  return list.length ? list : [FALLBACK];
}

const seen = new Map();

function localLimited(key, max) {
  const now = Date.now();
  let e = seen.get(key);
  if (!e || now - e.start > 60000) e = { start: now, n: 0 };
  e.n += 1;
  seen.set(key, e);
  if (seen.size > 5000) for (const [k, v] of seen) if (now - v.start > 60000) seen.delete(k);
  return e.n > max;
}

async function readCapped(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

function ip6(ip) {
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return full.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}

async function limited(env, ip, method) {
  const bucket = ip.includes(":") ? ip6(ip.toLowerCase()) : ip;
  const send = method === "sendTransaction" || method === "simulateTransaction";
  const key = send ? `send:${bucket}` : `read:${bucket}`;
  if (localLimited(key, send ? 30 : 300)) return true;
  if (env.GLOBAL && !(await env.GLOBAL.limit({ key: "all" })).success) return true;
  const binding = send ? env.SEND_LIMIT : env.LIMIT;
  if (!binding) return false;
  const { success } = await binding.limit({ key });
  return !success;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const url = new URL(request.url);
    if (url.pathname !== "/") return fail(origin, 404, -32601, "not found");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return fail(origin, 405, -32600, "use POST");
    if (origin && !allowedOrigin(origin)) return fail(null, 403, -32600, "origin not allowed");
    if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return fail(origin, 415, -32600, "use content-type application/json");
    const len = Number(request.headers.get("content-length") || 0);
    if (len > MAX_BODY) return fail(origin, 413, -32600, "request too large");
    const text = await readCapped(request, MAX_BODY);
    if (text === null) return fail(origin, 413, -32600, "request too large");
    let body;
    try { body = JSON.parse(text); } catch { return fail(origin, 400, -32700, "invalid json"); }
    if (!body || Array.isArray(body) || typeof body !== "object") return fail(origin, 400, -32600, "batch requests are not supported");
    const id = typeof body.id === "number" || typeof body.id === "string" ? body.id : null;
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || !METHODS.has(body.method)) return fail(origin, 403, -32601, "method not allowed", id);
    if (body.params !== undefined && !Array.isArray(body.params)) return fail(origin, 400, -32602, "params must be an array", id);
    if (body.method === "getMultipleAccounts" && !(Array.isArray(body.params?.[0]) && body.params[0].length <= 100)) return fail(origin, 400, -32602, "at most 100 accounts", id);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (await limited(env, ip, body.method)) return fail(origin, 429, -32005, "too many requests, slow down", id);
    const out = JSON.stringify({ jsonrpc: "2.0", id, method: body.method, params: body.params || [] });
    let last = null;
    for (const up of upstreams(env)) {
      try {
        const res = await fetch(up, { method: "POST", headers: { "content-type": "application/json" }, body: out });
        if (res.status === 429 || res.status >= 500) { last = res.status; continue; }
        return new Response(res.body, { status: res.status, headers: { ...cors(origin), "content-type": "application/json" } });
      } catch {
        last = "network";
      }
    }
    return fail(origin, 502, -32603, `upstream unavailable (${last})`, id);
  },
};
