import { readFileSync } from 'fs';
import { join } from 'path';

import type { TechniqueSummary } from '../techniques';
import { buildTechniqueGraph, follows, groupByFunction } from '../techniqueGraph';

/**
 * The library stored graph edges for months in the one direction nobody asks
 * about. `setup_from` answers "what is this set up from"; standing in a
 * position the question is "what can I do from here", and nothing could
 * answer it.
 *
 * These cover the inversion, and then run it over the REAL seeded library —
 * because the interesting claim is not that the function works on three
 * fixtures, it is that the shipped data is connected enough for the inversion
 * to be worth rendering. A unit test on fixtures would pass just as happily
 * over a graph with four edges in it.
 */

const t = (over: Partial<TechniqueSummary> & { id: string; name: string }): TechniqueSummary => ({
  aliases: [],
  category: 'Submission',
  position: 'Guard - Bottom',
  position_detail: 'Closed Guard',
  gi_no_gi: 'Both',
  typical_belt: 'White',
  ibjjf_ruleset_id: '',
  setup_from: [],
  ...over,
});

describe('inverting setup_from', () => {
  it('answers what follows from a technique', () => {
    const list = [
      t({ id: 'ctrl', name: 'Closed-Guard Posture Control' }),
      t({ id: 'armbar', name: 'Armbar', setup_from: ['Closed-Guard Posture Control'] }),
      t({ id: 'triangle', name: 'Triangle', setup_from: ['Closed-Guard Posture Control'] }),
    ];
    const g = buildTechniqueGraph(list);
    expect(follows(g, 'ctrl').map((x) => x.id)).toEqual(['armbar', 'triangle']);
    // The forward direction is unchanged and still empty for a leaf.
    expect(follows(g, 'armbar')).toEqual([]);
  });

  it('resolves an alias, because the library carries both spellings', () => {
    const list = [
      t({ id: 'scarf', name: 'Scarf Hold', aliases: ['kesa gatame'] }),
      t({ id: 'americana', name: 'Americana', setup_from: ['kesa gatame'] }),
    ];
    expect(follows(buildTechniqueGraph(list), 'scarf').map((x) => x.id)).toEqual(['americana']);
  });

  it('counts an edge naming something the library lacks, rather than dropping it', () => {
    // ~20% of setup_from values are concepts — "Underhook", "Crossface".
    // Silently discarding them would present a partial graph as a complete
    // one; counting them lets a caller report honest coverage.
    const list = [t({ id: 'a', name: 'A', setup_from: ['Underhook', 'Crossface'] })];
    expect(buildTechniqueGraph(list).unresolved).toBe(2);
  });

  it('never lists a technique inside its own follows', () => {
    const list = [t({ id: 'a', name: 'A', setup_from: ['A'] })];
    expect(follows(buildTechniqueGraph(list), 'a')).toEqual([]);
  });
});

describe('grouping by what a technique does', () => {
  it('orders the verbs pedagogically and omits empty groups', () => {
    const list = [
      t({ id: '1', name: 'Sweep', function: 'reverse' }),
      t({ id: '2', name: 'Pass', function: 'advance' }),
      t({ id: '3', name: 'Choke', function: 'finish' }),
    ];
    // Not alphabetical: advance before reverse before finish, and no empty
    // "Escape" heading claiming there is no way out of this position.
    expect(groupByFunction(list).map((g) => g.fn)).toEqual(['advance', 'reverse', 'finish']);
  });

  it('gives the movement fundamentals no group at all', () => {
    // They have no verb by design; an "Other" bucket would imply the taxonomy
    // failed to classify them rather than that they are not techniques.
    const list = [t({ id: 'bf', name: 'Side Breakfall' })];
    expect(groupByFunction(list)).toEqual([]);
  });
});

/**
 * Over the real library. This is the test that would have stopped me building
 * on a graph that turned out to be mostly holes — it pins the connectivity
 * that made the whole approach worth choosing over authoring a new column.
 */
describe('the shipped library is actually connected', () => {
  const raw = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'backend/internal/modules/technique/techniques.json'),
    'utf8',
  );
  const library = (JSON.parse(raw) as TechniqueSummary[]).map((x) => ({
    ...x,
    setup_from: x.setup_from ?? [],
  }));

  it('has enough nodes for a hub to be worth rendering', () => {
    const g = buildTechniqueGraph(library);
    const hubs = [...g.follows.values()].filter((v) => v.length >= 3).length;
    // Measured at 100+ when written. Pinned low so ordinary library growth
    // does not fail it, but high enough that a change gutting the edges does.
    expect(hubs).toBeGreaterThan(40);
    expect(g.follows.size).toBeGreaterThan(120);
  });

  it('resolves the large majority of its edges', () => {
    const g = buildTechniqueGraph(library);
    const total = library.reduce((n, x) => n + (x.setup_from?.length ?? 0), 0);
    const resolved = total - g.unresolved;
    expect(resolved / total).toBeGreaterThan(0.7);
  });

  it('every function value is one the grouper renders', () => {
    // A sixth verb added to the backend without being added to FUNCTION_ORDER
    // would silently vanish from every position screen — present in the data,
    // absent from the UI, with nothing failing.
    const grouped = groupByFunction(library);
    const shown = grouped.reduce((n, g) => n + g.techniques.length, 0);
    const withFunction = library.filter((x) => x.function).length;
    expect(shown).toBe(withFunction);
  });
});
