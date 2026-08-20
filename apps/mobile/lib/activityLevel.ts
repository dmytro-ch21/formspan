/**
 * The athlete's daily-movement level, on the phone.
 *
 * ## Where it lives, and what that cost
 *
 * On the **profile, server-side**, with this module as a device-local cache in
 * front of it. Three options were on the table and this is the expensive one:
 *
 *  - **Device storage only** (a one-line `useState` → local write) fixes the
 *    reported bug completely and costs nothing. It was rejected on one
 *    consequence: the level is an input to a CALORIE TARGET, and web derives
 *    that target too. Held per-device, a phone set to `active` and a browser
 *    defaulting to `light` compute different numbers for the same athlete on
 *    the same day, and neither surface can tell it is disagreeing. That is
 *    #425's failure — web and mobile disagreeing about whether a dumbbell
 *    weight is per-hand — arriving in the one place the app claims to be
 *    auditable.
 *  - **Derived from logged training** is the wrong question. This term is NEAT:
 *    everything that is *not* logged training. The derivation already adds
 *    training separately, so inferring this from sessions would count mat time
 *    twice — the exact double-count the truncated 1.20/1.30/1.45 ladder exists
 *    to avoid. No amount of logging tells you whether somebody stands up all
 *    day at work.
 *  - **The profile** costs a migration, a contract change, and makes the level
 *    part of the athlete's record rather than a calculator input. That last
 *    part is the real price and it is worth naming: this is now a fact stored
 *    about a person, so it is one more field to export, delete and reason about
 *    on a shared device. Accepted, because a target that changes depending on
 *    which screen you asked is worse.
 *
 * ## Why there is still a local cache
 *
 * Because the server being the source of truth is not the same as the server
 * being reachable. Setting this in a gym dead-spot has to survive, so the
 * choice is written here FIRST and marked owed, and the push is retried on the
 * next focus that has a connection. Exactly the shape `UnitsProvider` and
 * `TrackEffortProvider` already use for `unit_system` and `track_effort` — the
 * `prefs` table's `dirty` column is that outbox, and it needed no new schema.
 *
 * ## The rule that makes web and phone agree
 *
 * {@link activityParam}. When nothing is owed the phone sends NO `activity`
 * parameter, so the server answers from the profile and the phone adopts what
 * comes back — which is how a change made in a browser reaches the handset.
 * When something IS owed, the local value is sent and the push retried, because
 * then the server holds the stale copy. Adopting the server's answer
 * unconditionally would silently revert a choice made offline; always sending
 * the local one would make the browser's change unreachable. Both directions
 * are needed and they are not symmetric.
 */

import {
  PREF_ACTIVITY_LEVEL,
  clearPrefOwed,
  owedPrefs,
  readPref,
  writePref,
} from './prefs';

/**
 * The vocabulary, in the order the pills render.
 *
 * A fourth copy of a list that also exists in `nutrition.Activities`,
 * `profile.ValidActivityLevel` and the OpenAPI enum. The server's response
 * carries `activities` and this could read it — but the pills need labels and
 * hints that no server sends, so the array would be a join against a remote
 * list to render a control that must work offline. Pinned by a test to the same
 * literals the wire contract names instead.
 */
export const ACTIVITY_LEVELS = ['sedentary', 'light', 'active'] as const;

export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

/**
 * What a derivation runs at when nobody has chosen.
 *
 * Duplicated from the server deliberately — the phone has to render a ladder
 * before its first response arrives, and offline it may never arrive. The
 * server remains authoritative: it sends back what it actually used, and
 * {@link adoptServerActivity} takes that answer over this constant.
 */
export const ACTIVITY_DEFAULT: ActivityLevel = 'light';

export function isActivityLevel(v: unknown): v is ActivityLevel {
  return typeof v === 'string' && (ACTIVITY_LEVELS as readonly string[]).includes(v);
}

/**
 * What this device knows: the athlete's level, and whether the account has
 * heard about it yet.
 *
 * `level: null` means this device has never seen a choice — NOT that the
 * athlete chose the default. The screen renders those two differently, so
 * collapsing them here would remove its ability to.
 */
export type ActivityChoice = {
  level: ActivityLevel | null;
  /** The device holds a value the server may not have. */
  owed: boolean;
};

/** Nothing known and nothing owed — a device that has never asked. */
export const UNKNOWN_ACTIVITY: ActivityChoice = { level: null, owed: false };

export async function readActivityChoice(userID: string): Promise<ActivityChoice> {
  const cached = await readPref(userID, PREF_ACTIVITY_LEVEL);
  const owed = (await owedPrefs(userID)).some((p) => p.key === PREF_ACTIVITY_LEVEL);
  // A cached value the vocabulary no longer knows is discarded rather than
  // trusted: it would be sent as an `activity` parameter and earn a 400,
  // breaking the whole derivation over a stale string.
  return { level: isActivityLevel(cached) ? cached : null, owed };
}

/**
 * Record a choice the athlete just made.
 *
 * Written as OWED up front rather than marked owed if the push fails. If the
 * app dies between the write and the push, the debt is already on disk;
 * recording it only in a catch loses the change to a crash.
 */
export async function rememberActivityChoice(
  userID: string,
  level: ActivityLevel,
): Promise<void> {
  await writePref(userID, PREF_ACTIVITY_LEVEL, level, { owed: true });
}

/** Adopt the server's answer. Never clears an outstanding debt — `writePref`
 *  preserves it — so this cannot drop a change made a moment ago. */
export async function cacheActivityLevel(
  userID: string,
  level: ActivityLevel,
): Promise<void> {
  await writePref(userID, PREF_ACTIVITY_LEVEL, level);
}

/**
 * The account now holds this value.
 *
 * Compare-and-swap on the value that was actually pushed: a change made while
 * the push was in flight must stay owed rather than be marked as sent.
 */
export async function settleActivityChoice(
  userID: string,
  pushed: ActivityLevel,
): Promise<void> {
  await clearPrefOwed(userID, PREF_ACTIVITY_LEVEL, pushed);
}

/**
 * The `activity` query parameter to send with a derivation request, or
 * `undefined` to let the server answer from the profile.
 *
 * **This tiny function is the whole server-wins/local-wins rule**, which is why
 * it is extracted and tested rather than inlined as a ternary:
 *
 *  - **Owed** — the device holds a choice the account has not heard, so the
 *    server's copy is the STALE one. Send the local value, so the ladder
 *    reflects what the athlete actually picked while the push is retried.
 *  - **Not owed** — the server is authoritative. Send nothing, take back
 *    whatever it says. This is the only path by which a level set in the
 *    browser reaches the phone.
 *
 * Note a level with no debt is still not sent. That looks redundant and is not:
 * it is precisely what makes the phone adopt a newer answer instead of pinning
 * its own.
 */
export function activityParam(choice: ActivityChoice): ActivityLevel | undefined {
  return choice.owed && choice.level ? choice.level : undefined;
}

/**
 * Fold a derivation response back into what this device believes.
 *
 * The server reports the level it actually derived at and whether the athlete
 * chose it. With a debt outstanding that answer is ignored: it is either our
 * own value echoed back or the stale one, and neither should overwrite a
 * pending choice.
 */
export function adoptServerActivity(
  choice: ActivityChoice,
  server: { activity?: string | null; activity_chosen?: boolean | null },
): ActivityChoice {
  if (choice.owed) return choice;
  if (!isActivityLevel(server.activity)) return choice;
  // `activity_chosen: false` means the server APPLIED the default without
  // anybody picking it. Storing it would manufacture a choice out of an
  // assumption — and the next request would then send it as owed-nothing
  // truth, making the assumption permanent and invisible.
  if (!server.activity_chosen) return { level: null, owed: false };
  return { level: server.activity, owed: false };
}

/** The level a derivation runs at — the choice, else the documented default. */
export function effectiveActivity(choice: ActivityChoice): ActivityLevel {
  return choice.level ?? ACTIVITY_DEFAULT;
}
