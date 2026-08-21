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
  units,
  unitsReady,
  collapseAfter,
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
   *
   * There is deliberately no separate "day being rendered" prop — the cards
   * show whatever `day.refresh(on)` last loaded, and the screen owns that call.
   * Two day inputs would be two things to keep in step.
   */
  dayAtTap: () => string;
  units: UnitSystem;
  unitsReady: boolean;
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
  testID?: string;
}) {
  const [expanded, setExpanded] = useState(false);

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
    return target != null && day.entriesFor(t.id).length < target;
  }).length;

  return (
    <>
      {shown.map((t) => (
        <TrackerCard
          key={t.id}
          tracker={t}
          entries={day.entriesFor(t.id)}
          units={units}
          unitsReady={unitsReady}
          onAdd={() => void day.addTap(t, dayAtTap())}
          onRemove={(entryID) => void day.removeEntry(entryID, dayAtTap())}
          onEdit={() => day.openSettings(t)}
        />
      ))}
      {collapsed ? (
        <Pressable
          onPress={() => setExpanded(true)}
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
