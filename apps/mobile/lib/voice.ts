import * as Speech from 'expo-speech';

import type { CountdownKind } from './countdown';
import { PREF_VOICE, readPref, writePref } from './prefs';
import { soundsEnabled } from './sounds';

/**
 * The spoken half of a guided workout.
 *
 * A hands-free run is only hands-free if it is also **eyes-free**. Chimes tell
 * you *that* something changed; on a five-exercise circuit you also need to know
 * *what* — whether the thing that just ended was your set or your rest, and
 * whether the next forty seconds are burpees or mountain climbers. That is a
 * sentence, not a bell.
 *
 * ## Synthesised, not recorded
 *
 * Device TTS rather than shipped clips. The obvious cost is that the voice is
 * whatever the phone has, and it varies; the two things bought are worth more:
 * the cue set can be reworded without a binary landing in the repo, and the
 * exercise NAME can be spoken — "Next: mountain climbers" — which a fixed clip
 * library of 761 exercises could never do.
 *
 * It is also the only option consistent with `assets/brand/` and
 * `scripts/generate_sounds.py`, both of which hold a *recipe* rather than
 * artefacts. There is no speech pipeline in this repo and inventing one to
 * render eight phrases would be the tail wagging the dog.
 *
 * ## Where the cues sit in the timeline, and why not anywhere else
 *
 * Every cue fires at a step BOUNDARY and nowhere else. The countdown's own
 * last-three-seconds ticks own the inside of a step, and the two must never
 * overlap — a voice starting on top of the "1" tick is the audio equivalent of
 * two people talking, and in a gym it means you hear neither.
 *
 * So during a guided run the completion CHIME is suppressed and the voice takes
 * its place; the ticks are untouched. The athlete hears: tick, tick, tick,
 * "Start exercise" — one continuous idea, one voice at a time.
 *
 * ## Failure is always silent
 *
 * Same discipline as `lib/sounds.ts` beside it. Nothing here throws into a
 * caller: a TTS engine that is missing, muted or busy must not be able to stop a
 * countdown, because the countdown is the feature and this decorates it.
 */

export type Cue =
  | 'getReady'
  | 'startExercise'
  | 'setComplete'
  | 'rest'
  | 'lastSet'
  | 'workoutComplete';

/**
 * What each cue says.
 *
 * Short, and in the imperative where the athlete has to act. Two rules learned
 * from reading them out loud against a running clock: nothing over about a
 * second, because the next thing is three seconds away; and no numbers, because
 * "set three of five" is exactly the sentence that is still going when the work
 * interval starts.
 */
export const CUE_TEXT: Record<Cue, string> = {
  getReady: 'Get ready',
  startExercise: 'Start exercise',
  setComplete: 'Set completed',
  rest: 'Rest now',
  lastSet: 'Last set',
  workoutComplete: 'Workout complete',
};

/**
 * What to say when the run moves from one step to the next.
 *
 * Pure, and the whole ordering lives here rather than in the screen's transition
 * handler, because this is the part that is easy to get subtly wrong and
 * impossible to notice: a run that says "rest now" on the way INTO a work
 * interval is still a run that makes noises at the right times.
 *
 * `null` on either side means the ends of the run — starting it, and finishing.
 * Leaving a work step always earns a "set completed" first, because that is the
 * event the athlete is waiting to hear confirmed; what comes next is a second
 * sentence, and `expo-speech` queues rather than interrupts, so the two play in
 * order.
 */
export function cuesForTransition(
  from: CountdownKind | null,
  to: CountdownKind | null,
): Cue[] {
  const out: Cue[] = [];
  if (from === 'work') out.push('setComplete');
  if (to === null) {
    // Only the end of a whole run is worth announcing. A run that ended because
    // the athlete stopped it does not reach here — see `stopSpeaking`.
    if (from !== null) out.push('workoutComplete');
    return out;
  }
  if (to === 'work') out.push('startExercise');
  else if (to === 'rest') out.push('rest');
  else if (to === 'ready') out.push('getReady');
  return out;
}

/**
 * Voices worth using, in preference order, and how they are recognised.
 *
 * The request was for a soft female voice, and neither platform exposes gender
 * as a field — iOS dropped it from `AVSpeechSynthesisVoice` metadata years ago
 * and Android never had it. So it is matched by name, which is exactly as
 * fragile as it sounds and is why {@link pickVoice} falls back to the system
 * default rather than to a second guess.
 *
 * iOS ships these as named voices; the ordering is by how they read a short
 * imperative phrase, which is all this ever says. Android encodes the register
 * in the identifier instead (`en-us-x-tpf-local`, `…#female_1-local`), so the
 * marker list catches those.
 */
const FEMALE_NAMES = [
  'samantha', 'ava', 'allison', 'susan', 'nicky', 'zoe',
  'karen', 'moira', 'tessa', 'fiona', 'serena', 'kate',
];

const FEMALE_MARKERS = ['female', '-tpf-', '-tpc-', '#female'];

/** A voice, reduced to what the ranking actually reads. */
export type VoiceLike = {
  identifier: string;
  name?: string;
  language?: string;
  quality?: string;
};

/**
 * The best available voice, or null for "let the system choose".
 *
 * Ranked rather than filtered, so a device with no match still gets a sensible
 * answer instead of silence. The four signals, in order of weight:
 *
 *  1. **Language.** A German voice reading "Get ready" is unusable, and it is the
 *     one mismatch that is worse than the default. Non-matching languages are
 *     dropped outright rather than ranked low.
 *  2. **Recognised as female**, by name or identifier marker.
 *  3. **Quality.** `Enhanced`/`Premium` where the user has downloaded one —
 *     these are the ones that do not sound like a satnav.
 *  4. **Name order**, so the same device picks the same voice every launch.
 *     Determinism matters more than it looks: a cue set that changes voice
 *     between sessions reads as a bug.
 *
 * Returning null when nothing matches is deliberate. `Speech.speak` with no
 * `voice` uses the system default, which is the phone's own setting and
 * therefore the best available guess about what its owner wants to hear.
 */
export function pickVoice(voices: VoiceLike[], language = 'en'): string | null {
  const lang = language.toLowerCase();
  const eligible = voices.filter((v) => (v.language ?? '').toLowerCase().startsWith(lang));
  if (eligible.length === 0) return null;

  const female = (v: VoiceLike) => {
    const name = (v.name ?? '').toLowerCase();
    const id = v.identifier.toLowerCase();
    if (FEMALE_NAMES.some((n) => name === n || name.startsWith(`${n} `) || id.includes(`.${n}`))) {
      return true;
    }
    return FEMALE_MARKERS.some((m) => id.includes(m) || name.includes(m));
  };
  const quality = (v: VoiceLike) => {
    const q = (v.quality ?? '').toLowerCase();
    return q.includes('enhanced') || q.includes('premium') ? 1 : 0;
  };

  const ranked = [...eligible].sort(
    (a, b) =>
      Number(female(b)) - Number(female(a)) ||
      quality(b) - quality(a) ||
      (a.name ?? a.identifier).localeCompare(b.name ?? b.identifier),
  );
  // A voice that is not recognised as female is no better than the system
  // default, and the default is at least the phone owner's own choice.
  return female(ranked[0]) ? ranked[0].identifier : null;
}

let voiceID: string | null = null;
let enabled = true;
let resolved = false;
/** Which athlete's preference `enabled` reflects — see `lib/sounds.ts`. */
let prefLoadedFor: string | null = null;

/**
 * Resolve the voice and the athlete's preference.
 *
 * Two independent jobs in one call, for the same reason `initSounds` has them:
 * `useAuth().userId` is undefined on the first render and real on the second, so
 * this is always called twice and a single latch would mean the preference is
 * never read. That shipped once already, in the sounds module, as a muted
 * athlete getting noise back on every launch.
 */
export async function initVoice(userId: string | null | undefined): Promise<void> {
  try {
    if (userId && prefLoadedFor !== userId) {
      enabled = (await readPref(userId, PREF_VOICE)) !== '0';
      prefLoadedFor = userId;
    }
  } catch {
    // Unreadable preference leaves the default (on) in place.
  }

  if (resolved) return;
  resolved = true;
  try {
    voiceID = pickVoice(await Speech.getAvailableVoicesAsync());
  } catch {
    // No voice list, no chosen voice — `speak` falls back to the system default.
  }
}

/**
 * Say one cue. Fire and forget — never awaited, never throws.
 *
 * **Rate below 1.0 and pitch a touch above.** The default rate reads a
 * two-word imperative as a clipped bark; slowing it is what makes "Get ready"
 * sound like a coach rather than a lift announcement. The numbers are the same
 * on both platforms because `expo-speech` normalises them.
 */
export function speak(cue: Cue): void {
  if (!voiceEnabled()) return;
  try {
    Speech.speak(CUE_TEXT[cue], {
      voice: voiceID ?? undefined,
      language: 'en-US',
      rate: 0.94,
      pitch: 1.05,
    });
  } catch {
    // See the note at the top: the voice never breaks its caller.
  }
}

/**
 * Say something with a name in it — "Next: mountain climbers".
 *
 * Separate from {@link speak} because it is the one cue that is not from a fixed
 * vocabulary, so it cannot be a `Cue`, and because it is the only one allowed to
 * be long: it plays at the head of a rest interval, where there are thirty
 * seconds of nothing to talk over.
 */
export function announce(text: string): void {
  if (!voiceEnabled() || !text.trim()) return;
  try {
    Speech.speak(text, {
      voice: voiceID ?? undefined,
      language: 'en-US',
      rate: 0.94,
      pitch: 1.05,
    });
  } catch {
    // Silent, as above.
  }
}

/**
 * Cut the voice off mid-sentence.
 *
 * Called when a run is stopped, and it has to be immediate rather than "after
 * the current phrase": stopping a workout and then being told to get ready is
 * the app arguing with a decision the athlete already made.
 */
export function stopSpeaking(): void {
  try {
    void Speech.stop();
  } catch {
    // Nothing was speaking.
  }
}

/**
 * Is the phone allowed to talk right now?
 *
 * **Muting sounds silences the voice too, and not the reverse.** `PREF_VOICE`
 * says so and the code did not, which review caught: sounds off with voice on
 * left the phone announcing "set completed" out loud to somebody who had just
 * told it to be quiet. Silence is one switch; a *talking* app is the narrower
 * choice inside a noisy one.
 *
 * Read live rather than mirrored into `enabled`, because the sounds flag is
 * flipped synchronously by its own toggle and a copy here would go stale for as
 * long as this module was not re-initialised.
 */
export function voiceEnabled(): boolean {
  return enabled && soundsEnabled();
}

export async function readVoiceEnabled(userId: string): Promise<boolean> {
  return (await readPref(userId, PREF_VOICE)) !== '0';
}

/** Flag first, write second — see `writeSoundsEnabled` for why that order. */
export async function writeVoiceEnabled(userId: string, on: boolean): Promise<void> {
  enabled = on;
  if (!on) stopSpeaking();
  await writePref(userId, PREF_VOICE, on ? '1' : '0');
}

/** Test seam. */
export function resetVoice(): void {
  voiceID = null;
  enabled = true;
  resolved = false;
  prefLoadedFor = null;
}
