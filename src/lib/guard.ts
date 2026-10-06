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
    pattern: /\b(this fan|that fan|a fan named|individual fans?|specific fans?|fans?'s? (?:home|address|email|phone)|their (?:home address|email|phone))\b/i,
    reason: "referred to individual fans, but Qloo data describes audiences only in aggregate",
  },
];

export function unsupportedClaim(text: string): string | undefined {
  return UNSUPPORTED_CLAIMS.find(({ pattern }) => pattern.test(text))?.reason;
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
export function insightGuard(validIds: Set<string>, templated = false) {
  const withheld: Withheld[] = [];
  const guard = (field: string, value: unknown): Insight | undefined => {
    const item = toInsight(value, validIds, templated);
    if (!item) return undefined;
    const reason = unsupportedClaim(item.text);
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
