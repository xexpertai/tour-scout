import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TourApp } from "@/components/tour/TourApp";
import { loadPlan } from "@/lib/store";

export async function generateMetadata({ params }: PageProps<"/t/[id]">): Promise<Metadata> {
  const plan = await loadPlan((await params).id);
  return plan ? { title: `${plan.artist.name.replace(/\s*\(sample\)$/, "")} · Tour Scout`, description: `A ${plan.stops.length}-stop tour planned from Qloo taste data.` } : {};
}

/** A shared, read-only tour plan. */
export default async function SharedPlan({ params }: PageProps<"/t/[id]">) {
  const plan = await loadPlan((await params).id);
  if (!plan) notFound();
  return <TourApp sharedPlan={plan} />;
}
