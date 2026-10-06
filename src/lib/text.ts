/** Small text helpers shared by templates and labels. */
export const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");

/** "Big Thief" → "Big Thief's", "Phoebe Bridgers" → "Phoebe Bridgers'". */
export function possessive(name: string): string {
  const n = clean(name);
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}
