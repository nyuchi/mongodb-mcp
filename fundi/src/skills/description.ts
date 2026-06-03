// Skill: generate_description (§4.6 + §6). Anthropic-backed, with the v10 guard
// carried forward: clean-or-absent, never a hedge. The previous enrichment saved
// any model output >=20 chars, so hedges ("I don't have specific information…")
// polluted ~65% of descriptions. Do NOT regress this.

import type { OsmFeature } from "./classify";

// Case-insensitive patterns that mark a refusal / hedge / meta-commentary.
const HEDGE_ANYWHERE = [
  "i don't have",
  "i do not have",
  "i cannot",
  "i can't",
  "i'm unable",
  "i am unable",
  "i'd be happy to",
  "following the rule",
  "here's what i can",
  "no specific information",
  "no reliable information",
  "no verified information",
  "based on the limited information",
  "cannot provide",
  "as an ai",
  "unfortunately, i",
];

const HEDGE_LEADING = [
  "i ",
  "i'",
  "i’",
  "i'm",
  "i am",
  "i'd",
  "as an ai",
  "unfortunately, i",
  "sure,",
  "certainly,",
  "here is",
  "here's",
  "description:",
];

export function isHedge(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower === "skip") return true;
  if (HEDGE_LEADING.some((p) => lower.startsWith(p))) return true;
  if (HEDGE_ANYWHERE.some((p) => lower.includes(p))) return true;
  if (trimmed.length < 20) return true;
  return false;
}

const BASE_PROMPT =
  "Write a place description in third person, present tense, factual only. " +
  "No opening hours, no contact details. Do not start with 'Welcome to' or 'Located in'. " +
  "Warm professional tone, 2-3 sentences. Output ONLY the description.";

const STRICT_SUFFIX =
  " If you lack enough specific information, reply with exactly the single word SKIP. " +
  "Never explain what you don't know. Output ONLY the description or SKIP.";

function buildContext(feature: OsmFeature, placeName: string): string {
  const t = feature.tags ?? {};
  const facts: string[] = [`Name: ${placeName}`];
  const interesting = [
    "tourism",
    "amenity",
    "shop",
    "natural",
    "leisure",
    "cuisine",
    "addr:city",
    "addr:country",
    "description",
    "operator",
  ];
  for (const key of interesting) {
    if (t[key]) facts.push(`${key}: ${t[key]}`);
  }
  return facts.join("\n");
}

export interface AnthropicConfig {
  endpoint: string; // e.g. https://api.anthropic.com/v1/messages
  apiKey: string;
  model: string;
}

async function callAnthropic(cfg: AnthropicConfig, system: string, user: string): Promise<string> {
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 256,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return text;
}

// Returns a clean description, or null. Never returns a hedge.
export async function generateDescription(
  cfg: AnthropicConfig | null,
  feature: OsmFeature,
  placeName: string,
): Promise<string | null> {
  if (!cfg) return null;
  const context = buildContext(feature, placeName);

  try {
    const first = await callAnthropic(cfg, BASE_PROMPT, context);
    if (!isHedge(first)) return first.trim();

    // Retry once, stricter (§6).
    const second = await callAnthropic(cfg, BASE_PROMPT + STRICT_SUFFIX, context);
    if (!isHedge(second)) return second.trim();
  } catch (e) {
    console.error("generate_description failed", { id: feature.id, error: String(e) });
  }
  // Clean null beats a polluted string. Place stays re-enrichable later.
  return null;
}
