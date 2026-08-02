import { chipFor } from '../SyncChip';
import type { SyncState } from '@/lib/sync';

/**
 * What the chip says, which is the whole of its behaviour.
 *
 * Extracted from the component because the decision is a priority ordering
 * over five pieces of state, and that is where it can be wrong in a way an
 * athlete would notice — not in how it renders.
 */

const base: SyncState = {
  syncing: false,
  pending: 0,
  deferred: 0,
  lastSyncAt: null,
  lastError: null,
  online: true,
};
const at = (over: Partial<SyncState>) => chipFor({ ...base, ...over });

it('says NOTHING when everything is synced and online', () => {
  // The chip appearing is the signal. A permanent "Synced ✓" badge is
  // furniture — it trains you to stop reading the corner, which is exactly
  // where you need to look on the day it says something else.
  expect(at({})).toBeNull();
});

it('says offline before it says how much is waiting', () => {
  // Offline EXPLAINS the count. "3 waiting" beside a phone with no signal
  // invites a pointless retry; "Offline" says the app is behaving correctly
  // and there is nothing to do.
  expect(at({ online: false, pending: 3 })?.label).toBe('Offline · 3 waiting');
});

it('says offline even with nothing pending', () => {
  expect(at({ online: false })?.label).toBe('Offline');
});

it('reports a failure as the alarming state, and only that', () => {
  const c = at({ lastError: 'Server refused' });
  expect(c?.label).toBe('Sync failed');
  expect(c?.tone).toBe('danger');
});

it('does NOT cry failure while offline', () => {
  // Offline outranks the error: the last run failing because there was no
  // signal is not a fault, and calling it one is how an app teaches people
  // to distrust it.
  expect(at({ online: false, lastError: 'Network request failed' })?.tone).toBe('muted');
});

it('describes deferred rows as waiting on a plan, not as a backlog', () => {
  // They resolve themselves once the workout lands. Wording them like a
  // queue would suggest something is wrong when nothing is.
  expect(at({ deferred: 2, pending: 2 })?.label).toBe('2 waiting on a plan');
});

it('prefers the deferred wording over the plain count', () => {
  // Deferred rows are counted inside `pending`, so checking pending first
  // would describe them as an ordinary backlog.
  expect(at({ deferred: 1, pending: 4 })?.label).toBe('1 waiting on a plan');
});

it('shows a plain count when rows are simply queued', () => {
  const c = at({ pending: 4 });
  expect(c?.label).toBe('4 to sync');
  expect(c?.tone).toBe('warn');
});

it('shows progress while a run is in flight', () => {
  expect(at({ syncing: true, pending: 2 })?.label).toBe('Syncing…');
});

it('an error outranks a run in progress', () => {
  // A retry is usually already underway when someone looks; hiding the
  // failure behind "Syncing…" would make the problem invisible exactly when
  // it is being looked for.
  expect(at({ syncing: true, lastError: 'refused' })?.label).toBe('Sync failed');
});
