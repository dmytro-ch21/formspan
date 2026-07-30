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
/** The Library tab's sport filter. Deliberately remembered; its search box
 *  deliberately isn't — see the Library screen for the reasoning. */
export const PREF_LIBRARY_SPORT = 'library_sport';
