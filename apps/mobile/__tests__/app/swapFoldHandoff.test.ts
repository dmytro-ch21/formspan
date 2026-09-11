import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * F35/#999 — the wiring half: who records the handoff, and where it is applied.
 *
 * Same approach as `strengthSessionCollapse.test.ts`, for the same reason:
 * `app/session/[id].tsx` has no render test, and building one would mean mocking
 * SQLite, sync, the rest timer and the celebration flow to look at one branch.
 * The rekey itself is pinned in `lib/__tests__/sessionCollapse.test.ts` and the
 * handoff in `lib/__tests__/collapseHandoff.test.ts`; what only a read of the
 * source proves is that the three files are actually wired to them, in the
 * order that makes the rekey correct.
 *
 * None of this proves the rendered screen on a device.
 */

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const screen = read('../../app/session/[id].tsx');
const picker = read('../../app/session/[id]/add.tsx');
const identify = read('../../app/session/[id]/identify.tsx');

function loadBody(): string {
  const start = screen.indexOf('const load = useCallback(async () => {');
  expect(start).toBeGreaterThan(-1);
  const end = screen.indexOf('}, [getToken, id, userId, refreshSuggestions]);', start);
  expect(end).toBeGreaterThan(start);
  return screen.slice(start, end);
}

it('actually read all three files', () => {
  expect(screen.length).toBeGreaterThan(1000);
  expect(picker.length).toBeGreaterThan(1000);
  expect(identify.length).toBeGreaterThan(1000);
});

describe('the session screen applies the handoff in load', () => {
  it('takes it, checks it still describes SQLite, and rekeys through the functional updater', () => {
    const body = loadBody();
    expect(body).toContain('takeSetsHandoff(userId, id)');
    expect(body).toContain('handoffStillApplies(handoff, s.sets)');
    expect(body).toContain('setCollapsed((prev) => applySetsHandoff(prev, handoff))');
  });

  it('applies it AFTER hydration and BEFORE the sets reach the screen', () => {
    // After hydration, so a fresh mount rekeys the stored keys too; before
    // `setSets`, so the first render of the new rows already has the new keys.
    const body = loadBody();
    const hydrated = body.indexOf('collapsedHydratedFor.current = `${userId}:${id}`');
    const taken = body.indexOf('takeSetsHandoff(userId, id)');
    const shown = body.indexOf('setSets(s.sets)');
    expect(hydrated).toBeGreaterThan(-1);
    expect(taken).toBeGreaterThan(hydrated);
    expect(shown).toBeGreaterThan(taken);
  });
});

describe.each([
  ['the exercise picker', picker, 'await saveLocalSets(userId!, id, next)'],
  ['photo identify', identify, 'await saveLocalSets(userId, id, next)'],
])('%s records the handoff', (_name, source, save) => {
  it('records it after the save lands and before navigating back', () => {
    const saved = source.indexOf(save);
    const recorded = source.indexOf('recordSetsHandoff(', saved);
    const back = source.indexOf('router.back()', saved);
    expect(saved).toBeGreaterThan(-1);
    expect(recorded).toBeGreaterThan(saved);
    expect(back).toBeGreaterThan(recorded);
  });

  it('uses the swap correspondence when swapping and the append one otherwise', () => {
    expect(source).toContain(
      'swapping ? handoffForSwap(session.sets, next) : handoffForAppend(session.sets, next)',
    );
  });
});
