import type { HealthConnectRecordType } from './healthConnect';
import { PREF_HEALTH_CONNECT_REFUSED, readPref, writePref } from './prefs';

/**
 * N527/#949 — the one line under Settings' Health Connect toggle that says
 * which grant Health Connect refused, now that the pass can tell (W15/#944).
 *
 * ## What is stored, and when
 *
 * `syncHealthConnectBiometrics` writes its `notPermitted` list here, as-is, at
 * the end of every pass that REACHED its reads — including an empty list,
 * which is what clears the line once the athlete allows the grant. A pass that
 * never got there (toggle off, no Health Connect on the phone, the identity
 * changing mid-pass) writes nothing, so the last real answer stands. The line
 * is therefore "what the last pass that asked was told", never a sticky flag.
 *
 * ## What is shown
 *
 * Only the record types behind the Health Connect toggle. `Steps` is stored
 * (it is part of the pass's answer) but never shown here: N569's Steps row
 * already owns a Steps refusal, with its own Ask again, and reporting one
 * refusal twice on the same screen is noise, not information.
 *
 * iOS has no equivalent and never will: HealthKit returns an empty result for
 * a denied read by design, so there is nothing to store and nothing to show.
 */

/** The record types the Health Connect toggle asks for — every read type but `Steps`. */
export type ToggleRecordType = Exclude<HealthConnectRecordType, 'Steps'>;

/**
 * Each toggle type in the athlete's words: what Health Connect is not sharing,
 * and what that costs them in VOLA. A `Record` over `ToggleRecordType`, so a
 * type added to `READ_RECORD_TYPES` fails typecheck here until it has words —
 * it can never reach the screen as an enum name. Key order is display order.
 */
const TOGGLE_WORDS: Record<ToggleRecordType, { noun: string; consequence: string }> = {
  ExerciseSession: { noun: 'exercise sessions', consequence: "walks and hikes won't appear on Today" },
  HeartRate: { noun: 'heart rate', consequence: "sessions won't get heart-rate zones or load" },
  Vo2Max: { noun: 'VO2max', consequence: "your VO2max trend won't update" },
};

/** Every type this line can name, in display order. Exported for the parity test. */
export const TOGGLE_LINE_TYPES = Object.keys(TOGGLE_WORDS) as ToggleRecordType[];

/**
 * Which refused types the Settings line names: the toggle's types that appear
 * in `refused`, once each, in display order. `Steps` — and anything else that
 * is not a toggle type, such as a malformed stored value — is dropped here, and
 * only here.
 */
export function refusalsForToggleLine(refused: readonly unknown[]): ToggleRecordType[] {
  return TOGGLE_LINE_TYPES.filter((t) => refused.includes(t));
}

/** "a", "a or b", "a, b or c" — the house list style (no serial comma). */
function listNouns(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Whole clauses read better with the comma: "a, and b", "a, b, and c". */
function listClauses(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * The line itself, or `null` when there is nothing to say. One sentence naming
 * every refused type as one list, what it costs, and where to change it.
 *
 * Health Connect is the subject on purpose: the athlete said no to a system
 * screen, possibly months ago, and this is information to act on, not a
 * reminder that they refused.
 *
 * The route names Health Connect's own labels because the button can only open
 * Health Connect's settings home — `react-native-health-connect` v4.1.3 exposes
 * no intent for VOLA's own permission page (see `openHealthConnectSettingsScreen`).
 */
export function refusalLineCopy(types: readonly ToggleRecordType[]): string | null {
  if (types.length === 0) return null;
  const nouns = listNouns(types.map((t) => TOGGLE_WORDS[t].noun));
  const costs = listClauses(types.map((t) => TOGGLE_WORDS[t].consequence));
  return `Health Connect isn't sharing ${nouns} with VOLA, so ${costs}. To change it, open Health Connect, then App permissions, then VOLA.`;
}

// --- the store ---------------------------------------------------------------

const listeners = new Set<() => void>();

/**
 * Called after every write, so a Settings screen already open re-reads when the
 * foreground pass that follows a trip to Health Connect lands. Returns the
 * unsubscribe. Same shape as `lib/steps.ts`'s `onStepsChanged`.
 */
export function onHealthConnectRefusalsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record the answer of a pass that reached its reads. Overwrites whatever the
 * previous pass left, including with `[]`. Only `syncHealthConnectBiometrics`
 * calls this, and only on that path — see its own comment at the call.
 */
export async function recordHealthConnectPassRefusals(
  userID: string,
  notPermitted: readonly HealthConnectRecordType[],
): Promise<void> {
  await writePref(userID, PREF_HEALTH_CONNECT_REFUSED, JSON.stringify(notPermitted));
  for (const listener of [...listeners]) listener();
}

/**
 * What the Settings line should name for `userID`: `[]` when no pass has
 * recorded anything, when the last one was refused nothing the toggle asks
 * for, or when the stored value cannot be read as a list.
 */
export async function readHealthConnectRefusals(userID: string): Promise<ToggleRecordType[]> {
  const raw = await readPref(userID, PREF_HEALTH_CONNECT_REFUSED);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? refusalsForToggleLine(parsed) : [];
  } catch {
    return [];
  }
}
