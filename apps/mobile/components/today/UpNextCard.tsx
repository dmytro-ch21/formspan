import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { vola } from '@/constants/Colors';

/**
 * `UP NEXT` — the scheduled session, as one row.
 *
 * ## The BJJ mark is ours
 *
 * The reference draws a kimono glyph of its own. This uses the brand kit's
 * `bjj` icon through {@link sportIcon}, which is the same indirection every
 * other session surface uses — so a BJJ session here gets the identical mark
 * and colour it gets on a plan card, a `SessionCard` and the calendar. The
 * brand kit is the source of truth for identity; a second kimono would be a
 * second answer.
 *
 * The disc behind it is {@link sportTint}, a flat 13%-alpha wash of the sport
 * colour — **not a glow.** The reference blooms here and the user has twice
 * said they do not want it, so there is no `shadow*` or `elevation` in this
 * file.
 *
 * ## The hint line is load-bearing empty space
 *
 * **#447 puts the roadmap theme inside this card.** It is not built here and
 * must not be — but a card built tight to the reference would have to be
 * redesigned to accept it, which is exactly the trap. So {@link
 * UpNextCardProps.hint} exists now, renders nothing when absent, and sits in the
 * text column below the time where a theme line belongs. #447 becomes a prop
 * value rather than a layout change.
 */
export type UpNextCardProps = {
  sport: string;
  /** What the session is called — `BJJ Session` in the reference. */
  title: string;
  /** When it is — `Today • 7:00 PM`. */
  when: string;
  /**
   * One short line under the time. **#447's slot** — the roadmap theme and what
   * would move it. Absent renders nothing at all, not an empty row.
   */
  hint?: string | null;
  onLog: () => void;
  onOpen: () => void;
  logLabel?: string;
  /**
   * A day already gone, and nothing was logged for it — still a real button
   * (N457/#766): tapping it opens the same past-day-aware log flow as any
   * other card, backdated to the day being browsed, so a planned-but-missed
   * session can be logged from right here instead of only through the
   * floating "New log" picker.
   *
   * It was briefly made inert instead — dropping the handler entirely and
   * saying `pastLabel` as plain text — to fix two real accessibility bugs on
   * the plan card this replaced: a blanket `opacity` composited every ink
   * inside and took "Not logged" to 1.96:1 against its ground (fails AA), and
   * `disabled` folded into `accessibilityState`, so VoiceOver appended
   * "dimmed" to something already declared `text`. That fixed the symptom by
   * removing the feature. Both bugs are avoided here without going inert
   * again: `pastLabel` renders in `vola.warn`, a flat colour (no opacity
   * wash) that measures 9.99:1 on `vola.surface` — clear of AA with room —
   * and this component never sets `disabled` or `accessibilityState` on
   * either `Pressable`, on this path or any other, so VoiceOver has nothing
   * to fold "dimmed" onto.
   */
  past?: boolean;
  pastLabel?: string;
  accessibilityLabel?: string;
  testID?: string;
};

export function UpNextCard({
  sport,
  title,
  when,
  hint,
  onLog,
  onOpen,
  logLabel = 'Log',
  past = false,
  pastLabel = 'Not logged',
  accessibilityLabel,
  testID,
}: UpNextCardProps) {
  const tone = sportColor(sport) ?? vola.textMuted;
  const icon = sportIcon(sport);

  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={
        accessibilityLabel ?? `${title}, ${when}${hint ? `. ${hint}` : ''}`
      }
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      testID={testID}
    >
      {/* The sport's rule down the leading edge, flat fill. */}
      <RNView style={[styles.rule, { backgroundColor: tone }]} />

      <RNView style={[styles.disc, { backgroundColor: sportTint(tone) }]}>
        {icon ? <Icon name={icon} size={22} color={tone} /> : null}
      </RNView>

      <RNView style={styles.text}>
        <Text style={[styles.eyebrow, { color: tone }]}>UP NEXT</Text>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.when}>{when}</Text>
        {hint ? (
          <Text style={styles.hint} numberOfLines={2} testID="up-next-hint">
            {hint}
          </Text>
        ) : null}
      </RNView>

      {past ? (
        <>
          {/*
            The whole card is already the one active control here (`onOpen`
            above) — `onLog` is the same handler at every call site this
            component has, so a second nested Pressable would just be two
            hit targets doing one thing. The chevron is what used to sit
            beside the Log button; keeping it beside `pastLabel` is what
            tells a sighted athlete "Not logged" is now tappable rather than
            a plain status line.
          */}
          <Text style={styles.missed}>{pastLabel}</Text>
          <Icon name="chevron" size={16} color={vola.textDim} />
        </>
      ) : (
        <>
          <Pressable
            onPress={onLog}
            accessibilityRole="button"
            accessibilityLabel={`${logLabel} ${title}`}
            style={({ pressed }) => [styles.log, pressed && styles.logPressed]}
            testID="up-next-log"
          >
            <Text style={styles.logLabel}>{logLabel}</Text>
          </Pressable>
          <Icon name="chevron" size={16} color={vola.textDim} />
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    overflow: 'hidden',
    paddingLeft: 0,
    paddingRight: 12,
    paddingVertical: 14,
  },
  pressed: { backgroundColor: vola.surfaceHover },
  rule: { width: 3, alignSelf: 'stretch' },
  disc: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 9,
  },
  text: { flex: 1, gap: 1 },
  eyebrow: { fontSize: 10, letterSpacing: 1, fontWeight: '700' },
  title: { fontSize: 19, fontWeight: '700', color: vola.text },
  when: { fontSize: 12, color: vola.textMuted },
  hint: { fontSize: 12, color: vola.textDim, marginTop: 2 },
  log: {
    backgroundColor: vola.lime,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  logPressed: { opacity: 0.85 },
  logLabel: { fontSize: 14, fontWeight: '700', color: vola.bg },
  missed: { fontSize: 13, color: vola.warn },
});
