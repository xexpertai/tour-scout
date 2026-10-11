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
/** A pitch is sent to a booker: no internal metrics, scores or evidence ids in it. */
export function pitchJargon(text: string): string | undefined {
  if (/\broom affinity\b|\baffinity (score|of)\b/i.test(text)) return "pitch quotes the room-affinity metric";
  if (/\b\d{1,3}\.\d\b/.test(text)) return "pitch quotes a decimal score";
  if (/\(?\bQ\d{1,3}\b\)?/.test(text)) return "pitch shows an evidence id";
  return undefined;
}

export type GuardOpts = {
  capacity?: [number, number]; offRoute?: string[];
  /** The act's name; with `emerging`, it has no Qloo data of its own, so text must not describe its music. */
  actName?: string; emerging?: boolean;
  /** Cities near a country-wide fan hotspot; text claiming a hotspot elsewhere is withheld. */
  hotspotCities?: string[];
  /** Each stop's rank among the scored cities: "among the strongest" only for the top three. */
  cityRanks?: Record<string, number>;
  /** Room names on this plan: "partnered with <room>" is a claim the data cannot show. */
  venues?: string[];
  /** The route's first and last stop and its stop count, for claims about the route's span and "every stop". */
  routeEnds?: [string, string]; stopNames?: string[];
  /** How many cities were scored (for "bottom third"), and the route's weakest stop. */
  rankOf?: number; weakest?: string;
};

/** Absolute claims about the world that a check over a few scored cities cannot support. */
const ABSOLUTE_NONE = /\b(?:no (?:stronger|better|other) (?:cities|city|markets?|options?) (?:exists?|anywhere)|there (?:is|are) no (?:stronger|better) (?:city|cities|markets?)(?! (?:in|among|that) (?:the|this|its) (?:check|ranking|results|scored))|no (?:stronger|better) (?:city|cities|markets?) (?:exists?|anywhere))\b/i;

const ROOM = String.raw`(?:rooms?|venues?|clubs?|stages?|spaces?|bars?|halls?|theat(?:er|re)s?|lounges?|pubs?|ballrooms?|listening rooms?)`;
const ROOM_PARTNER = new RegExp(String.raw`\bpartner ${ROOM}\b|\b(?:sister|affiliated) ${ROOM}\b|\b${ROOM} (?:are |is )?partner(?:ed|s)\b|\bpartnership between (?:the |these |both |two )?${ROOM}`, "i");
const PARTNER_WITH = /\b(?:partner(?:ed|ing|s)?|in partnership) with\b([^.;\n]{0,40})/gi;
/**
 * A claimed partnership between rooms/venues ("partner venues", "sister rooms", "partnered with
 * <room>"). Plain advice about people ("partner with a local opener") is not a room claim.
 */
export function roomPartnership(text: string, venues: string[] = []): boolean {
  if (ROOM_PARTNER.test(text)) return true;
  const roomObj = new RegExp(String.raw`^\s*(?:the |a |an |another |other |local |nearby |this |that |their |its |your )*(?:\w+ ){0,2}${ROOM}\b`, "i");
  for (const m of text.matchAll(PARTNER_WITH)) {
    const after = m[1];
    if (roomObj.test(after)) return true;
    const obj = after.replace(/^\s*(?:the\s+)?/i, "").toLowerCase();
    if (venues.some((v) => v.length > 2 && obj.startsWith(v.toLowerCase().replace(/^the\s+/, "")))) return true;
  }
  return false;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Claims the data cannot back for this plan: pronouns for the act, a new act's own music, hotspots that are not there. */
export function planClaims(field: string, text: string, o: GuardOpts): string | undefined {
  if (/\b(he|she|him|her|hers|his)\b/i.test(text)) return "used he/she (the act's gender is not in the data)";
  if (/\b(already booked|is booked|are booked|booked (for|at|in))\b/i.test(text)) return "presented a suggestion as a booking";
  if (/\b(already|currently|now) (touring|on tour|playing|performing|routing)\b|\bon tour (with|in|through)\b/i.test(text)) return "claimed an act's touring activity, which Qloo data does not show";
  if (/\b(?:is|are|was|were|been|already|now) partnered with\b/i.test(text)) return "presented a suggestion as a booking";
  if (roomPartnership(text, o.venues)) return "implied a partnership between rooms that the data does not show";
  if (/\branks? #?\d+[^.]{0,20}\b(nationally|in the (country|nation|US|United States))\b/i.test(text)) return "presented a rank among the scored cities as a national rank";
  if (/\b(optimi[sz]ed|optimal|optimum|perfect(ly)? (fit|match))\b/i.test(text)) return "claimed the plan is optimal (the data ranks options; it does not prove a best)";
  if (/\bmatch(es|ed)?\b[^.]{0,40}\b(well|perfectly|ideally)\b|\b(well|perfectly|ideally)[- ]matched\b|\b(line-?up|openers?|support acts?) (is|are) (strong|great|perfect|ideal)\b/i.test(text)) return "claimed a fit the tool results did not measure";
  if (o.emerging && /\b(opener|openers|opens)\b/i.test(text) && !/\bopen for\b/i.test(text)) return "called a support-slot act an opener (the new act opens for them)";
  // A new act has no Qloo data, so no audience of its own: "Maya is a new act whose audience lines up with yours",
  // "Maya's fans", "our audience" all claim one.
  if (o.emerging && (/\bnew act whose (?:audience|fans|listeners|fanbase)\b/i.test(text) || /\b(?:our|my) (?:audience|fans|fanbase|listeners)\b|\bshares? tastes with ours\b/i.test(text)
    || (o.actName && new RegExp(`\\b${escape(o.actName)}(?:'s|’s)\\s+(?:own\\s+)?(?:audience|fans|fanbase|listeners|following)\\b`, "i").test(text)))) {
    return "claimed an audience for the new act, which has no Qloo data of its own";
  }
  if (ABSOLUTE_NONE.test(text)) return "stated an absolute about cities the check did not score";
  // Where fans cluster comes from Qloo's fan heatmap (where_popular), not from room affinity.
  if (/\broom (?:data|affinity|results)\b[^.]{0,80}\b(?:concentrat\w*|cluster\w*|gather\w*)\b|\b(?:concentrat\w*|cluster\w*)\b[^.]{0,40}\b(?:per|according to|in) Qloo'?s? room (?:data|affinity)\b/i.test(text)) {
    return "credited room data for where fans cluster (that comes from Qloo's fan heatmap)";
  }
  if (o.emerging && o.actName && new RegExp(`\\b${escape(o.actName)}(?:'s\\s+(?:[\\w-]+,?\\s+){0,4}(?:songwriting|work|music|approach|sound|storytelling|style|songs)|\\s+(?:is(?! a new act)|brings|writes|makes|sings|plays|delivers)\\b)`, "i").test(text)) {
    return "described the new act, which has no Qloo data of its own";
  }
  // The route's weakest stop, or one in the bottom third of the scored cities, is not "strong" or "the best":
  // the card beside it shows its rank.
  if (o.cityRanks && / (why|pitch)$/.test(field)) {
    const city = field.replace(/\s+(why|pitch)$/, "");
    const rank = o.cityRanks[city];
    const low = city === o.weakest || (rank !== undefined && o.rankOf !== undefined && rank > Math.ceil((o.rankOf * 2) / 3));
    if (low && /\b(?:a |the )?(?:strong|strongest|best|top|ideal|excellent|great) (?:fit|match|market|city|stop|choice|showing|option)\b/i.test(text)) return city === o.weakest ? "called the route's weakest stop strong" : "called a stop in the bottom third of the scored cities strong";
  }
  // The route's span: "from A to B" or "(A through B)" naming two stops must name its two ends.
  if (o.routeEnds && o.stopNames && /^summary/.test(field)) {
    const names = o.stopNames.map(escape).join("|");
    const m = new RegExp(`\\b(${names})\\b(?:,? (?:and|&) \\w+)?\\s+(?:to|through|thru|down to|up to)\\s+(${names})\\b`, "i").exec(text);
    const ends = o.routeEnds.map((x) => x.toLowerCase());
    if (m && !(ends.includes(m[1].toLowerCase()) && ends.includes(m[2].toLowerCase()) && m[1].toLowerCase() !== m[2].toLowerCase())) return `misstated the route's span (it runs ${o.routeEnds[0]} to ${o.routeEnds[1]})`;
  }
  // A superlative about the route's markets as a group ("the Northeast's strongest comedy markets", "top
  // markets", "best cities") needs every stop in the top third of the scored cities.
  if (/^summary/.test(field) && o.cityRanks && o.rankOf && o.stopNames?.length
    && /\b(?:strongest|top|best|leading|premier)\b[^.]{0,30}?\b(?:markets|cities|stops|scenes)\b/i.test(text)) {
    const third = Math.ceil(o.rankOf / 3);
    const below = o.stopNames.filter((c) => (o.cityRanks![c] ?? Infinity) > third);
    if (below.length) return `called the route's markets the strongest, but ${below.join(", ")} ${below.length === 1 ? "ranks" : "rank"} below the top third`;
  }
  // "Each city hosts fans…" when only some stops are near a fan hotspot.
  if (o.hotspotCities && o.stopNames && o.hotspotCities.length < o.stopNames.length && /^summary/.test(field)
    && (/\b(?:each|every|all(?: (?:five|four|three|six|\d))?)\b(?: (?:city|cities|stop|stops|market|markets))?[^.]{0,40}\b(?:hosting|hosts?|home to|with|has|have)\b[^.]{0,25}\bfans\b/i.test(text)
      || /\b(?:all|each|every)\b[^.]{0,40}\bnear\b[^.]{0,20}\bhotspots?\b/i.test(text)
      || /\b(?:cities|stops|markets)\b where (?:fans|the audience|this audience)\b[^.]{0,50}\b(?:concentrate|cluster|gather|live)\b/i.test(text))) {
    return `claimed fans in every stop, but only ${o.hotspotCities.length} of ${o.stopNames.length} stops are near a Qloo fan hotspot`;
  }
  if (o.cityRanks && /\b(among the (strongest|top|best)|top (market|city|cities)|strongest (market|city|cities))\b/i.test(text)) {
    const city = field.replace(/\s+(why|pitch)$/, "");
    const rank = o.cityRanks[city];
    if (rank !== undefined && rank > 3) return "called a city one of the strongest, but it ranks below the top three";
    // A sentence that lists cities as "among the strongest" (a summary) may only list top-three cities.
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (!/\b(among the (strongest|top|best)|strongest (markets|cities))\b/i.test(sentence)) continue;
      const below = Object.entries(o.cityRanks).find(([c, r]) => r > 3 && sentence.toLowerCase().includes(c.toLowerCase()));
      if (below) return `called ${below[0]} one of the strongest cities, but it ranks #${below[1]}`;
    }
  }
  if (o.hotspotCities && /hotspot/i.test(text)) {
    const city = field.replace(/\s+(why|pitch)$/, "");
    const stopField = city !== field;
    if (stopField ? !o.hotspotCities.some((c) => c.toLowerCase() === city.toLowerCase()) : !o.hotspotCities.length) return "claimed a fan hotspot the data does not show";
  }
  return undefined;
}

export function insightGuard(validIds: Set<string>, templated = false, opts: GuardOpts = {}) {
  const withheld: Withheld[] = [];
  const guard = (field: string, value: unknown): Insight | undefined => {
    const item = toInsight(value, validIds, templated);
    if (!item) return undefined;
    const routeText = /^summary|(why|pitch)$/.test(field);
    const reason = unsupportedClaim(item.text) ?? inventedCapacity(item.text, opts.capacity) ?? (routeText ? offRouteCity(item.text, opts.offRoute) : undefined)
      ?? (/pitch$/.test(field) ? pitchJargon(item.text) : undefined)
      ?? (templated ? undefined : planClaims(field, item.text, opts));
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
