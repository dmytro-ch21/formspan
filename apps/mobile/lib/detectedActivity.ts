import { getDb, withTransaction } from './db';
import { averagePaceSecPerKm, emptyDetail, RUN_EXERCISE_ID } from './running';
import { emptySet } from './sessions';
import { saveLocalRunningDetail, saveLocalSets, startLocalSession } from './sessionStore';
import { request as requestSync } from './sync';

/**
 * N479/#824 — Today's "detected but not logged" card: a walk or hike the
 * platform health store noticed that has no matching VOLA session.
 *
 * Three layers, mirroring the split `lib/healthkitSync.ts`/`healthConnect.ts`
 * already use: `lib/healthkit.ts`'s `queryOtherWorkouts` and
 * `lib/healthConnect.ts`'s `queryOtherExerciseSessions` are the native
 * boundary; the functions in THIS file are pure filtering plus the local
 * SQLite ledger; `lib/healthkitSync.ts`/`healthConnectSync.ts` call both to
 * decide WHEN a detection pass runs (the existing foreground/sign-in
 * trigger — see those files' own doc comments for why this ticket adds to
 * that pattern rather than inventing a third orchestrator).
 *
 * ## Why "already logged" is a READ-time decision, not a ledger flag
 *
 * A detected workout and a VOLA session are two independent facts that can
 * arrive in either order: the athlete might log a walk by hand minutes
 * before HealthKit surfaces the same workout on the next foreground pass, or
 * tap "Log it" on a detected card and then later delete that session. Either
 * way, whether a card is still worth showing has to be re-decided every time
 * `detected_activities` is read (`isAlreadyLogged`, cross-referencing
 * `local_sessions` fresh) rather than stamped once and trusted — a ledger
 * flag would go stale the moment the OTHER side of that relationship
 * changed, and there is no event in this app that would ever go back and
 * correct it.
 *
 * ## Why dismissal IS a ledger flag
 *
 * A dismissal is a fact about the athlete's decision, not a derived state —
 * "not this one" does not become false again just because a session was
 * later logged or deleted. `dismissed_at` is therefore the one thing this
 * table's row is genuinely the record of; everything else in the row is a
 * cache of what the platform reported, safe to have gone slightly stale
 * (duration/distance are, at worst, wrong for a beat until the next pass).
 */

export type DetectedActivitySource = 'healthkit' | 'health_connect';
export type DetectedActivityType = 'walking' | 'hiking';

/** How far back a detection pass looks, and how far back the display query
 *  reads — the SAME window on both ends, so a sync pass never fetches (or
 *  keeps showing) more than the card is willing to surface. A walk from
 *  outside this window ages out of the card on its own, which is this
 *  ticket's answer to "must not silently accumulate as clutter" for an
 *  athlete who never taps either action: no dismissal is needed for the
 *  card to eventually stop asking. */
export const DETECTED_ACTIVITY_WINDOW_DAYS = 3;

export type DetectedWorkout = {
  /** Stable id from the platform: a HealthKit workout uuid, or a Health
   *  Connect record's `metadata.id`. Unique per (user, source) but not
   *  globally — a uuid and a Health Connect id are drawn from unrelated
   *  namespaces, so the ledger's primary key is `(user_id, external_id)`
   *  without needing `source` in it, on the same "collision is not a
   *  realistic concern across two different id schemes" basis
   *  `healthkit_uuid`/Health Connect `metadata.id` already rely on
   *  elsewhere in this app. */
  id: string;
  type: DetectedActivityType;
  source: DetectedActivitySource;
  /** RFC3339 */
  startDate: string;
  /** RFC3339 */
  endDate: string;
  durationSeconds: number;
  distanceMeters: number | null;
};

/** The half of a local session `isAlreadyLogged` needs — matches
 *  `sessionStore.ts`'s `sessionsSince` return shape. */
export type ExistingSessionWindow = { id: string; started_at: string; ended_at: string | null };

/** Whether `[aStart, aEnd)` and `[bStart, bEnd)` share any instant. Plain
 *  interval intersection, not containment — a workout the athlete logged by
 *  hand will rarely line up to the second with what the platform
 *  independently timestamped, so requiring one window to fully contain the
 *  other would under-match the common case. ISO 8601 strings compare
 *  lexicographically in date order, so this needs no `Date` parsing. */
export function windowsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Whether `workout` overlaps a local session the athlete already has —
 * regardless of that session's sport, exactly matching the ticket's "no
 * duplicate noise" criterion. A still-running session (`ended_at === null`)
 * never counts: it has not finished being logged yet, so its final window is
 * unknown, and treating an open-ended session as covering "now onward" would
 * hide a genuinely separate, already-finished detected activity.
 */
export function isAlreadyLogged(
  workout: DetectedWorkout,
  sessions: readonly ExistingSessionWindow[],
): boolean {
  return sessions.some(
    (s) => s.ended_at != null && windowsOverlap(workout.startDate, workout.endDate, s.started_at, s.ended_at),
  );
}

/**
 * Detected workouts still worth a card — not already logged under any
 * sport. (Dismissal is already excluded by `readRecentDetections`'s own SQL,
 * `WHERE dismissed_at IS NULL`, so this function has nothing left to filter
 * on that front; it stays a separate step because it is the one PURE
 * decision here, and pure functions are what `lib/__tests__/` can exercise
 * without a database.) Newest first, matching every other "what happened
 * recently" list in this app.
 */
export function visibleDetections(
  detections: readonly DetectedWorkout[],
  sessions: readonly ExistingSessionWindow[],
): DetectedWorkout[] {
  return detections
    .filter((w) => !isAlreadyLogged(w, sessions))
    .slice()
    .sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0));
}

/** "Walk" / "Hike" — the card's title. */
export function activityTypeLabel(type: DetectedActivityType): string {
  return type === 'hiking' ? 'Hike' : 'Walk';
}

/** "via Apple Health" / "via Google Health" — the ticket's own wording for
 *  the source tag, generalising `app/running/[id].tsx`'s "Imported from
 *  Apple Health" badge onto a platform-neutral card. "Google Health" rather
 *  than "Health Connect" for the same reason that screen says "Apple
 *  Health" rather than "HealthKit" — the athlete-facing name, not the
 *  API's. */
export function sourceLabel(source: DetectedActivitySource): string {
  return source === 'healthkit' ? 'via Apple Health' : 'via Google Health';
}

// --- the local ledger -----------------------------------------------------

type DetectedActivityRow = {
  external_id: string;
  source: string;
  type: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  distance_m: number | null;
};

function fromRow(r: DetectedActivityRow): DetectedWorkout {
  return {
    id: r.external_id,
    // Cast rather than validated: this app itself is the only writer of
    // this column (see `upsertDetectedActivities` below), so an
    // unrecognised value here would mean this file's own writer regressed,
    // not bad external input to defend against.
    source: r.source as DetectedActivitySource,
    type: r.type as DetectedActivityType,
    startDate: r.started_at,
    endDate: r.ended_at,
    durationSeconds: r.duration_seconds,
    distanceMeters: r.distance_m,
  };
}

/**
 * Record newly-detected workouts. `INSERT OR IGNORE`, matching
 * `healthkitSync.ts`'s `recordHealthKitImport` — a workout already in the
 * ledger is a no-op rather than an overwrite, which is what protects an
 * existing `dismissed_at` from being clobbered back to "not dismissed" by
 * the next foreground pass simply re-reporting the same workout.
 */
export async function upsertDetectedActivities(
  userID: string,
  source: DetectedActivitySource,
  workouts: readonly Omit<DetectedWorkout, 'source'>[],
): Promise<void> {
  if (workouts.length === 0) return;
  const db = await getDb();
  const now = new Date().toISOString();
  for (const w of workouts) {
    await db.runAsync(
      `INSERT OR IGNORE INTO detected_activities
         (user_id, external_id, source, type, started_at, ended_at, duration_seconds, distance_m, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userID,
      w.id,
      source,
      w.type,
      w.startDate,
      w.endDate,
      w.durationSeconds,
      w.distanceMeters,
      now,
    );
  }
}

/** Every un-dismissed detection since `sinceISO`, newest first. Whether each
 *  is still worth a card (i.e. not already logged) is decided separately by
 *  `visibleDetections` — see this file's own doc comment for why that is a
 *  read-time cross-reference rather than anything stored here. */
export async function readRecentDetections(
  userID: string,
  sinceISO: string,
): Promise<DetectedWorkout[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<DetectedActivityRow>(
    `SELECT external_id, source, type, started_at, ended_at, duration_seconds, distance_m
       FROM detected_activities
      WHERE user_id = ? AND dismissed_at IS NULL AND started_at >= ?
      ORDER BY started_at DESC`,
    userID,
    sinceISO,
  );
  return rows.map(fromRow);
}

/** "Not this one" — permanent until the ledger row itself is gone. See this
 *  file's doc comment for why dismissal, alone among this table's facts, is
 *  stored rather than re-derived. */
export async function dismissDetection(userID: string, externalID: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE detected_activities SET dismissed_at = ? WHERE user_id = ? AND external_id = ?`,
    new Date().toISOString(),
    userID,
    externalID,
  );
}

/**
 * "Log it for real": a real, finished local session for this detected
 * workout — sport `running`, the only VOLA sport with distance-based
 * semantics (see `lib/modules.ts`'s registry; there is no dedicated
 * `walking` module). Named for the activity type rather than left as the
 * generic "Run" a live-tracked run gets, so Training History reads "Walk",
 * not a run that never happened.
 *
 * **Writes `running_json` too, not just `session_sets`** — found in review
 * (N479/#824): `app/running/[id].tsx`'s finished-session branch reads
 * distance/time/pace ONLY from `readLocalRunningDetail` (`running_json`),
 * never from `session_sets`, so a session created without it opened to
 * zeroed-out everything even though Training History (which reads
 * `session_sets` directly) showed it correctly. Mirrors
 * `healthkitSync.ts`'s `importHealthKitRuns`, the only other writer of a
 * `running` session, which makes the identical `saveLocalRunningDetail`
 * call for the identical reason.
 *
 * `source: 'manual'`, not `'healthkit'`/a Health-Connect equivalent —
 * `running.Source` is a backend-validated enum
 * (`backend/internal/modules/running/running.go`) of exactly `phone_gps` /
 * `healthkit` / `manual`, with no fourth value for Android; sending
 * anything else is rejected outright by the server. `'healthkit'` on this
 * app's own running-import screen specifically means "imported
 * automatically, without you doing anything" (N465's badge), which is not
 * true here even on iOS — the athlete tapped Log. `'manual'`'s own doc
 * comment ("distance and duration typed in after the fact, with no track at
 * all") describes this case exactly, and is the one value valid on BOTH
 * platforms, so logging a detected walk reads the same way regardless of
 * which store it came from.
 *
 * Deliberately does NOT write a `dismissed_at` or any other "handled" marker
 * to `detected_activities` — the session this creates overlaps the
 * detection's own window by construction, so the very next
 * `visibleDetections` filters it out via `isAlreadyLogged` with nothing
 * extra to track. If the athlete later deletes that session, the walk
 * becoming detectable again is the correct behaviour, not a bug to guard
 * against: it is once again true that nothing logs it.
 *
 * All three writes happen in one transaction — same reasoning as
 * `healthkitSync.ts`'s `importHealthKitRuns`: a failure partway through must
 * not leave a session with a working-volume row but no running detail, or
 * vice versa.
 */
export async function logDetectionAsSession(userID: string, workout: DetectedWorkout): Promise<void> {
  const db = await getDb();
  await withTransaction(db, async () => {
    const session = await startLocalSession(userID, {
      sport: 'running',
      name: activityTypeLabel(workout.type),
      started_at: workout.startDate,
      ended_at: workout.endDate,
    });
    await saveLocalRunningDetail(userID, session.id, {
      ...emptyDetail(session.id),
      distance_m: workout.distanceMeters,
      duration_seconds: workout.durationSeconds,
      avg_pace_sec_per_km:
        workout.distanceMeters != null
          ? averagePaceSecPerKm(workout.distanceMeters, workout.durationSeconds)
          : null,
      source: 'manual',
    });
    await saveLocalSets(userID, session.id, [
      {
        ...emptySet(RUN_EXERCISE_ID, 0),
        distance_m: workout.distanceMeters,
        seconds: workout.durationSeconds || null,
        completed: true,
      },
    ]);
  });
  requestSync('detected-activity-logged');
}
