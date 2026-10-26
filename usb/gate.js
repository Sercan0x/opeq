import { UsbFile, FileStore, LocalArea, LastSeen, watch, info } from "./usbstore.js";

const VOLUME = "usb:volume";
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, text = "") {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function screen() {
  const g = el("div", { id: "usb-gate", role: "dialog", "aria-labelledby": "usb-title" });
  const box = el("div", { class: "usb-box" });
  box.append(
    el("img", { src: "assets/mark.svg", alt: "", class: "usb-mark" }),
    el("h1", { id: "usb-title" }, "OPEQ on USB"),
    el("p", { id: "usb-say" }, "Opening the wallet on your USB stick."),
    el("ul", { id: "usb-list", class: "usb-list hidden" }),
    el("button", { id: "usb-go", class: "usb-btn hidden", type: "button" }, ""),
    el("p", { class: "usb-note" }, "Only plug this stick into computers you trust. A computer with malware can change the OPEQ files on the stick even if you never open OPEQ there. Your 24 words stay the only backup: never copy the data folder to a second place."),
  );
  g.append(box);
  document.body.prepend(g);
  document.body.classList.add("usb-locked");
}

function token() {
  const m = /^#t=([0-9a-f]{64})$/.exec(location.hash);
  if (m) {
    try { sessionStorage.setItem("opeq:t", m[1]); } catch {}
    history.replaceState(null, "", location.pathname);
    return m[1];
  }
  try { return sessionStorage.getItem("opeq:t"); } catch { return null; }
}

function locked(text, danger = false) {
  document.body.classList.add("usb-locked");
  $("usb-gate").classList.remove("hidden");
  $("usb-gate").classList.toggle("usb-danger", danger);
  $("usb-say").textContent = text;
  $("usb-go").classList.add("hidden");
}

function ask(text, label) {
  locked(text);
  const b = $("usb-go");
  b.textContent = label;
  b.classList.remove("hidden");
  b.focus();
  return new Promise((res) => b.addEventListener("click", () => { b.classList.add("hidden"); res(); }, { once: true }));
}

async function boot() {
  screen();
  const t = token();
  if (!t) return locked("Open OPEQ by double-clicking OPEQ on your USB stick.");
  const facts = await info(t);
  if (facts.check === "changed") {
    locked("The OPEQ files on this stick do not match the official release. Someone or something may have changed them. Do not enter your password or your 24 words here. Delete the OPEQ-USB folder except the data folder, copy a fresh OPEQ-USB from the official zip, and put the data folder back.", true);
    const list = $("usb-list");
    for (const f of facts.changed || []) list.append(el("li", {}, f));
    list.classList.toggle("hidden", !list.children.length);
    return;
  }
  if (facts.drive === "fixed") {
    await ask("This OPEQ-USB folder is on this computer's own drive, not on a USB stick, so the wallet would be saved on this computer. Copy the OPEQ-USB folder to a USB stick and double-click OPEQ there, or continue here only to try it out.", "Continue here");
  }
  if (facts.check !== "ok") {
    await ask("OPEQ could not check its files against the official release because opeq.io did not answer. If this stick was plugged into a computer you do not trust, close this window and check it while online first.", "Continue");
  }
  const file = await new UsbFile(t).open();
  const known = file.cache.local[VOLUME];
  if (facts.volume && known && known !== facts.volume) {
    await ask("This wallet folder was last used on a different USB stick. If you copied it, delete every other copy now: two copies of the same wallet can reuse a one-time key and expose your funds. Continue only if this is the only copy left.", "This is the only copy, continue");
  }
  if ((facts.volume && known !== facts.volume) || "opeq:rpc" in file.cache.local) {
    await file.change((d) => {
      if (facts.volume) d.local[VOLUME] = facts.volume;
      delete d.local["opeq:rpc"];
    });
  }
  globalThis.OPEQ_USB = { store: new FileStore(file), local: new LocalArea(file), ls: new LastSeen(file), file };
  watch(file, () => {
    locked("The USB was removed, so the wallet locked. Plug it back in and double-click OPEQ again.");
    setTimeout(() => {
      try { window.close(); } catch {}
      location.replace("about:blank");
    }, 1500);
  });
  $("usb-gate").classList.add("hidden");
  document.body.classList.remove("usb-locked");
  await import("./app.js");
  await import("./activate.js");
}

boot().catch((e) => locked(String((e && e.message) || e)));
