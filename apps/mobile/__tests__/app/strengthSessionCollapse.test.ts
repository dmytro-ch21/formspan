import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * N530/#961 — per-exercise "Done", and "+ Set" after a drop: the screen half.
 *
 * Same approach as `strengthSessionFinishPlacement.test.ts`, for the same
 * reason: `app/session/[id].tsx` has no render test, and building one would
 * mean mocking SQLite, sync, the rest timer and the celebration flow to look
 * at one branch. The properties this ticket needs from the SCREEN (as opposed
 * to the lib, which `lib/__tests__/sessionCollapse.test.ts`,
 * `addSetAfterDrop.test.ts` and `collapsedGroupsStore.test.ts` cover
 * directly) are structural, and a static read proves them:
 *
 *  - "+ Set" goes through `emptyWorkingSet`, never `emptySet` — the bug was
 *    one call site, and this is the call site.
 *  - The collapsed-state hook sits ABOVE the screen's early returns. Hook
 *    order is invisible to the typechecker; `react-hooks/rules-of-hooks` is
 *    the real guard, and this pins the same fact from the other side.
 *  - The collapsed branch renders BEFORE "+ Set"/"+ Drop" and the set rows,
 *    and returns — so a folded group cannot show either.
 *  - `toggleCollapsed` touches `collapsed` and its column only: no `sets`,
 *    no `completed`, no `commit`, no `persist`.
 *
 * None of this proves the rendered screen on a device — that is the ticket's
 * two NEEDS HUMAN EVIDENCE items.
 */

const SOURCE_PATH = resolve(__dirname, '../../app/session/[id].tsx');
const source = readFileSync(SOURCE_PATH, 'utf8');

function body(fnName: string): string {
  // From `function <name>(` to the next top-level `\n  }` closing brace at the
  // component's indentation. Good enough for these single-purpose functions;
  // a mismatch fails loudly below rather than passing on an empty string.
  const start = source.indexOf(`function ${fnName}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }\n', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

it('actually read the file', () => {
  expect(source.length).toBeGreaterThan(1000);
});

describe('"+ Set" always makes a working set', () => {
  it('addSet builds its row with emptyWorkingSet, not emptySet', () => {
    const addSet = body('addSet');
    expect(addSet).toContain('emptyWorkingSet(sets, exerciseID, afterIndex)');
    expect(addSet).not.toMatch(/\bemptySet\(/);
  });

  it('the screen no longer imports emptySet at all', () => {
    // There is exactly one place on this screen that ever built a plain set,
    // and it was the bug. Reimporting `emptySet` here is how it comes back.
    expect(source).not.toMatch(/^\s*emptySet,\s*$/m);
  });

  it('addDropSet still goes through emptyDropSet', () => {
    expect(body('addDropSet')).toContain('emptyDropSet(sets[afterIndex], afterIndex + 1)');
  });
});

describe('the collapsed-state hook is above every early return', () => {
  it('useState for collapsed precedes the loading early return', () => {
    const hook = source.indexOf('const [collapsed, setCollapsed] = useState');
    const firstEarlyReturn = source.indexOf('if (loading && !everLoaded) {');
    expect(hook).toBeGreaterThan(-1);
    expect(firstEarlyReturn).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(firstEarlyReturn);
  });
});

describe('a folded group shows the summary and none of the set controls', () => {
  it('the collapsed branch returns before the rows, "+ Set" and "+ Drop"', () => {
    const branch = source.indexOf('if (collapsed.has(key)) {');
    const branchReturn = source.indexOf('return (', branch);
    const summary = source.indexOf('testID={`summary-${g.exerciseID}`}');
    const expand = source.indexOf('testID={`expand-${g.exerciseID}`}');
    const addSet = source.indexOf('testID={`add-set-${g.exerciseID}`}');
    const addDrop = source.indexOf('testID={`add-drop-${g.exerciseID}`}');
    const rows = source.indexOf('testID={`set-${i}-swipe`}');
    const done = source.indexOf('testID={`done-${g.exerciseID}`}');

    for (const i of [branch, branchReturn, summary, expand, addSet, addDrop, rows, done]) {
      expect(i).toBeGreaterThan(-1);
    }
    // Summary and the re-expand control live inside the branch…
    expect(summary).toBeGreaterThan(branch);
    expect(expand).toBeGreaterThan(branch);
    // …and everything a folded group must NOT show comes after it, in the
    // full render that the branch's `return` never reaches.
    for (const i of [done, rows, addSet, addDrop]) {
      expect(i).toBeGreaterThan(summary);
      expect(i).toBeGreaterThan(expand);
    }
  });

  it('the summary is built from the group\'s own rows', () => {
    expect(source).toContain('summariseGroup(');
    expect(source).toMatch(/summariseGroup\(\s*g\.indices\.map\(\(i\) => sets\[i\]\)/);
  });
});

describe('Done writes nothing to any set', () => {
  it('toggleCollapsed never reaches sets, completed, commit or persist', () => {
    const toggle = body('toggleCollapsed');
    // N543/#981 moved two things and neither weakens this: the updater is
    // now functional (`prev`, not the render closure's `collapsed`), and the
    // SQLite write moved to a single effect on `collapsed` so the updater
    // stays pure. What this test is FOR is unchanged — the fold path must
    // not be able to reach a row.
    expect(toggle).toContain('toggleGroup(prev, key)');
    expect(toggle).not.toContain('saveCollapsedGroups(');
    expect(toggle).not.toMatch(/\bsetSets\b/);
    expect(toggle).not.toMatch(/\bcompleted\b/);
    expect(toggle).not.toMatch(/\bcommit\(/);
    expect(toggle).not.toMatch(/\bpersist/);
    expect(toggle).not.toMatch(/\bsaveLocalSets\b/);
    expect(toggle).not.toMatch(/\bstopTimerForStructureChange\b/);
  });

  it('the Done chip and the collapsed header both call toggleCollapsed, and nothing else calls it', () => {
    const calls = source.match(/toggleCollapsed\(key\)/g) ?? [];
    expect(calls).toHaveLength(2);
  });
});

/**
 * N543/#981 — the fold state must be REBUILT whenever a block can disappear.
 *
 * `groupKeys` numbers blocks by occurrence, so a removal renames every later
 * block of the same exercise: drop the first squat of a circuit and `squat#1`
 * becomes `squat#0`. `lib/__tests__/sessionCollapse.test.ts` proves
 * `rekeyCollapsed` answers that correctly. Only a read of THIS file can prove
 * the screen asks it — and "a helper that is right and uncalled" is precisely
 * the shape of the bug being fixed, which lived a whole release as
 * `removeGroup` never touching the `collapsed` set while every pure function
 * around it behaved perfectly.
 */
describe('every removal rebuilds the fold state', () => {
  it.each(['removeSet', 'removeGroup'])('%s rekeys the collapsed set', (fn) => {
    const fnBody = body(fn);
    // `sets` is the list BEFORE the removal, and `surviving` the old indices
    // that remain — handing it the post-removal list would compare a list
    // against itself and change nothing, silently.
    expect(fnBody).toMatch(/setCollapsed\(\(prev\) => rekeyCollapsed\(prev, sets, surviving\)\)/);
  });

  it('moveGroup rekeys too, from the same permutation the move is built on', () => {
    // The case N543's first draft argued away and `frontend-reviewer`
    // reproduced: moving a block out from between two same-exercise blocks
    // makes them adjacent, `groupSets` welds them into one, and every later
    // block of that exercise is renamed — no removal anywhere.
    const fnBody = body('moveGroup');
    expect(fnBody).toMatch(/setCollapsed\(\(prev\) => rekeyCollapsed\(prev, sets, moved\)\)/);
    // One copy of the swap, not two: the screen builds the new set list from
    // the SAME permutation it hands the rekey, so the two cannot disagree.
    expect(fnBody).toContain('reorderedIndices(');
    expect(fnBody).toContain('commit(moved.map((i, position) => ({ ...sets[i], position })))');
    expect(fnBody).not.toContain('reorderGroups(');
  });

  it('the screen imports rekeyCollapsed', () => {
    // Guards the guard: a rename that broke the two assertions above should
    // fail loudly here rather than leaving them matching nothing.
    expect(source).toContain('rekeyCollapsed');
  });

  it('the fold state is written from exactly one place', () => {
    // The effect on `collapsed`. Two writers means a rekey somewhere saves a
    // different set than the one it just installed.
    expect(source.match(/saveCollapsedGroups\(/g) ?? []).toHaveLength(1);
  });

  it('the stored fold state is read once per session, not once per focus', () => {
    // `load` re-runs on every focus, and `collapsed_json` has exactly one
    // writer — this screen. So a re-read there can only return what this
    // screen last wrote, and its one possible surprise is a stale answer
    // clobbering a toggle whose write is still in flight. Hydrating once
    // removes the read rather than racing it.
    const read = source.indexOf('readCollapsedGroups(userId, id)');
    expect(read).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, read - 400), read)).toContain(
      'collapsedHydratedFor.current !==',
    );
  });
});

describe('the 2-tap logging path is untouched', () => {
  it('"+ Set" still commits straight from addSet, and the row tick is still toggleDone', () => {
    // Before this ticket: "+ Set" → ✓ was two taps. After: the same two
    // controls, the same two handlers, nothing in between — Done is a third
    // control on the header, not a step on this path.
    expect(source).toContain('onPress={() => addSet(g.exerciseID, g.indices[g.indices.length - 1])}');
    expect(source).toContain('onToggleDone={() => toggleDone(i, g.exerciseID)}');
  });
});
