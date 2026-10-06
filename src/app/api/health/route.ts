import { synthesisProvider } from "@/lib/llm";
import { QLOO_BASE_URL, qlooMode } from "@/lib/qloo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readiness for the host's health check. Makes no Qloo or model request and reveals no credentials. */
export async function GET() {
  const mode = await qlooMode();
  return Response.json({ ok: true, qloo: mode.mock ? "mock" : "live", qlooReason: mode.reason, qlooBaseUrl: QLOO_BASE_URL, llm: synthesisProvider().name });
}
