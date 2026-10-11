import { llmStatus } from "@/lib/llm";
import { QLOO_BASE_URL, qlooMode, qlooTransport } from "@/lib/qloo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readiness for the host's health check. Makes no Qloo or model request and reveals no credentials. */
export async function GET() {
  const [mode, transport] = await Promise.all([qlooMode(), qlooTransport()]);
  return Response.json({ ok: true, qloo: mode.mock ? "mock" : "live", qlooReason: mode.reason, qlooBaseUrl: QLOO_BASE_URL, qlooHarness: transport, ...llmHealth() });
}

/** The real text state: "claude" only when a model call could be made now; else "template" and why. */
function llmHealth() {
  const s = llmStatus();
  return s.available ? { llm: s.provider } : { llm: "template", llmReason: s.reason };
}
