import { TourApp } from "@/components/tour/TourApp";

export default async function Page({ searchParams }: PageProps<"/">) {
  const { demo } = await searchParams;
  return <TourApp initialDemo={typeof demo === "string" ? demo : undefined} />;
}
