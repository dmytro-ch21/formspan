import { beltLabel, beltSyllabuses } from '@/lib/syllabuses';
import type { Curriculum } from '@/lib/curriculum';

const c = (over: Partial<Curriculum>): Curriculum =>
  ({
    id: over.id ?? 'x',
    name: over.name ?? 'X',
    belt: over.belt ?? null,
    track: over.track ?? null,
    description: '',
    editable: over.editable ?? false,
    enrolled: false,
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
    // curriculum can wear either. `editable` catches only the caller's own —
    // it means "not yours", not "VOLA's" — which is the whole guard the client
    // has. See F7.
    const got = beltSyllabuses([
      c({ id: 'mine', belt: 'blue', track: 'syllabus', editable: true }),
      c({ id: 'vola', belt: 'blue', track: 'syllabus' }),
    ]);
    expect(got.map((x) => x.id)).toEqual(['vola']);
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
