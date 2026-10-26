import { NET } from "./net.js";

const $ = (id) => document.getElementById(id);
const READY = 10000000;
const EVERY = 6000;

const sol = (lamports) => (lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

async function balance(address) {
  const r = await fetch(NET.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address, { commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!j.result || typeof j.result.value !== "number") throw new Error("no balance");
  return j.result.value;
}

async function tick() {
  const box = $("w-init-box"), wait = $("i-wait"), go = $("w-init");
  const address = $("i-addr").textContent.trim();
  if (box && wait && go && !box.classList.contains("hidden") && address && !document.hidden) {
    try {
      const b = await balance(address);
      const ready = b >= READY;
      wait.textContent = ready
        ? `${sol(b)} SOL arrived. Press Activate.`
        : b > 0
          ? `${sol(b)} SOL arrived so far. Send at least 0.01 SOL in total.`
          : "Waiting for SOL to arrive at the activation address. This page checks every few seconds.";
      wait.classList.toggle("act-ok", ready);
      go.classList.toggle("act-ready", ready);
    } catch {
      wait.textContent = "Could not check the balance right now. It will try again in a few seconds.";
    }
  }
  setTimeout(tick, EVERY);
}

tick();
