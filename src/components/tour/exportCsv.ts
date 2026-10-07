import type { TourPlan } from "@/lib/tour/types";

const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");

/** Quotes a CSV cell and neutralises spreadsheet formulas (cells starting with = + - @ tab or CR). */
function cell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One row per stop, with the provenance of every column spelled out in the header. */
export function planToCsv(plan: TourPlan): string {
  const header = [
    "Stop", "City", "Fan affinity 0-100 (Qloo)", "Fan cluster (OpenStreetMap name)", "Venues (Qloo)", plan.artist.proxyOf?.length ? "Support slot idea (Qloo)" : plan.artist.type === "person" ? "Feature act idea (Qloo)" : "Opener idea (Qloo)",
    "Shared tastes with opener (Qloo)", "Why (text)", "Why provenance", "Pitch email (text)", "Pitch provenance", "Evidence ids",
  ];
  const rows = plan.stops.map((s) => [
    s.order, clean(s.city.name), Math.round(s.city.affinity * 100), s.cluster ? clean(s.cluster.name) : "",
    s.venues.map((v) => clean(v.name)).join("; "), s.opener ? clean(s.opener.name) : "",
    s.opener?.overlap?.shared.map(clean).join("; ") ?? "", s.why?.text ?? "", s.why?.kind ?? "", s.pitch?.text ?? "", s.pitch?.kind ?? "",
    [...new Set([s.city.evidence, s.cluster?.evidence, s.venues[0]?.evidence, s.opener?.evidence, ...(s.why?.evidence ?? []), ...(s.pitch?.evidence ?? [])].filter(Boolean))].join(" "),
  ]);
  const note = [`# ${clean(plan.artist.name)} — Tour Scout plan ${plan.id} (${plan.createdAt}). Qloo data: ${plan.mode.qloo}. Text: ${plan.mode.llm}. Affinity is aggregate taste, not an attendance forecast.`];
  return [note, header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

export function downloadCsv(plan: TourPlan) {
  const blob = new Blob(["﻿", planToCsv(plan)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: `tour-scout-${clean(plan.artist.name).toLowerCase().replace(/\W+/g, "-")}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
