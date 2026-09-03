import type { Split } from './running';

/**
 * Spoken split announcements for a live-tracked run (L13/#779).
 *
 * The chosen prototype out of the three the ticket named — see the history
 * entry for the full evaluation. This module holds only the pure "what to say
 * and when" logic; `announce()` in `lib/voice.ts` (already built for the
 * guided-workout timer) is what actually speaks it, and already respects the
 * athlete's existing Sounds/Spoken-cues preferences — that reuse is what makes
 * this cheap and is why it satisfies this ticket's own AC without a new
 * toggle. `app/running/[id].tsx` is the only caller.
 */

/**
 * Turn a duration into words a TTS engine reads naturally.
 *
 * `formatElapsed`'s "5:12" is exactly right for a screen and wrong for a
 * voice — every synthesiser reads a bare "5:12" as "five twelve", which is
 * easy to mishear as a pace rather than a split time. Spelling out the units
 * removes the ambiguity at the cost of a couple more words, and a couple more
 * words is nothing against the minutes of silence between splits.
 */
export function spokenDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  if (minutes === 0) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  if (seconds === 0) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ${seconds} ${
    seconds === 1 ? 'second' : 'seconds'
  }`;
}

/**
 * What the voice says when a kilometre split completes.
 *
 * `splitIndex` is 0-based (the same index `splitsFromTrack` returns in its
 * array), spoken as the 1-based distance marker a runner actually thinks in —
 * "Kilometer 1" for the first split, never "Kilometer 0".
 *
 * Always says "Kilometer", regardless of the athlete's unit preference,
 * matching the live screen's own split list (`Km 1`, `Km 2`, …):
 * `splitsFromTrack` only ever measures splits at `DEFAULT_SPLIT_METERS`
 * (1000m) boundaries, so a mile-based announcement would describe a boundary
 * the track was never actually measured against. Making splits unit-aware is
 * a larger, unrelated change and explicitly out of scope for this ticket —
 * see the history entry.
 */
export function spokenSplitAnnouncement(splitIndex: number, split: Split): string {
  return `Kilometer ${splitIndex + 1}, ${spokenDuration(split.duration_seconds)}.`;
}

/**
 * Which split indices are newly completed since a baseline count.
 *
 * Pulled out of the screen's effect so the "what's new" arithmetic — the one
 * part of this feature that is easy to get subtly wrong (an off-by-one here
 * silently replays or skips exactly one split) and impossible to notice by
 * watching a running screen for a minute — is testable without mounting
 * anything.
 *
 * `previousCount` is clamped at 0 rather than trusted, so a caller that
 * hasn't established a baseline yet (a `null` ref coerced to 0 by a careless
 * caller) announces every split already on the track instead of silently
 * going negative and announcing nothing forever.
 */
export function newSplitIndices(previousCount: number, splitsLength: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, previousCount); i < splitsLength; i++) out.push(i);
  return out;
}
