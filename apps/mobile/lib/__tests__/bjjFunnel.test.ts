import {
  bumpTechniqueOutcome,
  removeDrilledTechnique,
  tagCount,
  techniqueOutcomeCount,
  type Tag,
} from '../bjjSession';

/**
 * The technique funnel's missing middle.
 *
 * `drilled → attempted → scored` was in the schema from the first migration
 * and only `drilled` was ever captured with a technique: the live grid records
 * category+position only, and nothing in either client produced an `attempted`
 * row at all. These transforms are what fills the gap, so what they must
 * guarantee is that the two halves of the tag list stay disjoint — the live
 * grid owns untagged rows, the drilled step owns technique-tagged ones — and
 * that removing a chip cannot strand evidence that is still saved and sent.
 */

const armbar: Tag = {
  category: 'submission',
  event: 'drilled',
  position: 'Guard',
  technique_id: 'armbar-from-guard',
  count: 1,
};

const triangle: Tag = {
  category: 'submission',
  event: 'drilled',
  position: 'Guard',
  technique_id: 'triangle-from-guard',
  count: 1,
};

describe('bumpTechniqueOutcome', () => {
  it('inherits category and position from the drilled row rather than recomputing them', () => {
    // The funnel only joins if both ends agree on the position. familyOf()
    // returns '' for a family the hardcoded POSITIONS list has fallen behind
    // on — which has happened twice — so deriving it a second time could file
    // the drilled row under "Guard" and the attempted row under nothing,
    // splitting one technique's evidence with no error anywhere.
    // Both values differ from every default in play, so a mutation that drops
    // the inheritance cannot land on the right answer by accident. The first
    // version of this test used position: '' — which is precisely what a
    // broken implementation produces — and stayed green when the inheritance
    // was deleted.
    const drilledElsewhere: Tag = { ...armbar, position: 'Half Guard', category: 'sweep' };
    const [, attempted] = bumpTechniqueOutcome([drilledElsewhere], drilledElsewhere, 'attempted', 1);
    expect(attempted).toEqual({
      category: 'sweep',
      event: 'attempted',
      position: 'Half Guard',
      technique_id: 'armbar-from-guard',
      count: 1,
    });
  });

  it('keeps attempted and scored as separate rows for the same technique', () => {
    // They are disjoint outcomes, not cumulative: attempted is "went for it
    // and it did not land". Merging them would make the hit rate unrecoverable.
    let tags = bumpTechniqueOutcome([armbar], armbar, 'attempted', 1);
    tags = bumpTechniqueOutcome(tags, armbar, 'scored', 1);
    expect(tags.filter((t) => t.technique_id === armbar.technique_id)).toHaveLength(3);
    expect(techniqueOutcomeCount(tags, 'armbar-from-guard', 'attempted')).toBe(1);
    expect(techniqueOutcomeCount(tags, 'armbar-from-guard', 'scored')).toBe(1);
  });

  it('increments an existing row instead of appending a second one', () => {
    let tags: Tag[] = [armbar];
    for (let i = 0; i < 3; i++) tags = bumpTechniqueOutcome(tags, armbar, 'attempted', 1);
    expect(tags.filter((t) => t.event === 'attempted')).toHaveLength(1);
    expect(techniqueOutcomeCount(tags, 'armbar-from-guard', 'attempted')).toBe(3);
  });

  it('drops the row at zero rather than keeping a count of 0', () => {
    // A zero-count row would fail the backend's count > 0 CHECK, so the whole
    // reflection would 400 on save because someone tapped once and undid it.
    let tags = bumpTechniqueOutcome([armbar], armbar, 'scored', 1);
    tags = bumpTechniqueOutcome(tags, armbar, 'scored', -1);
    expect(tags.some((t) => t.event === 'scored')).toBe(false);
    expect(tags).toEqual([armbar]);
  });

  it('refuses to go negative from nothing', () => {
    expect(bumpTechniqueOutcome([armbar], armbar, 'attempted', -1)).toEqual([armbar]);
  });

  it('is a no-op for a drilled row carrying no technique', () => {
    const untagged: Tag = { category: 'sweep', event: 'drilled', position: 'Guard', count: 1 };
    expect(bumpTechniqueOutcome([untagged], untagged, 'scored', 1)).toEqual([untagged]);
  });

  it('does not mutate the array it was given', () => {
    const tags: Tag[] = [armbar];
    bumpTechniqueOutcome(tags, armbar, 'scored', 1);
    expect(tags).toHaveLength(1);
  });

  it('replaces the incremented row rather than mutating it in place', () => {
    // The push path is satisfied by the array spread alone, so it cannot see
    // this. A row object mutated in place is shared with the state React
    // already rendered, which is the classic stale-render bug on this screen.
    const existing: Tag = { ...armbar, event: 'scored', count: 1 };
    const tags: Tag[] = [armbar, existing];
    const after = bumpTechniqueOutcome(tags, armbar, 'scored', 1);
    expect(existing.count).toBe(1);
    expect(after[1]).not.toBe(existing);
    expect(after[1].count).toBe(2);
  });

  it('honours a delta greater than one when creating the row', () => {
    const [, created] = bumpTechniqueOutcome([armbar], armbar, 'attempted', 2);
    expect(created.count).toBe(2);
  });
});

describe('the live grid and the funnel partition the tag list', () => {
  it('tagCount ignores the funnel rows, so nothing is counted twice', () => {
    // This is the property that keeps the two screens honest. The live grid's
    // +/- only edits untagged rows; if its display counted technique-tagged
    // ones too, the athlete would see a number that long-press refuses to
    // move and no way to tell why.
    const tags: Tag[] = [
      { category: 'submission', event: 'scored', position: 'Guard', count: 2 }, // live grid's
      ...bumpTechniqueOutcome([armbar], armbar, 'scored', 1).filter((t) => t.event === 'scored'),
    ];
    expect(tagCount(tags, 'submission', 'scored', 'Guard')).toBe(2);
    expect(techniqueOutcomeCount(tags, 'armbar-from-guard', 'scored')).toBe(1);
  });
});

describe('removeDrilledTechnique', () => {
  it('takes the technique’s live outcomes with it', () => {
    // The counters are only reachable through the drilled chip, so orphaned
    // attempted/scored rows would still be saved and sent while being
    // invisible and uneditable — evidence the athlete cannot see or correct.
    let tags: Tag[] = [armbar, triangle];
    tags = bumpTechniqueOutcome(tags, armbar, 'attempted', 2);
    tags = bumpTechniqueOutcome(tags, armbar, 'scored', 1);
    tags = bumpTechniqueOutcome(tags, triangle, 'scored', 1);

    const after = removeDrilledTechnique(tags, 'armbar-from-guard');
    expect(after.some((t) => t.technique_id === 'armbar-from-guard')).toBe(false);
    // and only that technique
    expect(after.filter((t) => t.technique_id === 'triangle-from-guard')).toHaveLength(2);
  });

  it('leaves the live grid’s untagged rows alone', () => {
    // Every event the function CAN delete, so the id match is the only thing
    // that can spare them. The first version of this test used a single
    // `conceded` row — which the event guard excludes on its own — so
    // replacing the whole body with `filter(t => t.event === 'conceded')`
    // kept it green and the named property was never exercised.
    const untagged: Tag[] = [
      { category: 'sweep', event: 'scored', position: 'Half Guard', count: 3 },
      { category: 'pass', event: 'attempted', position: 'Guard', count: 2 },
      { category: 'submission', event: 'drilled', position: 'Mount', count: 1 },
      { category: 'sweep', event: 'conceded', position: 'Half Guard', count: 4 },
    ];
    expect(removeDrilledTechnique([armbar, ...untagged], 'armbar-from-guard')).toEqual(untagged);
  });

  it('refuses a nullish id rather than matching every untagged row', () => {
    // THE data-loss case, and the reason this function guards the id before
    // it filters. The API sends `"technique_id": null` on every untagged row
    // (the Go field has no omitempty), and a drilled row can legitimately
    // lose its technique — migration 000025 sets it NULL when a technique is
    // retired, precisely so the athlete's record survives. With `null` on
    // both sides, an id-only match deletes the entire live grid, and
    // `PUT /bjj/sessions/{id}` replaces the tag set wholesale, so it syncs.
    const serverShaped: Tag[] = [
      { category: 'submission', event: 'drilled', position: 'Guard', technique_id: null, count: 1 },
      { category: 'sweep', event: 'scored', position: 'Half Guard', technique_id: null, count: 4 },
      { category: 'pass', event: 'conceded', position: 'Guard', technique_id: null, count: 2 },
    ];
    // Only the `null` case does work against the guard — every fixture row
    // carries an explicit null, so `=== undefined` never matches anyway. null
    // IS the reachable shape (the API sends it; a locally-authored drilled row
    // always has a real id). The other two are cheap breadth, not three
    // independent proofs, and this file has enough history of assertions
    // satisfied by the wrong thing to be worth saying so.
    expect(removeDrilledTechnique(serverShaped, null)).toEqual(serverShaped);
    expect(removeDrilledTechnique(serverShaped, undefined)).toEqual(serverShaped);
    expect(removeDrilledTechnique(serverShaped, '')).toEqual(serverShaped);
  });

  it('keeps a technique-tagged conceded row, which this screen did not author', () => {
    // "They armbarred me" is not something the drilled step can produce — but
    // the API accepts it, so a reflection authored elsewhere and read back can
    // carry one. Removing a drilled chip must not silently delete it.
    const caughtIn: Tag = {
      category: 'submission',
      event: 'conceded',
      position: 'Mount',
      technique_id: 'armbar-from-guard',
      count: 1,
    };
    const after = removeDrilledTechnique([armbar, caughtIn], 'armbar-from-guard');
    expect(after).toEqual([caughtIn]);
  });
});

describe('techniqueOutcomeCount', () => {
  it('returns 0 for a nullish id rather than summing every untagged row', () => {
    // The funnel side of the partition property. Both call sites currently
    // launder the value before it gets here, so without this the guard is
    // protected by its callers rather than the other way round — and a third
    // call site that forgets would silently attribute the whole live grid to
    // one technique.
    const untagged: Tag[] = [
      { category: 'sweep', event: 'scored', position: 'Guard', count: 4 },
      { category: 'sweep', event: 'scored', position: 'Guard', technique_id: null, count: 2 },
    ];
    expect(techniqueOutcomeCount(untagged, null, 'scored')).toBe(0);
    expect(techniqueOutcomeCount(untagged, undefined, 'scored')).toBe(0);
    expect(techniqueOutcomeCount(untagged, '', 'scored')).toBe(0);
  });

  it('sums counts across rows and never crosses technique or event', () => {
    const tags: Tag[] = [
      { ...armbar, event: 'attempted', count: 2 },
      { ...armbar, event: 'attempted', count: 3 }, // a duplicate the API would accept
      { ...armbar, event: 'scored', count: 1 },
      { ...triangle, event: 'attempted', count: 9 },
    ];
    expect(techniqueOutcomeCount(tags, 'armbar-from-guard', 'attempted')).toBe(5);
    expect(techniqueOutcomeCount(tags, 'armbar-from-guard', 'scored')).toBe(1);
    expect(techniqueOutcomeCount(tags, 'unknown', 'attempted')).toBe(0);
  });
});
