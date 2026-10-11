import type { TourPlan } from "@/lib/tour/types";
import { isTasteName } from "../../lib/text.ts";

const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");

/** Quotes a CSV cell and neutralises spreadsheet formulas (cells starting with = + - @ tab or CR). */
function cell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** The same provenance labels the app shows. */
const LABEL = { interpretation: "AI", general: "GENERAL", template: "TEMPLATE" } as const;
const label = (kind?: keyof typeof LABEL) => (kind ? LABEL[kind] : "");

/** One row per stop, with the provenance of every column spelled out in the header. */
export function planToCsv(plan: TourPlan): string {
  const header = [
    "Stop", "City", "Room affinity 0-100 (Qloo)", "Fan cluster (OpenStreetMap name)", "Venues (Qloo)", plan.artist.proxyOf?.length ? "Support slot idea (Qloo)" : plan.artist.type === "person" ? "Feature act idea (Qloo)" : "Opener idea (Qloo)",
    "Shared tastes with opener (Qloo)", "Why (text)", "Why provenance", "Pitch email (text)", "Pitch provenance", "Evidence ids",
  ];
  const rows = plan.stops.map((s) => [
    s.order, clean(s.city.name), (Math.round(s.city.affinity * 1000) / 10).toFixed(1), s.cluster ? clean(s.cluster.name) : "",
    s.venues.map((v) => clean(v.name)).join("; "), s.opener ? clean(s.opener.name) : "",
    s.opener?.overlap?.shared.filter(isTasteName).map(clean).join("; ") ?? "", s.why?.text ?? "", label(s.why?.kind), s.pitch?.text ?? "", label(s.pitch?.kind),
    [...new Set([s.city.evidence, s.cluster?.evidence, s.venues[0]?.evidence, s.opener?.evidence, ...(s.why?.evidence ?? []), ...(s.pitch?.evidence ?? [])].filter(Boolean))].join(" "),
  ]);
  const note = [`# ${clean(plan.artist.name)} — Tour Scout plan ${plan.id} (${plan.createdAt}). Qloo data: ${plan.mode.qloo}. Text: ${textNote(plan)} (per row in the provenance columns: AI = model text citing Qloo, GENERAL = model text without Qloo evidence, TEMPLATE = written by code). Affinity is aggregate taste, not an attendance forecast.`];
  return [note, header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/** "AI 9, TEMPLATE 1 of 10 stop texts" — counted from the rows, so it never disagrees with them. */
function textNote(plan: TourPlan): string {
  const kinds = plan.stops.flatMap((s) => [s.why?.kind, s.pitch?.kind]).filter((k): k is keyof typeof LABEL => Boolean(k));
  const counts = (Object.keys(LABEL) as (keyof typeof LABEL)[]).map((k) => [LABEL[k], kinds.filter((x) => x === k).length] as const).filter(([, n]) => n);
  return `${counts.map(([l, n]) => `${l} ${n}`).join(", ")} of ${kinds.length} stop texts`;
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
