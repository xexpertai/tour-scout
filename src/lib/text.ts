/** Small text helpers shared by templates and labels. */
export const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");

/**
 * The town a room is in: from its US-style street address ("30 Main St Winooski, VT 05404" →
 * "Winooski"), else Qloo's city label. Not the fans' neighbourhood: a room can sit in the
 * next town over.
 */
const STREET = /^(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|pl|place|ct|court|hwy|highway|pkwy|parkway|sq|square|ter|terrace|cir|circle|row|alley|plz|plaza)\.?$/i;
export function venueTown(v: { town?: string; address?: string }): string | undefined {
  // The street address wins: Qloo's city label can be the metro ("Burlington" for a Winooski room).
  const head = v.address?.match(/^(.*?),\s*[A-Z]{2}\s+[\dA-Z]/)?.[1];
  if (!head) return v.town?.trim() || undefined;
  const words = head.trim().split(/\s+/);
  let k = -1;
  words.forEach((w, i) => { if (STREET.test(w)) k = i; });
  // Without a street word the split is a guess ("1 Broadway New York"), so give no town.
  return k >= 0 && k < words.length - 1 ? words.slice(k + 1).join(" ") : v.town?.trim() || undefined;
}

/** Qloo tag names occasionally carry stray capitals ("DedicateD"); tidy only that pattern. */
export const tidyTag = (name: string) => name.trim().replace(/\b([A-Z]?[a-z]{2,})([A-Z])\b/g, (_, a: string, b: string) => a + b.toLowerCase());

/** "Big Thief" → "Big Thief's", "Phoebe Bridgers" → "Phoebe Bridgers'". */
export function possessive(name: string): string {
  const n = clean(name);
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}
