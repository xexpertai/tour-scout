import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-accent">404 · no such tour</p>
        <h1 className="mt-2 font-display text-5xl uppercase">This tour has left the building</h1>
        <p className="mx-auto mt-3 max-w-md text-muted">The link may be mistyped, or the plan was cleared from storage. Start a new one — it takes about half a minute.</p>
        <Link href="/" className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-accent px-6 font-display text-xl uppercase text-accent-ink">Plan a tour</Link>
      </div>
    </main>
  );
}
