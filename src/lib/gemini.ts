/* eslint-disable @typescript-eslint/no-explicit-any -- raw third-party API JSON is narrowed into typed shapes at this boundary */
/** Minimal client for the Gemini Interactions API (function calling). */
const URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

export type Tool = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };
export type FunctionCall = { id: string; name: string; arguments: Record<string, any> };
export type Interaction = { id: string; status: string; calls: FunctionCall[]; text: string };

const RETRYABLE = new Set([500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GeminiError extends Error {
  readonly code: "GEMINI_QUOTA" | "GEMINI_UNAVAILABLE" | "GEMINI_ERROR";
  readonly retryable: boolean;
  constructor(message: string, code: GeminiError["code"], retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export async function interact(body: {
  input: string | Array<Record<string, unknown>>;
  tools: Tool[];
  previousId?: string;
  instructions?: string;
}): Promise<Interaction> {
  if (!process.env.GEMINI_API_KEY) throw new GeminiError("GEMINI_API_KEY is not set on the server (see README setup).", "GEMINI_ERROR");
  const payload = JSON.stringify({
    model: GEMINI_MODEL,
    input: body.input,
    tools: body.tools,
    ...(body.previousId ? { previous_interaction_id: body.previousId } : {}),
    ...(body.instructions ? { system_instruction: body.instructions } : {}),
  });
  // Gemini returns 503 under load spikes; back off and retry. A 429 is a quota limit (the free tier
  // is a small daily allowance), so retrying would only burn more of it: fail fast with a clear error.
  let res: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(URL, {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY as string, "Content-Type": "application/json" },
      body: payload,
    });
    if (!RETRYABLE.has(res.status)) break;
    if (attempt < 3) await sleep(1500 * 2 ** attempt);
  }
  if (res!.status === 429) {
    const detail = ((await res!.json().catch(() => ({}))) as any).error?.message ?? "";
    throw new GeminiError(`The AI model's usage limit is reached. ${detail}`.trim(), "GEMINI_QUOTA");
  }
  if (RETRYABLE.has(res!.status)) throw new GeminiError("The AI model is busy right now. Please try again in a minute.", "GEMINI_UNAVAILABLE", true);
  if (!res!.ok) throw new GeminiError(`Gemini ${res!.status}: ${(await res!.text()).slice(0, 300)}`, "GEMINI_ERROR");
  const data = await res!.json();
  const steps: any[] = data.steps ?? [];
  return {
    id: data.id,
    status: data.status,
    calls: steps.filter((s) => s.type === "function_call").map((s) => ({ id: s.id, name: s.name, arguments: s.arguments ?? {} })),
    text: steps.filter((s) => s.type === "model_output").flatMap((s) => (s.content ?? []).map((c: any) => c.text ?? "")).join("\n"),
  };
}

export const functionResult = (call: FunctionCall, result: unknown) => ({
  type: "function_result",
  name: call.name,
  call_id: call.id,
  result: [{ type: "text", text: JSON.stringify(result) }],
});
