import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import {
  byTracker,
  fetchTrackerDay,
  localEntries,
  localTrackers,
  logTap,
  removeTap,
  type TrackerView,
} from './trackers';
import type { Tracker, TrackerEntry } from './trackerModel';
import { request as requestSync } from './sync';
import { useAuthToken } from './useAuthToken';

/**
 * One day of trackers, and the two gestures that change it.
 *
 * **Two screens render this card — Today and Food — and there is ONE
 * implementation of loading it.** That is deliberate and it is the lesson of
 * #392, where two image-upload paths each learned the same downscale
 * independently and the second learned it from a device report rather than from
 * review. Two copies of "read SQLite, then the network, then re-read" would
 * diverge in exactly the places that are hard to see: which failure renders as
 * empty, whether a tap re-reads, whether the day is recomputed on focus.
 *
 * ## What it does NOT do
 *
 * No `useEffect`. The caller decides when to load — from `useFocusEffect` on a
 * tab screen that stays mounted for the life of the process, and again when
 * `lastSyncAt` moves. That is the idiom Today already uses for food and
 * check-ins, and a hook that fetched on its own would fire on every render of
 * a screen that never unmounts.
 */
export type TrackerDay = {
  view: TrackerView;
  entriesFor: (trackerID: string) => TrackerEntry[];
  /** Load, for the given local day. Returns a cancel function. */
  refresh: (on: string) => () => void;
  addTap: (tracker: Tracker, on: string) => Promise<void>;
  /** Remove one logged tap, named by its entry id rather than its position. */
  removeEntry: (entryID: string, on: string) => Promise<void>;
  openSettings: (tracker: Tracker) => void;
};

export function useTrackerDay(): TrackerDay {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const router = useRouter();
  // Keyed to the day it was computed for, so a screen stepping between days
  // never renders yesterday's cups under today's date. Same shape the Food
  // screen already uses for its meals.
  const [loaded, setLoaded] = useState<{ on: string; view: TrackerView; entries: TrackerEntry[] }>(
    { on: '', view: { state: 'unknown' }, entries: [] },
  );

  const refresh = useCallback(
    (on: string) => {
      let live = true;
      if (!userId) {
        // `unknown`, never an empty list. A signed-out read has not discovered
        // that the athlete has no trackers; it has not asked.
        setLoaded({ on, view: { state: 'unknown' }, entries: [] });
        return () => {
          live = false;
        };
      }

      const readLocal = async () => {
        const [view, entries] = await Promise.all([localTrackers(userId), localEntries(userId, on)]);
        if (live) setLoaded({ on, view, entries });
      };

      // Cache first, network second, and SEQUENCED rather than raced: started
      // in parallel, a slow SQLite read can land after a fast network answer
      // and overwrite it with the older picture.
      void readLocal()
        .catch(() => {})
        .then(() => fetchTrackerDay(userId, getToken, on))
        .then(() => (live ? readLocal() : undefined))
        .catch(() => {
          // A failed fetch leaves whatever the cache said standing. It must not
          // fall back to "you have no trackers" — that is a claim from a read
          // that did not happen, on the screen whose whole job is the reminder.
        });

      return () => {
        live = false;
      };
    },
    [userId, getToken],
  );

  const addTap = useCallback(
    async (tracker: Tracker, on: string) => {
      if (!userId) return;
      await logTap(userId, tracker, on);
      requestSync('tracker tap');
      const entries = await localEntries(userId, on);
      setLoaded((prev) => (prev.on === on ? { ...prev, entries } : prev));
    },
    [userId],
  );

  const removeEntry = useCallback(
    async (entryID: string, on: string) => {
      if (!userId) return;
      // The entry the athlete actually pointed at, by id.
      //
      // This used to take an INDEX and resolve it against a freshly-read day —
      // which meant two quick taps on one glyph could each resolve against a
      // different snapshot and remove two cups, because the re-render that
      // empties the glyph lands after the second tap. `removeTap` is idempotent
      // on an id, so the second tap is now a no-op instead.
      await removeTap(userId, entryID);
      requestSync('tracker tap removed');
      const entries = await localEntries(userId, on);
      setLoaded((prev) => (prev.on === on ? { ...prev, entries } : prev));
    },
    [userId],
  );

  const entriesFor = useCallback(
    (trackerID: string) => byTracker(loaded.entries).get(trackerID) ?? [],
    [loaded.entries],
  );

  const openSettings = useCallback(
    (tracker: Tracker) => router.push(`/trackers/${tracker.id}`),
    [router],
  );

  return { view: loaded.view, entriesFor, refresh, addTap, removeEntry, openSettings };
}
