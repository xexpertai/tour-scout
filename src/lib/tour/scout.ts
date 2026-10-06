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
import Anthropic from "@anthropic-ai/sdk";
import { EvidenceLedger } from "../evidence.ts";
import { areaName } from "../geo.ts";
import { insightGuard } from "../guard.ts";
import { CLAUDE_MODEL, LlmError, logUsage, takeDailyBudget } from "../llm.ts";
import { compareAudiences, rankOptions, recommend, signalHeatmap, wherePopular, type QEntity } from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import { makeStepper, toCity, venueTagFor, type StepSink } from "./pipeline.ts";
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
  { name: "rank_cities", description: "Rank up to 6 cities against the plan's current stops by the fans' Qloo affinity (0–100). Use to compare a new city with the route.",
    input_schema: { type: "object", properties: { cities: { type: "array", items: str, maxItems: 6 } }, required: ["cities"] } },
  { name: "find_cities", description: "Discover the cities in a country or region with the strongest affinity for these fans (Qloo locality recommendations).",
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
- Only propose cities that appeared in a rank_cities or find_cities result, and only remove existing stop_ids. Keep 2–6 stops.
- Scores are Qloo fan affinity on a 0–100 scale for ranking places against each other. Never present them as attendance, ticket sales, certainty, cause, or a prediction about any individual. Never forecast turnout.
- Never state or imply income, wealth, class or sensitive traits of fans or places. Never invent venues, places, artists or numbers.
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
          answer: `For a ${fewer}-stop run, drop the stops with the lowest fan affinity: ${drop.map((s) => `${clean(s.city.name)} (${score(s.city.affinity)})`).join(", ")}.`,
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
      const rankEvidence: string = results.find((r) => r.ranking)?.evidence_id;
      const best = ranking.find((c) => !c.on_route);
      const weakScore = ranking.find((c) => clean(c.city).toLowerCase() === clean(weakest.city.name).toLowerCase())?.score;
      const opener = results.find((r) => r.openers)?.openers?.[0];
      const openerEvidence: string | undefined = results.find((r) => r.openers)?.evidence_id;
      const swap = best && weakScore !== undefined && best.score > weakScore;
      const parts = [
        swap ? `${best.city} scores ${best.score} out of 100, above ${clean(weakest.city.name)} (${weakScore}), so swapping it in strengthens the route.`
          : best ? `${best.city} scores ${best.score}, which does not beat your current stops, so the route stays as is.` : "No stronger city came up in this region.",
        opener ? `For ${clean((named ?? plan.stops[0]).city.name)}, ${clean(opener.name)} is a possible opener (${opener.score}).` : "",
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

// ---------------------------------------------------------------- the loop
const score = (n?: number) => (n === undefined ? null : Math.round(n * 100));
const sameCity = (a: string, b: string) => clean(a).toLowerCase() === clean(b).toLowerCase();

function planBrief(plan: TourPlan, question: string): string {
  return JSON.stringify({
    request: question,
    act: { name: clean(plan.artist.name), type: plan.artist.type, sounds_like: plan.artist.proxyOf?.map(clean) },
    region: plan.inputs.region ?? null,
    stops: plan.stops.map((s) => ({ stop_id: s.stopId, order: s.order, city: clean(s.city.name), score: score(s.city.affinity), opener: s.opener ? clean(s.opener.name) : null })),
  });
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
  const isArtistMode = !plan.artist.proxyOf?.length;
  const stopCities = plan.stops.map((s) => clean(s.city.name));

  // What this session has seen; proposals may only use these.
  const seenCities = new Map<string, City>();
  const seenOpeners = new Map<string, Opener>();
  const pins: GhostPin[] = [];
  // Scores from rank_cities compare cities with the stops directly, so they override earlier ones.
  const rankedScores = new Map<string, { affinity: number; evidence: string }>();
  const remember = async (entities: QEntity[], evidence: string, fromRank = false) => {
    for (const e of entities) {
      const key = clean(e.name).toLowerCase();
      if (fromRank) rankedScores.set(key, { affinity: e.affinity ?? 0, evidence });
      const known = seenCities.get(key);
      if (known) {
        if (fromRank) seenCities.set(key, { ...known, affinity: e.affinity ?? known.affinity, evidence });
        continue;
      }
      const city = await toCity(e, evidence);
      seenCities.set(key, city);
      if (!stopCities.some((c) => sameCity(c, e.name)) && city.lat !== undefined && city.lng !== undefined && pins.length < 6) {
        pins.push({ name: clean(e.name), lat: city.lat, lng: city.lng, affinity: city.affinity, evidence });
      }
    }
  };

  async function execute(call: ToolCall): Promise<unknown> {
    const i = call.input ?? {};
    const city = typeof i.city === "string" ? i.city.slice(0, 80) : "";
    switch (call.name) {
      case "rank_cities": {
        const asked = (Array.isArray(i.cities) ? i.cities : []).map((c: unknown) => String(c).slice(0, 80)).filter(Boolean).slice(0, 6);
        if (!asked.length) return { error: "Give at least one city." };
        const options = [...asked, ...stopCities.filter((c) => !asked.some((a: string) => sameCity(a, c)))];
        const r = await step((v) => `Ranked ${v.entities.length} cities for ${who}`, () => rankOptions({ options, optionType: "locality", signals: plan.signals }), `${asked.join(", ")} ranked against your stops for ${who}`);
        if (!r) return { error: "Qloo could not rank these cities." };
        await remember(r.entities, r.source.id, true);
        return { evidence_id: r.source.id, ranking: r.entities.map((e, k) => ({ rank: k + 1, city: clean(e.name), score: score(e.affinity), on_route: stopCities.some((c) => sameCity(c, e.name)) })) };
      }
      case "find_cities": {
        const region = typeof i.region === "string" ? i.region.slice(0, 80) : "";
        const r = await step((v) => `Fan hotspots in ${region}: ${v.entities.slice(0, 3).map((e) => clean(e.name)).join(", ")}`,
          () => recommend({ targetType: "locality", signals: plan.signals, filterLocation: region, limit: 8 }), `Cities in ${region} ranked by ${who}`);
        if (!r) return { error: `Qloo found no cities for "${region}".` };
        await remember(r.entities, r.source.id);
        return { evidence_id: r.source.id, cities: r.entities.map((e) => ({ city: clean(e.name), score: score(e.affinity), on_route: stopCities.some((c) => sameCity(c, e.name)) })) };
      }
      case "fan_cluster": {
        const r = await step((v) => `${city}: ${v.cells.length} fan map cells`,
          () => (isArtistMode ? wherePopular(plan.signals[0], city, 10) : signalHeatmap({ location: city, entityIds: plan.signals })), `Where ${who} concentrate in ${city}`);
        const top = r?.cells.slice().sort((a, b) => b.affinity - a.affinity)[0];
        if (!r || !top) return { error: `No fan map for ${city}.` };
        const name = await areaName(top.lat, top.lng);
        return { evidence_id: r.source.id, city, cluster: /^-?\d/.test(name) || sameCity(name, city) ? "one part of the city (no local name)" : name, score: score(top.affinity) };
      }
      case "find_venues": {
        const venueTag = await venueTagFor(plan.artist.type, step);
        const r = await step((v) => `${city}: ${v.entities.length} rooms`, () => recommend({ targetType: "place", signals: plan.signals, includeTags: venueTag ? [venueTag] : undefined, filterLocation: city, limit: 4 }), `Venues in ${city} with affinity for ${who}`);
        if (!r) return { error: `No venues found in ${city}.` };
        return { evidence_id: r.source.id, venues: r.entities.map((e) => ({ name: clean(e.name), score: score(e.affinity) })) };
      }
      case "find_openers": {
        const r = await step((v) => `${city}: openers ${v.entities.slice(0, 2).map((e) => clean(e.name)).join(", ")}`,
          () => recommend({ targetType: plan.artist.type, signals: plan.signals, signalLocation: city, limit: 5 }), `Similar acts with affinity in ${city}`);
        if (!r) return { error: `No opener candidates in ${city}.` };
        const openers = r.entities.filter((e) => !plan.signals.includes(e.id));
        for (const e of openers) seenOpeners.set(e.id, { entityId: e.id, name: e.name, affinity: e.affinity, evidence: r.source.id });
        return { evidence_id: r.source.id, city, openers: openers.map((e) => ({ entity_id: e.id, name: clean(e.name), score: score(e.affinity) })) };
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
  const { guard } = insightGuard(validIds, model.name === "scripted");
  // Accept the answer as a string (schema) or an object (older shape); strip stray tool markup the
  // model sometimes leaks; if no evidence list came back, use Q-ids the text itself cites.
  const rawAnswer = typeof final?.answer === "string" ? final.answer : typeof final?.answer?.text === "string" ? final.answer.text : fallbackText;
  const answerText = rawAnswer.replace(/<\/?(?:parameter|invoke|antml:[a-z_]+)[^>]*>/gi, "").trim();
  const listed = Array.isArray(final?.evidence) ? final!.evidence : Array.isArray(final?.answer?.evidence) ? final!.answer.evidence : [];
  const evidence = listed.length ? listed : [...answerText.matchAll(/\bQ\d+\b/g)].map((m) => m[0]);
  const answer = guard("answer", answerText ? { text: answerText, evidence } : undefined)
    ?? { text: "The scout could not support an answer with the data it found.", evidence: [], kind: "template" as const };
  const add = (Array.isArray(final?.add_cities) ? final!.add_cities : [])
    .map((name: unknown) => seenCities.get(clean(String(name)).toLowerCase()))
    .filter((c: City | undefined): c is City => Boolean(c) && !stopCities.some((s) => sameCity(s, c!.name)))
    .slice(0, 3);
  const remove = (Array.isArray(final?.remove_stop_ids) ? final!.remove_stop_ids : []).map(String).filter((id: string) => plan.stops.some((s) => s.stopId === id));
  // An opener can only be set on a stop that stays in the plan.
  const openerStop = final?.set_opener ? String(final.set_opener.stop_id) : undefined;
  const openerPick = openerStop && plan.stops.some((s) => s.stopId === openerStop) && !remove.includes(openerStop) ? seenOpeners.get(String(final!.set_opener.entity_id)) : undefined;
  const resulting = plan.stops.length - remove.length + add.length;
  const valid = (add.length || remove.length || openerPick) && resulting >= 2 && resulting <= 6;
  const scoreOf = (id: string) => {
    const stop = plan.stops.find((s) => s.stopId === id)!;
    return score(rankedScores.get(clean(stop.city.name).toLowerCase())?.affinity ?? stop.city.affinity);
  };
  const proposal: PlanDiff | undefined = valid ? {
    add,
    remove,
    opener: openerPick ? { stopId: final!.set_opener.stop_id, opener: openerPick } : undefined,
    summary: [
      ...add.map((c: City) => `+ ${clean(c.name)} (${score(c.affinity)})`),
      ...remove.map((id: string) => `− ${clean(plan.stops.find((s) => s.stopId === id)!.city.name)} (${scoreOf(id)})`),
      ...(openerPick ? [`opener → ${clean(openerPick.name)}`] : []),
    ].join(" · "),
  } : undefined;

  return { kind: "agent", question, answer, pins, proposal, sources: ledger.sources, askedAt: new Date().toISOString(), by: model.name };
}
