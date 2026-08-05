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

/**
 * Write a preference.
 *
 * `owed` marks it as holding a value the account has not heard yet — the
 * device is ahead of the server. Preserved rather than defaulted on update:
 * a plain local write (adopting the server's own value, say) must not clear a
 * debt that is still outstanding, and must not invent one either.
 */
export async function writePref(
  userID: string,
  key: string,
  value: string,
  opts: { owed?: boolean } = {},
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO prefs (user_id, key, value, dirty) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       -- max(), not excluded.dirty. A write that says nothing about the debt
       -- must leave it standing: clearing it here would silently drop a
       -- preference the athlete changed offline, which is the exact failure
       -- the OWED companion keys were introduced to prevent.
       dirty = max(prefs.dirty, excluded.dirty)`,
    userID,
    key,
    value,
    opts.owed ? 1 : 0,
  );
}

/** Preferences this device holds that the account has not been told about. */
export async function owedPrefs(userID: string): Promise<{ key: string; value: string }[]> {
  const db = await getDb();
  return db.getAllAsync<{ key: string; value: string }>(
    `SELECT key, value FROM prefs WHERE user_id = ? AND dirty = 1`,
    userID,
  );
}

/**
 * The account now holds this value; the debt is settled.
 *
 * Takes the value that was pushed and clears the flag ONLY if the row still
 * says the same thing. Otherwise a change made while the push was in flight
 * would be marked as sent and never go out — the same compare-and-swap the
 * session and workout outboxes use, for the same reason.
 */
export async function clearPrefOwed(userID: string, key: string, pushed: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE prefs SET dirty = 0 WHERE user_id = ? AND key = ? AND value = ?`,
    userID,
    key,
    pushed,
  );
}

/** How many preferences are waiting to reach the account. */
export async function countOwedPrefs(userID: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM prefs WHERE user_id = ? AND dirty = 1`,
    userID,
  );
  return row?.n ?? 0;
}

/**
 * Keys, named in one place so a typo can't silently create a second
 * preference that nothing ever reads.
 */
export const PREF_UNIT_SYSTEM = 'unit_system';
/**
 * `'1'` while the local unit choice hasn't reached the account.
 *
 * Persisted rather than held in component state because Settings is a screen
 * people leave immediately: a flag that dies on unmount would stop admitting
 * the change was local-only while it still was. It also gates the server-wins
 * refresh in `useUnits`, so a pending choice can't be silently reverted by the
 * next successful profile read.
 *
 * A one-key stand-in for the preference outbox that arrives with the sync
 * orchestrator — deliberately not generalised here.
 */
/**
 * @deprecated Superseded by the `dirty` column on `prefs` (schema v10).
 *
 * Kept only so an upgrading device can migrate its outstanding debt across —
 * see `adoptLegacyOwedFlags`. Do not write it.
 */
export const PREF_UNIT_SYSTEM_OWED = 'unit_system_owed';
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
/**
 * How many times the "add what happened in rolling" offer has been shown.
 *
 * A COUNT, not a boolean, because the offer is allowed a few appearances
 * before it stops for good. Device-local and not synced: it bounds a nudge,
 * and an athlete on a second device seeing it a few more times is a far
 * smaller cost than the sync surface for it.
 */
export const PREF_DETAIL_OFFERS = 'bjj_detail_offers';

/**
 * Technique ids the athlete has dismissed a suggestion for, as a JSON array.
 *
 * One key holding a set rather than a key per technique, because the
 * suggestion rule needs the WHOLE set to pick its next-best candidate — a
 * per-technique key would answer "is this one dismissed" and could not answer
 * "which is the best one that is not".
 *
 * Device-local, like {@link PREF_DETAIL_OFFERS} and for the same reason: it
 * bounds a nudge. Dismissing on a phone and seeing it once more on a tablet is
 * a smaller cost than the sync surface, and `writePref` only pushes what is
 * explicitly marked owed.
 */
export const PREF_DISMISSED_SUGGESTIONS = 'bjj_dismissed_suggestions';

/** `'0'` turns every suggestion off. Absent means on — the default needs no write. */
export const PREF_SUGGESTIONS = 'suggestions_enabled';

/**
 * Modules with suggestions turned off, as a JSON array of sport keys.
 *
 * An OFF list rather than an on list, so a discipline added to the registry
 * later is suggestible without a migration, and so the master switch can be
 * flipped without destroying the athlete's per-module choices.
 */
export const PREF_SUGGESTIONS_OFF = 'suggestions_off';

export const PREF_AUTO_REST = 'auto_rest';
export const PREF_TRACK_EFFORT = 'track_effort';
/**
 * `'1'` while the local effort-tracking choice hasn't reached the account.
 *
 * Exactly the same debt `PREF_UNIT_SYSTEM_OWED` records, and added because
 * `useTrackEffort` was missing it: turning effort off with no signal pushed
 * to the server, failed, was swallowed — and then the next successful profile
 * read set it straight back on and overwrote the cache. The switch reverted
 * on its own, silently, some minutes later.
 */
export const PREF_TRACK_EFFORT_OWED = 'track_effort_owed';
/** The Library tab's sport filter. Deliberately remembered; its search box
 *  deliberately isn't — see the Library screen for the reasoning. */
export const PREF_LIBRARY_SPORT = 'library_sport';
/**
 * The Library tab's belt cap for BJJ techniques.
 *
 * Remembered like the sport filter, and deliberately NOT cleared when the
 * sport chip moves away from BJJ the way the position filter is — a belt
 * changes over years, not per visit, so "I've reached Blue" is a standing
 * fact about the athlete in the same way "I train Strength" is, not a
 * transient narrowing that would surprise them if it silently persisted.
 */
export const PREF_LIBRARY_BELT = 'library_belt';
/**
 * The shape of the last BJJ session logged, as this time's defaults.
 *
 * The single biggest lever on the three-tap budget: people train the same way
 * most weeks, so last time's answers for how long, how many rounds and gi or
 * not are almost always right, which turns four decisions into zero. Stored
 * as one JSON blob for the same reason `PREF_MODULES` is — it is read once,
 * before the first paint of the log screen, and N keyed reads would be N
 * round trips to SQLite for one form.
 *
 * Deliberately does NOT carry the note, the body note or the tags: those are
 * facts about one session, and pre-filling them would put last week's words
 * in this week's record.
 */
export const PREF_BJJ_LAST_LOG = 'bjj_last_log';

/**
 * The whole module set, JSON, under one key.
 *
 * One key rather than one per module because this is read before the first
 * paint — the tab bar is built from it — and N sequential reads is exactly the
 * delay that makes the tabs rearrange after launch.
 */
export const PREF_MODULES = 'modules';

/**
 * The chosen accent — a device preference, never synced.
 *
 * Deliberately not `owed`: the accent is how this phone looks, not a fact about
 * the athlete, and there is no server field for it. Someone signing in on a
 * second device gets the default rather than an inherited colour, which is the
 * right answer for a look-and-feel choice made on one screen.
 */
export const PREF_ACCENT = 'accent';


/**
 * Timestamp of the first successful full seed, or absent if it never ran.
 *
 * Deliberately a timestamp rather than a boolean: "when" answers questions a
 * flag cannot — whether the seed predates a schema change, and whether an
 * install that has been offline since day one has ever actually held data.
 */
export const PREF_SEEDED_AT = 'seeded_at';

/**
 * The pinned-records shortlist, as a JSON array of exercise ids.
 *
 * Held in prefs rather than a table because that is genuinely all it is — a
 * short ordered list of ids. The names, thumbnails and load types it renders
 * against come from `exercise_cache`, which the seed fills first, so the
 * Records screen has everything it needs offline without a second store to
 * keep reconciled.
 */
export const PREF_PINNED_RECORDS = 'pinned_records';

/**
 * Carry pre-v10 OWED flags onto the `dirty` column.
 *
 * The companion-key scheme worked; it just did not generalise. Migrating
 * rather than dropping matters because the flag means "the athlete changed
 * this offline and the account still has not heard" — throwing it away on
 * upgrade silently reverts their choice on the next profile fetch, which is
 * the precise bug the flag existed to stop.
 *
 * Idempotent: the legacy key is deleted once adopted.
 */
export async function adoptLegacyOwedFlags(userID: string): Promise<void> {
  const db = await getDb();
  for (const [legacy, key] of [
    [PREF_UNIT_SYSTEM_OWED, PREF_UNIT_SYSTEM],
    [PREF_TRACK_EFFORT_OWED, PREF_TRACK_EFFORT],
  ] as const) {
    const row = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM prefs WHERE user_id = ? AND key = ?`,
      userID,
      legacy,
    );
    if (row?.value === '1') {
      await db.runAsync(
        `UPDATE prefs SET dirty = 1 WHERE user_id = ? AND key = ?`,
        userID,
        key,
      );
    }
    if (row) {
      await db.runAsync(`DELETE FROM prefs WHERE user_id = ? AND key = ?`, userID, legacy);
    }
  }
}
