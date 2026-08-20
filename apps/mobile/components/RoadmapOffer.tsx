import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { listCurricula, type Curriculum } from '@/lib/curriculum';
import { roadmapToOffer } from '@/lib/roadmapEntry';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The offer, on Today, for an athlete who is on no roadmap.
 *
 * **This is the whole of N96.** The user could not find roadmaps, and the
 * reason was not that there were too few links: it was that the only surface
 * offering an un-enrolled roadmap was a horizontal strip below a seven-day
 * week grid, on the tab you open to pick a template. See `lib/roadmapEntry.ts`
 * for the full diagnosis. Today is the screen the app opens to, and the slot
 * this occupies is the one `RoadmapLine` already owns for everybody else — so
 * the roadmap row is now PERMANENT with two states rather than a prompt that
 * appears out of nowhere. That distinction is what keeps it from being the nag
 * `RoadmapSummary` declines to be on the profile screen.
 *
 * **It self-limits, structurally.** Today renders this only when the working
 * list came back empty, so enrolling replaces it with the progress line and it
 * never returns. There is no dismiss control, because there is nothing left to
 * dismiss the moment it has done its job.
 *
 * **It says what a roadmap IS.** The strip's tiles say "WHITE BELT" and "25 to
 * master", which names a thing the athlete has no model for — one of the four
 * candidate diagnoses in the ticket, and the one a fourth link would not have
 * fixed. So the body sentence spends its words on the mechanism (your logged
 * sessions move it) rather than on the noun.
 *
 * **One extra request, and only for the people it is for.** Today already
 * reads `/curricula/working`; the full list is fetched only when that came back
 * empty — i.e. only for an athlete on no roadmap — and stops being fetched the
 * moment they take one on.
 */
export function RoadmapOffer() {
  const getToken = useAuthToken();
  const accent = useAccent();
  const [offer, setOffer] = useState<Curriculum | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setOffer(roadmapToOffer(await listCurricula(getToken, signal)));
      } catch {
        // Silent, like every other block on this screen: an error banner over
        // an offer nobody asked for would make an offline Today look broken.
        // Left as it was, so nothing is claimed either way — and an abort
        // lands here too, which is exactly the "change nothing" this wants.
      }
    },
    [getToken],
  );

  // ON FOCUS, not on mount. A tab screen stays mounted for the life of the
  // process, and enrolling happens on the roadmap screen pushed over it — read
  // once, this would keep offering a roadmap the athlete had already started.
  // The same bug `CurriculaStrip` documents, in the same place.
  //
  // The abort is the OTHER half of that, and it is the same stale-read shape
  // Today's own `planSeq` and the Plan tab's `readSeq` both guard. Blur this
  // tab mid-request on a slow connection, enrol, come back: two reads are in
  // flight and the FIRST one — built from a list where nothing was enrolled —
  // can land last and put the offer back on top of a roadmap the athlete just
  // started. Cancelling on blur means the losing read never reaches `setOffer`
  // at all, which is cheaper than sequencing and also stops a response
  // resolving into an unmounted card.
  useFocusEffect(
    useCallback(() => {
      const inflight = new AbortController();
      void load(inflight.signal);
      return () => inflight.abort();
    }, [load]),
  );

  if (offer === null) return null;

  return (
    <Link href={`/curriculum/${offer.id}`} asChild>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`Start a roadmap. ${offer.name}, ${offer.countable_items} techniques. Your logged sessions decide the progress.`}
        accessibilityHint="Opens the roadmap so you can look at it before starting"
        testID="today-roadmap-offer"
      >
        <RNView style={styles.head}>
          {/* `route`, NOT `goal` — and this is a real collision rather than a
              preference. `goal` is the GOALS TAB's icon, which is in the tab
              bar at the bottom of this very screen, so the same glyph would
              be pointing at two unrelated destinations eight hundred points
              apart. `route` is a path through somewhere, which is what a
              roadmap is, and nothing else in the app claims it. */}
          <Icon name="route" size={14} color={accent.ink} />
          <Text style={[styles.eyebrow, { color: accent.ink }]}>ROADMAPS</Text>
        </RNView>

        <Text style={styles.title}>Start a roadmap</Text>
        <Text style={styles.body}>
          {/* The name first, because the offer is for a specific one and "a
              roadmap" alone is the abstraction that failed.

              One interpolated string rather than JSX text spanning four
              source lines: JSX collapses a line break into a space and drops
              a whitespace-only one, so where the spaces land in the rendered
              sentence depends on how this block happens to be wrapped. That
              is a formatter away from reading "sessionsdecide", with nothing
              red — and the test asserts this sentence verbatim. */}
          <Text style={styles.name}>{offer.name}</Text>
          {` — ${offer.countable_items} techniques, in the order they are usually ` +
            // Never "you have earned": mastery is recomputed on every read and
            // can go back down, the same honesty the roadmap screen keeps.
            `learned. Your logged sessions decide how far along it says you are — ` +
            `there is nothing to tick off by hand.`}
        </Text>
        <Text style={styles.note}>
          {/* Plain text, no second destination. It names where the rest live,
              which is the half of "hidden" a single offer cannot fix. */}
          The rest are under Roadmaps on the Plan tab.
        </Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: vola.surface,
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 4,
  },
  pressed: { opacity: 0.7 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  title: { color: vola.text, fontSize: 15, fontWeight: '700' },
  body: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },
  name: { color: vola.text, fontWeight: '700' },
  /* `textMuted`, NOT `textDim`. Measured against `surface` (#10151F): textDim
     is 3.67:1, which fails 4.5 for body text at this size, and textMuted is
     6.85:1. Same rule the palette states for a done row's set ordinal. */
  note: { color: vola.textMuted, fontSize: 12, marginTop: 2 },
});
