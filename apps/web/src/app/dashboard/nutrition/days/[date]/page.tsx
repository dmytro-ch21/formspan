import { notFound } from "next/navigation";

import { DayEditor } from "./DayEditor";

/**
 * A Server Component whose only job is to validate the segment.
 *
 * `[date]` is user-controlled and reaches the API as a path segment. Rejecting
 * anything that is not exactly `YYYY-MM-DD` here means the client below can
 * treat it as a date rather than re-checking it at four call sites — and an
 * unparseable one gets a 404 instead of a screen that renders empty and reads
 * as "you logged nothing that day".
 */
export default async function DayPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!isDate(date)) notFound();
  return <DayEditor date={date} />;
}

function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
