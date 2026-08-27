import {
  FUNNEL_OUTCOMES,
  LIVE_ROWS,
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
 * guarantee is that the two halves of the tag list stay disjoint — the
 * category grid owns untagged rows, the focus rows own technique-tagged ones —
 * and that removing a drilled chip cannot strand evidence that is still saved
 * and sent.
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

  describe('backfills a drilled tag (N206)', () => {
    // A live outcome IS evidence of drilling — you cannot land, miss or get
    // stopped on a technique you did not practise that session. A focus
    // technique whose ONLY criterion is `target_drilled_sessions` (a
    // breakfall, say) is worked exclusively through these live counters —
    // typing it a second time into the drilled-step picker is a separate,
    // slower action — so before this fix the "classes drilled in X/Y"
    // milestone never moved no matter how many times "Landed" was tapped.
    const focus = {
      technique_id: 'breakfall-backward',
      name: 'Backward Breakfall',
      position: 'Standing',
      category: 'control' as const,
    };

    it('adds one drilled tag the first time any live outcome is recorded', () => {
      const tags = bumpTechniqueOutcome([], focus, 'scored', 1);
      expect(tags).toContainEqual({
        category: 'control',
        event: 'drilled',
        position: 'Standing',
        technique_id: 'breakfall-backward',
        count: 1,
      });
    });

    it('does not add a second drilled tag on a later bump', () => {
      let tags = bumpTechniqueOutcome([], focus, 'scored', 1);
      tags = bumpTechniqueOutcome(tags, focus, 'scored', 4); // "Landed" tapped four more times
      expect(tags.filter((t) => t.event === 'drilled')).toHaveLength(1);
      expect(techniqueOutcomeCount(tags, 'breakfall-backward', 'scored')).toBe(5);
    });

    it('does not add a second drilled tag when the drilled-step picker already recorded one', () => {
      // armbar is already `event: 'drilled'` in the seed array.
      const tags = bumpTechniqueOutcome([armbar], armbar, 'scored', 1);
      expect(tags.filter((t) => t.event === 'drilled')).toHaveLength(1);
    });

    it('never backfills on a decrement, even from nothing', () => {
      expect(bumpTechniqueOutcome([], focus, 'scored', -1)).toEqual([]);
    });

    it('never backfills on a decrement of an existing row either', () => {
      // The test above returns early on the `i === -1, delta < 0` branch,
      // before the backfill guard is ever reached — it cannot tell a working
      // `delta > 0` check from a deleted one. This one goes through the
      // OTHER branch (an existing row found, then decremented), which is
      // the path a session synced before N206 shipped would take: a live
      // count already exists with no drilled tag alongside it yet.
      const existingScored: Tag = { ...focus, event: 'scored', count: 3 };
      const tags = bumpTechniqueOutcome([existingScored], focus, 'scored', -1);
      expect(tags.some((t) => t.event === 'drilled')).toBe(false);
    });

    it('backfills per technique — a different technique already having a drilled tag does not suppress it', () => {
      // The dedup check has to match on technique_id, not "does a drilled tag
      // exist anywhere in this session's tags" — armbar's own drilled tag
      // (already in the seed array) must not block breakfall's backfill.
      const tags = bumpTechniqueOutcome([armbar], focus, 'scored', 1);
      expect(tags).toContainEqual({
        category: 'control',
        event: 'drilled',
        position: 'Standing',
        technique_id: 'breakfall-backward',
        count: 1,
      });
    });
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
  it('leaves the technique’s live outcomes alone', () => {
    // INVERTED from what this asserted before, deliberately.
    //
    // While the drilled step owned the tried/landed counters, removing a chip
    // had to take them with it or they became stranded — saved and sent with
    // no control able to edit them. Live outcomes now come from the focus rows
    // on the live step, which are reachable whether or not the technique was
    // drilled today. So "I did not actually drill this" and "I did not hit
    // this live" became different statements, and un-saying one must not
    // un-say the other.
    let tags: Tag[] = [armbar, triangle];
    tags = bumpTechniqueOutcome(tags, armbar, 'attempted', 2);
    tags = bumpTechniqueOutcome(tags, armbar, 'scored', 1);

    const after = removeDrilledTechnique(tags, 'armbar-from-guard');
    if (after.some((t) => t.event === 'drilled' && t.technique_id === 'armbar-from-guard')) {
      throw new Error('the drilled row survived');
    }
    expect(techniqueOutcomeCount(after, 'armbar-from-guard', 'attempted')).toBe(2);
    expect(techniqueOutcomeCount(after, 'armbar-from-guard', 'scored')).toBe(1);
    // and the other technique is untouched
    expect(after.some((t) => t.technique_id === 'triangle-from-guard')).toBe(true);
  });

  it('leaves the live grid’s untagged rows alone', () => {
    // A spread of events including `drilled`, the only one the function can
    // now delete — so for the rest, and for `drilled` on a different
    // technique, the id match is the only thing sparing them. The first version of this test used a single
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

  it('keeps every non-drilled row for that technique', () => {
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

describe('the defensive half of the funnel', () => {
  /*
   * `defended` completes a 2x2 of who started the exchange and whether it
   * landed. Before it existed, defensive success was the one outcome nothing
   * could record — inferable only from an absence, and an absence argues more
   * strongly the LESS you roll.
   *
   * Note what is NOT tested here: that `bumpTechniqueOutcome` stores a
   * `defended` count. It has no event-specific branching — `event` is an
   * opaque match key — so such a test would pass for `'banana'` too and could
   * not fail for a defended-specific reason. The behaviour worth pinning is
   * where the event is offered and where it is deliberately not.
   */
  it('offers the defensive counter on the per-technique chips', () => {
    // Labels, not just events: the label is what the athlete reads, and a bare
    // "Stopped" was ambiguous enough to invert the data — it reads as "my
    // technique got stopped", which is what `attempted` already means.
    //
    // "Missed", not "Tried", and this one is now load-bearing rather than
    // cosmetic. The column counts attempts that did NOT land, so "Tried" reads
    // as total tries and anyone tapping it that way double-counts every score.
    // A roadmap's `min_hit_rate` is scored / (attempted + scored), so that
    // misreading biases the hit rate DOWNWARD — against the athlete, on the
    // number that decides whether a technique is mastered.
    expect(FUNNEL_OUTCOMES.map((o) => o.label)).toEqual(['Missed', 'Landed', 'Stopped theirs']);
    expect(FUNNEL_OUTCOMES.map((o) => o.event)).toEqual(['attempted', 'scored', 'defended']);
  });

  it('keeps the category grid free of it', () => {
    // The grid is the fastest structured input in the app. A defensive column
    // there would tax every session for every athlete to serve a roadmap
    // criterion most are not on — so it stays five rows of scored/conceded.
    expect(LIVE_ROWS).toHaveLength(5);
    for (const r of LIVE_ROWS) {
      expect(Object.keys(r).sort()).toEqual(['category', 'conceded', 'label', 'scored']);
    }
  });

  it('clamps a decrement at zero rather than going negative', () => {
    const focus = { technique_id: 't1', name: 'Guard pull', position: 'Standing', category: 'sweep' as const };
    // Bump to one FIRST — decrementing an empty list exits at the early
    // return and never reaches the clamp this is named for.
    let tags = bumpTechniqueOutcome([], focus, 'defended', 1);
    expect(techniqueOutcomeCount(tags, 't1', 'defended')).toBe(1);
    tags = bumpTechniqueOutcome(tags, focus, 'defended', -1);
    expect(techniqueOutcomeCount(tags, 't1', 'defended')).toBe(0);
    // The defended row itself is removed rather than left at zero, so it
    // cannot be PUT as a meaningless count — but the backfilled `drilled` row
    // (N206) is NOT removed by decrementing a live count back to zero. Once a
    // session has evidence the technique was drilled, undoing a tap should
    // not erase that; see `bumpTechniqueOutcome`'s docstring.
    expect(tags.filter((t) => t.technique_id === 't1')).toEqual([
      { category: 'sweep', event: 'drilled', position: 'Standing', technique_id: 't1', count: 1 },
    ]);
  });

  it('does not let a defended count leak into the offensive ones', () => {
    const focus = { technique_id: 't1', name: 'Guard pull', position: 'Standing', category: 'sweep' as const };
    const tags = bumpTechniqueOutcome([], focus, 'defended', 2);
    expect(techniqueOutcomeCount(tags, 't1', 'scored')).toBe(0);
    expect(techniqueOutcomeCount(tags, 't1', 'attempted')).toBe(0);
    // The roadmap reads the two directions as separate criteria; one bleeding
    // into the other would complete the wrong half.
    expect(techniqueOutcomeCount(tags, 't1', 'defended')).toBe(2);
  });
});
