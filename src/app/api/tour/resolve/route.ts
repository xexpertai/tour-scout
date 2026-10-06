import { clientKey, limitedResponse, take } from "@/lib/limits";
import { QlooError } from "@/lib/qloo";
import { resolveArtist } from "@/lib/tour/resolve";

export const runtime = "nodejs";

/** Resolves an artist or comedian name to Qloo candidates for the "Did you mean…?" card. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.slice(0, 120).trim() : "";
  const kind = body.kind === "person" ? "person" : "artist";
  if (!name) return Response.json({ error: "Please enter an artist or comedian name." }, { status: 400 });
  const limit = take("resolve", clientKey(req));
  if (!limit.ok) return limitedResponse(limit);
  try {
    return Response.json(await resolveArtist(name, kind));
  } catch (e) {
    const status = e instanceof QlooError && e.code === "QLOO_RATE_LIMIT" ? 429 : 502;
    return Response.json({ error: (e as Error).message, code: e instanceof QlooError ? e.code : "INTERNAL" }, { status });
  }
}
