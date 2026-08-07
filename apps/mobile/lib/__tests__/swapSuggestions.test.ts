import exercises from '../../../../backend/internal/modules/exercise/exercises.json';
import { sharesMuscleGroup } from '../exerciseFacets';
import { MAX_SWAP_SUGGESTIONS, swapSuggestions } from '../sessions';
import type { Exercise } from '../exercises';

/**
 * What the swap screen offers, and in what order.
 *
 * The ranking is a recommendation, so the standard the rest of this product
 * holds recommendations to applies: it has to be explainable, and these
 * assertions are the explanation written down. The bug being fixed is not a
 * crash — the old rule returned plausible-looking suggestions forever while
 * never once consulting what the exercise actually trained.
 */

const ex = (over: Partial<Exercise>): Exercise =>
  ({
    id: 'x',
    name: 'X',
    sport: 'strength',
    movement_pattern: 'horizontal_push',
    movement_pattern_detail: '',
    primary_muscles: ['chest'],
    secondary_muscles: [],
    equipment: ['barbell'],
    load_type: 'weight_reps',
    is_unilateral: false,
    instructions: [],
    media: [],
    ...over,
  }) as Exercise;

const bench = ex({ id: 'bench', name: 'Barbell Bench Press' });

describe('muscle comes first', () => {
  it('offers a same-muscle exercise even when the movement differs', () => {
    // THE fix. A cable fly is a different pattern (isolation, not
    // horizontal_push) and the old rule scored it zero — so "what else trains
    // my chest?" returned nothing of the sort.
    const fly = ex({
      id: 'fly',
      name: 'Cable Fly',
      movement_pattern: 'isolation',
      primary_muscles: ['chest'],
      equipment: ['cable'],
    });
    const got = swapSuggestions(bench, [fly], sharesMuscleGroup);
    expect(got.muscle.map((e) => e.id)).toEqual(['fly']);
    expect(got.movement).toEqual([]);
  });

  it('puts a same-pattern exercise in the MOVEMENT tier when the muscle differs', () => {
    const row = ex({
      id: 'row',
      name: 'Barbell Row',
      movement_pattern: 'horizontal_push',
      primary_muscles: ['lats'],
    });
    const got = swapSuggestions(bench, [row], sharesMuscleGroup);
    expect(got.muscle).toEqual([]);
    expect(got.movement.map((e) => e.id)).toEqual(['row']);
  });

  it('never puts the same exercise in its own suggestions', () => {
    const got = swapSuggestions(bench, [bench], sharesMuscleGroup);
    expect(got.muscle).toEqual([]);
    expect(got.movement).toEqual([]);
  });

  it('puts an exercise in ONE tier, never both', () => {
    // A same-muscle, same-pattern exercise qualifies for both by the letter of
    // the rules. Listing it twice would make the screen look broken.
    const db = ex({ id: 'db', name: 'Dumbbell Bench', equipment: ['dumbbell'] });
    const got = swapSuggestions(bench, [db], sharesMuscleGroup);
    expect(got.muscle.map((e) => e.id)).toEqual(['db']);
    expect(got.movement).toEqual([]);
  });
});

describe('order within a tier', () => {
  it('walks the whole ladder, with names that fight the ranking at every rung', () => {
    /*
      Every fixture is named so alphabetical order is the REVERSE of rank
      order. Review found the first version had "A Machine Press" sorting
      ahead of "A Push-up" anyway, so collapsing rank 3 into rank 2 still
      passed — the names only defeated the sort for one of the three.

      Rank 3: same pattern, numbers carry.
      Rank 2: same pattern, measured differently.
      Rank 1: different pattern, numbers carry.
      Rank 0: different pattern, measured differently.
    */
    const r3 = ex({ id: 'r3', name: 'Zulu', movement_pattern: 'horizontal_push' });
    const r2 = ex({
      id: 'r2',
      name: 'Yankee',
      movement_pattern: 'horizontal_push',
      load_type: 'reps',
    });
    const r1 = ex({ id: 'r1', name: 'X-Ray', movement_pattern: 'isolation' });
    const r0 = ex({
      id: 'r0',
      name: 'Alpha',
      movement_pattern: 'isolation',
      load_type: 'reps',
    });
    const got = swapSuggestions(bench, [r0, r1, r2, r3], sharesMuscleGroup);
    expect(got.muscle.map((e) => e.id)).toEqual(['r3', 'r2', 'r1', 'r0']);
  });

  it('falls back to name so the order never wobbles between renders', () => {
    // Ids crossed against names: `zzz` is called Alpha. Aligned, a tie-break
    // switched to comparing ids would pass this too.
    const bravo = ex({ id: 'aaa', name: 'Bravo' });
    const alpha = ex({ id: 'zzz', name: 'Alpha' });
    expect(
      swapSuggestions(bench, [bravo, alpha], sharesMuscleGroup).muscle.map((e) => e.id),
    ).toEqual(['zzz', 'aaa']);
  });

  it('does NOT reward matching equipment', () => {
    // The old rule counted shared equipment as a point in favour, which is
    // backwards for the case this screen exists for: if the barbell is taken,
    // another barbell movement is the one suggestion that cannot help. The
    // ranking stays out of it entirely — the row shows the equipment instead.
    // Both a DIFFERENT pattern from the base, so they meet only on load type —
    // the rank where a shared-equipment bonus would actually tip the order. At
    // the same-pattern rank both already tie, so a test there proves nothing.
    const sameKit = ex({
      id: 'same',
      name: 'Zulu Fly',
      movement_pattern: 'isolation',
      equipment: ['barbell'],
    });
    const otherKit = ex({
      id: 'other',
      name: 'Alpha Fly',
      movement_pattern: 'isolation',
      equipment: ['dumbbell'],
    });
    const got = swapSuggestions(bench, [sameKit, otherKit], sharesMuscleGroup);
    // Purely alphabetical — equipment moved neither of them.
    expect(got.muscle.map((e) => e.id)).toEqual(['other', 'same']);
  });
});

describe('caps', () => {
  it('caps each tier separately, so one cannot crowd out the other', () => {
    // The old cap was 8 across everything. With muscle-first ranking that
    // would let a well-covered muscle push the movement tier off the screen.
    const many = Array.from({ length: 30 }, (_, i) =>
      ex({ id: `m${i}`, name: `M${i}`, primary_muscles: ['chest'] }),
    );
    const movers = Array.from({ length: 30 }, (_, i) =>
      ex({ id: `v${i}`, name: `V${i}`, primary_muscles: ['lats'] }),
    );
    const got = swapSuggestions(bench, [...many, ...movers], sharesMuscleGroup);
    expect(got.muscle).toHaveLength(MAX_SWAP_SUGGESTIONS);
    expect(got.movement).toHaveLength(MAX_SWAP_SUGGESTIONS);
  });
});

describe('muscle grouping', () => {
  it('treats a row and a chin-up as the same job', () => {
    // `upper-back` and `lats` are different raw values; an athlete swapping
    // one for the other plainly considers them the same thing. Comparing raw
    // muscles would call them unrelated.
    const row = ex({ id: 'row', primary_muscles: ['upper-back'] });
    const chin = ex({ id: 'chin', primary_muscles: ['lats'] });
    expect(sharesMuscleGroup(row, chin)).toBe(true);
  });

  it('does not match two exercises whose muscles are BOTH unmapped', () => {
    // The console can mint free-text muscles — there is no server-side
    // vocabulary for this field. Letting unknowns match each other would
    // bucket every typo together and offer them as substitutes.
    const a = ex({ id: 'a', primary_muscles: ['not-a-muscle'] });
    const b = ex({ id: 'b', primary_muscles: ['also-not-a-muscle'] });
    expect(sharesMuscleGroup(a, b)).toBe(false);
  });

  it('does not match on an empty muscle list', () => {
    expect(sharesMuscleGroup(ex({ primary_muscles: [] }), bench)).toBe(false);
  });
});

describe('against the catalog that actually ships', () => {
  const all = exercises as unknown as Exercise[];
  const find = (id: string) => all.find((e) => e.id === id);

  it('has a real bench press to reason about', () => {
    // Guards every assertion below: if the id changes, these would otherwise
    // pass by testing nothing.
    expect(find('bench-press')).toBeDefined();
  });

  it('suggests other chest work for a bench press, not other pushes', () => {
    const base = find('bench-press')!;
    const got = swapSuggestions(base, all, sharesMuscleGroup);
    expect(got.muscle.length).toBeGreaterThan(0);
    // Every muscle-tier suggestion genuinely shares a muscle group — the
    // property the whole change is about.
    for (const e of got.muscle) expect(sharesMuscleGroup(base, e)).toBe(true);
    // And nothing in the movement tier does.
    for (const e of got.movement) expect(sharesMuscleGroup(base, e)).toBe(false);
  });
});
