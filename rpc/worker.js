const METHODS = new Set([
  "getAccountInfo", "getBalance", "getMultipleAccounts", "getGenesisHash", "getLatestBlockhash", "getMinimumBalanceForRentExemption",
  "getRecentPrioritizationFees", "getSignatureStatuses", "getSlot", "getTokenAccountBalance", "getTokenAccountsByOwner",
  "sendTransaction", "simulateTransaction", "getSignaturesForAddress", "getTransaction",
]);
const EVM_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode", "eth_call", "eth_estimateGas", "eth_getTransactionCount",
  "eth_sendRawTransaction", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_maxPriorityFeePerGas", "eth_gasPrice",
]);
const EVM_SEND = new Set(["eth_sendRawTransaction", "eth_estimateGas"]);
const EVM_CALL = new Set(["eth_call"]);
const NO_RETRY = new Set(["eth_call", "eth_estimateGas"]);
const EVM_DEFAULT = {
  1: ["https://ethereum-rpc.publicnode.com"],
  8453: ["https://mainnet.base.org"],
  42161: ["https://arb1.arbitrum.io/rpc"],
  4663: ["https://rpc.mainnet.chain.robinhood.com"],
};
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

function evmUpstreams(env, chain) {
  let custom = {};
  try { custom = JSON.parse(env.EVM_UPSTREAM || "{}"); } catch {}
  const list = (Array.isArray(custom[chain]) ? custom[chain] : []).filter((s) => typeof s === "string" && s.startsWith("https://"));
  return list.length ? list : EVM_DEFAULT[chain] || [];
}

function evmParamsOk(method, p) {
  if (method === "eth_getBlockByNumber") return p.length === 2 && typeof p[0] === "string" && p[1] === false;
  if (method === "eth_call" || method === "eth_estimateGas") return p.length >= 1 && p.length <= 2 && p[0] && typeof p[0] === "object" && !Array.isArray(p[0]) && (p.length === 1 || typeof p[1] === "string");
  if (method === "eth_sendRawTransaction" || method === "eth_getTransactionReceipt") return p.length === 1 && typeof p[0] === "string";
  if (method === "eth_getBalance" || method === "eth_getCode" || method === "eth_getTransactionCount") return p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string";
  return p.length === 0;
}

function upstreams(env) {
  const list = String(env.UPSTREAM || "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("https://"));
  return list.length ? list : [FALLBACK];
}

const seen = new Map();
let pruned = 0;

function localLimited(key, max) {
  const now = Date.now();
  let e = seen.get(key);
  if (!e || now - e.start > 60000) e = { start: now, n: 0 };
  e.n += 1;
  seen.set(key, e);
  if (seen.size > 5000 && now - pruned > 10000) {
    pruned = now;
    for (const [k, v] of seen) if (now - v.start > 60000) seen.delete(k);
    if (seen.size > 20000) seen.clear();
  }
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
  return full.slice(0, 3).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/48";
}

async function limited(env, ip, method, evm) {
  const bucket = ip.includes(":") ? ip6(ip.toLowerCase()) : ip;
  const send = method === "sendTransaction" || method === "simulateTransaction" || EVM_SEND.has(method);
  const key = send ? `send:${bucket}` : `read:${bucket}`;
  if (localLimited(key, send ? 30 : 300)) return true;
  if (EVM_CALL.has(method) && localLimited(`call:${bucket}`, 120)) return true;
  const binding = send ? env.SEND_LIMIT : env.LIMIT;
  if (binding && !(await binding.limit({ key })).success) return true;
  if (env.GLOBAL && !(await env.GLOBAL.limit({ key: evm ? "evm" : "sol" })).success) return true;
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const url = new URL(request.url);
    const evm = /^\/evm\/(\d{1,10})$/.exec(url.pathname);
    if (url.pathname !== "/" && !evm) return fail(origin, 404, -32601, "not found");
    if (evm && !evmUpstreams(env, evm[1]).length) return fail(origin, 404, -32601, "network not served");
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
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || !(evm ? EVM_METHODS : METHODS).has(body.method)) return fail(origin, 403, -32601, "method not allowed", id);
    if (body.params !== undefined && !Array.isArray(body.params)) return fail(origin, 400, -32602, "params must be an array", id);
    if (evm && !evmParamsOk(body.method, body.params || [])) return fail(origin, 400, -32602, "params not allowed", id);
    if (body.method === "getMultipleAccounts" && !(Array.isArray(body.params?.[0]) && body.params[0].length <= 100)) return fail(origin, 400, -32602, "at most 100 accounts", id);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (await limited(env, ip, body.method, !!evm)) return fail(origin, 429, -32005, "too many requests, slow down", id);
    const out = JSON.stringify({ jsonrpc: "2.0", id, method: body.method, params: body.params || [] });
    let last = null;
    for (const up of evm ? evmUpstreams(env, evm[1]) : upstreams(env)) {
      try {
        const res = await fetch(up, { method: "POST", headers: { "content-type": "application/json" }, body: out });
        if ((res.status === 429 || res.status >= 500) && !NO_RETRY.has(body.method)) { last = res.status; continue; }
        return new Response(res.body, { status: res.status, headers: { ...cors(origin), "content-type": "application/json" } });
      } catch {
        last = "network";
      }
    }
    return fail(origin, 502, -32603, `upstream unavailable (${last})`, id);
  },
};
