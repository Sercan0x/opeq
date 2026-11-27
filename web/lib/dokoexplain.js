import { REGISTRY } from "./indicators.js";

const money = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

export function label(ref) {
  if (typeof ref === "number") return String(ref);
  const spec = REGISTRY[ref.ind];
  if (!spec) return String(ref.ind);
  if (ref.asset) return `${ref.asset} ${label({ ...ref, asset: undefined })}`;
  if (ref.ind === "pattern") return `${ref.name} candle${ref.tf ? ` on ${ref.tf}` : ""}`;
  const ps = Object.keys(spec.p).map((k) => (ref[k] !== undefined ? ref[k] : spec.p[k].def));
  const name = ref.ind === "price" ? "price" : ref.ind.toUpperCase();
  const out = ref.out && ref.out !== spec.out[0] ? ` ${ref.out}` : ref.ind === "price" && ref.out ? ` ${ref.out}` : "";
  return `${name}${ps.length ? `(${ps.join(", ")})` : ""}${out}${ref.tf ? ` on ${ref.tf}` : ""}`;
}

export function condLines(c, depth = 0) {
  const pad = "  ".repeat(depth);
  if (c.all) return [`${pad}all of these:`, ...c.all.flatMap((x) => condLines(x, depth + 1))];
  if (c.any) return [`${pad}any of these:`, ...c.any.flatMap((x) => condLines(x, depth + 1))];
  if (c.of) return [`${pad}at least ${c.atLeast} of these:`, ...c.of.flatMap((x) => condLines(x, depth + 1))];
  if (c.not) return [`${pad}not:`, ...condLines(c.not, depth + 1)];
  if (c.cross) return [`${pad}${label(c.a)} crosses ${c.cross} ${label(c.b)}`];
  return [`${pad}${label(c.left)} ${c.op} ${label(c.right)}`];
}

export function explain(rule) {
  const liq = Math.max(0, 100 / rule.leverage - 0.5);
  const out = [];
  out.push(["Market", `${rule.coins.join(", ")} perpetuals, ${rule.timeframe} candles, ${rule.leverage}x leverage, ${money(rule.marginUsd)} margin per trade (${money(rule.marginUsd * rule.leverage)} position)${rule.maxTradesPerDay ? `, at most ${rule.maxTradesPerDay} new trades a day` : ""}`]);
  if (rule.long) { out.push(["Go long when", condLines(rule.long.entry).join("\n")]); if (rule.long.exit) out.push(["Close a long when", condLines(rule.long.exit).join("\n")]); }
  if (rule.short) { out.push(["Go short when", condLines(rule.short.entry).join("\n")]); if (rule.short.exit) out.push(["Close a short when", condLines(rule.short.exit).join("\n")]); }
  out.push(["Stop loss", `${rule.stopLossPct}% price move against the position (${(rule.stopLossPct * rule.leverage).toFixed(1)}% of the margin)`]);
  if (rule.takeProfitPct !== undefined) out.push(["Take profit", `${rule.takeProfitPct}% price move in favour (${(rule.takeProfitPct * rule.leverage).toFixed(1)}% of the margin)`]);
  out.push(["Liquidation", `${liq.toFixed(2)}% price move against the position loses the whole margin${rule.stopLossPct >= liq ? ", which comes before the stop loss" : ""}`]);
  if (rule.long && rule.short) out.push(["Switching", "an opposite signal closes the position and opens the other side"]);
  return out;
}
