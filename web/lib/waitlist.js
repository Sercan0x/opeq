const KEY = "opeq:waitlist";
const FOLLOW = "opeqio";
const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const POST = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;
const $ = (id) => document.getElementById(id);

function postText() {
  return `I just joined the waitlist for @${FOLLOW}, a Solana wallet that quantum computers can't break.\n\nSame address, works with every app.\n\n${location.origin}`;
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const handle = typeof s.handle === "string" && HANDLE.test(s.handle) ? s.handle.replace(/^@/, "") : "";
    const url = typeof s.url === "string" && POST.test(s.url) ? s.url : "";
    return { handle, url: handle && url ? url : "", joined: s.joined === true };
  } catch {
    return { handle: "", url: "", joined: false };
  }
}

function persist(st) {
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {}
}

function checkHandle(raw) {
  const m = HANDLE.exec(raw.trim());
  if (!m) throw new Error("Enter your X username, like @satoshi.");
  if (m[1].toLowerCase() === FOLLOW) throw new Error("Enter your own X username, not ours.");
  return m[1];
}

function checkPost(raw, handle) {
  const m = POST.exec(raw.trim());
  if (!m) throw new Error("Paste the link to your post. It looks like x.com/you/status/123...");
  if (m[1].toLowerCase() !== handle.toLowerCase()) throw new Error(`This post is from @${m[1]}, but your username is @${handle}.`);
  return `https://x.com/${m[1].toLowerCase()}/status/${m[2]}`;
}

export function initWaitlist() {
  const text = postText();
  $("wl-quote").textContent = text;
  $("wl-post-link").href = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  const st = load();
  const edit = { follow: false, post: false };

  const step = (id, { locked, done }) => {
    $(id).classList.toggle("wl-locked", locked);
    $(id).classList.toggle("is-done", done);
    $(id).toggleAttribute("inert", locked);
  };

  const render = () => {
    const followed = !!st.handle && !edit.follow;
    const posted = followed && !!st.url && !edit.post;
    step("wl-s1", { locked: false, done: followed });
    step("wl-s2", { locked: !followed, done: posted });
    step("wl-s3", { locked: !posted, done: st.joined });
    $("wl-follow-form").classList.toggle("hidden", followed);
    $("wl-followed").classList.toggle("hidden", !followed);
    $("wl-handle-out").textContent = st.handle ? `@${st.handle}` : "";
    $("wl-post-form").classList.toggle("hidden", posted);
    $("wl-posted").classList.toggle("hidden", !posted);
    if (st.url) $("wl-post-out").href = st.url;
    $("wl-form").classList.toggle("hidden", st.joined);
    $("wl-joined").classList.toggle("hidden", !st.joined);
    $("wl-handle-edit").classList.toggle("hidden", st.joined);
    $("wl-url-edit").classList.toggle("hidden", st.joined);
    $("wl-all").classList.toggle("hidden", !st.joined);
  };

  const onEnter = (input, fn) => $(input).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fn(); } });

  const saveHandle = () => {
    $("wl-handle-err").textContent = "";
    try {
      const h = checkHandle($("wl-handle").value);
      if (st.url && POST.exec(st.url)[1].toLowerCase() !== h.toLowerCase()) st.url = "";
      st.handle = h;
      edit.follow = false;
      persist(st);
      render();
      if (!st.url) $("wl-url").focus();
    } catch (e) {
      $("wl-handle-err").textContent = e.message;
    }
  };

  const saveUrl = () => {
    $("wl-url-err").textContent = "";
    try {
      st.url = checkPost($("wl-url").value, st.handle);
      edit.post = false;
      persist(st);
      render();
      $("wl-email").focus();
    } catch (e) {
      $("wl-url-err").textContent = e.message;
    }
  };

  $("wl-handle-save").addEventListener("click", saveHandle);
  onEnter("wl-handle", saveHandle);
  $("wl-url-save").addEventListener("click", saveUrl);
  onEnter("wl-url", saveUrl);
  $("wl-handle-edit").addEventListener("click", () => { edit.follow = true; $("wl-handle").value = st.handle; render(); $("wl-handle").focus(); });
  $("wl-url-edit").addEventListener("click", () => { edit.post = true; $("wl-url").value = st.url; render(); $("wl-url").focus(); });

  $("wl-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("wl-join");
    $("wl-err").textContent = "";
    const email = $("wl-email").value.trim();
    if (!EMAIL.test(email)) { $("wl-err").textContent = "Enter a valid email address."; return; }
    btn.disabled = true;
    try {
      let res;
      try {
        res = await fetch("/api/waitlist/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: st.handle, url: st.url, email, company: $("wl-company").value }) });
      } catch {
        throw new Error("Can't reach the server. Check your connection and try again.");
      }
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        const e = new Error(data.error || "Something went wrong. Try again.");
        e.step = data.step;
        throw e;
      }
      st.joined = true;
      persist(st);
      render();
    } catch (e) {
      if (e.step === "follow") { edit.follow = true; $("wl-handle").value = st.handle; render(); $("wl-handle-err").textContent = e.message; }
      else if (e.step === "post") { edit.post = true; $("wl-url").value = st.url; render(); $("wl-url-err").textContent = e.message; }
      else $("wl-err").textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("wl-handle").value = st.handle;
  $("wl-url").value = st.url;
  render();
  return () => {};
}
