/**
 * Regenerates the redacted request → result excerpt in README.md and docs/SUBMISSION.md from the
 * lead demo preset, so the Q-ids and numbers always match the capture.   npm run docs:excerpt
 */
import { readFileSync, writeFileSync } from "node:fs";

const { requestExcerpt, withExcerpt } = await import("../src/lib/tour/excerpt.ts");
const excerpt = requestExcerpt(JSON.parse(readFileSync("public/presets/us-emerging.json", "utf8")));
for (const file of ["README.md", "docs/SUBMISSION.md"]) {
  writeFileSync(file, withExcerpt(readFileSync(file, "utf8"), excerpt));
  console.log(`✓ ${file}`);
}
