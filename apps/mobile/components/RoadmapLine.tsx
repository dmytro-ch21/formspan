import { Link } from 'expo-router';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { nextStep, type Curriculum } from '@/lib/curriculum';
import { roadmapMilestone } from '@/lib/roadmapEntry';

/**
 * The roadmap, on Today — as a REMINDER OF INTENT, not as a suggestion.
 *
 * **The design doc contradicts itself here and this resolves it.** Its
 * connective table says Today shows "one suggestion, sourced from the active
 * roadmap". Sixty lines later it says, with reasoning: "A curriculum is not a
 * suggestion source. Following one tells the app what you intend to learn; the
 * suggestion tiers tell you what your logs say about how it is going. Keeping
 * them separate is what stops a curriculum from silently becoming a
 * prescription."
 *
 * The second statement wins, because it is the one with an argument behind it
 * and the table entry reads as shorthand written before the principle was
 * articulated. So the roadmap appears on Today — honouring what the table
 * wanted — but it does not compete with the suggestion card and never phrases
 * itself as advice. It reports two facts the athlete already committed to:
 * which syllabus they are on, and which step is next in its order.
 *
 * Concretely, this says "Working the arm drag · 3 of 14". It never says "you
 * should work the arm drag". The suggestion card, twenty points below, is still
 * free to disagree with it — and that disagreement is information rather than a
 * bug, because one is a plan and the other is a reading of the evidence.
 *
 * ---
 *
 * **N96 added the milestone line, and the reason is that a title and a bar are
 * not a position.** This used to lead with "Next up: <technique>" over "3 of 25
 * mastered" — which says what is next and how much is left, but never where in
 * the syllabus the athlete actually is. On a roadmap of eleven named phases,
 * "3 of 25" is a bare fraction wearing words; "Milestone 3 of 11 · Mount: get
 * out, then hold" is the thing a glance can read and the thing the roadmap
 * screen shows when you arrive. The next step stays, one line down, because the
 * two answer different questions.
 *
 * The bar stays too, and stays decorative — `importantForAccessibility` off,
 * the numbers said in words above it. A percentage is precisely what the ticket
 * says an entry point must not lead with.
 */
export function RoadmapLine({ curriculum }: { curriculum: Curriculum }) {
  const accent = useAccent();
  const next = nextStep(curriculum);
  // Null on an unphased roadmap, and on a finished one. Both fall back to the
  // shape this component had before — see `roadmapMilestone` for why those are
  // three different situations rather than one missing value.
  const milestone = roadmapMilestone(curriculum);

  return (
    <Link href={`/curriculum/${curriculum.id}`} asChild>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={
          next
            ? `${curriculum.name}. ${
                milestone
                  ? `Milestone ${milestone.number} of ${milestone.of}, ${milestone.title}. `
                  : ''
              }Next up, ${next.name}. ${curriculum.mastered_items} of ${curriculum.countable_items} mastered.`
            : `${curriculum.name}. All ${curriculum.countable_items} mastered.`
        }
        testID={`today-roadmap-${curriculum.id}`}
      >
        <RNView style={styles.main}>
          <Text style={[styles.eyebrow, { color: accent.ink }]}>
            {curriculum.name.toUpperCase()}
          </Text>
          <Text style={styles.title} numberOfLines={2}>
            {/* WHERE THEY ARE leads, when the roadmap has phases to be
                somewhere in. Without them this falls back to the next step,
                which is what this line said before N96 — an unphased
                curriculum has no milestone to report and must not invent one. */}
            {milestone
              ? `Milestone ${milestone.number} of ${milestone.of} · ${milestone.title}`
              : next
                ? `Next up: ${next.name}`
                : 'Every technique on this one is done.'}
          </Text>
          {milestone && next && (
            <Text style={styles.sub} numberOfLines={1}>
              {/* Present tense and no imperative: this is what they said they
                  were doing, not what the app thinks they should do. */}
              Next up: {next.name}
            </Text>
          )}
          <Text style={styles.meta}>
            {curriculum.mastered_items} of {curriculum.countable_items} mastered
          </Text>
        </RNView>
        <RNView
          style={styles.track}
          accessible={false}
          // Decorative: the same numbers are in the label above, and a second
          // announcement of them is noise rather than context.
          importantForAccessibility="no-hide-descendants"
        >
          <RNView
            style={[
              styles.fill,
              {
                backgroundColor: accent.accent,
                width: `${
                  curriculum.countable_items === 0
                    ? 0
                    : Math.round((curriculum.mastered_items / curriculum.countable_items) * 100)
                }%`,
              },
            ]}
          />
        </RNView>
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
    gap: 8,
  },
  pressed: { opacity: 0.7 },
  main: { gap: 2 },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  title: { color: vola.text, fontSize: 15, fontWeight: '700', lineHeight: 20 },
  sub: { color: vola.textMuted, fontSize: 13 },
  meta: { color: vola.textMuted, fontSize: 12 },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: vola.line,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 2 },
});
