/** Streams events as NDJSON (one JSON object per line), tolerating client disconnects. */
export const NDJSON_HEADERS = { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" };

export function ndjsonStream<E extends { type: string }>(events: AsyncIterable<E> | Iterable<E>, onEvent?: (event: E) => Promise<void>) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { /* client disconnected */ }
      };
      try {
        for await (const event of events) {
          if (onEvent) await onEvent(event).catch(() => undefined);
          send(event);
        }
      } catch (e) {
        send({ type: "error", message: (e as Error).message, code: (e as { code?: string }).code ?? "INTERNAL", retryable: true });
      } finally {
        try { controller.close(); } catch { /* already closed by a disconnect */ }
      }
    },
  });
}
