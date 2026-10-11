import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-accent">404 · page not found</p>
        <h1 className="mt-2 font-display text-5xl uppercase">Nothing plays here</h1>
        <p className="mx-auto mt-3 max-w-md text-muted">This address isn’t part of Tour Scout. Start a tour instead: a live tour takes about a minute, and the demo tours open instantly.</p>
        <Link href="/" className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-accent px-6 font-display text-xl uppercase text-accent-ink">Plan a tour</Link>
      </div>
    </main>
  );
}
