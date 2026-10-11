/* eslint-disable @typescript-eslint/no-explicit-any -- tool inputs are model-produced JSON, validated field by field */
/**
 * "Ask the scout": a tool-using agent that answers free-form questions about a tour plan.
 *
 * The model chooses Qloo-backed tools (rank, find cities, fan clusters, venues, openers, audience
 * overlap), chains them for up to MAX_ROUNDS rounds, then calls `propose_change` with an answer and
 * an optional diff to the plan. The server validates everything it proposes: added cities must come
 * from this session's tool results, removed stops must exist, and every cited Q-id must be real.
 * Nothing changes until the user applies the proposal.
 */
import { MARKETS, countryOf, distanceKm } from "../markets.ts";
import { MAX_LEG_KM, ROAD_FACTOR, TIE, bestOrder, legs, swapFits } from "./region.ts";
import Anthropic from "@anthropic-ai/sdk";
import { EvidenceLedger } from "../evidence.ts";
import { areaName } from "../geo.ts";
import { insightGuard, type Insight } from "../guard.ts";
import { CLAUDE_MODEL, LlmError, logUsage, takeDailyBudget } from "../llm.ts";
import { compareAudiences, fanHeatmap, recommend } from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import { discoverCities, placeFor, scoreCities, scoreCity } from "./cities.ts";
import { venueNames } from "./plan.ts";
import { COMEDIAN_TAGS, describedAs, isRelatedAct, unlikelyOpener, makeStepper, venueTagFor, type StepSink, SMALL_ROOM_POPULARITY } from "./pipeline.ts";
import type { City, FollowUp, GhostPin, Opener, PlanDiff, TourPlan } from "./types.ts";

export const MAX_ROUNDS = 4;
export const MAX_AGENT_QUESTIONS = 5;

// ---------------------------------------------------------------- model interface
export type ToolCall = { id: string; name: string; input: Record<string, any> };
export type AgentTurn = { calls: ToolCall[]; text: string; raw?: unknown };
export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; turn: AgentTurn }
  | { role: "tool_results"; results: { id: string; content: string; isError?: boolean }[] };

export interface AgentModel {
  readonly name: "claude" | "scripted";
  next(system: string, history: AgentMessage[], opts: { forceFinal: boolean }): Promise<AgentTurn>;
}

const str = { type: "string" } as const;
export const SCOUT_TOOLS = [
  { name: "rank_cities", description: "Score up to 6 cities by room affinity (0–100: how strongly these fans line up with the city's best-matching live room) and rank them with the plan's current stops, which use the same score.",
    input_schema: { type: "object", properties: { cities: { type: "array", items: str, maxItems: 6 } }, required: ["cities"] } },
  { name: "find_cities", description: "Discover cities in a country or region from Qloo's fan heatmap (hotspots snapped to touring markets), each scored by room affinity.",
    input_schema: { type: "object", properties: { region: { ...str, description: "e.g. 'Tennessee', 'Pacific Northwest', 'United States'" } }, required: ["region"] } },
  { name: "fan_cluster", description: "Where in one city the fans concentrate (neighbourhood).",
    input_schema: { type: "object", properties: { city: str }, required: ["city"] } },
  { name: "find_venues", description: "Venues in a city with affinity for these fans.",
    input_schema: { type: "object", properties: { city: str }, required: ["city"] } },
  { name: "find_openers", description: "Similar acts with affinity in a city, as opener candidates. Returns entity ids for audience_overlap.",
    input_schema: { type: "object", properties: { city: str }, required: ["city"] } },
  { name: "audience_overlap", description: "Shared tastes between the fans and one opener candidate (entity_id from find_openers).",
    input_schema: { type: "object", properties: { entity_id: str }, required: ["entity_id"] } },
  { name: "propose_change", description: "Finish: answer the question and optionally propose a change to the plan. Call exactly once, last.",
    // Flat fields: small models fill nested objects less reliably.
    input_schema: { type: "object", properties: {
      answer: { ...str, description: "At most 70 words" },
      evidence: { type: "array", items: str, description: "Q-ids of the tool results the answer relies on" },
      add_cities: { type: "array", items: str, description: "Cities to add; each must have appeared in a rank_cities or find_cities result" },
      remove_stop_ids: { type: "array", items: str, description: "stop_id values of current stops to drop" },
      set_opener: { type: "object", properties: { stop_id: str, entity_id: str }, required: ["stop_id", "entity_id"] },
    }, required: ["answer", "evidence"] } },
] as const;

export const SCOUT_RULES = `You are Tour Scout, a touring strategist for independent musicians and comedians, working only from Qloo taste data.
Use the tools to answer the user's request about their tour plan, then call propose_change exactly once.
- At most ${MAX_ROUNDS} rounds of tool calls; call independent tools together in one round.
- When the request asks for a change (swap, add, drop, or an opener for a stop) and the tool results support one, put it in propose_change's fields (add_cities, remove_stop_ids, set_opener) rather than only describing it. For an opener, check audience_overlap first and set set_opener with that stop_id and entity_id.
- Put Q-ids in the evidence field, not inside the answer text.
- Only propose cities that appeared in a rank_cities or find_cities result, and only remove existing stop_ids. Keep 2–6 stops.
- City scores are Qloo room affinity on a 0–100 scale for ranking cities against each other. Never present them as attendance, ticket sales, certainty, cause, or a prediction about any individual. Never forecast turnout.
- Never state or imply income, wealth, class or sensitive traits of fans or places. Never invent venues, places, artists or numbers.
- Never list raw scores in parentheses like "(97, 96.9, 97)"; if a number helps, write it once as "Qloo affinity 97".
- If act.sounds_like is set, the act is new: an "opener" is an act it could support (it opens for them). Say "a support slot with X" or "support act"; never use the words "opener", "openers" or "opens" in the answer, and never say the new act has fans or an audience of its own.
- The answer's first sentence is your reason in plain words (it is shown as your own words, so it must hold on its own): name the cities and Qloo affinities you compared, scoped to the cities you checked ("of the cities checked…"). Never state absolutes ("no stronger city exists").
- For driving, use the tool's numbers: extra_drive_km_by_road under 10 means "about the same driving"; otherwise say "about N km more/less driving".
- Refer to the act by name or as "they"; never he, she, his or her.
- A route check ("Check this route: …"): call rank_cities or find_cities, then read route_check. If a city is vs_weakest "stronger" with swap_keeps_route_drivable true, you must propose swapping it in for weakest_stop (add_cities + remove_stop_ids). If one is "tied", say they are effectively tied. Only say the route holds when no city is stronger and drivable. Openers: only use a find_openers result for that same city; if it had 0 candidates, say so. Propose at most one change.
- The answer is at most 70 words, cites the evidence ids (Q…) of the tool results it relies on, and says plainly if the data does not support a change.`;

// ---------------------------------------------------------------- Claude
export const claudeAgentModel: AgentModel = {
  name: "claude",
  async next(system, history, { forceFinal }) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new LlmError("CLAUDE_API_KEY is not set", "LLM_CONFIG");
    takeDailyBudget();
    const client = new Anthropic({ apiKey, timeout: 45_000 });
    const messages: Anthropic.MessageParam[] = history.map((m): Anthropic.MessageParam => {
      if (m.role === "user") return { role: "user", content: m.text };
      if (m.role === "assistant") return { role: "assistant", content: m.turn.raw as Anthropic.ContentBlockParam[] };
      return { role: "user", content: m.results.map((r): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: r.id, content: r.content, is_error: r.isError })) };
    });
    try {
      const response = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        system,
        tools: SCOUT_TOOLS as unknown as Anthropic.Tool[],
        // The last round must finish; forced tool use is supported on Claude Haiku 4.5.
        tool_choice: forceFinal ? { type: "tool", name: "propose_change" } : { type: "auto" },
        messages,
      });
      logUsage("claude-scout", CLAUDE_MODEL, { input: response.usage.input_tokens, output: response.usage.output_tokens });
      if (response.stop_reason === "refusal") throw new LlmError("Claude declined this request", "LLM_BAD_OUTPUT");
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, any> }));
      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      return { calls, text, raw: response.content };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (e instanceof Anthropic.RateLimitError) throw new LlmError("The AI scout's rate limit is reached.", "LLM_QUOTA");
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new LlmError("The Claude API key is missing or invalid.", "LLM_CONFIG");
      if (e instanceof Anthropic.APIError) throw new LlmError("The AI scout is busy right now.", "LLM_UNAVAILABLE");
      throw e;
    }
  },
};

// ---------------------------------------------------------------- scripted (no model)
/**
 * A deterministic scout for runs without a model (demo mode, no key, budget used up): it looks for
 * stronger cities in the plan's region and proposes swapping the weakest stop, or an opener.
 */
export function scriptedAgentModel(plan: TourPlan, question: string): AgentModel {
  return {
    name: "scripted",
    async next(_system, history) {
      const turns = history.filter((m) => m.role === "assistant").length;
      const results = history.filter((m): m is Extract<AgentMessage, { role: "tool_results" }> => m.role === "tool_results")
        .flatMap((m) => m.results).map((r) => { try { return JSON.parse(r.content); } catch { return {}; } });
      const wantsOpener = /opener|support act|crossover/i.test(question);
      const named = plan.stops.find((s) => question.toLowerCase().includes(clean(s.city.name).toLowerCase()));
      const weakest = [...plan.stops].sort((a, b) => a.city.affinity - b.city.affinity)[0];
      const id = (n: number) => `scripted-${turns}-${n}`;
      const fewer = Number(question.match(/(\d)\s*-?\s*stops?\b/i)?.[1]);
      if (turns === 0 && fewer >= 2 && fewer < plan.stops.length) {
        const drop = [...plan.stops].sort((a, b) => a.city.affinity - b.city.affinity).slice(0, plan.stops.length - fewer);
        return { calls: [{ id: id(0), name: "propose_change", input: {
          answer: `For a ${fewer}-stop run, drop the stops with the lowest room affinity: ${drop.map((s) => `${clean(s.city.name)} (${score(s.city.affinity)})`).join(", ")}.`,
          evidence: [...new Set(drop.map((s) => s.city.evidence))],
          remove_stop_ids: drop.map((s) => s.stopId),
        } }], text: "" };
      }
      if (turns === 0) {
        const calls: ToolCall[] = [{ id: id(0), name: "find_cities", input: { region: plan.inputs.region ?? "United States" } }];
        if (wantsOpener) calls.push({ id: id(1), name: "find_openers", input: { city: clean((named ?? plan.stops[0]).city.name) } });
        return { calls, text: "" };
      }
      const found = results.flatMap((r) => r.cities ?? []).filter((c: any) => !c.on_route);
      if (turns === 1 && found.length && !results.some((r) => r.ranking)) {
        return { calls: [{ id: id(0), name: "rank_cities", input: { cities: found.slice(0, 2).map((c: any) => c.city) } }], text: "" };
      }
      const ranking: any[] = results.find((r) => r.ranking)?.ranking ?? [];
      // The same test the server applies: only a stronger city whose swap keeps every leg drivable.
      const drivable = new Set(results.flatMap((r) => r.route_check ?? []).filter((t: any) => t.swap_keeps_route_drivable).map((t: any) => clean(t.city).toLowerCase()));
      const best = ranking.find((c) => !c.on_route && drivable.has(clean(c.city).toLowerCase()));
      const rankEvidence: string | undefined = best?.evidence_id ?? results.find((r) => r.ranking)?.evidence_id;
      const weakScore = ranking.find((c) => clean(c.city).toLowerCase() === clean(weakest.city.name).toLowerCase())?.score;
      // Never the opener the stop already has, one used at another stop, or one bigger than the act.
      const target = named ?? plan.stops[0];
      const opener = results.find((r) => r.openers)?.openers?.find((o: any) => o.entity_id !== target.opener?.entityId
        && !plan.stops.some((x) => x.opener?.entityId === o.entity_id) && o.fits_the_act !== false);
      const openerEvidence: string | undefined = results.find((r) => r.openers)?.evidence_id;
      const swap = best && weakScore !== undefined && best.score > weakScore;
      const parts = [
        swap ? `${best.city} scores ${best.score} out of 100, above ${clean(weakest.city.name)} (${weakScore}), so swapping it in strengthens the route.`
          : best ? `${best.city} scores ${best.score}, which does not beat your current stops, so the route stays as is.` : "No stronger city within a day's drive came up in this region.",
        opener ? `For ${clean((named ?? plan.stops[0]).city.name)}, ${plan.artist.proxyOf?.length ? `a support slot with ${clean(opener.name)} is worth asking for` : `${clean(opener.name)} is a possible opener`} (artist affinity ${opener.artist_affinity_with_these_fans}).` : "",
      ].filter(Boolean);
      return {
        calls: [{ id: id(0), name: "propose_change", input: {
          answer: parts.join(" "), evidence: [rankEvidence, openerEvidence].filter(Boolean),
          ...(swap ? { add_cities: [best.city], remove_stop_ids: [weakest.stopId] } : {}),
          ...(opener && wantsOpener ? { set_opener: { stop_id: (named ?? plan.stops[0]).stopId, entity_id: opener.entity_id } } : {}),
        } }],
        text: "",
      };
    },
  };
}

/**
 * Strips what the model sometimes leaks into the answer string: tool-call markup, and the evidence
 * list it should have put in its own field (e.g. `…lineup.",\n["Q30", "Q32"]`).
 */
export function cleanAnswer(raw: string): string {
  return raw
    .replace(/<\/?(?:parameter|invoke|antml:[a-z_]+)[^>]*>/gi, "")
    // Tool-result field names the model sometimes echoes ("(fits_the_act: true)").
    .replace(/\s*\(\s*[a-z]+(?:_[a-z]+)+\s*:[^)]*\)/g, "")
    // Raw score lists ("(97, 96.9, 97)") read as noise; the scores are in the receipts.
    .replace(/\s*\((?:\s*\d+(?:\.\d+)?\s*,)+\s*\d+(?:\.\d+)?\s*\)/g, "")
    .replace(/["'”]?\s*,?\s*\[\s*"?Q\d+"?(?:\s*,\s*"?Q\d+"?)*\s*\]\s*$/, "")
    // Inline evidence ids ("(Q37, Q34)"): they belong in the evidence field, shown as chips.
    .replace(/\s*\(\s*Q\d+(?:\s*,\s*Q\d+)*\s*\)/g, "")
    .replace(/["'\s,]+$/, "")
    .replace(/^["'\s]+/, "")
    .trim();
}

// ---------------------------------------------------------------- the loop
// One decimal, as the UI shows scores (88.4 vs 88.8 would otherwise both read "88").
const score = (n?: number) => (n === undefined ? null : Math.round(n * 1000) / 10);
const sameCity = (a: string, b: string) => clean(a).toLowerCase() === clean(b).toLowerCase();

function planBrief(plan: TourPlan, question: string): string {
  return JSON.stringify({
    request: question,
    act: { name: clean(plan.artist.name), type: plan.artist.type, sounds_like: plan.artist.proxyOf?.map(clean) },
    region: plan.inputs.region ?? null,
    stops: plan.stops.map((s) => ({ stop_id: s.stopId, order: s.order, city: clean(s.city.name), room_affinity: score(s.city.affinity), fan_hotspot: Boolean(s.city.hotspot), opener: s.opener ? clean(s.opener.name) : null })),
  });
}

/** Straight-line km as road km, rounded to 10 (the unit every distance on screen uses). */
const roadKm = (km: number) => Math.round((km * ROAD_FACTOR) / 10) * 10;
const located = (cs: { lat?: number; lng?: number }[]) => cs.filter((c) => c.lat !== undefined && c.lng !== undefined).map((c) => ({ lat: c.lat!, lng: c.lng! }));
const routeKm = (pts: { lat: number; lng: number }[]) => (pts.length > 1 ? legs(pts, bestOrder(pts)).reduce((a, b) => a + b, 0) : 0);

/** "+ Charlotte (92.0)", "− Indianapolis (89.0)": scores with one decimal, as everywhere else. */
export const diffSummary = (plan: TourPlan, add: City[], remove: string[]) => [
  ...add.map((c) => `+ ${clean(c.name)} (${score(c.affinity)!.toFixed(1)})`),
  ...remove.map((id) => plan.stops.find((s) => s.stopId === id)!).filter(Boolean).map((s) => `− ${clean(s.city.name)} (${score(s.city.affinity)!.toFixed(1)})`),
];

/** One find_openers lookup the route check made for a stop: where, its receipt, and (when known) whether
 * Qloo returned any act at or below the act's size fit other than the stop's current one. */
export type OpenerLookup = { city: string; evidence: string; smallerFound?: boolean };

/**
 * The opener half of the route check, in code-written words (TEMPLATE): which stops' openers it looked
 * up and that it proposes no opener change, or why. Empty when it made no lookup or changed an opener.
 */
export function openerCheckLine(plan: TourPlan, lookups: OpenerLookup[], changedOpener: boolean, diff?: Pick<PlanDiff, "add" | "remove">): Insight | undefined {
  if (changedOpener) return undefined;
  // Stops that stay on the route (a dropped stop's opener no longer matters); an added city gets its idea on Apply.
  const kept = plan.stops.filter((s) => !(diff?.remove ?? []).includes(s.stopId));
  const byStop = lookups.filter((l, i) => kept.some((s) => sameCity(s.city.name, l.city)) && lookups.findIndex((x) => sameCity(x.city, l.city)) === i);
  if (!byStop.length) return undefined;
  const role = plan.artist.proxyOf?.length ? "support-slot ideas" : plan.artist.type === "person" ? "feature acts" : "openers";
  const cities = byStop.map((l) => clean(l.city));
  const list = cities.length < 3 ? cities.join(" and ") : `${cities.slice(0, -1).join(", ")} and ${cities.at(-1)}`;
  const none = byStop.every((l) => l.smallerFound === false);
  const flagged = plan.stops.filter((s) => s.opener?.oversize && byStop.some((l) => sameCity(l.city, s.city.name))).map((s) => clean(s.city.name));
  const text = `${role[0].toUpperCase()}${role.slice(1)}: the check looked up Qloo's similar acts for ${list} and proposes no change${
    none ? `: Qloo returned no other act within ${possessive(plan.artist.name)} size fit there` : ""}${
    flagged.length ? `, so the "above your size fit" flag${flagged.length === 1 ? "" : "s"} on ${flagged.join(", ")} stay${flagged.length === 1 ? "s" : ""}` : ""}.`;
  return { text, evidence: byStop.map((l) => l.evidence), kind: "template" };
}

/** The opener lookups of a recorded route check, from its receipts ("Similar acts with affinity in X"). */
export const openerLookupsFrom = (f: Pick<FollowUp, "sources">): OpenerLookup[] =>
  f.sources.flatMap((s) => { const m = /^Similar acts with affinity in (.+)$/.exec(s.label); return m ? [{ city: m[1], evidence: s.id }] : []; });

/**
 * The route check's verdict in code-written words (TEMPLATE), built from the final proposal and the
 * cities the check scored: what changes and why, or why the route holds, with the numbers.
 */
export function routeVerdict(plan: TourPlan, seen: City[], diff?: Pick<PlanDiff, "add" | "remove">): Insight {
  const stops = plan.stops.filter((s) => s.city.lat !== undefined && s.city.lng !== undefined);
  const weakest = [...stops].sort((a, b) => a.city.affinity - b.city.affinity)[0] ?? plan.stops[0];
  const s1 = (n: number) => score(n)!.toFixed(1);
  const removed = (diff?.remove ?? []).map((id) => plan.stops.find((x) => x.stopId === id)!).filter(Boolean);
  if (diff && (diff.add.length || removed.length)) {
    const before = routeKm(located(plan.stops.map((x) => x.city)));
    const after = routeKm(located([...plan.stops.filter((x) => !diff.remove.includes(x.stopId)).map((x) => x.city), ...diff.add]));
    // Rounded exactly as the rank_cities tool rounds extra_drive_km_by_road (swapFits rounds km first), so the
    // verdict and the agent quote the same number.
    const delta = roadKm(Math.round(after - before));
    const driving = Math.abs(delta) < 10 ? "about the same driving" : `≈ ${Math.abs(delta).toLocaleString("en")} km ${delta > 0 ? "more" : "less"} driving by road`;
    const ev = [...diff.add.map((c) => c.evidence), ...removed.map((x) => x.city.evidence)];
    if (diff.add.length && removed.length) {
      const a = diff.add[0], r = removed[0];
      // Disclose stronger cities the check scored that the proposal passed over, with their driving cost.
      const kept = plan.stops.filter((x) => !diff.remove.includes(x.stopId)).map((x) => x.city);
      const keptPts = located(kept);
      const nowPts = located(plan.stops.map((x) => x.city));
      const limit = Math.max(MAX_LEG_KM, nowPts.length > 1 ? Math.max(...legs(nowPts, bestOrder(nowPts))) : 0) + 1;
      const stronger = seen.filter((c) => c.lat !== undefined && c.affinity > a.affinity && !plan.stops.some((x) => sameCity(x.city.name, c.name)) && !diff.add.some((d) => sameCity(d.name, c.name)))
        .map((c) => ({ c, km: routeKm(located([...kept, c])), legOk: keptPts.length < 1 || Math.max(0, ...legs([...keptPts, { lat: c.lat!, lng: c.lng! }], bestOrder([...keptPts, { lat: c.lat!, lng: c.lng! }]))) <= limit }))
        .filter((x) => x.legOk).sort((x, y) => y.c.affinity - x.c.affinity).slice(0, 2);
      const names = stronger.map((x) => `${clean(x.c.name)} (${s1(x.c.affinity)})`).join(" and ");
      const allTied = stronger.every((x) => x.c.affinity - a.affinity <= TIE);
      const moreKm = stronger.length ? roadKm(Math.min(...stronger.map((x) => x.km)) - after) : 0;
      const passedOver = !stronger.length ? "" : ` ${names} ${stronger.length === 1 ? "scores" : "score"} ${allTied ? "within a point of it (effectively tied)" : "higher"}${moreKm >= 10 ? ` but ${stronger.length === 1 ? "means" : "each means at least"} ≈ ${moreKm.toLocaleString("en")} km more driving` : ""}.`;
      return { text: `Route check: ${clean(a.name)} scores ${s1(a.affinity)}, above ${clean(r.city.name)} (${s1(r.city.affinity)})${r.stopId === weakest.stopId ? ", the weakest stop" : ""}, and the changed route keeps every leg within a day's drive (${driving}).${passedOver} Proposed: swap it in.`,
        evidence: [...ev, ...stronger.map((x) => x.c.evidence)], kind: "template" };
    }
    if (diff.add.length) return { text: `Route check: adding ${diff.add.map((c) => `${clean(c.name)} (${s1(c.affinity)})`).join(" and ")} keeps every leg within a day's drive (${driving}).`, evidence: ev, kind: "template" };
    return { text: `Proposed: drop ${removed.map((x) => `${clean(x.city.name)} (${s1(x.city.affinity)})`).join(" and ")}, the lowest room affinity on the route (${driving}).`, evidence: ev, kind: "template" };
  }
  // No city change: say which stop is weakest and what the nearby cities scored.
  const pts = located(stops.map((x) => x.city));
  const others = seen.filter((c) => c.lat !== undefined && c.lng !== undefined && !plan.stops.some((x) => sameCity(x.city.name, c.name)));
  const wIndex = stops.indexOf(weakest);
  const far = others.filter((c) => c.affinity - weakest.city.affinity > TIE && !swapFits(pts, wIndex, { lat: c.lat!, lng: c.lng! }).fits).sort((a, b) => b.affinity - a.affinity)[0];
  const tied = others.filter((c) => Math.abs(c.affinity - weakest.city.affinity) <= TIE).sort((a, b) => b.affinity - a.affinity)[0];
  const lower = others.filter((c) => weakest.city.affinity - c.affinity > TIE).sort((a, b) => b.affinity - a.affinity).slice(0, 2);
  const nearestKm = (c: City) => roadKm(Math.min(...pts.map((p) => distanceKm(p, { lat: c.lat!, lng: c.lng! }))));
  const parts = [
    `Route holds: ${clean(weakest.city.name)} (${s1(weakest.city.affinity)}) is the weakest stop, and no stronger city the check scored is within a day's drive.`,
    lower.length ? `${lower.map((c) => `${clean(c.name)} (${s1(c.affinity)})`).join(" and ")} ${lower.length === 1 ? "scores" : "score"} lower.` : "",
    tied ? `${clean(tied.name)} (${s1(tied.affinity)}) is effectively tied with it.` : "",
    far ? `${clean(far.name)} (${s1(far.affinity)}) scores higher but is about ${nearestKm(far).toLocaleString("en")} km by road from the nearest stop.` : "",
  ].filter(Boolean);
  return { text: parts.join(" "), evidence: [weakest.city.evidence, ...[...lower, tied, far].filter((c): c is City => Boolean(c)).map((c) => c.evidence)], kind: "template" };
}

const CHECKING: Record<string, (i: Record<string, any>) => string> = {
  rank_cities: (i) => `ranking ${(i.cities ?? []).join(", ")} against your stops`,
  find_cities: (i) => `looking for fan hotspots in ${i.region}`,
  fan_cluster: (i) => `finding where fans cluster in ${i.city}`,
  find_venues: (i) => `checking rooms in ${i.city}`,
  find_openers: (i) => `looking for openers in ${i.city}`,
  audience_overlap: () => "comparing audiences with an opener",
};

export async function runScout(plan: TourPlan, question: string, model: AgentModel, out: StepSink & { push(e: { type: "checking"; label: string } | Parameters<StepSink["push"]>[0]): void }, signal?: AbortSignal): Promise<FollowUp> {
  const usedIds = [...plan.sources, ...(plan.followUps ?? []).flatMap((f) => f.sources)].map((s) => Number(s.id.slice(1)));
  const ledger = new EvidenceLedger(Math.max(0, ...usedIds));
  const step = makeStepper(ledger, out, signal);
  const who = plan.artist.proxyOf?.length ? `fans of ${plan.artist.proxyOf.map(clean).join(", ")}` : `${possessive(plan.artist.name)} fans`;
  const stopCities = plan.stops.map((s) => clean(s.city.name));

  // What this session has seen; proposals may only use these.
  const seenCities = new Map<string, City>();
  const seenOpeners = new Map<string, Opener>();
  const openerLookups: OpenerLookup[] = [];
  const openerPopularity = new Map<string, number | undefined>();
  /** The cities whose find_openers results contained each candidate: an opener is evidence for those cities only. */
  const openerCities = new Map<string, string[]>();
  const weakestStop = () => {
    const located = plan.stops.filter((s) => s.city.lat !== undefined && s.city.lng !== undefined);
    const stop = [...located].sort((a, b) => a.city.affinity - b.city.affinity)[0];
    return stop ? { stop, index: located.indexOf(stop), points: located.map((s) => ({ lat: s.city.lat!, lng: s.city.lng! })) } : undefined;
  };
  /** How a city compares with the weakest stop, with the route geometry (the agent must use these facts). */
  const routeTest = (c: City) => {
    const w = weakestStop();
    if (!w || c.lat === undefined || c.lng === undefined || stopCities.some((s) => sameCity(s, c.name))) return undefined;
    const diff = c.affinity - w.stop.city.affinity;
    const fit = swapFits(w.points, w.index, { lat: c.lat, lng: c.lng });
    return { city: clean(c.name), score: score(c.affinity), vs_weakest: diff > TIE ? "stronger" : diff >= -TIE ? "tied" : "weaker",
      swap_keeps_route_drivable: fit.fits, extra_drive_km_by_road: roadKm(fit.extraKm), evidence_id: c.evidence };
  };
  const pins: GhostPin[] = [];
  const remember = (cities: City[]) => {
    for (const c of cities) {
      const key = clean(c.name).toLowerCase();
      seenCities.set(key, c);
      if (!stopCities.some((s) => sameCity(s, c.name)) && c.lat !== undefined && c.lng !== undefined && pins.length < 6 && !pins.some((p) => sameCity(p.name, c.name))) {
        pins.push({ name: clean(c.name), lat: c.lat, lng: c.lng, affinity: c.affinity, evidence: c.evidence });
      }
    }
  };
  let venueTag: string | undefined | null = null;
  const cityCtx = async () => {
    if (venueTag === null) venueTag = await venueTagFor(plan.artist.type, step);
    return { signals: plan.signals, who, venueTag, comedy: plan.artist.type === "person" };
  };

  async function execute(call: ToolCall): Promise<unknown> {
    const i = call.input ?? {};
    const city = typeof i.city === "string" ? i.city.slice(0, 80) : "";
    switch (call.name) {
      case "rank_cities": {
        const asked = (Array.isArray(i.cities) ? i.cities : []).map((c: unknown) => String(c).slice(0, 80)).filter(Boolean).slice(0, 6);
        if (!asked.length) return { error: "Give at least one city." };
        const places = await Promise.all(asked.filter((a: string) => !stopCities.some((c) => sameCity(a, c))).map((c: string) => placeFor(c)));
        const { cities, unscored } = await scoreCities(places, await cityCtx(), step);
        remember(cities);
        const all = [...cities.map((c) => ({ c, on_route: false })), ...plan.stops.map((s) => ({ c: s.city, on_route: true }))].sort((a, b) => b.c.affinity - a.c.affinity);
        const weak = weakestStop();
        return {
          weakest_stop: weak ? { stop_id: weak.stop.stopId, city: clean(weak.stop.city.name), score: score(weak.stop.city.affinity) } : undefined,
          route_check: cities.map((c) => routeTest(c)).filter(Boolean),
          evidence_id: cities[0]?.evidence,
          evidence_ids: [...new Set(cities.map((c) => c.evidence))],
          ranking: all.map((x, k) => ({ rank: k + 1, city: clean(x.c.name), score: score(x.c.affinity), evidence_id: x.c.evidence, on_route: x.on_route, fan_hotspot: Boolean(x.c.hotspot) })),
          no_rooms_found: unscored,
        };
      }
      case "find_cities": {
        const region = typeof i.region === "string" ? i.region.slice(0, 80) : "";
        if (!region) return { error: "Give a region." };
        const onRoute = new Map(plan.stops.map((s) => [clean(s.city.name).toLowerCase(), s.city]));
        const { cities, coverage } = await discoverCities(region, 4, await cityCtx(), step, onRoute);
        if (!cities.length) return { error: `Qloo found no scorable cities for "${region}".` };
        remember(cities);
        return {
          hotspot_evidence_id: coverage.evidence,
          route_check: cities.filter((c) => !stopCities.some((s) => sameCity(s, c.name))).map((c) => routeTest(c)).filter(Boolean),
          cities: cities.map((c) => ({ city: clean(c.name), score: score(c.affinity), evidence_id: c.evidence, fan_hotspot: Boolean(c.hotspot), on_route: stopCities.some((s) => sameCity(s, c.name)) })),
          remote_hotspots_skipped: coverage.remoteCells,
        };
      }
      case "fan_cluster": {
        const place = await placeFor(city);
        const r = await step((v) => `${place.name}: ${v.cells.length} fan map cells`, () => fanHeatmap(plan.signals, place.query, 10), `Where ${who} concentrate in ${place.name}`);
        const top = r?.cells.slice().sort((a, b) => b.affinity - a.affinity)[0];
        if (!r || !top) return { error: `No fan map for ${city}.` };
        const name = await areaName(top.lat, top.lng);
        return { evidence_id: r.source.id, city: place.name, cluster: /^-?\d/.test(name) || sameCity(name, place.name) ? "one part of the city (no local name)" : name, score: score(top.affinity) };
      }
      case "find_venues": {
        const scored = await scoreCity(await placeFor(city), await cityCtx(), step);
        if (!scored) return { error: `No rooms with affinity found in ${city}.` };
        remember([scored]);
        return { evidence_id: scored.evidence, city: clean(scored.name), room_affinity: score(scored.affinity), venues: (scored.rooms ?? []).map((e) => ({ name: clean(e.name), score: score(e.affinity) })) };
      }
      case "find_openers": {
        const r = await step((v) => `${city}: openers ${v.entities.slice(0, 2).map((e) => clean(e.name)).join(", ")}`,
          () => recommend({ targetType: plan.artist.type, signals: plan.signals, signalLocation: city, limit: 8, ...(plan.artist.type === "person" ? { includeTags: COMEDIAN_TAGS, includeTagsOperator: "union" as const } : {}) }), `Similar acts with affinity in ${city}`);
        if (!r) return { error: `No opener candidates in ${city}.` };
        // Same rule as the pipeline: not the act, not a member of it, and (for a known act) not more popular.
        const others = r.entities.filter((e) => !plan.signals.includes(e.id) && !isRelatedAct(e.description, plan.artist.proxyOf?.length ? plan.artist.proxyOf : [plan.artist.name]) && !unlikelyOpener(e.description, plan.artist.type === "person", e.name));
        const cap = plan.artist.popularity ?? (plan.artist.proxyOf?.length ? SMALL_ROOM_POPULARITY : undefined);
        const fitsAct = (e: { popularity?: number }) => cap === undefined || (e.popularity !== undefined && e.popularity <= cap);
        const openers = [...others.filter(fitsAct), ...others.filter((e) => !fitsAct(e)).sort((a, b) => (a.popularity ?? 1) - (b.popularity ?? 1))];
        const current = plan.stops.find((s) => sameCity(s.city.name, city))?.opener?.entityId;
        openerLookups.push({ city, evidence: r.source.id, smallerFound: others.some((e) => fitsAct(e) && e.id !== current) });
        if (!openers.length) return { evidence_id: r.source.id, city, openers: [], note: `0 opener candidates in ${city}: say so; never use another city's results for this stop.` };
        for (const e of openers) {
          if (!seenOpeners.has(e.id)) seenOpeners.set(e.id, { entityId: e.id, name: e.name, affinity: e.affinity, evidence: r.source.id, popularity: e.popularity, sizeCap: cap, oversize: !fitsAct(e) || undefined });
          openerPopularity.set(e.id, e.popularity);
          openerCities.set(e.id, [...(openerCities.get(e.id) ?? []), city]);
        }
        return { evidence_id: r.source.id, city, openers: openers.map((e) => ({ entity_id: e.id, name: clean(e.name), artist_affinity_with_these_fans: score(e.affinity), fits_the_act: cap === undefined || (e.popularity !== undefined && e.popularity <= cap) })),
          note: "artist_affinity is how strongly these fans like that act, not a room score. Only suggest acts with fits_the_act: true (not bigger than the act)." };
      }
      case "audience_overlap": {
        const opener = seenOpeners.get(String(i.entity_id));
        if (!opener) return { error: "Use an entity_id returned by find_openers." };
        const r = await step((v) => `${v.shared.length} shared tastes with ${possessive(opener.name)} audience`, () => compareAudiences(plan.signals, [opener.entityId], 6), `Audience overlap with ${clean(opener.name)}`);
        if (!r) return { error: "Qloo could not compare these audiences." };
        opener.overlap = { shared: r.shared, evidence: r.source.id };
        return { evidence_id: r.source.id, opener: clean(opener.name), shared_tastes: r.shared.map(clean) };
      }
      default:
        return { error: `Unknown tool ${call.name}` };
    }
  }

  const system = SCOUT_RULES;
  const history: AgentMessage[] = [{ role: "user", text: `Plan and request (JSON): ${planBrief(plan, question)}` }];
  // A route check always starts from the same deterministic step: the server scores the touring cities
  // near the route (within a day's drive of a stop) so the agent, and the server's own check, compare the
  // weakest stop against them, whatever the model chooses to look at next.
  if (/^Check this route:/.test(question)) {
    const country = countryOf(plan.inputs.region ?? "United States");
    const located = plan.stops.filter((x) => x.city.lat !== undefined && x.city.lng !== undefined);
    const nearby = MARKETS.filter((m) => (!country || m.country === country) && !stopCities.some((c) => sameCity(c, m.name))
      && located.some((x) => distanceKm({ lat: x.city.lat!, lng: x.city.lng! }, m) <= MAX_LEG_KM * 0.6))
      .sort((a, b) => Math.min(...located.map((x) => distanceKm({ lat: x.city.lat!, lng: x.city.lng! }, a))) - Math.min(...located.map((x) => distanceKm({ lat: x.city.lat!, lng: x.city.lng! }, b))))
      .slice(0, 6).map((m) => m.name);
    if (nearby.length) {
      out.push({ type: "checking", label: `Scout is ranking the cities near your route: ${nearby.join(", ")}…` });
      const pre = await execute({ id: "route-check-0", name: "rank_cities", input: { cities: nearby } });
      const first = history[0] as { role: "user"; text: string };
      first.text += `\n\nServer pre-check: the touring cities near the route, ranked with your stops (a rank_cities result you may cite): ${JSON.stringify(pre)}`;
    }
  }
  const serverChecks = ledger.sources.length;
  let final: Record<string, any> | undefined;
  let fallbackText = "";
  for (let round = 0; round <= MAX_ROUNDS && !final; round++) {
    if (signal?.aborted) break;
    const turn = await model.next(system, history, { forceFinal: round === MAX_ROUNDS });
    history.push({ role: "assistant", turn });
    fallbackText = turn.text || fallbackText;
    const finish = turn.calls.find((c) => c.name === "propose_change");
    if (finish) { final = finish.input; break; }
    if (!turn.calls.length) break;
    for (const call of turn.calls) out.push({ type: "checking", label: `Scout is ${CHECKING[call.name]?.(call.input ?? {}) ?? `running ${call.name}`}…` });
    const results = await Promise.all(turn.calls.map(async (call) => {
      try {
        return { id: call.id, content: JSON.stringify(await execute(call)) };
      } catch (e) {
        return { id: call.id, content: JSON.stringify({ error: (e as Error).message }), isError: true };
      }
    }));
    history.push({ role: "tool_results", results });
  }

  // Validate the proposal against what the session actually saw.
  const validIds = new Set([...plan.sources, ...(plan.followUps ?? []).flatMap((f) => f.sources), ...ledger.sources].map((s) => s.id));
  const { guard, withheld } = insightGuard(validIds, model.name === "scripted", {
    capacity: plan.inputs.capacity, actName: plan.artist.name, emerging: Boolean(plan.artist.proxyOf?.length),
    hotspotCities: plan.stops.filter((s) => s.city.hotspot).map((s) => clean(s.city.name)),
    venues: venueNames(plan.stops),
  });
  // Accept the answer as a string (schema) or an object (older shape); strip stray tool markup the
  // model sometimes leaks; if no evidence list came back, use Q-ids the text itself cites.
  const rawAnswer = typeof final?.answer === "string" ? final.answer : typeof final?.answer?.text === "string" ? final.answer.text : fallbackText;
  const answerText = cleanAnswer(rawAnswer);
  const listed = Array.isArray(final?.evidence) ? final!.evidence : Array.isArray(final?.answer?.evidence) ? final!.answer.evidence : [];
  const evidence = listed.length ? listed : [...rawAnswer.matchAll(/\bQ\d+\b/g)].map((m) => m[0]);
  const modelAnswer = guard("answer", answerText ? { text: answerText, evidence } : undefined);
  if (withheld.length) console.warn(JSON.stringify({ event: "scout_withheld", reasons: withheld.map((w) => w.reason) }));
  const requestedAdds = Array.isArray(final?.add_cities) ? final!.add_cities.length : 0;
  const seenAdds: City[] = (Array.isArray(final?.add_cities) ? final!.add_cities : [])
    .map((name: unknown) => seenCities.get(clean(String(name)).toLowerCase()))
    .filter((c: City | undefined): c is City => Boolean(c) && !stopCities.some((s) => sameCity(s, c!.name)))
    .slice(0, 3);
  // Keep the tour drivable: an added city must be within a day's drive of a stop that stays.
  let add: City[] = seenAdds.filter((c: City) => c.lat === undefined || plan.stops.some((s) => s.city.lat !== undefined && distanceKm({ lat: s.city.lat, lng: s.city.lng! }, { lat: c.lat!, lng: c.lng! }) <= MAX_LEG_KM * 1.25));
  let remove: string[] = (Array.isArray(final?.remove_stop_ids) ? final!.remove_stop_ids : []).map(String).filter((id: string) => plan.stops.some((s) => s.stopId === id));
  // A swap is one change: if a city it adds is too far to drive, the stop it would replace stays too.
  if (add.length < seenAdds.length) { add = []; remove = []; }
  // The changed route as a whole must stay drivable (no leg over the limit in its best order).
  if (add.length) {
    const next = [...plan.stops.filter((x) => !remove.includes(x.stopId)).map((x) => x.city), ...add].filter((c) => c.lat !== undefined && c.lng !== undefined).map((c) => ({ lat: c.lat!, lng: c.lng! }));
    const now = plan.stops.filter((x) => x.city.lat !== undefined && x.city.lng !== undefined).map((x) => ({ lat: x.city.lat!, lng: x.city.lng! }));
    const limit = Math.max(MAX_LEG_KM, now.length > 1 ? Math.max(...legs(now, bestOrder(now))) : 0);
    if (next.length > 1 && Math.max(...legs(next, bestOrder(next))) > limit + 1) { add = []; remove = []; }
  }

  // ---- the agent must obey its own numbers: a stronger city that keeps the route drivable replaces the
  // weakest stop. If the agent said otherwise, the server makes the swap and says why (TEMPLATE).
  const checks: Insight[] = [];
  let overridden = false;
  const w = weakestStop();
  const tested = [...seenCities.values()].map((c) => ({ c, t: routeTest(c) })).filter((x): x is { c: City; t: NonNullable<ReturnType<typeof routeTest>> } => Boolean(x.t));
  const better = tested.filter((x) => x.t.vs_weakest === "stronger" && x.t.swap_keeps_route_drivable).sort((a, b) => b.c.affinity - a.c.affinity)[0];
  if (w && better && !add.length && !remove.length) {
    add = [better.c];
    remove = [w.stop.stopId];
    overridden = true;
  }
  // A tie with the weakest stop is worth a note, unless the proposal removes that stop anyway.
  const tie = tested.find((x) => x.t.vs_weakest === "tied" && x.t.swap_keeps_route_drivable && !add.some((a) => sameCity(a.name, x.c.name)));
  if (w && tie && !remove.includes(w.stop.stopId) && !/\btie|tied|about (the )?same|about equal|effectively equal/i.test(String(final?.answer ?? ""))) {
    checks.push({ text: `${clean(tie.c.name)} (${score(tie.c.affinity)}) and ${clean(w.stop.city.name)} (${score(w.stop.city.affinity)}) are effectively tied; either works for the route.`, evidence: [tie.c.evidence, w.stop.city.evidence], kind: "template" });
  }

  // ---- openers: evidence from that stop's own city search, not already on the plan, sized to the act.
  const openerStop = final?.set_opener ? String(final.set_opener.stop_id) : undefined;
  const capPop = plan.artist.popularity ?? (plan.artist.proxyOf?.length ? SMALL_ROOM_POPULARITY : undefined);
  const fits = (id: string) => capPop === undefined || ((openerPopularity.get(id) ?? 1) <= capPop);
  const pickedId = final?.set_opener ? String(final.set_opener.entity_id) : "";
  const target = openerStop ? plan.stops.find((x) => x.stopId === openerStop) : undefined;
  const current = target?.opener;
  const curPop = current ? (openerPopularity.get(current.entityId) ?? current.popularity) : undefined;
  const pickPop = openerPopularity.get(pickedId);
  const localFits = target ? [...openerCities.entries()].filter(([id, cs]) => cs.some((c) => sameCity(c, target.city.name)) && fits(id)) : [];
  // When nothing local fits the size cap, a change may only move to a smaller act than the current one.
  const tooBig = Boolean(pickedId) && !fits(pickedId) && (localFits.length > 0 || curPop === undefined || (pickPop ?? 1) >= curPop);
  const local = Boolean(target) && (openerCities.get(pickedId) ?? []).some((c) => sameCity(c, target!.city.name));
  const noOp = current?.entityId === pickedId;
  const duplicate = plan.stops.some((x) => x.stopId !== openerStop && x.opener?.entityId === pickedId);
  let openerPick = target && local && !tooBig && !noOp && !duplicate && !remove.includes(openerStop!) ? seenOpeners.get(pickedId) : undefined;
  // The same realism rule as the plan: no supergroup, and no actor-first person for a comedian.
  if (openerPick && unlikelyOpener(await describedAs({ id: openerPick.entityId, name: openerPick.name }, plan.artist.type, step), plan.artist.type === "person", openerPick.name)) openerPick = undefined;
  const resulting = plan.stops.length - remove.length + add.length;
  const valid = (add.length || remove.length || openerPick) && resulting >= 2 && resulting <= 6;
  const role = plan.artist.proxyOf?.length ? "support slot with" : plan.artist.type === "person" ? "feature act" : "opener";
  const proposal: PlanDiff | undefined = valid ? {
    add,
    remove,
    opener: openerPick ? { stopId: final!.set_opener.stop_id, opener: openerPick } : undefined,
    summary: [
      ...diffSummary(plan, add, remove),
      ...(openerPick ? [`${role} → ${clean(openerPick.name)}`] : []),
    ].join(" · "),
  } : undefined;
  if (overridden) console.warn(JSON.stringify({ event: "route_check_override", add: add.map((c) => c.name), remove }));

  // The answer must describe the final proposal. A model answer that contradicts the server's route
  // check is replaced; a withheld model answer, and every scripted (no-AI) answer about the route, is
  // code-written from the final proposal and the cities the check saw (TEMPLATE), with its numbers.
  const o = proposal?.opener?.opener;
  const where = proposal?.opener ? clean(plan.stops.find((x) => x.stopId === proposal.opener!.stopId)!.city.name) : "";
  const openerLine = o ? `For ${where}: ${plan.artist.proxyOf?.length ? `a support slot with ${clean(o.name)}` : `${clean(o.name)} as ${role}`}${fits(o.entityId) && capPop !== undefined ? ", an act within the size fit," : ""} whose fans share tastes with this audience${o.overlap?.shared.length ? ` (${o.overlap.shared.slice(0, 4).join(", ")})` : ""}.` : "";
  const routeQuestion = /^Check this route:/.test(question);
  const cityChange = Boolean(proposal && (proposal.add.length || proposal.remove.length));
  const scriptedFewer = model.name === "scripted" && !requestedAdds && cityChange && !overridden;
  const verdict = (cityChange || routeQuestion) && !scriptedFewer ? routeVerdict(plan, [...seenCities.values()], proposal) : undefined;
  // On a route check the verdict is always code-written from the numbers; the agent's own words are kept as its note.
  const useModel = !overridden && modelAnswer && !(routeQuestion && verdict) && (model.name !== "scripted" || scriptedFewer || (!verdict && !requestedAdds));
  const answer: Insight = useModel ? modelAnswer! : verdict ? { ...verdict, text: [verdict.text, openerLine].filter(Boolean).join(" "), evidence: [...new Set([...verdict.evidence, o?.evidence, o?.overlap?.evidence].filter((x): x is string => Boolean(x)))] }
    : o ? { text: `Suggested change: ${openerLine}`, evidence: [o.evidence, o.overlap?.evidence].filter((x): x is string => Boolean(x)), kind: "template" }
    : { text: "The scout could not support an answer with the data it found.", evidence: [], kind: "template" };
  const openerCheck = routeQuestion ? openerCheckLine(plan, openerLookups, Boolean(proposal?.opener), proposal) : undefined;
  if (openerCheck) checks.push(openerCheck);
  // The agent's own words, kept visible when the verdict shown is code-written: its first sentence,
  // guarded again on its own, or the guard's reason if its answer was withheld. Never for a scripted agent.
  const ai = model.name !== "scripted";
  const note = ai && modelAnswer && answer !== modelAnswer ? agentOneLine(modelAnswer, guard) : undefined;
  const noteWithheld = ai && !modelAnswer && answerText ? withheld.find((x) => x.field === "answer")?.reason : undefined;
  return { kind: "agent", question, answer, checks: checks.length ? checks : undefined, pins, proposal, sources: ledger.sources, askedAt: new Date().toISOString(), by: model.name, serverChecks: serverChecks || undefined,
    ...(cityChange ? { proposedBy: overridden ? "server" as const : "agent" as const } : {}),
    ...(note ? { agentNote: note } : {}), ...(noteWithheld ? { agentNoteWithheld: noteWithheld } : {}) };
}

/** The first sentence (two when the first is short) of the agent's answer (at most ~220 characters), re-guarded on its own. */
export function agentOneLine(item: Insight, guard: (field: string, value: unknown) => Insight | undefined): Insight | undefined {
  const text = item.text.replace(/\s+/g, " ").trim();
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const first = parts[0].length < 60 && parts[1] ? `${parts[0]} ${parts[1]}` : parts[0];
  const line = first.length > 220 ? `${first.slice(0, 217).replace(/\s+\S*$/, "")}…` : first;
  const cited = item.evidence.filter((id) => line.includes(id));
  return guard("agent note", { text: line, evidence: cited.length ? cited : item.evidence });
}

