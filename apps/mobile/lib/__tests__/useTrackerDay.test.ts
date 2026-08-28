import { entriesForLoadedDay } from '../useTrackerDay';
import type { TrackerEntry } from '../trackerModel';

/**
 * W16/#704 — a water/coffee tap logged on a browsed day leaked onto every
 * other day until something else forced a re-fetch.
 *
 * `refresh(on)` is async: SQLite first, then the network. `entriesFor` used
 * to hand back whatever `loaded.entries` currently held with no check that
 * `loaded` was ever asked to load the day being displayed — so a screen that
 * had moved on to a new day, while the previous day's `refresh` was still in
 * flight (or simply hadn't been re-triggered), rendered the PREVIOUS day's
 * rows under the new one.
 *
 * `entriesForLoadedDay` is the guard pulled out of the hook so this can be
 * pinned as a plain unit test over `{on, entries}` state, rather than
 * `renderHook`-ing the whole hook (Clerk auth, SQLite, network) to prove a
 * string comparison.
 */

const tap = (id: string): TrackerEntry => ({
  id,
  tracker_id: 'water',
  logged_on: '2026-08-25',
  logged_at: '2026-08-25T08:00:00.000Z',
  amount: 1,
});

it('returns the entries when the loaded day matches the day being asked for', () => {
  const loaded = { on: '2026-08-26', entries: [tap('t1'), tap('t2')] };
  expect(entriesForLoadedDay(loaded, 'water', '2026-08-26')).toEqual([tap('t1'), tap('t2')]);
});

it('never leaks a browsed day\'s taps onto another day still mid-refresh', () => {
  // The exact sequence from the report: browse to yesterday, log a tap
  // there (loaded now says yesterday), then browse back to today. `refresh`
  // for today has been called but its SQLite/network round trip has not
  // resolved yet — `loaded` still reflects yesterday.
  const loggedYesterday = { on: '2026-08-25', entries: [tap('yesterday-cup')] };

  // Today's own cards, still reading `loaded` from before `refresh('2026-08-26')`
  // resolves, must see nothing — not yesterday's cup.
  expect(entriesForLoadedDay(loggedYesterday, 'water', '2026-08-26')).toEqual([]);

  // And browsing back to yesterday itself must still see its own tap — the
  // guard is a day MATCH, not a blanket "always empty until reload".
  expect(entriesForLoadedDay(loggedYesterday, 'water', '2026-08-25')).toEqual([
    tap('yesterday-cup'),
  ]);
});

it('shows today\'s own entries once refresh actually resolves for today', () => {
  // The window closes the moment `refresh('2026-08-26')`'s readLocal() lands
  // and calls `setLoaded`.
  const loadedToday = { on: '2026-08-26', entries: [tap('today-cup')] };
  expect(entriesForLoadedDay(loadedToday, 'water', '2026-08-26')).toEqual([tap('today-cup')]);
});

it('scopes by tracker id, not just by day', () => {
  const loaded = {
    on: '2026-08-26',
    entries: [
      { ...tap('w1'), tracker_id: 'water' },
      { ...tap('c1'), tracker_id: 'coffee' },
    ],
  };
  expect(entriesForLoadedDay(loaded, 'water', '2026-08-26')).toEqual([
    { ...tap('w1'), tracker_id: 'water' },
  ]);
  expect(entriesForLoadedDay(loaded, 'coffee', '2026-08-26')).toEqual([
    { ...tap('c1'), tracker_id: 'coffee' },
  ]);
});

it('the untouched-since-mount state ("") never matches a real day', () => {
  // `useTrackerDay`'s initial `loaded.on` is `''` before the first `refresh`
  // call resolves anything — this must not accidentally equal a legitimate
  // day key and hand back stale/empty rows as if they were authoritative.
  const initial = { on: '', entries: [] as TrackerEntry[] };
  expect(entriesForLoadedDay(initial, 'water', '2026-08-26')).toEqual([]);
});
