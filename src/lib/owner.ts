/**
 * Who may add to a stored plan. A share link is read-only for everyone else: a question or an Apply on
 * someone else's plan works on a copy (a fork), never on the original. The browser holds a random
 * owner key in an HttpOnly cookie; plans store only its hash. No accounts and no personal data.
 */
import { createHash, randomUUID } from "node:crypto";

const COOKIE = "ts_owner";
export type Owner = { hash: string; setCookie?: string };

export function ownerOf(req: Request): Owner {
  const m = /(?:^|;\s*)ts_owner=([A-Za-z0-9-]{20,64})(?:;|$)/.exec(req.headers.get("cookie") ?? "");
  const key = m?.[1] ?? randomUUID();
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return {
    hash: createHash("sha256").update(key).digest("hex").slice(0, 32),
    setCookie: m ? undefined : `${COOKIE}=${key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
  };
}

/** Plans stored before owners existed (no `owner`) belong to nobody, so changes to them fork too. */
export const owns = (plan: { owner?: string }, o: Owner) => Boolean(plan.owner) && plan.owner === o.hash;

export const withOwnerCookie = (headers: Record<string, string>, o: Owner): Record<string, string> =>
  (o.setCookie ? { ...headers, "set-cookie": o.setCookie } : headers);
