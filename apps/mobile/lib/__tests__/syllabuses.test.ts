import { beltLabel, beltSyllabuses, roadmapCurricula } from '@/lib/syllabuses';
import type { Curriculum } from '@/lib/curriculum';

const c = (over: Partial<Curriculum>): Curriculum =>
  ({
    id: over.id ?? 'x',
    name: over.name ?? 'X',
    belt: over.belt ?? null,
    track: over.track ?? null,
    description: '',
    editable: over.editable ?? false,
    // Defaults to a VOLA row, because that is what most of these are about.
    // The F7 test below sets it false explicitly — a fixture default is never
    // allowed to BE the guard under test.
    official: over.official ?? true,
    enrolled: over.enrolled ?? false,
    started_on: null,
    item_count: 0,
    countable_items: 0,
    mastered_items: 0,
  }) as Curriculum;

describe('beltSyllabuses', () => {
  it('returns the four belts in rank order, not alphabetical', () => {
    const got = beltSyllabuses([
      c({ id: 'p', belt: 'purple', track: 'syllabus' }),
      c({ id: 'w', belt: 'white', track: 'syllabus' }),
      c({ id: 'br', belt: 'brown', track: 'syllabus' }),
      c({ id: 'b', belt: 'blue', track: 'syllabus' }),
    ]);
    expect(got.map((x) => x.id)).toEqual(['w', 'b', 'p', 'br']);
  });

  it('takes only the syllabus track', () => {
    // The roadmaps carry a belt too. Keying on `belt` alone is the mistake the
    // Plan strip made in the other direction.
    const got = beltSyllabuses([
      c({ id: 'roadmap', belt: 'white', track: 'belt' }),
      c({ id: 'foundations', belt: null, track: 'foundations' }),
      c({ id: 'syllabus', belt: 'white', track: 'syllabus' }),
    ]);
    expect(got.map((x) => x.id)).toEqual(['syllabus']);
  });

  it("excludes the caller's OWN curriculum even if it claims the track", () => {
    // `track` and `belt` are both athlete-writable hints, so a personal public
    // curriculum can wear either.
    const got = beltSyllabuses([
      c({ id: 'mine', belt: 'blue', track: 'syllabus', editable: true, official: false }),
      c({ id: 'vola', belt: 'blue', track: 'syllabus' }),
    ]);
    expect(got.map((x) => x.id)).toEqual(['vola']);
  });

  it("excludes ANOTHER athlete's public curriculum — F7", () => {
    // The row the old `!editable` guard could not see. It is not the caller's,
    // so `editable` is false, exactly as it is for VOLA's own — and `track`
    // and `belt` are unvalidated, so the stranger picked both. Only `official`
    // separates them, which is why this test sets the two rows to differ on
    // that field ALONE.
    const got = beltSyllabuses([
      c({ id: 'stranger', belt: 'white', track: 'syllabus', editable: false, official: false }),
      c({ id: 'vola', belt: 'white', track: 'syllabus', editable: false, official: true }),
    ]);
    expect(got.map((x) => x.id)).toEqual(['vola']);
  });

  it('hides everything when the server does not send the field at all', () => {
    // An older API omitting `official` yields undefined, the truthy filter
    // drops the row, and the strip renders empty. Empty is the safe failure;
    // a strip full of strangers wearing belt words is not.
    const got = beltSyllabuses([
      { ...c({ id: 'unknown', belt: 'white', track: 'syllabus' }), official: undefined },
    ]);
    expect(got).toEqual([]);
  });

  it('sorts an unrecognised belt last rather than above white', () => {
    // This could not fail while the filter also dropped unknown belts: the
    // branch it covers was unreachable through the public API, which is the
    // exact shape this suite exists to refuse. The filter no longer drops
    // them — hiding a syllabus because a future build named a belt this one
    // does not know is worse than listing it last.
    const got = beltSyllabuses([
      c({ id: 'odd', belt: 'coral', track: 'syllabus' }),
      c({ id: 'white', belt: 'white', track: 'syllabus' }),
    ]);
    expect(got.map((x) => x.id)).toEqual(['white', 'odd']);
  });
});

describe('beltLabel', () => {
  it('is the belt word, capitalised', () => {
    expect(beltLabel(c({ belt: 'purple', track: 'syllabus' }))).toBe('Purple');
  });

  it('falls back to the name when the belt is unreadable', () => {
    expect(beltLabel(c({ belt: null, name: 'Something else' }))).toBe('Something else');
  });
});

describe('roadmapCurricula', () => {
  it("excludes ANOTHER athlete's public curriculum wearing the belt track — F7", () => {
    // The Plan strip's half of the same hole. It had already been fixed once,
    // for the caller's OWN curricula, and still let every stranger's through:
    // `!editable` is false for both a VOLA roadmap and somebody else's public
    // one. The two rows here differ on `official` and nothing else.
    const got = roadmapCurricula([
      c({ id: 'stranger', belt: 'blue', track: 'belt', editable: false, official: false }),
      c({ id: 'vola', belt: 'blue', track: 'belt', editable: false, official: true }),
    ]);
    expect(got.map((x) => x.id)).toEqual(['vola']);
  });

  it('takes the belt and foundations tracks but never the syllabus track', () => {
    // By TRACK, not by belt: a reference syllabus carries a belt too, and it
    // finishes nothing, so it does not belong on a strip called Roadmaps.
    const got = roadmapCurricula([
      c({ id: 'syllabus', belt: 'white', track: 'syllabus' }),
      c({ id: 'roadmap', belt: 'white', track: 'belt' }),
      c({ id: 'foundations', belt: null, track: 'foundations' }),
    ]);
    expect(got.map((x) => x.id).sort()).toEqual(['foundations', 'roadmap']);
  });

  it('leads with what you are working, then foundations, then belts by rank', () => {
    const got = roadmapCurricula([
      c({ id: 'blue', belt: 'blue', track: 'belt' }),
      c({ id: 'foundations', belt: null, track: 'foundations' }),
      c({ id: 'white', belt: 'white', track: 'belt' }),
      c({ id: 'working', belt: 'purple', track: 'belt', enrolled: true }),
    ]);
    expect(got.map((x) => x.id)).toEqual(['working', 'foundations', 'white', 'blue']);
  });

  it('drops a belt-track row whose belt this build does not recognise', () => {
    // Foundations is the ONLY track allowed to have no recognised belt. A
    // belt-track row with a bad belt would otherwise sort as though it were
    // foundations and lead the strip.
    const got = roadmapCurricula([c({ id: 'odd', belt: 'coral', track: 'belt' })]);
    expect(got).toEqual([]);
  });

  it('hides everything when the server does not send the field at all', () => {
    const got = roadmapCurricula([
      { ...c({ id: 'x', belt: 'white', track: 'belt' }), official: undefined },
    ]);
    expect(got).toEqual([]);
  });
});
