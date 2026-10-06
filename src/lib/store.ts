/**
 * Share-link storage: plans the server itself generated, as JSON files under DATA_DIR/plans.
 * Plans hold only aggregate Qloo data and the user's tour inputs (artist, region, stops), never
 * personal data. Only server-produced plans are stored; clients can read them but never write.
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TourPlan } from "./tour/types.ts";

const DIR = path.join(process.env.DATA_DIR || path.join(process.cwd(), ".cache"), "plans");
const MAX_PLANS = Math.max(50, Number(process.env.MAX_STORED_PLANS) || 1000);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isPlanId = (id: string) => ID.test(id);
const fileOf = (id: string) => path.join(/*turbopackIgnore: true*/ DIR, `${id}.json`);

export async function savePlan(plan: TourPlan): Promise<void> {
  if (!isPlanId(plan.id)) throw new Error("invalid plan id");
  await mkdir(/*turbopackIgnore: true*/ DIR, { recursive: true });
  const tmp = `${fileOf(plan.id)}.tmp`;
  await writeFile(tmp, JSON.stringify(plan));
  await rename(tmp, fileOf(plan.id));
  void prune();
}

export async function loadPlan(id: string): Promise<TourPlan | undefined> {
  if (!isPlanId(id)) return undefined;
  try {
    return JSON.parse(await readFile(fileOf(id), "utf8")) as TourPlan;
  } catch {
    return undefined;
  }
}

/** Keeps the newest MAX_PLANS plans so the volume cannot fill up. */
async function prune() {
  try {
    const names = (await readdir(/*turbopackIgnore: true*/ DIR)).filter((n) => n.endsWith(".json"));
    if (names.length <= MAX_PLANS) return;
    const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(path.join(DIR, n))).mtimeMs })));
    dated.sort((a, b) => a.t - b.t);
    await Promise.all(dated.slice(0, dated.length - MAX_PLANS).map(({ n }) => unlink(path.join(DIR, n)).catch(() => undefined)));
  } catch {
    // Pruning is best effort.
  }
}
