import { describe, expect, it } from "vitest";

import { trackSections } from "@/lib/curriculumSections";
import type { Curriculum } from "@/lib/api";

const c = (over: Partial<Curriculum>): Curriculum =>
  ({
    id: "x",
    name: "X",
    editable: false,
    belt: null,
    track: null,
    visibility: "public",
    enrolled: false,
    started_on: null,
    item_count: 0,
    countable_items: 0,
    mastered_items: 0,
    ...over,
  }) as Curriculum;

const titles = (list: Curriculum[]) => trackSections(list).map((s) => s.title);

describe("trackSections", () => {
  it("files VOLA content under its track's heading", () => {
    expect(
      titles([
        c({ id: "s", track: "syllabus", official: true }),
        c({ id: "b", track: "belt", official: true }),
        c({ id: "f", track: "foundations", official: true }),
      ]),
    ).toEqual(["Belt roadmaps", "Foundations", "Reference syllabuses"]);
  });

  it("does NOT let a stranger's curriculum claim a VOLA heading", () => {
    // F7/F8: `track` has no validation on write, so anyone can publish
    // `track: "syllabus"`. Before this it landed under "Reference syllabuses"
    // with nothing on the card saying otherwise.
    //
    // Two rows on purpose. A single-row test passes against the bug in both
    // directions — check only the VOLA row and the grouping looks right;
    // check only the stranger's and "it grouped by track" also looks right.
    // The defect is that the two were treated the SAME.
    const sections = trackSections([
      c({ id: "vola", track: "syllabus", official: true }),
      c({ id: "stranger", track: "syllabus", official: false }),
    ]);
    const syllabus = sections.find((s) => s.title === "Reference syllabuses");
    const others = sections.find((s) => s.title === "From other athletes");
    expect(syllabus?.list.map((x) => x.id)).toEqual(["vola"]);
    expect(others?.list.map((x) => x.id)).toEqual(["stranger"]);
  });

  it("keeps a stranger's list visible, in the section that says so", () => {
    // Not the mobile fix. The strips drop non-official rows entirely because
    // they advertise VOLA content; this page exists to browse other people's,
    // so hiding them would remove the feature to fix the label.
    const sections = trackSections([c({ id: "stranger", track: "belt", official: false })]);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("From other athletes");
    expect(sections[0].list.map((x) => x.id)).toEqual(["stranger"]);
  });

  it("treats a server that omits `official` as attributing nothing", () => {
    // An older API sends no field at all. Everything keys to null and lands
    // under "From other athletes" — over-attributing to strangers, which is
    // the safe direction. The unsafe one is a VOLA heading over a personal list.
    expect(titles([c({ track: "syllabus" }), c({ track: "belt" })])).toEqual([
      "From other athletes",
    ]);
  });

  it("orders the named tracks explicitly, roadmaps before syllabuses", () => {
    expect(
      titles([
        c({ id: "s", track: "syllabus", official: true }),
        c({ id: "u", track: "untracked-thing", official: true }),
        c({ id: "f", track: "foundations", official: true }),
        c({ id: "b", track: "belt", official: true }),
        c({ id: "n" }),
      ]),
    ).toEqual([
      "Belt roadmaps",
      "Foundations",
      "Reference syllabuses",
      "Untracked-thing",
      "From other athletes",
    ]);
  });

  it("renders no empty sections", () => {
    expect(titles([])).toEqual([]);
  });

  it("treats an empty-string track as untracked", () => {
    // The column is unconstrained TEXT, so "" is reachable by a raw write and
    // must not render a blank heading among the named ones.
    expect(titles([c({ track: "", official: true })])).toEqual(["From other athletes"]);
  });
});
