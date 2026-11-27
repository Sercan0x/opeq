import { REGISTRY } from "./indicators.js";

const money = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

export function label(ref) {
  if (typeof ref === "number") return String(ref);
  const spec = REGISTRY[ref.ind];
  if (!spec) return String(ref.ind);
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
  if (c.not) return [`${pad}not:`, ...condLines(c.not, depth + 1)];
  if (c.cross) return [`${pad}${label(c.a)} crosses ${c.cross} ${label(c.b)}`];
  return [`${pad}${label(c.left)} ${c.op} ${label(c.right)}`];
}

export function explain(rule) {
  const out = [];
  out.push(["Market", `${rule.pair}, ${rule.timeframe} candles, ${money(rule.orderUsd)} per trade${rule.maxTradesPerDay ? `, at most ${rule.maxTradesPerDay} buys a day` : ""}`]);
  out.push(["Buy when", condLines(rule.entry).join("\n")]);
  if (rule.exit) out.push(["Sell when", condLines(rule.exit).join("\n")]);
  out.push(["Stop loss", `${rule.stopLossPct}% below the buy price`]);
  if (rule.takeProfitPct !== undefined) out.push(["Take profit", `${rule.takeProfitPct}% above the buy price`]);
  return out;
}
