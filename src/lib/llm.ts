/**
 * Phase B synthesis behind one provider-agnostic interface: a single model call turns the compact
 * evidence ledger into interpretation text (with cited Q-ids). Providers: Claude, Gemini, scripted.
 *
 * LLM_PROVIDER=claude|gemini|scripted picks the primary (default scripted, so development spends no
 * model credit). A failing primary falls back to the next configured provider, then to scripted.
 * LLM_DAILY_CAP bounds model calls per UTC day (default 40) and LLM_SPEND_CAP_USD the total spend
 * (default $4, persisted); token counts and cost are logged per call. Past either, text is templated.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GEMINI_MODEL, GeminiError, interact } from "./gemini.ts";
import { possessive } from "./text.ts";

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

/** What the model sees: Qloo values with their evidence ids, never raw responses. */
export type SynthesisInput = {
  artist: { name: string; arenaScale: boolean; proxyOf?: string[] };
  capacity?: [number, number];
  fan: { tags: string[]; tagsEvidence?: string; demographics?: string; demographicsEvidence?: string; alsoLikes: { domain: string; items: string[]; evidence: string }[] };
  /**
   * affinity is the city's best room affinity: Qloo's score (scaled to 0–100, as the UI shows) for
   * the audience and the city's best-matching live room. fanHotspot marks cities near a cell of the
   * country-wide fan heatmap.
   */
  stops: { stop_id: string; city: string; affinity: number; evidence: string; fanHotspot?: boolean; hotspotEvidence?: string; cluster?: string; clusterEvidence?: string; venues: string[]; venuesEvidence?: string;
    /** The room the pitch is addressed to (the stop's first room) and the town it is in. */
    pitchTo?: { venue: string; town?: string };
    /** The city's rank among all scored cities (1 = best) and how many were scored. */
    rank?: number; of?: number; opener?: string; openerEvidence?: string; shared?: string[]; sharedEvidence?: string }[];
  /** The route in driving order (city names) and its weakest stop, so text about the route's span is right. */
  route?: { order: string[]; weakest?: string };
};

type RawInsight = { text: string; evidence: string[] };
export type RawSynthesis = {
  summary?: RawInsight;
  stops?: { stop_id: string; why?: RawInsight; pitch?: RawInsight }[];
  theme?: RawInsight[];
  merch?: RawInsight[];
  risks?: RawInsight[];
};

/** Receives the partially parsed plan while a provider streams; entries may be incomplete. */
export type PartialHandler = (snapshot: RawSynthesis) => void;

export interface SynthesisProvider {
  readonly name: "gemini" | "claude" | "scripted";
  synthesize(input: SynthesisInput, onPartial?: PartialHandler): Promise<RawSynthesis>;
}

export class LlmError extends Error {
  readonly code: "LLM_QUOTA" | "LLM_UNAVAILABLE" | "LLM_CONFIG" | "LLM_BAD_OUTPUT";
  constructor(message: string, code: LlmError["code"]) {
    super(message);
    this.code = code;
  }
}

export const SYNTHESIS_RULES = `You write a tour plan for an indie artist or comedian from Qloo taste data.
Rules:
- Use only the data provided. Never name venues, neighbourhoods, artists or brands that are not in it.
- Qloo values are aggregate taste affinity. Never present them as attendance, ticket sales, a certainty, a cause, or a prediction about any individual. Never forecast turnout or sell-outs.
- Never state or imply income, wealth, class, or sensitive traits (religion, caste, ethnicity, health, politics) of fans or places.
- Every item cites the evidence ids (Q1, Q2, …) it relies on. Use an empty list only for general touring advice no data supports.
- If capacity is not in the data, never mention a room size, capacity or headcount number at all.
- Capacity, if given, is the artist's own target and is not Qloo data. Mention it at most once per pitch, exactly as: "We're looking at rooms of A–B (our own target)." Qloo has no venue capacity: never link the capacity to a venue, neighbourhood or programme, and never say anything fits, matches, suits or supports it.
- Openers are suggestions from Qloo data, not bookings: write "a suggested opener" or "we'd like to approach X to open"; never "partnered with", "joins" or "opens" as if confirmed.
- Refer to the artist by name or as "they"; never assume gender, age or identity.
- Describe audience overlap as shared tastes, naming the shared items; never quantify it ("significantly", "most fans") unless a number is provided.
- Describe the audience only through the provided tags and affinities; do not invent traits (e.g. "collectors", "students").
- If the act is arena-scale, say the plan shows where the fans are, but the suggested rooms are clubs and theatres this audience favours, not arena-sized venues.
- A stop's affinity (0–100) is its best room affinity: how strongly the act's audience lines up with the city's best-matching live room. Quote it exactly as given (one decimal, e.g. 88.4) and call it room affinity. fanHotspot: true means Qloo's country-wide heatmap puts a fan hotspot near that city (cite hotspotEvidence); say "near a Qloo fan hotspot", never "confirmed".
- Demographic values are relative over/under-index scores, not percentages.
- Mention demographics only as Qloo's aggregate index with the exact bucket and value, e.g. "ages 45–54 over-index (+0.53)". Never characterise the audience by gender or age ("skews male", "older crowd", "mostly women").
- Demographics describe the whole audience nationally, in aggregate; they are not per city. Never attribute them to a city, never say a group "dominates", and never recommend targeting, excluding, framing for or marketing to an age or gender group.
- If artist.proxyOf is set, the act is new and has no Qloo data of its own and NO audience of its own: describe the audience as "fans of <proxyOf names>", never as the act's own fans, audience or tags (never "<act> is a new act whose audience…", "<act>'s fans", "our audience", "shares tastes with ours"), and never describe the new act's own music, style or values. In that case a stop's "opener" is an act the new act could ask to support (a support slot: the new act opens for them), never an act opening for the new act.
- If no stop has fanHotspot: true, the cities were found by room affinity, not by a fan map: never say fans cluster, concentrate, gather or are densest in these cities; say Qloo's room data ranks them.
- Never use he, she, his or her for the act; use its name or "they".
- Never call anything "confirmed"; Qloo shows taste affinity, not confirmed demand.
- Never call the route's weakest stop, or a stop in the bottom third of the scored cities, "strong", "best", "top" or "ideal"; give its rank instead (the facts block says which stops these are).
- Never call the route's cities as a group "the strongest", "top" or "best" markets unless every stop ranks in the top third of the scored cities.
- Where fans concentrate in a city comes from Qloo's fan heatmap; rooms come from room affinity. Never say room data shows where fans concentrate.
- Never state absolutes about the world ("no stronger city exists", "the only market"): the data covers only the cities Qloo scored for this plan.
- If you name the route's span, name its first and last stop exactly as in ROUTE ORDER ("from <first> to <last>").
- Never say every stop or each city has fans, hosts fans or is near a hotspot unless every stop has fanHotspot: true.
- Risks are about touring and the limits of this data (affinity is not demand, rooms unconfirmed, routing, dates, competing shows); never about an audience group.
- The pitch is an email a booker could receive today. Address it to the room in pitchTo ("Hi <venue> team,"), and name its town (pitchTo.town) if given; never place a room in the fans' cluster neighbourhood (the cluster is where fans concentrate, not where rooms are).
- In the pitch, never quote affinity numbers, scores, evidence ids or the words "room affinity": say what Qloo's taste data shows in plain words (e.g. "Qloo's taste data ranks <city> among the strongest cities for this audience").
- End the pitch with a clear ask for a date, and keep these placeholders exactly, for the sender to fill in: [dates], [draw / last play in the area], [ticket price], [links].
Write, in this order: a summary (at most 2 sentences); for each stop a "why" (at most 40 words) and a pitch email to that room's booker (a "Subject:" line, then at most 110 words, grounded in the stop's data and the fan profile); exactly 3 show-theme ideas; exactly 3 merch ideas; 3 risks. Keep every item short.`;

const insight = { type: "object", properties: { text: { type: "string" }, evidence: { type: "array", items: { type: "string" } } }, required: ["text", "evidence"] };
export const SUBMIT_TOUR_SCHEMA = {
  type: "object",
  properties: {
    summary: insight,
    stops: { type: "array", items: { type: "object", properties: { stop_id: { type: "string" }, why: insight, pitch: insight }, required: ["stop_id", "why", "pitch"] } },
    theme: { type: "array", items: insight },
    merch: { type: "array", items: insight },
    risks: { type: "array", items: insight },
  },
  required: ["summary", "stops", "theme", "merch", "risks"],
};
const SUBMIT_TOUR = { name: "submit_tour", description: "Submit the tour plan text. Call exactly once." };
/**
 * The model gets an explicit "facts allowed" block per stop and a pitch skeleton, so it writes from
 * what is true for this plan instead of from habit (it otherwise invented hotspots and described a
 * fictional act's music).
 */
/** The route's weakest stop, or one in the bottom third of the scored cities (the guard withholds "strong" for these). */
const lowStop = (input: SynthesisInput, s: SynthesisInput["stops"][number]) =>
  s.city === input.route?.weakest || (s.rank !== undefined && s.of !== undefined && s.rank > Math.ceil((s.of * 2) / 3));

export function factsBlock(input: SynthesisInput): string {
  const emerging = Boolean(input.artist.proxyOf?.length);
  const who = emerging ? `fans of ${input.artist.proxyOf!.join(" and ")}` : `${input.artist.name}'s audience`;
  const hotspots = input.stops.filter((s) => s.fanHotspot).length;
  const lines = [
    ...(input.route?.order.length ? [`ROUTE ORDER: ${input.route.order.join(" → ")} (the route runs from ${input.route.order[0]} to ${input.route.order.at(-1)}).`] : []),
    `FAN HOTSPOTS: ${hotspots} of ${input.stops.length} stops are near one${hotspots < input.stops.length ? " (never say every stop or each city has fans or a hotspot)" : ""}.`,
    `RULES FOR THIS PLAN: no absolutes about cities Qloo did not score; ${emerging ? `${input.artist.name} has no audience of its own (write "fans of ${input.artist.proxyOf!.join(" and ")}")` : "describe the audience only through its tags"}; never call a weak stop strong.`,
    `ACT: ${input.artist.name}. ${emerging
      ? `A new act unknown to Qloo. Qloo knows nothing about its music. Write only about the AUDIENCE: ${who}. Never describe ${input.artist.name}'s sound, songwriting, style or values.`
      : `Describe the audience through its tags; do not invent facts about the act.`} Refer to the act by name or "they", never he/she.`,
    `AUDIENCE TAGS: ${input.fan.tags.join(", ") || "(none)"}`,
    ...input.stops.map((s) => [
      `STOP ${s.stop_id} ${s.city}: ranks #${s.rank ?? "?"} of ${s.of ?? "?"} scored cities${s.rank && s.rank <= 3 ? " (you may say 'among the strongest')" : lowStop(input, s) ? " (the weakest or a bottom-third stop: never call it strong, best, top or ideal; say where it ranks)" : " (never say 'among the strongest' or 'top'; say where it ranks)"}`,
      `  fan hotspot near this city: ${s.fanHotspot ? "YES (you may say it is near a Qloo fan hotspot)" : "NO (never mention a hotspot for this stop)"}`,
      `  fans concentrate around (from Qloo's fan heatmap for the city, not from room data; city-level, not a hotspot): ${s.cluster ?? "(not named)"}`,
      `  pitch goes to: ${s.pitchTo ? `${s.pitchTo.venue}${s.pitchTo.town ? ` in ${s.pitchTo.town}` : ""}` : "(no room)"}; other rooms: ${s.venues.slice(1, 3).join(", ") || "(none)"}`,
      `  ${emerging ? "support-slot idea (the new act would open for them; not bigger than the sounds-like artist)" : "suggested opener (not bigger than the act)"}: ${s.opener ?? "(none)"}${s.shared?.length ? `; shared tastes: ${s.shared.join(", ")}` : ""}`,
    ].join("\n")),
    "",
 ...(emerging ? [
    "PITCH SKELETON (a support-slot request goes to the HEADLINER's team or agent, not the venue; fill the slots; keep the bracketed placeholders exactly):",
    "  Subject: Support slot request: <act> with <support act> in <city>, [their dates]",
    "  Hi <support act> team,",
    "  \"<act> is a new act aimed at fans of <sounds-like artists>: <one sentence on what Qloo shows about THOSE fans and the headliner's fans, naming the shared tastes>.\" (The new act has no Qloo data: never say it has an audience or fans of its own.)",
    "  \"If <support act> plays <city> around [their dates], we'd love to open; <room> is a room these fans favour.\"",
    "  About <act>: [one line about the act]. Draw / last play in the area: [draw / last play in the area]. Links: [links].",
  ] : [
    "PITCH SKELETON (fill the slots; keep the bracketed placeholders exactly):",
    "  Subject: <act> at <room>, [dates]",
    "  Hi <room> team,",
    "  <one sentence on what Qloo's taste data shows about the AUDIENCE in this city, in plain words>",
    "  opener line: \"For support we'd like to approach <opener>, whose fans share <shared tastes>.\"",
    "  Draw / last play in the area: [draw / last play in the area]. Ticket price: [ticket price]. Links: [links].",
    "  Do you have a hold around [dates]?",
  ]),
    "",
    "GOOD pitch line: \"Qloo's taste data shows fans of Joanna Sternberg here favour intimate, introspective indie folk.\"",
    `BAD pitch line: \"${input.artist.name}'s honest songwriting connects with Burlington fans near a Qloo fan hotspot (room affinity 94.1).\" (describes the act, may claim a hotspot, quotes a score)`,
  ];
  return lines.join("\n");
}
const userContent = (input: SynthesisInput) => `Facts allowed:\n${factsBlock(input)}\n\nTour data (JSON):\n${JSON.stringify(input)}\n\nCall submit_tour with the plan.`;

// ---------------------------------------------------------------- Gemini (Interactions API)
const geminiProvider: SynthesisProvider = {
  name: "gemini",
  async synthesize(input) {
    if (!process.env.GEMINI_API_KEY) throw new LlmError("GEMINI_API_KEY is not set", "LLM_CONFIG");
    takeDailyBudget();
    try {
      // The rules are also in the input so they apply even if the model ignores system_instruction.
      const turn = await interact({
        input: `${SYNTHESIS_RULES}\n\n${userContent(input)}`,
        instructions: SYNTHESIS_RULES,
        tools: [{ type: "function", ...SUBMIT_TOUR, parameters: SUBMIT_TOUR_SCHEMA }],
      });
      logUsage("gemini", GEMINI_MODEL, {});
      const callArgs = turn.calls.find((c) => c.name === SUBMIT_TOUR.name)?.arguments;
      if (callArgs) return callArgs as RawSynthesis;
      const json = turn.text.match(/\{[\s\S]*\}/)?.[0];
      if (json) return JSON.parse(json) as RawSynthesis;
      throw new LlmError("Gemini returned no tour plan", "LLM_BAD_OUTPUT");
    } catch (e) {
      if (e instanceof GeminiError) {
        throw new LlmError(e.message, e.code === "GEMINI_QUOTA" ? "LLM_QUOTA" : e.code === "GEMINI_UNAVAILABLE" ? "LLM_UNAVAILABLE" : "LLM_CONFIG");
      }
      throw e;
    }
  },
};

/**
 * With eager input streaming the API does not validate tool input, and Haiku occasionally returns a
 * degenerate payload (e.g. `summary: {text: "text"}` and no stop text). A usable plan has a real
 * summary and why + pitch text for at least half the stops.
 */
export function usableSynthesis(raw: RawSynthesis, stopIds: string[]): boolean {
  const real = (i?: RawInsight) => typeof i?.text === "string" && i.text.trim().length >= 25;
  const stops = Array.isArray(raw.stops) ? raw.stops : [];
  const written = stopIds.filter((id) => stops.some((s) => String(s?.stop_id) === id && real(s.why) && real(s.pitch))).length;
  return real(raw.summary) && written * 2 >= stopIds.length;
}

// ---------------------------------------------------------------- Claude (Messages API)
const claudeProvider: SynthesisProvider = {
  name: "claude",
  async synthesize(input, onPartial) {
    const ids = input.stops.map((s) => s.stop_id);
    // One retry when the streamed tool input arrives malformed (the SDK fails to parse it) or is unusable.
    const first = await claudeOnce(input, onPartial).catch((e) => {
      if (e instanceof LlmError) throw e;
      return undefined;
    });
    if (first && usableSynthesis(first, ids)) return first;
    console.warn(JSON.stringify({ event: "llm_bad_output", provider: "claude", model: CLAUDE_MODEL, retry: true }));
    const second = await claudeOnce(input, onPartial);
    if (usableSynthesis(second, ids)) return second;
    throw new LlmError("Claude returned an incomplete tour plan twice", "LLM_BAD_OUTPUT");
  },
};

async function claudeOnce(input: SynthesisInput, onPartial?: PartialHandler): Promise<RawSynthesis> {
  {
    // The key is deliberately not ANTHROPIC_API_KEY, so no other tool picks it up; pass it explicitly.
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new LlmError("CLAUDE_API_KEY is not set", "LLM_CONFIG");
    takeDailyBudget();
    // The SDK retries 408/409/429/5xx twice with backoff before raising.
    const client = new Anthropic({ apiKey, timeout: 60_000 });
    try {
      // Streamed so each stop's text can reach the UI as soon as it is written.
      const stream = client.messages.stream({
        model: CLAUDE_MODEL,
        max_tokens: 8000,
        system: SYNTHESIS_RULES,
        // eager_input_streaming sends tool input as it is generated instead of in one burst at the end.
        tools: [{ ...SUBMIT_TOUR, input_schema: SUBMIT_TOUR_SCHEMA as Anthropic.Tool.InputSchema, eager_input_streaming: true }],
        // Forced tool use returns the plan as schema-shaped JSON (supported on Claude Haiku 4.5).
        tool_choice: { type: "tool", name: SUBMIT_TOUR.name },
        messages: [{ role: "user", content: userContent(input) }],
      });
      if (onPartial) stream.on("inputJson", (_delta, snapshot) => onPartial((snapshot ?? {}) as RawSynthesis));
      const response = await stream.finalMessage();
      logUsage("claude", CLAUDE_MODEL, { input: response.usage.input_tokens, output: response.usage.output_tokens });
      // With eager streaming the API does not validate the input; the plan assembly treats every field defensively.
      if (response.stop_reason === "max_tokens") throw new LlmError("Claude's reply was cut off", "LLM_BAD_OUTPUT");
      if (response.stop_reason === "refusal") throw new LlmError("Claude declined to write this plan", "LLM_BAD_OUTPUT");
      const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_TOUR.name);
      if (!block || typeof block.input !== "object" || block.input === null) throw new LlmError("Claude returned no tour plan", "LLM_BAD_OUTPUT");
      return block.input as RawSynthesis;
    } catch (e) {
      // Status and error type only: never prompt, output or credentials.
      console.warn(JSON.stringify({ event: "llm_error", provider: "claude", model: CLAUDE_MODEL, status: (e as { status?: number }).status, type: (e as Error).constructor?.name ?? (e as Error).name, message: String((e as Error).message ?? "").slice(0, 160) }));
      if (e instanceof LlmError) throw e;
      if (e instanceof Anthropic.RateLimitError) throw new LlmError("The AI model's rate limit is reached.", "LLM_QUOTA");
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new LlmError("The Claude API key is missing or invalid.", "LLM_CONFIG");
      if (e instanceof Anthropic.BadRequestError) throw new LlmError(`Claude rejected the request: ${e.message}`, "LLM_CONFIG");
      if (e instanceof Anthropic.APIError) throw new LlmError("The AI model is busy right now.", "LLM_UNAVAILABLE");
      throw e;
    }
  }
}

// ---------------------------------------------------------------- scripted (no model)
/** A booking email a booker could act on: addressed to the room, plain words, a clear ask, placeholders to fill. */
export function templatePitch(input: SynthesisInput, s: SynthesisInput["stops"][number], name: string): string {
  const room = s.pitchTo?.venue ? clean(s.pitchTo.venue) : undefined;
  const strongest = s.rank !== undefined && s.rank <= 3;
  const rankLine = strongest ? `ranks ${clean(s.city)} among the strongest cities for` : s.rank !== undefined && s.of ? `ranks ${clean(s.city)} #${s.rank} of ${s.of} scored cities for` : `shows affinity in ${clean(s.city)} for`;
  // A support slot is the headliner's to give: the request goes to their team, with the room as context.
  if (input.artist.proxyOf?.length && s.opener) {
    const head = clean(s.opener);
    return [
      `Subject: Support slot request: ${name} with ${head} in ${clean(s.city)}, [their dates]`,
      "",
      `Hi ${head} team,`,
      "",
      // A new act has no Qloo data of its own: the claim is about the fans of the acts it sounds like.
      `${name} is a new act aimed at fans of ${input.artist.proxyOf.map(clean).join(" and ")}: Qloo's taste data ${rankLine} those fans${s.shared?.length ? `, who share tastes with ${possessive(head)} fans (${s.shared.slice(0, 3).map(clean).join(", ")})` : ""}. If ${head} plays ${clean(s.city)} around [their dates], we'd love to open${room ? `; ${room} is a room these fans favour` : ""}.`,
      "",
      "About us: [one line about the act]. Draw / last play in the area: [draw / last play in the area]. Links: [links].",
    ].join("\n");
  }
  const where = room ? `${room}${s.pitchTo?.town ? ` in ${s.pitchTo.town}` : ""}` : `a room in ${clean(s.city)}`;
  const audience = input.artist.proxyOf?.length ? `fans of ${input.artist.proxyOf.map(clean).join(" and ")}` : `${possessive(name)} audience`;
  const support = s.opener
    ? input.artist.proxyOf?.length
      ? ` We'd love to be considered for a support slot with ${clean(s.opener)}, whose fans share tastes with fans of ${input.artist.proxyOf.map(clean).join(" and ")}${s.shared?.length ? ` (${s.shared.slice(0, 2).map(clean).join(", ")})` : ""}.`
      : ` For support we'd like to approach ${clean(s.opener)}, whose audience shares tastes with ours${s.shared?.length ? ` (${s.shared.slice(0, 2).map(clean).join(", ")})` : ""}.`
    : "";
  return [
    `Subject: ${name} at ${room ?? clean(s.city)}, [dates]`,
    "",
    `Hi ${room ?? "there"} team,`,
    "",
    `I'm booking ${name} and would love a date at ${where}. Qloo's taste data ${rankLine} ${audience}${s.cluster ? `, with fans concentrated around ${clean(s.cluster)}` : ""}.${support}${input.capacity ? ` We're looking at rooms of ${input.capacity[0]}–${input.capacity[1]} (our own target).` : ""}`,
    "",
    "Draw / last play in the area: [draw / last play in the area]. Ticket price: [ticket price]. Links: [links].",
    "",
    "Do you have a hold around [dates]? Happy to send anything else you need.",
  ].join("\n");
}

const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");
/** The code-written "why" for a stop (TEMPLATE): its score, a nearby hotspot, where fans concentrate. `affinity` is 0–100. */
export const templateStopWhy = (s: { city: string; affinity: number; fanHotspot?: boolean; cluster?: string }) =>
  `${clean(s.city)} scores ${s.affinity.toFixed(1)} out of 100 on Qloo room affinity${s.fanHotspot ? " and sits near a Qloo fan hotspot" : ""}${s.cluster ? `; fans in the city concentrate around ${clean(s.cluster)}` : ""}.`;
export const scriptedProvider: SynthesisProvider = {
  name: "scripted",
  async synthesize(input) {
    const name = clean(input.artist.name);
    const brands = input.fan.alsoLikes.find((a) => a.domain === "brand");
    const films = input.fan.alsoLikes.find((a) => a.domain === "movie");
    const allStops = input.stops.map((s) => s.evidence);
    return {
      summary: {
        // "Highest within a day's drive of each other": a stronger city elsewhere may be outside this run.
        text: `${input.stops.map((s) => clean(s.city)).join(", ")} are the highest-scoring cities on Qloo room affinity for ${input.artist.proxyOf?.length ? `fans of ${input.artist.proxyOf.map(clean).join(" and ")}` : `${possessive(name)} audience`} that sit within a day's drive of each other. ${input.artist.arenaScale ? "This is an arena-scale act: the plan shows where the fans are, but no club or theatre rooms are suggested." : input.stops.some((s) => s.fanHotspot) ? "Each stop below names the neighbourhood where those fans cluster." : "No stop is near a country-wide fan hotspot, so this is a rooms-led plan."}`,
        evidence: [...new Set(allStops)],
      },
      stops: input.stops.map((s) => ({
        stop_id: s.stop_id,
        why: {
          text: templateStopWhy(s),
          evidence: [s.evidence, s.hotspotEvidence, s.clusterEvidence].filter((x): x is string => Boolean(x)),
        },
        pitch: {
          text: templatePitch(input, s, name),
          evidence: [s.evidence, s.clusterEvidence, s.openerEvidence, s.sharedEvidence].filter((x): x is string => Boolean(x)),
        },
      })),
      theme: [
        ...(films ? [{ text: `Borrow visual cues from films this audience shows affinity for: ${films.items.slice(0, 3).map(clean).join(", ")}.`, evidence: [films.evidence] }] : []),
        ...(input.fan.tags.length ? [{ text: `Build the set and visuals around the audience's top taste tags: ${input.fan.tags.slice(0, 3).map(clean).join(", ")}.`, evidence: input.fan.tagsEvidence ? [input.fan.tagsEvidence] : [] }] : []),
      ],
      merch: brands ? [{ text: `Take merch style cues from brands this audience shows affinity for: ${brands.items.slice(0, 3).map(clean).join(", ")}.`, evidence: [brands.evidence] }] : [],
      risks: [
        { text: "Fan affinity is not ticket demand: check local routing, dates and competing shows before confirming.", evidence: [] },
        { text: "Venue suggestions come from taste affinity, not capacity or availability; confirm both with each booker.", evidence: [] },
      ],
    };
  },
};

// ---------------------------------------------------------------- budget and selection
const DAILY_CAP = Math.max(0, Number(process.env.LLM_DAILY_CAP ?? 40));
/** Hard ceiling on total model spend (USD) for this deployment; 0 disables model calls. Persisted. */
const SPEND_CAP_USD = Math.max(0, Number(process.env.LLM_SPEND_CAP_USD ?? 4));
/** Claude Haiku 4.5 list prices per million tokens (input, output). */
const PRICE_PER_MTOK = { input: 1, output: 5 };
/**
 * Headroom kept before the ceiling: by default the largest single call seen (a synthesis with 8k max
 * output ≈ $0.05). A one-off capture with a small ceiling can lower it (LLM_CALL_RESERVE_USD) so a retry fits.
 */
const CALL_RESERVE_USD = Math.max(0, Number(process.env.LLM_CALL_RESERVE_USD ?? 0.05));
/** The spend ceiling applies per budget period (e.g. "pre-judging", "judging"); a new period starts at $0. */
const BUDGET_PERIOD = process.env.LLM_BUDGET_PERIOD?.trim() || "default";
const usageFile = () => (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "llm-usage.json") : undefined);
type Usage = { day: string; calls: number; spentUsd: number; period?: string };
let usage: Usage | undefined;

function loadUsage(): Usage {
  const file = usageFile();
  if (!usage && file) {
    try { usage = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")); } catch { /* first run */ }
  }
  usage ??= { day: "", calls: 0, spentUsd: 0, period: BUDGET_PERIOD };
  if ((usage.period ?? "default") !== BUDGET_PERIOD) { usage.period = BUDGET_PERIOD; usage.spentUsd = 0; }
  usage.spentUsd ??= 0;
  return usage;
}
function saveUsage() {
  const file = usageFile();
  if (!file || !usage) return;
  try {
    mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ file, JSON.stringify(usage));
  } catch { /* counting still works in memory */ }
}

/** Counts one model call against the daily cap and the total spend ceiling (both persisted) or refuses it. */
export function takeDailyBudget() {
  const day = new Date().toISOString().slice(0, 10);
  const u = loadUsage();
  if (u.day !== day) { u.day = day; u.calls = 0; }
  if (u.spentUsd + CALL_RESERVE_USD > SPEND_CAP_USD) throw new LlmError("AI text paused: this demo's AI budget is used up", "LLM_QUOTA");
  if (u.calls >= DAILY_CAP) throw new LlmError(`AI text paused: today's ${DAILY_CAP} AI calls are used up`, "LLM_QUOTA");
  u.calls++;
  saveUsage();
}

/** Whether model text is available right now, and why not (for /api/health and the plan header). */
export function llmStatus(): { provider: string; available: boolean; reason?: string } {
  const provider = process.env.LLM_PROVIDER ?? "scripted";
  if (provider === "scripted") return { provider, available: false, reason: "templated text, no AI configured" };
  const key = provider === "claude" ? process.env.CLAUDE_API_KEY : provider === "gemini" ? process.env.GEMINI_API_KEY : undefined;
  const backup = provider === "claude" ? process.env.GEMINI_API_KEY : provider === "gemini" ? process.env.CLAUDE_API_KEY : undefined;
  if (!key && !backup) return { provider, available: false, reason: `${provider === "claude" ? "CLAUDE_API_KEY" : "GEMINI_API_KEY"} is not set` };
  const u = loadUsage();
  const day = new Date().toISOString().slice(0, 10);
  if (u.spentUsd + CALL_RESERVE_USD > SPEND_CAP_USD) return { provider, available: false, reason: "this demo's AI budget is used up" };
  if (u.day === day && u.calls >= DAILY_CAP) return { provider, available: false, reason: `today's ${DAILY_CAP} AI calls are used up` };
  return { provider, available: true };
}

/** Model spend so far (USD), for the health check. */
export const spentUsd = () => +loadUsage().spentUsd.toFixed(4);

/** One structured log line per model call (counts and cost only, never prompt or output text); adds the cost to the total. */
export function logUsage(provider: string, model: string, tokens: { input?: number; output?: number }) {
  const costUsd = ((tokens.input ?? 0) * PRICE_PER_MTOK.input + (tokens.output ?? 0) * PRICE_PER_MTOK.output) / 1e6;
  const u = loadUsage();
  u.spentUsd += costUsd;
  saveUsage();
  console.info(JSON.stringify({ event: "llm_usage", provider, model, inputTokens: tokens.input, outputTokens: tokens.output, costUsd: +costUsd.toFixed(5),
    spentUsd: +u.spentUsd.toFixed(4), spendCapUsd: SPEND_CAP_USD, callsToday: u.calls, cap: DAILY_CAP }));
}

const PROVIDERS = { claude: claudeProvider, gemini: geminiProvider, scripted: scriptedProvider } as const;

/** The configured primary, falling back through the other configured providers to scripted. */
export function synthesisProvider(): SynthesisProvider {
  const primary = (process.env.LLM_PROVIDER ?? "scripted") as keyof typeof PROVIDERS;
  const chain = [PROVIDERS[primary] ?? scriptedProvider];
  if (primary === "claude" && process.env.GEMINI_API_KEY) chain.push(geminiProvider);
  if (primary === "gemini" && process.env.CLAUDE_API_KEY) chain.push(claudeProvider);
  if (chain.length === 1) return chain[0];
  return {
    name: chain[0].name,
    async synthesize(input, onPartial) {
      let lastError: unknown;
      for (const provider of chain) {
        try {
          return await provider.synthesize(input, onPartial);
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    },
  };
}
