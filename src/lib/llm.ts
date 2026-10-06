/**
 * Phase B synthesis behind one provider-agnostic interface: a single model call turns the compact
 * evidence ledger into interpretation text (with cited Q-ids). Providers: Claude, Gemini, scripted.
 *
 * LLM_PROVIDER=claude|gemini|scripted picks the primary (default scripted, so development spends no
 * model credit). A failing primary falls back to the next configured provider, then to scripted.
 * LLM_DAILY_CAP bounds model calls per UTC day (default 40); token counts are logged per call.
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
  /** affinity is Qloo's score scaled to 0–100, the same scale the UI shows. */
  stops: { stop_id: string; city: string; affinity: number; evidence: string; cluster?: string; clusterEvidence?: string; venues: string[]; venuesEvidence?: string; opener?: string; openerEvidence?: string; shared?: string[]; sharedEvidence?: string }[];
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
- Capacity, if given, is the artist's own target and is not Qloo data; say so if you mention it.
- Refer to the artist by name or as "they"; never assume gender, age or identity.
- Describe audience overlap as shared tastes, naming the shared items; never quantify it ("significantly", "most fans") unless a number is provided.
- Describe the audience only through the provided tags and affinities; do not invent traits (e.g. "collectors", "students").
- If the act is arena-scale, say the plan still works but venue suggestions may skew large.
- Affinity and scores are on a 0–100 scale; quote them exactly as given. Demographic values are relative over/under-index scores, not percentages.
Write, in this order: a summary (at most 2 sentences); for each stop a "why" (at most 40 words) and a pitch email to the venue booker (a subject line, then at most 90 words, grounded in the stop's data and the fan profile); exactly 3 show-theme ideas; exactly 3 merch ideas; 3 risks. Keep every item short.`;

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
const userContent = (input: SynthesisInput) => `Tour data (JSON):\n${JSON.stringify(input)}\n\nCall submit_tour with the plan.`;

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

// ---------------------------------------------------------------- Claude (Messages API)
const claudeProvider: SynthesisProvider = {
  name: "claude",
  async synthesize(input, onPartial) {
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
      if (e instanceof Anthropic.RateLimitError) throw new LlmError("The AI model's rate limit is reached.", "LLM_QUOTA");
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new LlmError("The Claude API key is missing or invalid.", "LLM_CONFIG");
      if (e instanceof Anthropic.BadRequestError) throw new LlmError(`Claude rejected the request: ${e.message}`, "LLM_CONFIG");
      if (e instanceof Anthropic.APIError) throw new LlmError("The AI model is busy right now.", "LLM_UNAVAILABLE");
      throw e;
    }
  },
};

// ---------------------------------------------------------------- scripted (no model)
const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");
export const scriptedProvider: SynthesisProvider = {
  name: "scripted",
  async synthesize(input) {
    const name = clean(input.artist.name);
    const brands = input.fan.alsoLikes.find((a) => a.domain === "brand");
    const films = input.fan.alsoLikes.find((a) => a.domain === "movie");
    const allStops = input.stops.map((s) => s.evidence);
    return {
      summary: {
        text: `Qloo ranks ${input.stops.map((s) => clean(s.city)).join(", ")} highest for ${possessive(name)} fan affinity. ${input.artist.arenaScale ? "This is an arena-scale act: the plan still works, but venue suggestions may skew large." : "Each stop below targets the neighbourhood where that affinity concentrates."}`,
        evidence: [...new Set(allStops)],
      },
      stops: input.stops.map((s) => ({
        stop_id: s.stop_id,
        why: {
          text: `${clean(s.city)} scores ${s.affinity} out of 100 on Qloo fan affinity${s.cluster ? `, concentrated around ${clean(s.cluster)}` : ""}.`,
          evidence: [s.evidence, s.clusterEvidence].filter((x): x is string => Boolean(x)),
        },
        pitch: {
          text: `Subject: ${name}, ${clean(s.city)} date\n\nHi, I'm booking ${name} and would love to bring the show to your room. Qloo's taste data shows ${clean(s.city)} among the strongest cities for ${possessive(name)} audience${s.cluster ? `, with affinity concentrated around ${clean(s.cluster)}` : ""}.${s.opener ? ` We'd pair it with ${clean(s.opener)}, whose audience shares tastes with ours${s.shared?.length ? ` (${s.shared.slice(0, 2).map(clean).join(", ")})` : ""}.` : ""}${input.capacity ? ` We're targeting rooms of ${input.capacity[0]}–${input.capacity[1]} (our own target, not Qloo data).` : ""} Happy to share the full data behind this.`,
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
const usageFile = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "llm-usage.json") : undefined;
let usage: { day: string; calls: number } | undefined;

/** Counts one model call against the daily cap (persisted under DATA_DIR when set) or refuses it. */
export function takeDailyBudget() {
  const day = new Date().toISOString().slice(0, 10);
  if (!usage && usageFile) {
    try { usage = JSON.parse(readFileSync(/*turbopackIgnore: true*/ usageFile, "utf8")); } catch { /* first run */ }
  }
  if (!usage || usage.day !== day) usage = { day, calls: 0 };
  if (usage.calls >= DAILY_CAP) throw new LlmError(`Today's AI budget (${DAILY_CAP} calls) is used up; showing templated text instead.`, "LLM_QUOTA");
  usage.calls++;
  if (usageFile) {
    try {
      mkdirSync(/*turbopackIgnore: true*/ path.dirname(usageFile), { recursive: true });
      writeFileSync(/*turbopackIgnore: true*/ usageFile, JSON.stringify(usage));
    } catch { /* counting still works in memory */ }
  }
}

/** One structured log line per model call: counts only, never prompt or output text. */
export function logUsage(provider: string, model: string, tokens: { input?: number; output?: number }) {
  console.info(JSON.stringify({ event: "llm_usage", provider, model, inputTokens: tokens.input, outputTokens: tokens.output, callsToday: usage?.calls, cap: DAILY_CAP }));
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
