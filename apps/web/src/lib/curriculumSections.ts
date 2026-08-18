import type { Curriculum } from "@/lib/api";

/** The Shared tab's sections, in a fixed order: belts, foundations, any other
 *  named track, then untracked (other athletes' published lists). Sections
 *  with nothing in them do not render — an empty "Foundations" heading is a
 *  promise, not a browse surface. */
export function trackSections(
  list: Curriculum[],
): { title: string; list: Curriculum[] }[] {
  const titles: Record<string, string> = {
    belt: "Belt roadmaps",
    foundations: "Foundations",
    syllabus: "Reference syllabuses",
  };
  /**
   * `!track`, not `=== null`: the column is unconstrained TEXT, so an empty
   * string is reachable via a raw API write, and it must not render an empty
   * heading sorted among the named sections.
   *
   * **And a track is only believed from VOLA.** `track` is a hint with no
   * validation on write, so a stranger publishing `track: "syllabus"` landed
   * under the "Reference syllabuses" heading — and `track: "belt"` under "Belt
   * roadmaps" — with nothing on the card saying otherwise. F7 fixed both mobile
   * strips by filtering them out entirely; that is wrong here, because this
   * page is *for* browsing other athletes' lists. They belong in the section
   * that says so.
   *
   * Truthy test, not a normalisation: a server older than F7 omits `official`,
   * every row keys to null, and the whole shared list renders under "From other
   * athletes". Over-attributing to strangers is the safe direction; the unsafe
   * one is a VOLA heading over somebody's personal list.
   */
  const keyOf = (c: Curriculum) => (c.official && c.track ? c.track : null);
  // Explicit rather than alphabetical, and syllabuses sit LAST of the named
  // tracks on purpose: they are the longest lists and the only ones that
  // finish nothing, so a browser scanning for something to work should meet
  // the roadmaps first.
  const order = (t: string | null) =>
    t === "belt"
      ? 0
      : t === "foundations"
        ? 1
        : t === "syllabus"
          ? 2
          : t !== null
            ? 3
            : 4;
  // Grouped on the track VALUE, not the display title — two tracks that
  // happen to render the same title must not merge into one section under
  // whichever arrived first's sort order.
  const groups = new Map<string | null, Curriculum[]>();
  for (const c of list) {
    const key = keyOf(c);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  return [...groups.entries()]
    .sort(
      (a, b) =>
        order(a[0]) - order(b[0]) || (a[0] ?? "").localeCompare(b[0] ?? ""),
    )
    .map(([track, l]) => ({
      title:
        track === null
          ? "From other athletes"
          : (titles[track] ?? track.charAt(0).toUpperCase() + track.slice(1)),
      list: l,
    }));
}
