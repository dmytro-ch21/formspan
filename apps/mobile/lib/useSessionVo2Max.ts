import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { listBiometricSamples } from './biometric';
import type { TokenGetter } from './useAuthToken';
import { shiftDate } from './anthropometry';
import { vo2MaxFetchWindow } from './vo2MaxSource';
import { vo2MaxAsOf, vo2MaxAsOfLine, type Vo2MaxReading } from './sessionVo2Max';

/**
 * N547/#990 part two — the VO₂max estimate as it stood on a session's day.
 *
 * ## Why this fetches, where part one cached
 *
 * `lib/sessionHR.ts` caches heart rate into SQLite because its surfaces are
 * offline-first LISTS, and a list cannot make a request per row. This is the
 * opposite case: VO₂max is only shown on a session DETAIL screen, which is
 * already a per-session fetch (`getSessionMetrics`, and BJJ's raw-sample
 * read), so one more bounded request is the same order of cost the screen
 * already pays.
 *
 * The consequence is honest rather than hidden: **offline, this shows
 * nothing.** There is no local VO₂max cache, and inventing one would mean
 * deciding how stale an estimate may be before it stops being true — a
 * question this ticket does not need to answer to put a real number on
 * screen. Absent reads as absent, which is the same discipline the rest of
 * the feature follows.
 *
 * The window ends at the SESSION's day, not today: `vo2MaxFetchWindow` is
 * reused rather than reimplemented so the server's 400-day cap (W16/#945,
 * whose absence meant every request 400'd for months) keeps applying here.
 *
 * Returns the finished LINE rather than the reading, so the three session
 * screens cannot word or date it three different ways — the wording is the
 * part that carries the honesty, and it is decided once, in a pure module.
 */
export function useSessionVo2Max(
  getToken: TokenGetter,
  /** The session's own day, `YYYY-MM-DD`. `null` while it is still loading. */
  sessionDay: string | null,
): string | null {
  const [reading, setReading] = useState<Vo2MaxReading | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (sessionDay === null) return;
      let live = true;
      // The window is asked for one day PAST the session's, and that extra day
      // is load-bearing rather than slack. `vo2MaxFetchWindow` ends its range
      // at `${day}T23:59:59Z` — UTC — which for an athlete at UTC-8 is 4pm
      // local. A VO₂max sync between 4pm and midnight on the session's own day
      // would fall outside the request entirely, and unlike a live trend chart
      // a finished session never refetches, so it would be missing for good.
      // Asking a day wider covers every offset; `vo2MaxAsOf` then does the
      // precise cut on the LOCAL day. Raised in review.
      const { from, to } = vo2MaxFetchWindow(shiftDate(sessionDay, 1));

      listBiometricSamples(getToken, 'vo2_max', from, to)
        .then((rows) => {
          if (live) setReading(vo2MaxAsOf(rows, sessionDay));
        })
        .catch(() => {
          // Offline or refused: show nothing. Never a zero, never a stale
          // figure from another day — see this module's doc comment.
          if (live) setReading(null);
        });

      return () => {
        live = false;
      };
    }, [getToken, sessionDay]),
  );

  return vo2MaxAsOfLine(reading, formatVo2MaxDay);
}

/**
 * The date format the line uses. Device locale, day and short month — the
 * estimate's date is context, not a headline, and a full date would compete
 * with the numbers above it.
 */
function formatVo2MaxDay(day: string): string {
  // `day` is `YYYY-MM-DD`; parsed as local noon so a timezone west of UTC
  // cannot roll it back a day, the same guard the rest of this app applies to
  // day strings.
  const at = new Date(`${day}T12:00:00`);
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
