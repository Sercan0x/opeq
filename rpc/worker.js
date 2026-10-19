const METHODS = new Set([
  "getAccountInfo", "getBalance", "getMultipleAccounts", "getGenesisHash", "getLatestBlockhash", "getMinimumBalanceForRentExemption",
  "getRecentPrioritizationFees", "getSignatureStatuses", "getSlot", "getTokenAccountBalance", "getTokenAccountsByOwner",
  "sendTransaction",
]);
const MAX_BODY = 16384;
const FALLBACK = "https://api.mainnet-beta.solana.com";

function allowedOrigin(origin) {
  if (!origin) return null;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return origin;
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

async function limited(env, ip, method) {
  const send = method === "sendTransaction";
  const key = send ? `send:${ip}` : `read:${ip}`;
  if (localLimited(key, send ? 30 : 300)) return true;
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
    const len = Number(request.headers.get("content-length") || 0);
    if (len > MAX_BODY) return fail(origin, 413, -32600, "request too large");
    const text = await request.text();
    if (text.length > MAX_BODY) return fail(origin, 413, -32600, "request too large");
    let body;
    try { body = JSON.parse(text); } catch { return fail(origin, 400, -32700, "invalid json"); }
    if (!body || Array.isArray(body) || typeof body !== "object") return fail(origin, 400, -32600, "batch requests are not supported");
    const id = typeof body.id === "number" || typeof body.id === "string" ? body.id : null;
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || !METHODS.has(body.method)) return fail(origin, 403, -32601, "method not allowed", id);
    if (body.params !== undefined && !Array.isArray(body.params)) return fail(origin, 400, -32602, "params must be an array", id);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (await limited(env, ip, body.method)) return fail(origin, 429, -32005, "too many requests, slow down", id);
    const out = JSON.stringify({ jsonrpc: "2.0", id, method: body.method, params: body.params || [] });
    let last = null;
    for (const up of upstreams(env)) {
      try {
        const res = await fetch(up, { method: "POST", headers: { "content-type": "application/json" }, body: out });
        if (res.status === 429 || res.status >= 500) { last = res.status; continue; }
        const data = await res.text();
        return new Response(data, { status: res.status, headers: { ...cors(origin), "content-type": "application/json" } });
      } catch {
        last = "network";
      }
    }
    return fail(origin, 502, -32603, `upstream unavailable (${last})`, id);
  },
};
