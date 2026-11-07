const rows = [];

export function plain(v, decimals, max = decimals) {
  const d = Math.max(0, Math.min(decimals, 36));
  const s = (v < 0n ? 0n : v).toString().padStart(d + 1, "0");
  const whole = s.slice(0, s.length - d) || "0";
  let frac = d ? s.slice(s.length - d).slice(0, max) : "";
  while (frac.endsWith("0")) frac = frac.slice(0, -1);
  return frac ? `${whole}.${frac}` : whole;
}

export function held(amount, decimals, symbol, reserve = 0n) {
  if (amount === null || amount === undefined) return null;
  const spend = amount - reserve;
  return {
    text: `Balance: ${plain(amount, decimals, Math.min(decimals, 8))} ${symbol}`,
    max: spend > 0n ? plain(spend, decimals) : null,
  };
}

export function balRow(input, read, watch = []) {
  if (!input) return () => {};
  const row = document.createElement("div");
  row.className = "balrow";
  const txt = document.createElement("span");
  txt.className = "hint";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-quiet btn-sm";
  btn.textContent = "Max";
  btn.hidden = true;
  row.append(txt, btn);
  input.after(row);
  let cur = null, gen = 0;
  const paint = async () => {
    const g = ++gen;
    let r = null;
    try { r = await read(); } catch { r = null; }
    if (g !== gen) return;
    cur = r;
    txt.textContent = r ? r.text : "";
    btn.hidden = !r || r.max === null;
  };
  btn.addEventListener("click", () => {
    if (!cur || cur.max === null) return;
    input.value = cur.max;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const el of watch) if (el) el.addEventListener("change", paint);
  rows.push(paint);
  paint();
  return paint;
}

export function repaint() {
  for (const p of rows) p();
}
