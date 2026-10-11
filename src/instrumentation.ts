/**
 * Runs once when a server instance starts. Starts loading the Qloo harness in the background (not
 * awaited, so readiness is not delayed): on a cold Cloud Run instance the first load from disk took
 * most of the first health check, which a visitor would otherwise wait for.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { preloadQloo } = await import("./lib/qloo.ts");
  void preloadQloo();
}
