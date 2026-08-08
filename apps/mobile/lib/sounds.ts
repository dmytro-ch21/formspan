import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

import { PREF_SOUNDS, readPref, writePref } from './prefs';

/**
 * Every sound the app makes, in one place.
 *
 * A named vocabulary rather than file paths at call sites, so a screen asks
 * for "the rest finished" and never for "rest-done.m4a". The files are
 * synthesised by `scripts/generate_sounds.py` — checked in as a recipe, not as
 * opaque binaries — and bundled locally, because the whole point is a
 * chime in a basement gym with no signal.
 *
 * ## Three audio-session decisions, none of them defaults
 *
 * **`playsInSilentMode: true` — it rings with the ringer switch off.** The
 * strongest argument against is that silencing a phone is a clear instruction,
 * and normally it would be. For the timer sounds it does not apply: a rest
 * timer you cannot hear is not a rest timer, hearing it is the entire feature,
 * each one fires as the direct result of a countdown the athlete started
 * seconds earlier, and a phone left on silent is the normal state for most
 * people — so respecting the switch would mean the feature silently does
 * nothing for most users.
 *
 * **That argument used to say "this app never makes an unsolicited sound", and
 * that is no longer true.** The arrival cue fires because somebody ELSE sent a
 * friend request, and it rings on a silenced phone. This is a deliberate
 * decision rather than an oversight, and it is written down because the
 * original reasoning would otherwise look like it still covers a case it does
 * not:
 *
 *   - The session is process-wide. `setAudioModeAsync` cannot be made
 *     per-sound, so the only alternatives were "no arrival cue" or "no timer
 *     sounds on a silenced phone". Neither is better.
 *   - The cue only fires with the app FOCUSED and in your hand — it plays as
 *     you arrive on a screen whose badge is changing in front of you. It is
 *     not a background alert, and it cannot fire from a pocket.
 *   - It is one tap to mute, and the toggle now says so.
 *
 * If a genuinely unsolicited sound is ever added — one that can fire while the
 * app is backgrounded — this decision has to be reopened, because at that
 * point the silent switch is being overridden for something the user has no
 * part in and cannot see.
 *
 * **`interruptionMode: 'duckOthers'` — it ducks music, never stops it.** People
 * train to their own music. `doNotMix` would kill the track on every rest and
 * leave the athlete restarting Spotify between sets; `mixWithOthers` would let
 * a chime disappear under a loud mix. Ducking is the only one that both plays
 * and gives the music back.
 *
 * **`shouldPlayInBackground: false` — no background audio session.** Holding
 * one so a chime could fire while the app is buried would be antisocial, and
 * it would buy nothing: see the limitation below.
 *
 * ## What this deliberately does NOT do
 *
 * **It is not a background alarm.** These sounds are driven by the countdown's
 * JS interval, and iOS throttles JS the moment the app leaves the screen — so
 * putting the phone in a pocket with the screen off means no chime, whatever
 * the audio session says. That is not a bug to fix here: a countdown that
 * fires with the app closed is a scheduled local notification, a different
 * mechanism and a different feature. Worth knowing before someone reports the
 * chime as broken.
 *
 * ## Failure is always silent
 *
 * Nothing here throws or rejects into a caller. Audio is a nicety; a timer
 * that stopped working because a sound file failed to decode would be the
 * feature breaking the thing it decorates. Same discipline as the existing
 * `Haptics.*(...).catch(() => {})` calls beside it.
 */

/**
 * Every sound, named once.
 *
 * The array is the source of truth and `SoundName` derives from it, rather
 * than the other way round, so that a test can assert "a player exists for
 * every sound" without hard-coding how many there are. It used to be a bare
 * union against `toHaveLength(4)`, which meant adding a sound failed three
 * unrelated tests that had no opinion about the new sound at all.
 */
export const SOUND_NAMES = [
  'restComplete',
  'workComplete',
  'sessionComplete',
  'tick',
  'pr',
  'notification',
  'streak',
  'success',
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

/**
 * `require` rather than a path string: Metro resolves these at build time and
 * bundles the asset. A runtime path would be a file that does not exist on the
 * device.
 */
const SOURCES: Record<SoundName, number> = {
  restComplete: require('@/assets/sounds/rest-done.m4a'),
  workComplete: require('@/assets/sounds/work-done.m4a'),
  sessionComplete: require('@/assets/sounds/session-done.m4a'),
  tick: require('@/assets/sounds/tick.m4a'),
  pr: require('@/assets/sounds/pr.m4a'),
  notification: require('@/assets/sounds/notification.m4a'),
  streak: require('@/assets/sounds/streak.m4a'),
  success: require('@/assets/sounds/success.m4a'),
};

let players: Partial<Record<SoundName, AudioPlayer>> = {};
let enabled = true;
/** Players and audio mode are process-wide: built once, never rebuilt. */
let loaded = false;
/**
 * Which athlete's mute preference `enabled` currently reflects.
 *
 * Tracked separately from `loaded`, and that separation is the entire fix for
 * a bug this shipped with: `useAuth().userId` is `undefined` on the first
 * render and only becomes real once Clerk resolves, so `initSounds` is ALWAYS
 * called twice — once with nothing, then with the id. A single `ready` flag
 * meant the first call claimed the job and the second returned early, so the
 * preference was never read and a muted athlete got sounds back on every
 * launch, while Settings correctly showed the toggle off. Two different
 * answers to "are sounds on", from two places, and only one of them made
 * noise.
 *
 * Keyed on the id rather than a boolean so switching accounts on a shared
 * phone re-reads too.
 */
let prefLoadedFor: string | null = null;

/**
 * Loads the players and claims the audio session's settings.
 *
 * Called once from the root layout. Preloaded rather than created per play,
 * because building a player costs a file read and a decode — tens of
 * milliseconds — and a rest chime that lands a beat after the countdown hits
 * zero reads as the timer being wrong, not as the sound being late.
 */
export async function initSounds(userId: string | null | undefined): Promise<void> {
  // Two independent jobs, because they become answerable at different times.
  // Called every launch as (undefined) then (userId); see `prefLoadedFor`.
  try {
    if (userId && prefLoadedFor !== userId) {
      enabled = (await readPref(userId, PREF_SOUNDS)) !== '0';
      prefLoadedFor = userId;
    }
  } catch {
    // Unreadable preference leaves the default (on) in place.
  }

  if (loaded) return;
  loaded = true;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      shouldPlayInBackground: false,
      // Never true. Asking for the microphone permission prompt as a side
      // effect of wanting a bell would be indefensible.
      allowsRecording: false,
    });
    for (const name of Object.keys(SOURCES) as SoundName[]) {
      players[name] = createAudioPlayer(SOURCES[name]);
    }
  } catch {
    // Leaves `players` partly or wholly empty; `play` no-ops on a missing one.
  }
}

/**
 * Plays one sound. Fire and forget — never awaited, never throws.
 *
 * **Rewind, then play, and the `await` between them is load-bearing.** A player
 * that has already run sits at the end of its buffer, and `play()` there is
 * silent — that is the bug where the first rest of a session chimes and none of
 * the others do, which reads as the sounds working and then randomly breaking
 * rather than as a defect.
 *
 * Writing `seekTo(0)` on the line above `play()` does NOT establish that order
 * on iOS. In `expo-audio@57`, iOS exposes `play` as a synchronous JSI function
 * that runs immediately on the JS thread, while `seekTo` is an `AsyncFunction`
 * dispatched onto a Swift task — so the un-awaited version most likely reaches
 * the native player as play-then-seek, the reverse of what it reads as.
 * (Android is fine either way: both hop the main queue, which preserves order.)
 * Awaiting removes the question rather than betting on it.
 *
 * The cost is a seek on a two-second asset already in memory — single-digit
 * milliseconds, against a completion the countdown has already quantised to a
 * 250ms interval. Inaudible.
 *
 * Still synchronous to callers: the promise is deliberately not returned, so
 * an interval callback cannot accidentally await a bell, and the `catch` keeps
 * a rejection from surfacing as a redbox.
 */
export function playSound(name: SoundName): void {
  if (!enabled) return;
  const player = players[name];
  if (!player) return;
  void (async () => {
    try {
      await player.seekTo(0);
      player.play();
    } catch {
      // See the note at the top: audio never breaks its caller.
    }
  })();
}

/** Whether sounds are on, for a settings screen to render. */
export function soundsEnabled(): boolean {
  return enabled;
}

export async function readSoundsEnabled(userId: string): Promise<boolean> {
  return (await readPref(userId, PREF_SOUNDS)) !== '0';
}

/**
 * Turns sounds on or off.
 *
 * The module-level flag is set first and independently of the write, so the
 * toggle takes effect immediately even if the pref write fails — the athlete
 * asked for silence, and making them wait on storage to get it would be the
 * wrong way round.
 */
export async function writeSoundsEnabled(userId: string, on: boolean): Promise<void> {
  enabled = on;
  await writePref(userId, PREF_SOUNDS, on ? '1' : '0');
}

/** Test seam — releases the native players. */
export function resetSounds(): void {
  for (const p of Object.values(players)) {
    try {
      p?.remove();
    } catch {
      // Already gone.
    }
  }
  players = {};
  loaded = false;
  prefLoadedFor = null;
  enabled = true;
}
