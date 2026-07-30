import { getDb } from './db';

/**
 * Small per-user key/value store for UI preferences.
 *
 * Scoped by user for the same reason the activity outbox is: a shared device
 * must not hand one account's settings — or its filters — to whoever signs
 * in next.
 */
export async function readPref(userID: string, key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM prefs WHERE user_id = ? AND key = ?`,
    userID,
    key,
  );
  return row?.value ?? null;
}

export async function writePref(userID: string, key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO prefs (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    userID,
    key,
    value,
  );
}

/**
 * Keys, named in one place so a typo can't silently create a second
 * preference that nothing ever reads.
 */
export const PREF_UNIT_SYSTEM = 'unit_system';
/**
 * Whether ticking a set starts the rest countdown.
 *
 * Local rather than on the profile, for the same reason the per-exercise
 * rest durations are: the rest timer is mobile-only by the platform rule,
 * so there's no second client to keep in step.
 *
 * Defaults **off**. A countdown that starts itself is one you spend
 * attention cancelling when it guesses wrong, and it guesses wrong often —
 * you tick late, or tick a set you finished five minutes ago. Off is the
 * behaviour that never surprises; on is there for people whose ticking
 * really is the moment they rack the bar.
 */
export const PREF_AUTO_REST = 'auto_rest';
/** The Library tab's sport filter. Deliberately remembered; its search box
 *  deliberately isn't — see the Library screen for the reasoning. */
export const PREF_LIBRARY_SPORT = 'library_sport';
