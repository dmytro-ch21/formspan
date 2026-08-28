import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/Themed';
import { TrackerCard } from '@/components/TrackerCard';
import { vola } from '@/constants/Colors';
import { targetCount } from '@/lib/trackerModel';
import type { TrackerDay } from '@/lib/useTrackerDay';
import type { UnitSystem } from '@/lib/units';

/**
 * Every tracker's card, for one day.
 *
 * The one place Today and Food both render, so the two screens cannot end up
 * showing different things — and so the empty and unknown states are decided
 * once. See `useTrackerDay` for why that matters here in particular.
 *
 * No self-margin: both screens space their children with `gap`.
 */
export function TrackerList({
  day,
  dayAtTap,
  on,
  units,
  unitsReady,
  now = null,
  collapseAfter,
  collapseKey,
  testID,
}: {
  day: TrackerDay;
  /**
   * The day a tap should be FILED UNDER, resolved at the MOMENT of the tap.
   *
   * A function, and the type is the guard: a `string` here would be computed
   * during render, and Today stays mounted for the life of the process — so a
   * phone left open across midnight would hold yesterday's value and the first
   * tap at 00:05 would file a cup under the day that just ended. A stale read
   * is a nuisance; a stale WRITE is data. Requiring a thunk makes passing a
   * frozen day a type error rather than a bug nobody meets until midnight.
   *
   * The screen decides what it means: Today reads the clock, Food passes its
   * stepper's day, because there the day is the subject of the screen and a tap
   * while reading Tuesday belongs to Tuesday.
   */
  dayAtTap: () => string;
  /**
   * The day being READ — what these cards are showing, as opposed to
   * `dayAtTap`'s "what a tap right now would write to". The two used to be
   * treated as one concept ("there is deliberately no separate 'day being
   * rendered' prop" used to be written here); that assumption was the root
   * cause of W16/#704, where a tap logged on a browsed past day kept
   * rendering on Today until something else forced a re-fetch, because
   * nothing checked that `day`'s loaded entries actually matched the day on
   * screen. `on` is threaded straight into `day.entriesFor(id, on)` for
   * that check, and used to key each `TrackerCard` so a day switch remounts
   * the card's glyphs instead of springing their fill from the previous
   * day's count to this one's — the same stale-transition failure class as
   * `MacroRings` (W15).
   */
  on: string;
  units: UnitSystem;
  unitsReady: boolean;
  /**
   * The live clock, passed straight through to `TrackerCard` for the cutoff
   * line (N431) — `null` unless the day on screen IS real today. Today passes
   * `new Date()` when `isToday`, Food likewise; a browsed past day passes
   * `null` from both, because "cutoff in 1h 20m" is a claim about right now
   * and neither screen's stepper changes what time it actually is.
   */
  now?: Date | null;
  /**
   * Draw at most this many cards, and put the rest behind one disclosure row.
   *
   * **Today passes a number; Food does not.** N78 asks for "a stated cap or a
   * collapse behaviour, and it is a deliberate decision rather than whatever
   * happens", and this is both halves of that answer:
   *
   * - The CAP is server-side and absolute (eight live trackers). It exists
   *   because a list you scroll to reorder stops being reorderable one-handed.
   * - The COLLAPSE is per-screen and is about what Today is FOR. Today is a
   *   decision surface, and eight tracker cards on it would push the session,
   *   the readiness and the week below the fold — a feature crowding out the
   *   screen it was added to.
   *
   * Food gets no collapse because Food is where trackers LIVE: an athlete who
   * went there went there to look at them.
   *
   * The disclosure row is not a plain "3 more". It says how many of the hidden
   * ones still have something to do, because a tracker you have already
   * finished is not a reason to expand and the whole point of being on Today is
   * not forgetting the ones you have not.
   */
  collapseAfter?: number;
  /**
   * Changing this collapses the list again.
   *
   * **Today never unmounts** — it stays mounted for the life of the process,
   * which is the same fact `dayAtTap` exists for — so a `useState` here is a
   * ONE-SHOT: tap "2 more trackers" once and the collapse is defeated for
   * every day after, including tomorrow's. Today passes its own day key, so
   * expanding is a decision about today rather than a permanent setting.
   *
   * Derived during render rather than reset in an effect: an effect that calls
   * `setState` is a `react-hooks/set-state-in-effect` warning, and the ratchet
   * has zero headroom.
   */
  collapseKey?: string;
  testID?: string;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const expanded = openFor !== null && openFor === (collapseKey ?? '');

  if (day.view.state === 'unknown') {
    // Deliberately says nothing rather than "you have no trackers". This device
    // has not been told yet — the server provisions water on the first list —
    // and a confident empty state here would tell an athlete with a water card
    // that they have none.
    return null;
  }
  if (day.view.trackers.length === 0) {
    return (
      <Text style={styles.empty} testID={testID ? `${testID}-empty` : 'trackers-empty'}>
        Nothing to track today.
      </Text>
    );
  }

  const all = day.view.trackers;
  const limit = collapseAfter ?? all.length;
  const collapsed = !expanded && all.length > limit;
  const shown = collapsed ? all.slice(0, limit) : all;
  const hidden = collapsed ? all.slice(limit) : [];
  // "still to do" rather than "not finished": a tracker with no target can
  // never be finished, so counting it as outstanding forever would make the row
  // always urgent and therefore never informative. Only a target can be unmet.
  const outstanding = hidden.filter((t) => {
    const target = targetCount(t);
    return target != null && day.entriesFor(t.id, on).length < target;
  }).length;

  return (
    <>
      {shown.map((t) => (
        <TrackerCard
          // Keyed on the day too, not just the tracker — see `on`'s own doc
          // comment above. A day switch remounts the card, so its glyphs'
          // `Animated.Value`s start fresh from the NEW day's count instead of
          // springing to it from the old one.
          key={`${t.id}-${on}`}
          tracker={t}
          entries={day.entriesFor(t.id, on)}
          units={units}
          unitsReady={unitsReady}
          now={now}
          onAdd={() => void day.addTap(t, dayAtTap())}
          onRemove={(entryID) => void day.removeEntry(entryID, dayAtTap())}
          onEdit={() => day.openSettings(t)}
        />
      ))}
      {collapsed ? (
        <Pressable
          onPress={() => setOpenFor(collapseKey ?? '')}
          style={styles.more}
          accessibilityRole="button"
          accessibilityLabel={moreLabel(hidden.length, outstanding)}
          testID={testID ? `${testID}-more` : 'trackers-more'}
        >
          {/* Text only. `assets/brand/icons/` has no chevron, and adding one
              means an SVG in the brand kit plus a regenerate — a change to the
              identity, made in passing, for a disclosure row. The label already
              says what tapping does. */}
          <Text style={styles.moreText}>{moreLabel(hidden.length, outstanding)}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

/**
 * The disclosure copy. States the arithmetic and stops.
 *
 * No "don't forget!", no exclamation mark, and nothing different about three
 * outstanding than about one — the same rule the card's own copy follows. An
 * athlete who wants to act on it can see the number.
 */
function moreLabel(hidden: number, outstanding: number): string {
  const noun = hidden === 1 ? 'tracker' : 'trackers';
  if (outstanding === 0) return `${hidden} more ${noun}, all done`;
  return `${hidden} more ${noun}, ${outstanding} still to log`;
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, color: vola.textDim },
  more: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    // 44pt tall: it is the only route to a tracker Today is hiding, so it is
    // not a control to make small.
    paddingVertical: 13,
  },
  moreText: { fontSize: 13, fontWeight: '700', color: vola.textMuted },
});
