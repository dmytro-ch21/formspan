import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * N445 — "Finish session" lives in ordinary scroll content, not a pinned
 * footer that tracks an open keyboard.
 *
 * No dedicated render test exists for `app/session/[id].tsx` — it is the
 * biggest screen in the app, wired to SQLite, sync, the rest timer and
 * celebration flow, and rendering it would mean mocking most of that
 * dependency graph just to look at one control's position. That cost buys
 * nothing this regression actually needs: the property N445 fixes is
 * structural (which container Finish is a child of, and where in the file
 * it sits relative to the last content control), which a static read of the
 * source proves directly — the same approach
 * `components/__tests__/keyboardCoverage.test.ts` already takes for a
 * sibling keyboard-handling property on every screen in the app.
 *
 * **What this proves, precisely.** That the source text places
 * `testID="session-finish"` after `testID="session-add-exercise"` and before
 * the scroll view's closing tag, and that the file does not import
 * `KeyboardAwareFooter` at all. It does not prove the rendered layout is
 * correct on a device — see the NEEDS HUMAN EVIDENCE item in
 * `docs/testing/functional-scenarios.md`'s N445 section for that.
 */

const SOURCE_PATH = resolve(__dirname, '../../app/session/[id].tsx');
const source = readFileSync(SOURCE_PATH, 'utf8');

describe('Finish session sits in scroll content, not a pinned footer', () => {
  it('actually read the file', () => {
    // Guards the guard — an empty or truncated read would make every
    // assertion below pass by finding nothing to fail on.
    expect(source.length).toBeGreaterThan(1000);
  });

  it('does not import or render KeyboardAwareFooter any more', () => {
    // This is the mechanism N184 used to pin Finish above the keyboard.
    // Reimporting or rendering it on this screen is exactly how the
    // regression would come back. Matched as an import/JSX-open, not as a
    // bare substring — the file's own comments explain this history by name,
    // and a substring match would fail on its own documentation.
    expect(source).not.toMatch(/^\s*KeyboardAwareFooter,?\s*$/m);
    expect(source).not.toMatch(/<KeyboardAwareFooter\b/);
  });

  it('renders session-finish strictly inside the KeyboardAwareScrollView', () => {
    const scrollOpen = source.indexOf('<KeyboardAwareScrollView');
    const scrollClose = source.indexOf('</KeyboardAwareScrollView>');
    const finishTestID = source.indexOf('testID="session-finish"');

    expect(scrollOpen).toBeGreaterThan(-1);
    expect(scrollClose).toBeGreaterThan(scrollOpen);
    expect(finishTestID).toBeGreaterThan(-1);
    expect(finishTestID).toBeGreaterThan(scrollOpen);
    expect(finishTestID).toBeLessThan(scrollClose);
  });

  it('renders session-finish after the last exercise content, not before it', () => {
    // "+ Add exercise" is the last control that belongs to the exercise list
    // itself — Finish has to come after it, per the acceptance criterion that
    // it sits "after the last exercise / \"+ Add exercise\" control".
    const addExerciseTestID = source.indexOf('testID="session-add-exercise"');
    const finishTestID = source.indexOf('testID="session-finish"');

    expect(addExerciseTestID).toBeGreaterThan(-1);
    expect(finishTestID).toBeGreaterThan(addExerciseTestID);
  });

  it('keeps the exact HoldToConfirm safety-gesture copy unchanged', () => {
    // The confirm mechanism (label/hold copy/confirm dialog) is explicitly
    // out of scope for N445 — only the container moved. Pinning the literal
    // strings means a future edit that quietly changes the gesture's wording
    // shows up here rather than only in a design review.
    expect(source).toMatch(/label="Finish session"/);
    expect(source).toMatch(/holdingLabel="Keep holding to finish…"/);
    expect(source).toMatch(/confirmTitle="Finish session\?"/);
    expect(source).toMatch(/confirmBody="You won't be able to add to it afterwards\."/);
  });

  it('leaves the rest-timer surface where it was, outside the scroll view', () => {
    // N445 only moves Finish. TimerSurface must still render after the
    // scroll view closes, same as before — a regression here would mean the
    // edit accidentally dragged the timer bar along with Finish.
    const scrollClose = source.indexOf('</KeyboardAwareScrollView>');
    const timerSurface = source.indexOf('<TimerSurface');

    expect(scrollClose).toBeGreaterThan(-1);
    expect(timerSurface).toBeGreaterThan(scrollClose);
  });
});
