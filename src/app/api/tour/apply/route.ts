import { Channel } from "@/lib/evidence";
import { clientKey, limitedResponse, take } from "@/lib/limits";
import { NDJSON_HEADERS, ndjsonStream } from "@/lib/ndjson";
import { loadPlan, savePlan } from "@/lib/store";
import { applyingLabel, applyProposal } from "@/lib/tour/apply";
import type { TourEvent, TourPlan } from "@/lib/tour/types";

export const runtime = "nodejs";
export const maxDuration = 120;

async function* apply(plan: TourPlan, index: number): AsyncGenerator<TourEvent> {
  const events = new Channel<TourEvent>();
  yield { type: "step", label: applyingLabel(plan, plan.followUps?.[index]?.proposal?.summary ?? "") };
  const result = applyProposal(plan, index, events).finally(() => events.close());
  result.catch(() => undefined);
  for await (const event of events) yield event;
  const next = await result;
  await savePlan(next);
  // The original plan records which plan its proposal became.
  await savePlan({ ...plan, followUps: (plan.followUps ?? []).map((f, i) => (i === index ? { ...f, appliedAs: next.id } : f)) });
  yield { type: "plan", plan: next };
}

/** Applies a stored scout proposal and streams the rebuilt plan. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const plan = typeof body.planId === "string" ? await loadPlan(body.planId) : undefined;
  const index = Number(body.index);
  if (!plan || !Number.isInteger(index) || !plan.followUps?.[index]?.proposal) return Response.json({ error: "There is no change to apply." }, { status: 404 });
  const limit = take("followup", clientKey(req));
  if (!limit.ok) return limitedResponse(limit);
  return new Response(ndjsonStream(apply(plan, index)), { headers: NDJSON_HEADERS });
}
