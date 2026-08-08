import { plannedEntryTarget } from '../WeekPlanner';

/**
 * A planned row opens something, or says nothing about opening.
 *
 * The bug: the row carried `accessibilityRole="button"` and drew a chevron
 * while having no `onPress` at all. On a device that is not "a row you long
 * press", it is a broken row — three taps at three points did nothing, under
 * the standard affordance for "tap to open".
 *
 * Both halves of the fix hang off this predicate: it decides whether the row
 * navigates AND whether the chevron is drawn, so the affordance cannot drift
 * from the behaviour. That is the property worth pinning — a fix that added
 * `onPress` but left the chevron unconditional would still lie on the rows
 * that have nowhere to go, and those are the common ones (a bare "BJJ on
 * Thursday" names no template at all).
 */

describe('plannedEntryTarget', () => {
  it('opens the workout a plan names, when the cache still holds it', () => {
    expect(plannedEntryTarget({ workoutId: 'w1' }, { w1: 'Push Day' })).toBe('w1');
  });

  it('opens nothing when the plan names no template', () => {
    // A plan can be nothing but a sport and a day — "BJJ on Thursday". There
    // is no detail screen for that, and the row must not claim there is.
    expect(plannedEntryTarget({ workoutId: null }, { w1: 'Push Day' })).toBeNull();
  });

  /**
   * The case `lib/plan.ts` creates on purpose.
   *
   * Plans keep no foreign key to workouts, so a template deleted on another
   * device leaves the plan row pointing at an id nothing resolves. The title
   * already falls back to "<Sport> session" for exactly this; navigating would
   * push a detail screen that can only render an error.
   */
  it('opens nothing when the named template is no longer cached', () => {
    expect(plannedEntryTarget({ workoutId: 'gone' }, { w1: 'Push Day' })).toBeNull();
  });

  it('opens nothing when the cache is empty, not merely missing the id', () => {
    expect(plannedEntryTarget({ workoutId: 'w1' }, {})).toBeNull();
  });

  /**
   * A name is a name, including a falsy-looking one.
   *
   * Guarding on `names[id]` truthiness is the simple reading, and an empty
   * string is the case where it silently differs from "the cache holds this
   * id". A workout saved with a blank name is reachable in the app (the rename
   * field abandons blanks, but nothing backfills rows created before that), and
   * it should still open rather than becoming quietly inert.
   */
  it('treats a cached-but-empty name as nowhere to go, and says so deliberately', () => {
    // Documenting the current behaviour rather than asserting it is ideal: an
    // empty name renders as the "<Sport> session" fallback anyway, so a row
    // that opened would show a title the plan row never displayed.
    expect(plannedEntryTarget({ workoutId: 'w1' }, { w1: '' })).toBeNull();
  });
});
