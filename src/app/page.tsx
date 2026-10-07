import { TourApp } from "@/components/tour/TourApp";

export default async function Page({ searchParams }: PageProps<"/">) {
  const { demo, video, check } = await searchParams;
  // ?video=1: presentation scale for screen recordings (the layout at 125%, rendered crisply at 1920 px).
  // ?video=<1..2>: another scale with the same layout width at a larger capture size (e.g. 1.6667 at 2560 px).
  const v = typeof video === "string" ? Number(video) : NaN;
  const present = video === "1" ? 1.25 : v > 1 && v <= 2 ? v : undefined;
  return <TourApp initialDemo={typeof demo === "string" ? demo : undefined} present={present} autoCheck={check !== "0"} />;
}
