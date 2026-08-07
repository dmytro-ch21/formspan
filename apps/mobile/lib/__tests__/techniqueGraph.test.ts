import { readFileSync } from 'fs';
import { join } from 'path';

import type { TechniqueSummary } from '../techniques';
import {
  buildEdgeIndex,
  buildTechniqueGraph,
  follows,
  groupByFunction,
  resolveEdge,
} from '../techniqueGraph';

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

  it('is acyclic, which is what makes "Leads to" safe to push-navigate', () => {
    // The technique screen pushes /technique/[id] -> /technique/[id]. That is
    // only bounded because the real edges form a DAG — measured: 0 cycles,
    // longest walk 9 hops. Nothing enforced it, and it is a property of the
    // DATA, not the code: one edit making Armbar set up from Triangle while
    // Triangle sets up from Armbar turns the navigation stack unbounded.
    const g = buildTechniqueGraph(library);
    const state = new Map<string, 'open' | 'done'>();
    const cycles: string[] = [];
    const walk = (id: string) => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'open') {
        cycles.push(id);
        return;
      }
      state.set(id, 'open');
      for (const next of g.follows.get(id) ?? []) walk(next.id);
      state.set(id, 'done');
    };
    for (const t of library) walk(t.id);
    expect(cycles).toEqual([]);
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

/**
 * Resolving a cross-reference to a link.
 *
 * `setup_from` / `common_next_moves` / `common_counters` hold NAMES, so a
 * tappable row means resolving one first. These cases are the reasons the
 * links were removed once and are being reintroduced selectively — not "does
 * a Map work", but the specific ways a naive resolver misleads.
 */
describe('buildEdgeIndex / resolveEdge', () => {
  // The real shipped catalog, matching the suite above — the claim worth
  // testing is about the DATA, and fixtures would agree with the code by
  // construction. Aliases included: they are half the reason the index exists.
  const catalog = (
    JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'backend/internal/modules/technique/techniques.json'),
        'utf8',
      ),
    ) as TechniqueSummary[]
  ).map((x) => ({ ...x, aliases: x.aliases ?? [], setup_from: x.setup_from ?? [] }));
  const index = buildEdgeIndex(catalog);

  it('resolves a plain name', () => {
    const hit = resolveEdge(index, 'Knee-Cut Pass');
    expect(hit?.id).toBe('knee-cut-pass');
  });

  it('resolves across the dash the keyboard produces', () => {
    // The whole reason this index folds while buildTechniqueGraph does not.
    // The catalog stores an en dash; references are written with a hyphen.
    const dashed = catalog.find((t) => t.name.includes('–'));
    expect(dashed).toBeDefined();
    const typed = dashed!.name.replace(/–/g, '-');
    expect(typed).not.toBe(dashed!.name);
    expect(resolveEdge(index, typed)?.id).toBe(dashed!.id);
  });

  it('resolves an alias to the technique that owns it', () => {
    const withAlias = catalog.find((t) => (t.aliases ?? []).length > 0);
    expect(withAlias).toBeDefined();
    expect(resolveEdge(index, withAlias!.aliases[0])?.id).toBe(withAlias!.id);
  });

  it('returns null for prose, which is most of what counters hold', () => {
    // NOT a data gap. "Sprawl" and "Crossface" are reactions, not techniques,
    // and a resolver that invented entries for them would be worse than one
    // that leaves them as the text they are.
    expect(resolveEdge(index, 'Stabilize top position')).toBeNull();
    expect(resolveEdge(index, 'Hand fight')).toBeNull();
    expect(resolveEdge(index, 'zzz not a technique')).toBeNull();
  });

  it('refuses a self-reference', () => {
    // A row that navigates to the screen it is already on is a dead control
    // that looks live.
    const t = catalog.find((x) => x.id === 'knee-cut-pass');
    expect(t).toBeDefined();
    expect(resolveEdge(index, t!.name, t!.id)).toBeNull();
    // ...but the same name from a DIFFERENT technique's list still resolves.
    expect(resolveEdge(index, t!.name, 'some-other-id')?.id).toBe('knee-cut-pass');
  });

  it('prefers a real name over another entry’s alias', () => {
    // ON A FIXTURE, NOT THE CATALOG, and that is the point. The first version
    // of this searched the shipped library for a name/alias collision, found
    // none, and asserted nothing — it passed with the precedence deliberately
    // inverted. A guard the data happens not to exercise still has to be
    // tested; it just has to be tested somewhere the case exists.
    const list = [
      t({ id: 'armbar-mount', name: 'Armbar from Mount' }),
      // A different entry claiming the first one's name as its alias.
      t({ id: 'impostor', name: 'Something Else', aliases: ['Armbar from Mount'] }),
    ];
    const idx = buildEdgeIndex(list);
    expect(resolveEdge(idx, 'Armbar from Mount')?.id).toBe('armbar-mount');

    // ...and the order the list arrives in must not decide it either.
    expect(resolveEdge(buildEdgeIndex([...list].reverse()), 'Armbar from Mount')?.id).toBe(
      'armbar-mount',
    );
  });

  it('resolves the field we are linking often enough to be worth it', () => {
    // The measurement the whole decision rests on, asserted against the real
    // catalog so a content change that guts it is visible rather than silent.
    const rate = (field: 'setup_from') => {
      let tot = 0;
      let hit = 0;
      for (const t of catalog) {
        for (const raw of t[field] ?? []) {
          tot++;
          if (resolveEdge(index, raw, t.id)) hit++;
        }
      }
      return hit / tot;
    };
    // 86% measured. Floored well below that so ordinary content churn does not
    // fail the build — but if `setup_from` ever drops toward the counters'
    // coverage, linking it stops being defensible and this should say so.
    expect(rate('setup_from')).toBeGreaterThan(0.7);
  });
});
