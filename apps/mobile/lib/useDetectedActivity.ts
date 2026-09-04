import { useCallback, useState } from 'react';

import {
  DETECTED_ACTIVITY_WINDOW_DAYS,
  dismissDetection,
  logDetectionAsSession,
  readRecentDetections,
  visibleDetections,
  type DetectedWorkout,
} from './detectedActivity';
import { sessionsSince } from './sessionStore';

/**
 * Today's read of `lib/detectedActivity.ts` — what to show, and the two
 * actions a card offers. Kept out of `app/(tabs)/index.tsx` itself for the
 * same reason `useTodayBoard`/`useTrackerDay` are: that screen already reads
 * eight-plus independent things, and a ninth inline `useState`/`useCallback`
 * pair would be one more thing to scroll past rather than one more line to
 * call.
 *
 * Both mutations are OPTIMISTIC — the item is removed from `items`
 * immediately, before the write resolves — matching this screen's own
 * `dismiss` (technique suggestions) rather than rolling back on failure: a
 * detected activity that reappears after a failed dismiss is a minor
 * annoyance the athlete can dismiss again, not lost data, so the extra
 * complexity of a rollback path buys little here.
 */
export function useDetectedActivity(userID: string | null) {
  const [items, setItems] = useState<DetectedWorkout[]>([]);

  const refresh = useCallback(() => {
    if (!userID) {
      setItems([]);
      return () => {};
    }
    let live = true;
    const sinceISO = new Date(
      Date.now() - DETECTED_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    Promise.all([readRecentDetections(userID, sinceISO), sessionsSince(userID, sinceISO)])
      .then(([detections, sessions]) => {
        if (live) setItems(visibleDetections(detections, sessions));
      })
      .catch(() => {
        // Offline, or a genuinely empty read — either way, no card is the
        // honest fallback: an ERROR here is not evidence of a real walk to
        // log, so asserting one would be worse than showing none.
        if (live) setItems([]);
      });
    return () => {
      live = false;
    };
  }, [userID]);

  const logIt = useCallback(
    (item: DetectedWorkout) => {
      if (!userID) return;
      setItems((cur) => cur.filter((x) => x.id !== item.id));
      void logDetectionAsSession(userID, item);
    },
    [userID],
  );

  const dismiss = useCallback(
    (item: DetectedWorkout) => {
      if (!userID) return;
      setItems((cur) => cur.filter((x) => x.id !== item.id));
      void dismissDetection(userID, item.id).catch(() => {
        // Best-effort, same posture as the rest of this screen's own
        // optimistic writes — see this file's own doc comment.
      });
    },
    [userID],
  );

  return { items, refresh, logIt, dismiss };
}
