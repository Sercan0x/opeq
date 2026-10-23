const FOLLOW = "opeqio";
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;
const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const POST = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/;
const JOINS_PER_HOUR = 20;

class Fail extends Error {
  constructor(status, message, step) {
    super(message);
    this.status = status;
    this.step = step;
  }
}

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
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

function ipKey(ip) {
  ip = (ip || "").trim().toLowerCase();
  return ip.includes(":") ? ip6(ip) : ip;
}

function sameHost(origin, url) {
  try {
    return new URL(origin).host === new URL(url).host;
  } catch {
    return false;
  }
}

function check(body) {
  const h = HANDLE.exec(String(body.handle || "").trim());
  if (!h) throw new Fail(400, "Enter your X username, like @satoshi.", "follow");
  const handle = h[1];
  if (handle.toLowerCase() === FOLLOW) throw new Fail(400, "Enter your own X username, not ours.", "follow");
  const p = POST.exec(String(body.url || "").trim());
  if (!p) throw new Fail(400, "Paste the link to your post. It looks like x.com/you/status/123...", "post");
  const [, author, sid] = p;
  if (author.toLowerCase() !== handle.toLowerCase()) throw new Fail(400, `This post is from @${author}, but your username is @${handle}.`, "post");
  const email = String(body.email || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new Fail(400, "Enter a valid email address.", "email");
  return { handle, url: `https://x.com/${author.toLowerCase()}/status/${sid}`, email };
}

async function join(env, body, ip) {
  if (body.company) throw new Fail(400, "Something went wrong. Try again.", "email");
  const { handle, url, email } = check(body);
  const ipHash = await sha(env.SALT + ipKey(ip));
  const now = Math.floor(Date.now() / 1000);
  const since = now - 3600;
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE ip_hash = ? AND created_at > ?").bind(ipHash, since).first();
  if (recent.n >= JOINS_PER_HOUR) throw new Fail(429, "Too many sign-ups from this network. Try again in an hour.", "email");
  if (await env.DB.prepare("SELECT 1 FROM waitlist WHERE email = ?").bind(email).first()) return { ok: true };
  if (await env.DB.prepare("SELECT 1 FROM waitlist WHERE post_url = ?").bind(url).first()) throw new Fail(409, "This post is already used by another sign-up.", "post");
  try {
    const res = await env.DB
      .prepare("INSERT INTO waitlist (email, x_handle, post_url, ip_hash, created_at) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM waitlist WHERE ip_hash = ? AND created_at > ?) < ?")
      .bind(email, handle, url, ipHash, now, ipHash, since, JOINS_PER_HOUR)
      .run();
    if (!res.meta.changes) throw new Fail(429, "Too many sign-ups from this network. Try again in an hour.", "email");
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail(409, "This email or post is already on the list.", "email");
  }
  return { ok: true };
}

function same(a, b) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function api(request, env, name) {
  if (request.method === "GET" && name === "export") {
    if (!env.ADMIN || !same(request.headers.get("Authorization") || "", `Bearer ${env.ADMIN}`)) return json(401, { error: "unauthorized" });
    const { results } = await env.DB.prepare("SELECT id, email, x_handle, post_url, created_at FROM waitlist ORDER BY id").all();
    return json(200, results);
  }
  if (request.method !== "POST" || name !== "join") return json(404, { error: "not found" });
  const origin = request.headers.get("Origin");
  if (origin && !sameHost(origin, request.url)) return json(403, { error: "Requests from other sites are not allowed." });
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (env.JOIN_LIMIT && !(await env.JOIN_LIMIT.limit({ key: ipKey(ip) })).success) return json(429, { error: "Too many attempts from this network. Try again in a minute." });
  const raw = await readCapped(request, 2048);
  if (raw === null) return json(413, { error: "Request too large." });
  let body;
  try {
    body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw 0;
  } catch {
    return json(400, { error: "Bad request." });
  }
  try {
    return json(200, await join(env, body, ip));
  } catch (e) {
    if (e instanceof Fail) return json(e.status, { error: e.message, step: e.step });
    return json(500, { error: "Something went wrong. Try again." });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/waitlist/")) return api(request, env, url.pathname.slice("/api/waitlist/".length));
    if (url.pathname === "/waitlist.html" || url.pathname === "/waitlist") return Response.redirect(`${url.origin}/`, 301);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
