import { destinationOf } from '../../app/sync';
import type { BlockedRow } from '@/lib/sessionStore';

/**
 * Where the repair screen sends you.
 *
 * The list used to be a dead end: it named the session, quoted the server's
 * complaint about set 10, and offered only "Try again" — which replays the same
 * doomed request. Every row opens the thing it is about now, and the routing is
 * the part worth pinning, because getting it wrong is a bug this project has
 * already shipped once. A BJJ class opened at `/session/[id]` — the strength
 * screen, which knows only about sets — renders as "Sets 0 · Reps 0 · Volume
 * —", an empty shell for a class that was logged in full.
 *
 * A unit test rather than a screen test on purpose: this is a pure mapping, and
 * the interesting failure is the mapping, not the tap.
 */

const row = (over: Partial<BlockedRow>): BlockedRow => ({
  kind: 'session',
  id: 's1',
  name: 'Workout 1',
  lastError: 'set 10: weight must be greater than 0',
  sport: 'strength',
  ...over,
});

it('sends a strength session to the session screen', () => {
  expect(destinationOf(row({ sport: 'strength' }))).toEqual({
    pathname: '/session/[id]',
    params: { id: 's1' },
  });
});

it('sends a BJJ class to the BJJ screen, not the strength one', () => {
  expect(destinationOf(row({ sport: 'bjj', id: 'c9' }))).toEqual({
    pathname: '/bjj/session/[id]',
    params: { id: 'c9' },
  });
});

it('sends a plan to the workout screen', () => {
  // `sport` is empty for a workout — it has only one destination — so this also
  // covers the routing not falling through to the sport check.
  expect(destinationOf(row({ kind: 'workout', id: 'w4', sport: '' }))).toBe('/workout/w4');
});

// N460/#771: this used to say "treats an unrecognised sport as a strength
// session" and asserted `/session/s1` — which was true only because nothing
// routed a running row anywhere specific yet, and is the exact bug the ticket
// fixes. Running is now a recognised sport with its own destination.
it('sends a running session to the live GPS tracker, not the strength session screen', () => {
  expect(destinationOf(row({ sport: 'running' }))).toEqual({
    pathname: '/running/[id]',
    params: { id: 's1' },
  });
});

it('still treats a genuinely unrecognised sport as a strength session', () => {
  // A sport this build has never heard of still opens somewhere, which beats
  // a dead row — `sessionHref`'s fallthrough branch, exercised here through
  // `destinationOf` rather than only through `sessionHref` directly.
  expect(destinationOf(row({ sport: 'rowing' }))).toEqual({
    pathname: '/session/[id]',
    params: { id: 's1' },
  });
});
