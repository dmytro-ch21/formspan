import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { SectionHeader } from '@/components/ui/Section';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fetchFocus, type Focus } from '@/lib/bjjFocus';
import { listWorkingCurricula, type Curriculum } from '@/lib/curriculum';
import { roadmapMilestone } from '@/lib/roadmapEntry';
import { subscribeSync, syncState } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * On You: what the record says you have, and what you are working now.
 *
 * The design doc's connective table asks this screen for "techniques complete,
 * current focus", and those two belong together for a reason worth stating —
 * they are the only place the athlete sees the loop from both ends. Focus is
 * what feeds the wizard; mastered is what came out of it months later.
 *
 * **Both numbers are derived and both can go down.** The copy says "your record
 * shows", never "you have earned", for the same reason the roadmap screen does:
 * mastery is recomputed on every read, so a long enough bad run takes one back.
 * A stats surface that implied permanence would be the one place in this app
 * that promised something the data model does not.
 *
 * **Reviewed for N107, kept as-is.** With the offer moved to Goals and Today
 * reduced to the #447 session hint, this became the ONLY place a roadmap's
 * progress reads as a standing fact rather than a decision or a momentary
 * hint — Today's own `RoadmapLine` (the other progress readout) was removed in
 * the same change specifically because it duplicated what this block already
 * says. So the "three surfaces" the ticket worried about collapsed to one
 * progress surface, one offer surface and one contextual hint by removing the
 * duplication rather than by cutting this block's content — trimming it
 * further would leave progress with nowhere to live at all.
 */
export function RoadmapSummary() {
  const getToken = useAuthToken();
  const accent = useAccent();
  const [roadmaps, setRoadmaps] = useState<Curriculum[] | null>(null);
  const [focus, setFocus] = useState<Focus[] | null>(null);

  const load = useCallback(async () => {
    try {
      // Together, because half of this block is meaningless alone: focus with
      // no roadmap is a hand-set list, and a roadmap with no focus cannot say
      // what is being worked.
      const [working, current] = await Promise.all([
        listWorkingCurricula(getToken),
        fetchFocus(getToken),
      ]);
      setRoadmaps(working);
      setFocus(current);
    } catch {
      // Silent. This is a summary block on a profile screen — an error banner
      // here would make an offline You tab look broken over something nobody
      // asked for. Left null, so nothing is claimed either way.
    }
  }, [getToken]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /**
   * And whenever a sync lands — N122, same reason as the roadmap screen.
   *
   * `mastered_items` here is derived server-side from the tags the outbox
   * pushes, so a reflection written and synced while this tab sat mounted
   * moved the server's answer and not this block's copy of it. Focus alone
   * corrects that only if the athlete leaves the tab and comes back, which is
   * exactly the "it never counted" reading the ticket reports.
   *
   * A subscription rather than an effect keyed on `lastSyncAt`, for the reason
   * spelled out on the roadmap screen: the latter is a setState in an effect
   * body, which the lint ratchet refuses.
   */
  useEffect(() => {
    let seen = syncState().lastSyncAt;
    return subscribeSync((s) => {
      // Sign-out emits `lastSyncAt: null`, which is not a sync — see the
      // longer note on the roadmap screen. Re-arm and say nothing rather than
      // fetching with no identity.
      if (s.lastSyncAt === null) {
        seen = null;
        return;
      }
      if (s.lastSyncAt === seen) return;
      seen = s.lastSyncAt;
      void load();
    });
  }, [load]);

  // Nothing to say rather than an empty state. Someone on no roadmap with no
  // focus is not missing anything — this block is for people mid-syllabus, and
  // an "enrol in something" prompt on the profile screen would be a nag.
  if (!roadmaps?.length && !focus?.length) return null;

  const mastered = (roadmaps ?? []).reduce((n, c) => n + c.mastered_items, 0);
  const countable = (roadmaps ?? []).reduce((n, c) => n + c.countable_items, 0);

  return (
    <View style={styles.wrap}>
      <SectionHeader label="Roadmap" />

      {countable > 0 && (
        <View style={styles.card}>
          <Text>
            <Text style={[styles.big, { color: accent.ink }]}>{mastered}</Text>
            <Text style={styles.rest}> of {countable} techniques mastered</Text>
          </Text>
          <Text style={styles.note}>
            {/* "Your record shows", not "you have earned" — see the doc
                comment. This is the sentence that keeps the claim honest. */}
            Across {roadmaps!.length === 1 ? 'the roadmap' : `${roadmaps!.length} roadmaps`} you
            are working. Your record decides these, so they can move both ways.
          </Text>
        </View>
      )}

      {focus && focus.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Working on now</Text>
          <RNView style={styles.chips}>
            {focus.map((f) => (
              <RNView key={f.technique_id} style={styles.chip}>
                <Text style={styles.chipText}>{f.name}</Text>
              </RNView>
            ))}
          </RNView>
          <Text style={styles.note}>
            These are the one-tap chips in the reflection wizard — what you tap
            there is what these roadmaps read.
          </Text>
        </View>
      )}

      {(roadmaps ?? []).map((c) => {
        // N96: the row said the name and a fraction, which is where you are in
        // a total and not where you are in the SYLLABUS. Null on an unphased
        // or finished roadmap — see `roadmapMilestone` for why those are
        // different situations, and why neither may be faked into a number.
        const milestone = roadmapMilestone(c);
        return (
          <Link key={c.id} href={`/curriculum/${c.id}`} asChild>
            <Pressable
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={
                milestone
                  ? `${c.name}, milestone ${milestone.number} of ${milestone.of}, ${milestone.title}, ${c.mastered_items} of ${c.countable_items} mastered`
                  : `${c.name}, ${c.mastered_items} of ${c.countable_items} mastered`
              }
              testID={`you-roadmap-${c.id}`}
            >
              <RNView style={styles.linkMain}>
                <Text style={styles.linkText} numberOfLines={1}>
                  {c.name}
                </Text>
                {milestone && (
                  <Text style={styles.linkSub} numberOfLines={1}>
                    Milestone {milestone.number} of {milestone.of} · {milestone.title}
                  </Text>
                )}
              </RNView>
              <Text style={styles.linkMeta}>
                {c.mastered_items}/{c.countable_items}
              </Text>
            </Pressable>
          </Link>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  card: {
    backgroundColor: vola.surface,
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  cardTitle: { color: vola.text, fontSize: 14, fontWeight: '700' },
  big: { fontSize: 28, fontWeight: '800' },
  rest: { color: vola.textMuted, fontSize: 14 },
  note: { color: vola.textMuted, fontSize: 12, lineHeight: 17 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: { color: vola.text, fontSize: 13, fontWeight: '600' },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: vola.surface,
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  pressed: { opacity: 0.7 },
  linkMain: { flex: 1, gap: 2 },
  linkText: { color: vola.text, fontSize: 14, fontWeight: '600' },
  linkSub: { color: vola.textMuted, fontSize: 12 },
  linkMeta: { color: vola.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
});
