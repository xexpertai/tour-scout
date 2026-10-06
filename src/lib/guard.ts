/**
 * Provenance labels and the deterministic safe-use guard, shared by every report the app builds.
 *
 * - Qloo data: values copied from Qloo results by the server (the model never writes them).
 * - AI interpretation: model text that cites at least one valid Qloo evidence id (Q1, Q2, …).
 * - General advice: model text with no valid Qloo evidence.
 * - Template: text filled in by code (no model ran); it may still cite the Qloo values it templates.
 */
export type Insight = { text: string; evidence: string[]; kind: "interpretation" | "general" | "template" };
export type Withheld = { field: string; reason: string };

/**
 * Statements aggregate taste data cannot support under Qloo's safe-use rules. Matching items are
 * withheld, not rewritten, and the report says how many were withheld and why.
 */
const UNSUPPORTED_CLAIMS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\b(income|incomes|affluen\w*|wealth\w*|well[- ]off|disposable|salar(?:y|ies|ied)|high[- ]earn\w*|earners?|net worth|spending power|purchasing power|socio-?economic|middle[- ]class|upper[- ]class|working[- ]class|posh|elite|luxury[- ]seeking)\b/i,
    reason: "mentioned income or financial status, which Qloo taste data does not measure",
  },
  {
    pattern: /\b(caste|religio\w*|ethnic\w*|racial|politic\w*|health condition|disabilit\w*|sexual orientation|immigra\w*)\b/i,
    reason: "mentioned a sensitive trait, which must not be inferred from taste data",
  },
  {
    pattern: /\b(guarantee[ds]?|will definitely|certain to|proves? that|causes? (?:people|customers|fans))\b/i,
    reason: "stated an affinity as a certainty or cause, which aggregate taste data cannot establish",
  },
  {
    pattern: /\b(sell(?:s|ing)? out|sold[- ]out|will (?:attend|show up|turn up|buy tickets)|expected (?:attendance|turnout|crowd)|(?:\d[\d,]*\+?|hundreds|thousands) (?:of )?(?:people|fans|attendees|tickets) will|ticket sales of|forecast(?:ed)? (?:attendance|turnout|sales))\b/i,
    reason: "forecast attendance or ticket sales, which taste affinity cannot predict",
  },
  {
    // Qloo has no venue capacity; the user's target may be quoted, never matched to a room.
    pattern: /\b(match(?:es|ing)?|suits?|suited|supports?|fits?|accommodat\w*|scaled to|sized for|calibrated)\b[^.\n]{0,60}\bcapacity\b|\bcapacity\b[^.\n]{0,40}\b(match(?:es)?|suits?|suited|fits?|aligns?)\b|\bhigh[- ]capacity\b|\b(match(?:es|ing)?|suits?|supports?|fits?)\b[^.\n]{0,40}\b\d{2,5}\s*[–-]\s*\d{2,5}\b/i,
    reason: "claimed a room fits the capacity, but Qloo has no venue capacity data",
  },
  {
    // Demographics are aggregate context for the whole audience, not a targeting tool or a city fact.
    pattern: /\b(target(?:s|ing)?|market(?:ing)? to|aim(?:ed|ing)? at|appeal(?:s|ing)? to|cater(?:s|ing)? to|resonates? with|connects? with|frame[sd]?\b[^.\n]{0,25}\bfor)\b[^.\n]{0,30}\b(older|younger|male|female|men|women|boys|girls|gen ?z|millennials?|boomers?|seniors?|over[- ]?\d{2}s?|under[- ]?\d{2}s?|\d{2}\+)\b|\b(ages?|aged)\s+\d{2}\s*[–-]\s*\d{2}\s+(dominate|make up|are most)/i,
    reason: "targeted or sized an age or gender group, but demographics are aggregate context only",
  },
  {
    // Demographics may only be quoted as Qloo's aggregate index with the exact bucket and value
    // ("ages 45–54 over-index, +0.53"); characterising the audience ("skews male") is not supported.
    pattern: /\b(skew(?:s|ing|ed)?|lean(?:s|ing)?|tilt(?:s|ing)?|predominantly|mostly|largely|majority(?: of)?|dominated by)\b[^.\n]{0,25}\b(male|female|men|women|guys|girls|older|younger|gen ?z|millennials?|boomers?)\b|\b(male|female|older|younger)[- ](leaning|skewing|skewed|dominated|heavy)\b/i,
    reason: "characterised the audience by gender or age instead of quoting Qloo's aggregate index",
  },
  {
    pattern: /(?<!\bnot\s)\bconfirm(?:s|ed)?\s+(?:a\s+|the\s+)?(?:fan\s+)?(?:hotspot|audience|demand|interest|depth|local)\b/i,
    reason: "presented taste affinity as confirmed demand",
  },
  {
    pattern: /\b(this fan|that fan|a fan named|individual fans?|specific fans?|fans?'s? (?:home|address|email|phone)|their (?:home address|email|phone))\b/i,
    reason: "referred to individual fans, but Qloo data describes audiences only in aggregate",
  },
];

export function unsupportedClaim(text: string): string | undefined {
  return UNSUPPORTED_CLAIMS.find(({ pattern }) => pattern.test(text))?.reason;
}

const SIZE_RANGE = /(\d[\d,]*)\s*(?:[–-]|to)\s*(\d[\d,]*)/g;
const SIZE_WORD = /\b(rooms?|capacity|cap|seats?|seated|venues? of|people|heads)\b/i;
/**
 * Room sizes are the user's input, never Qloo data or the model's guess. A size range in model text
 * must be the one the user gave; with no capacity given, any room-size range is invented.
 */
export function inventedCapacity(text: string, capacity?: [number, number]): string | undefined {
  for (const m of text.matchAll(SIZE_RANGE)) {
    const near = text.slice(Math.max(0, m.index! - 40), m.index! + m[0].length + 40);
    // "room affinity 84–92" is a score range, not a room size.
    const tight = text.slice(Math.max(0, m.index! - 20), m.index! + m[0].length + 12);
    if (!SIZE_WORD.test(near) || /affinit|score|index|ages?\b|\(Q\d/i.test(tight)) continue;
    const [a, b] = [Number(m[1].replace(/,/g, "")), Number(m[2].replace(/,/g, ""))];
    if (!capacity) return "gave a room size the user did not provide";
    if (a !== capacity[0] || b !== capacity[1]) return "gave a room size that differs from the user's own target";
  }
  return undefined;
}

/** Keeps only evidence ids that refer to real Qloo calls and labels the item accordingly. */
export function toInsight(raw: unknown, validIds: Set<string>, templated = false): Insight | undefined {
  const r = (raw ?? {}) as { text?: unknown; evidence?: unknown };
  const text = typeof r.text === "string" ? r.text.trim() : typeof raw === "string" ? raw.trim() : "";
  if (!text) return undefined;
  const evidence = Array.isArray(r.evidence) ? [...new Set(r.evidence.map(String).filter((id) => validIds.has(id)))] : [];
  return { text, evidence, kind: templated ? "template" : evidence.length ? "interpretation" : "general" };
}

/**
 * Builds a guarded insight factory bound to one run's evidence ids; withheld items are collected.
 * `templated` marks text written by code rather than a model, so it is never labelled as AI.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A city the text names that is not on the route (e.g. a summary written for a different stop list). */
export function offRouteCity(text: string, offRoute: string[] = []): string | undefined {
  const hit = offRoute.find((c) => new RegExp(`\\b${escapeRe(c)}\\b`).test(text));
  return hit ? `named ${hit}, which is not on this route` : undefined;
}

/**
 * `opts.offRoute`: touring cities that are not stops; text naming one is withheld from the summary
 * and stop text (fields starting with "summary", or ending in "why"/"pitch").
 */
export function insightGuard(validIds: Set<string>, templated = false, opts: { capacity?: [number, number]; offRoute?: string[] } = {}) {
  const withheld: Withheld[] = [];
  const guard = (field: string, value: unknown): Insight | undefined => {
    const item = toInsight(value, validIds, templated);
    if (!item) return undefined;
    const routeText = /^summary|(why|pitch)$/.test(field);
    const reason = unsupportedClaim(item.text) ?? inventedCapacity(item.text, opts.capacity) ?? (routeText ? offRouteCity(item.text, opts.offRoute) : undefined);
    if (reason) {
      withheld.push({ field, reason });
      return undefined;
    }
    return item;
  };
  const list = (field: string, values: unknown, max = 6): Insight[] =>
    (Array.isArray(values) ? values : []).map((v) => guard(field, v)).filter((v): v is Insight => Boolean(v)).slice(0, max);
  return { guard, list, withheld };
}
