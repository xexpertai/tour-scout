import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TourApp } from "@/components/tour/TourApp";
import { loadPlan } from "@/lib/store";
import { withDemoFlag } from "@/lib/tour/sources";
import { recheckKeptText } from "@/lib/tour/apply";

export async function generateMetadata({ params }: PageProps<"/t/[id]">): Promise<Metadata> {
  const plan = await loadPlan((await params).id);
  return plan ? { title: `${plan.artist.name.replace(/\s*\(sample\)$/, "")} · Tour Scout`, description: `A ${plan.stops.length}-stop tour planned from Qloo taste data.` } : {};
}

/** A shared, read-only tour plan. */
export default async function SharedPlan({ params }: PageProps<"/t/[id]">) {
  const plan = await loadPlan((await params).id);
  if (!plan) notFound();
  // Plans applied before the post-Apply check existed are checked when they are shown (stored text is unchanged).
  const change = plan.followUps?.find((f) => f.appliedAs === plan.id)?.proposal?.summary ?? "a proposed change";
  return <TourApp sharedPlan={await withDemoFlag(plan.parentId ? recheckKeptText(plan, change) : plan)} />;
}
