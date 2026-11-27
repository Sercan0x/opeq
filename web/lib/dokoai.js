import { validateRule, TIMEFRAMES, PAIRS } from "./bot.js";
import { describe, MTF_SECONDS } from "./indicators.js";

export const MODEL = "claude-opus-5-5";
const API = "https://api.anthropic.com/v1/messages";

export const SYSTEM = `You help a user design a trading strategy for the OPEQ DOKO demo. The strategy runs as fixed rules with no AI in the loop, on paper money first.

Talk with the user in their language. Keep replies short and concrete. Ask at most one question when something important is missing; otherwise propose a rule.

A rule is JSON with these fields:
- name: 1 to 60 characters
- pair: one of ${Object.keys(PAIRS).join(", ")}
- timeframe: one of ${Object.keys(TIMEFRAMES).join(", ")}
- entry: a condition (required)
- exit: a condition (optional)
- stopLossPct: required, 0.2 to 50
- takeProfitPct: optional, 0.2 to 100
- orderUsd: dollars per trade, 1 to 100000
- maxTradesPerDay: optional, 1 to 24
No other fields. There is no leverage and no shorting: the strategy buys, then sells.

A condition is one of:
- {"all": [conditions]} or {"any": [conditions]} (1 to 8 items), or {"not": condition}
- a comparison {"left": X, "op": "<" | "<=" | ">" | ">=", "right": Y}, where X and Y are a number or an indicator, and at least one is an indicator
- a cross {"cross": "above" | "below", "a": indicator, "b": X}
At most 24 conditions in total, nested at most 4 deep.

An indicator is {"ind": name, ...settings, "out": output, "tf": timeframe}. Leave a setting out to use its default. "out" picks one output (default: the first). "tf" computes the indicator on a longer timeframe than the rule's (one of ${Object.keys(MTF_SECONDS).join(", ")}, a multiple of the rule's timeframe); its value only updates when that longer candle closes. Candle patterns use {"ind": "pattern", "name": ...} and give 1 or 0.

Indicators:
${describe()}

Answer with JSON: "reply" is your message to the user, "rule_json" is the full rule as a JSON string when you propose or change one, or an empty string when you only talk. Never promise profits. If the user asks for something the rules cannot express (shorting, leverage, other coins, news), say so plainly.`;

const SCHEMA = { type: "object", properties: { reply: { type: "string" }, rule_json: { type: "string" } }, required: ["reply", "rule_json"], additionalProperties: false };

export class DokoError extends Error {}

async function call(apiKey, messages, fetchImpl) {
  const r = await fetchImpl(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, system: SYSTEM, cache_control: { type: "ephemeral" }, fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } }, messages }),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const msg = j && j.error && typeof j.error.message === "string" ? j.error.message.slice(0, 200) : `HTTP ${r.status}`;
    throw new DokoError(r.status === 401 ? "Claude rejected the API key" : r.status === 429 ? "Claude is rate limiting this key; wait a moment" : r.status === 400 && /credit/i.test(msg) ? "the API key has no credit left" : `Claude returned an error: ${msg}`);
  }
  if (!j || !Array.isArray(j.content)) throw new DokoError("Claude returned an unreadable answer");
  if (j.stop_reason === "refusal") throw new DokoError("Claude declined this request");
  if (j.stop_reason === "max_tokens") throw new DokoError("Claude's answer was cut off; try a shorter request");
  const text = j.content.filter((b) => b && b.type === "text").map((b) => b.text).join("");
  let out;
  try { out = JSON.parse(text); } catch { throw new DokoError("Claude's answer was not valid JSON"); }
  if (typeof out.reply !== "string" || typeof out.rule_json !== "string") throw new DokoError("Claude's answer was missing fields");
  return { out, raw: text, usage: j.usage || null };
}

export async function chat({ apiKey, history, text, currentRule, fetchImpl = fetch }) {
  if (typeof apiKey !== "string" || !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(apiKey)) throw new DokoError("that does not look like an Anthropic API key (sk-ant-...)");
  if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new DokoError("write a message of up to 4000 characters");
  const note = currentRule ? `\n\n(The current rule is: ${JSON.stringify(currentRule)})` : "";
  const messages = [...history, { role: "user", content: text.trim() + note }];
  let { out, raw, usage } = await call(apiKey, messages, fetchImpl);
  let rule = null, problem = null;
  for (let attempt = 0; out.rule_json.trim() && attempt < 2; attempt++) {
    try { rule = JSON.parse(out.rule_json); validateRule(rule); problem = null; break; }
    catch (e) {
      rule = null; problem = e.message;
      if (attempt === 1) break;
      const fix = [...messages, { role: "assistant", content: raw }, { role: "user", content: `That rule failed the checker: ${problem}. Send the corrected rule.` }];
      ({ out, raw, usage } = await call(apiKey, fix, fetchImpl));
    }
  }
  return { reply: out.reply, rule, problem, turn: [{ role: "user", content: text.trim() + note }, { role: "assistant", content: raw }], usage };
}
