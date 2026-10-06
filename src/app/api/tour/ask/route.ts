import { Channel } from "@/lib/evidence";
import { LlmError } from "@/lib/llm";
import { clientKey, limitedResponse, take } from "@/lib/limits";
import { NDJSON_HEADERS, ndjsonStream } from "@/lib/ndjson";
import { savePlan } from "@/lib/store";
import { askCity } from "@/lib/tour/followup";
import { MAX_AGENT_QUESTIONS, claudeAgentModel, runScout, scriptedAgentModel, type AgentModel } from "@/lib/tour/scout";
import { planForRequest } from "@/lib/tour/sources";
import type { AskEvent, FollowUp, TourPlan } from "@/lib/tour/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/** "Why not Denver?" and similar take the fast deterministic path; anything else goes to the scout. */
const QUICK = /^\s*(?:why\s+not|what\s+about|how\s+about)\s+([\p{L} .'-]{2,40}?)\s*\??\s*$/iu;

async function* answer(plan: TourPlan, question: string, forked: boolean, signal: AbortSignal): AsyncGenerator<AskEvent> {
  if (forked) yield { type: "forked", planId: plan.id };
  if (QUICK.test(question)) {
    yield { type: "checking", label: "Scout is ranking that city against your stops…" };
    yield { type: "answer", followUp: await askCity(plan, question) };
    return;
  }
  if ((plan.followUps ?? []).filter((f) => f.kind === "agent").length >= MAX_AGENT_QUESTIONS) {
    yield { type: "error", message: `This plan already has ${MAX_AGENT_QUESTIONS} scout questions. Start a new plan to keep exploring.`, code: "ASK_LIMIT" };
    return;
  }
  const events = new Channel<AskEvent>();
  const useClaude = process.env.LLM_PROVIDER === "claude" && Boolean(process.env.CLAUDE_API_KEY);
  const run = async (model: AgentModel) => runScout(plan, question, model, events, signal);
  const result = (useClaude ? run(claudeAgentModel) : run(scriptedAgentModel(plan, question)))
    .catch(async (e) => {
      // Without the model the scout still answers, from templates, and says so.
      if (!(e instanceof LlmError)) throw e;
      events.push({ type: "step", label: `AI scout unavailable (${e.message}); using the templated scout`, failed: true });
      return run(scriptedAgentModel(plan, question));
    })
    .finally(() => events.close());
  result.catch(() => undefined);
  for await (const event of events) yield event;
  yield { type: "answer", followUp: await result };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 200) : "";
  if (!question) return Response.json({ error: "Ask the scout something, e.g. “Swap the weakest stop for somewhere in the South”." }, { status: 400 });
  const limit = take("followup", clientKey(req));
  if (!limit.ok) return limitedResponse(limit);
  const found = await planForRequest(body);
  if (!found) return Response.json({ error: "This plan is no longer available." }, { status: 404 });

  const plan = found.plan;
  return new Response(ndjsonStream(answer(plan, question, found.forked, req.signal), async (e) => {
    // Each answer is kept on the plan, so shared links and later applies can see it.
    if (e.type === "answer") {
      plan.followUps = [...(plan.followUps ?? []), e.followUp as FollowUp];
      await savePlan(plan);
    }
  }), { headers: NDJSON_HEADERS });
}
