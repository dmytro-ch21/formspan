import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { Card } from '@/constants/Card';
import { vola } from '@/constants/Colors';
import { Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';

/**
 * `LOGGED` — one session the day being shown already has, as one row.
 *
 * **N548.** Today is where the logging happened and the athlete's own
 * complaint was that reviewing it meant leaving: Progress, find the week, open
 * it there. This row is the whole fix — it opens the session's own screen
 * (`sessionHref`, so strength/BJJ/running each land where they already live),
 * and it is deliberately not a new report surface.
 *
 * ## It is the `UpNextCard` shape, mirrored, and that is on purpose
 *
 * Same rule down the leading edge, same tinted disc with the sport's own
 * glyph, same text column, same chevron. The two cards are the two halves of
 * one sentence — what is coming, and what is done — and an athlete should not
 * have to learn a second vocabulary to read the second half. What differs is
 * the whole point of the difference:
 *
 * - **No filled button.** `UpNextCard` carries a lime `Log`; this carries
 *   nothing but the chevron. Today allows exactly one filled control, and it
 *   belongs to the thing you have not done yet. A row about the past that
 *   competed with it for the same glance would be miscalibrated.
 * - **The eyebrow names the SPORT**, not the section. The section header
 *   already says `LOGGED`; repeating it on every row spends the one line that
 *   answers "which sport is this" — the ticket's own second criterion, which
 *   has to be answerable without opening the row.
 *
 * Flat, per N444: no `shadow*` and no `elevation` anywhere in this file.
 * Tokens throughout (`Card.base`, `Spacing`, `Typography`) rather than the
 * literals its siblings still carry — same numbers, named.
 *
 * ## An in-progress row says so instead of showing a duration
 *
 * A session with no `ended_at` has no duration to state, and stating `0 min`
 * would be a fabricated zero. It gets `In progress` in `vola.warn` — a flat
 * colour, no opacity wash, for the contrast reason `UpNextCard`'s `pastLabel`
 * note sets out at length. Note the COMMON in-progress session is not drawn by
 * this card at all: while it is the screen's lead, the resume card above owns
 * it and `buildTodayBoard` filters it out of `logged`. This branch is for the
 * second open session, which is reachable and would otherwise vanish.
 */
export type LoggedCardProps = {
  sport: string;
  /** The discipline's own name, from the module registry — `BJJ`, `Strength`. */
  sportLabel: string;
  /** What the session is called; the caller falls back to the discipline. */
  title: string;
  /**
   * The measures, already formatted and in reading order — see
   * `lib/sessionSummary.ts`'s `sessionMeta`. An empty list renders no meta
   * line at all rather than an empty one.
   */
  meta: string[];
  /** No `ended_at`. Replaces the meta line's leading duration with a state. */
  inProgress?: boolean;
  onOpen: () => void;
  /**
   * Overrides the composed default. Callers that know something this card does
   * not — which day is being browsed, say — pass their own.
   */
  accessibilityLabel?: string;
  testID?: string;
};

export function LoggedCard({
  sport,
  sportLabel,
  title,
  meta,
  inProgress = false,
  onOpen,
  accessibilityLabel,
  testID,
}: LoggedCardProps) {
  const tone = sportColor(sport) ?? vola.textMuted;
  const icon = sportIcon(sport);
  const line = meta.join(' · ');

  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      // Leads with the card's OWN visible title — WCAG 2.5.3, the same rule
      // the plan card, the suggestion and the Tier 0 offer on this screen were
      // each corrected to follow. "Tap Legs" has to match.
      accessibilityLabel={
        accessibilityLabel ??
        `${title}, ${sportLabel}${inProgress ? ', in progress' : ''}${
          line ? `, ${meta.join(', ')}` : ''
        }. Open the session.`
      }
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      testID={testID}
    >
      <RNView style={[styles.rule, { backgroundColor: tone }]} />

      <RNView style={[styles.disc, { backgroundColor: sportTint(tone) }]}>
        {icon ? <Icon name={icon} size={18} color={tone} /> : null}
      </RNView>

      <RNView style={styles.text}>
        <Text style={[styles.eyebrow, { color: tone }]}>{sportLabel.toUpperCase()}</Text>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {inProgress ? (
          <Text style={styles.running}>In progress</Text>
        ) : line ? (
          <Text style={styles.meta} numberOfLines={1}>
            {line}
          </Text>
        ) : null}
      </RNView>

      <Icon name="chevron" size={16} color={vola.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    ...Card.base,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.smPlus,
    overflow: 'hidden',
    paddingLeft: 0,
    paddingRight: Spacing.md,
    paddingVertical: Spacing.smPlus,
  },
  pressed: { backgroundColor: vola.surfaceHover },
  rule: { width: 3, alignSelf: 'stretch' },
  disc: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: Spacing.sm,
  },
  text: { flex: 1, gap: 1 },
  eyebrow: { ...Typography.eyebrow, fontSize: 10, letterSpacing: 1 },
  title: { ...Typography.emphasis, color: vola.text, fontWeight: '700' },
  meta: { ...Typography.caption, color: vola.textMuted, fontWeight: '400' },
  running: { ...Typography.caption, color: vola.warn, fontWeight: '600' },
});
