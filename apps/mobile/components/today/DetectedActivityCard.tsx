import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { vola } from '@/constants/Colors';
import { Radius, Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import {
  activityTypeLabel,
  sourceLabel,
  type DetectedActivitySource,
  type DetectedActivityType,
} from '@/lib/detectedActivity';
import { formatElapsed } from '@/lib/rest';
import { formatDistance } from '@/lib/units';
import type { UnitSystem } from '@/lib/units';
import { PRESS_OPACITY } from '@/constants/Motion';

/**
 * N479/#824 — a walk or hike the platform health store noticed that has no
 * matching VOLA session, on Today. The structural precedent named in the
 * ticket is `UpNextCard`'s `past`/`pastLabel` row (a card outside the
 * ordinary manual-log flow) — this borrows its layout (a coloured rule, a
 * tinted disc, a text column) but not its component, because the semantics
 * genuinely differ: `UpNextCard`'s past state is "you planned this and
 * missed it"; this is "you never planned this and VOLA only just heard
 * about it". Forcing the two into one component would mean a `past` prop
 * that means two different things depending on other props — worse than two
 * small components.
 *
 * **Two explicit buttons, not a tappable card**, unlike `UpNextCard`'s
 * whole-row `onOpen`. There is no review screen to open here — "Log it"
 * *commits* a real session outright (`lib/detectedActivity.ts`'s
 * `logDetectionAsSession`) — so a single large tap target would risk
 * creating data from an accidental touch, exactly the "must not silently
 * accumulate" ticket criterion pointed the other way. Two ordinary sibling
 * `Pressable`s, each independently reachable and independently labelled, is
 * also what keeps VoiceOver clean: the nested-Pressable nesting that made
 * Today's suggestion-dismiss glyph unreachable (see this screen's own
 * `today-suggestion-dismiss` fix) never arises when neither button is
 * inside the other.
 */
export type DetectedActivityCardProps = {
  type: DetectedActivityType;
  source: DetectedActivitySource;
  durationSeconds: number;
  distanceMeters: number | null;
  units: UnitSystem;
  onLog: () => void;
  onDismiss: () => void;
  testID?: string;
};

export function DetectedActivityCard({
  type,
  source,
  durationSeconds,
  distanceMeters,
  units,
  onLog,
  onDismiss,
  testID,
}: DetectedActivityCardProps) {
  // Running is the closest thing this app has to a distance-based module —
  // see `logDetectionAsSession`'s own doc comment for why a detected walk or
  // hike is logged under that sport. Borrowing its colour/glyph here too
  // means the card and the session it creates read as the same kind of
  // thing, without this file needing a walking-specific entry in the brand
  // kit for a card that exists to be dismissed as often as it is kept.
  const tone = sportColor('running') ?? vola.textMuted;
  const icon = sportIcon('running');
  const title = activityTypeLabel(type);
  const meta = [
    formatElapsed(durationSeconds),
    ...(distanceMeters != null ? [formatDistance(distanceMeters, units)] : []),
    sourceLabel(source),
  ].join(' • ');

  return (
    <RNView style={styles.card} testID={testID}>
      <RNView style={[styles.rule, { backgroundColor: tone }]} />
      <RNView style={[styles.disc, { backgroundColor: sportTint(tone) }]}>
        {icon ? <Icon name={icon} size={22} color={tone} /> : null}
      </RNView>
      <RNView style={styles.text}>
        <Text style={[styles.eyebrow, { color: tone }]}>DETECTED</Text>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.meta}>{meta}</Text>
      </RNView>
      <RNView style={styles.actions}>
        <Pressable
          onPress={onLog}
          accessibilityRole="button"
          accessibilityLabel={`Log this ${title.toLowerCase()} as a session. ${meta}.`}
          style={({ pressed }) => [styles.log, pressed && styles.logPressed]}
          testID={testID ? `${testID}-log` : undefined}
        >
          <Text style={styles.logLabel}>Log</Text>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Dismiss this ${title.toLowerCase()}`}
          accessibilityHint="Won't ask about this activity again"
          style={({ pressed }) => [styles.dismiss, pressed && styles.dismissPressed]}
          testID={testID ? `${testID}-dismiss` : undefined}
        >
          <Icon name="close" size={15} color={vola.textMuted} />
        </Pressable>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: Radius.card,
    overflow: 'hidden',
    paddingLeft: 0,
    paddingRight: Spacing.md,
    paddingVertical: Spacing.cardPadding,
  },
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
  eyebrow: { ...Typography.eyebrow },
  title: { ...Typography.title, color: vola.text, fontWeight: '700' },
  meta: { ...Typography.caption, color: vola.textMuted, fontWeight: '400' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.smPlus },
  log: {
    backgroundColor: vola.lime,
    borderRadius: 10,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.smPlus,
  },
  logPressed: { opacity: PRESS_OPACITY },
  logLabel: { ...Typography.body, color: vola.bg, fontWeight: '700' },
  dismiss: { padding: Spacing.xs },
  dismissPressed: { opacity: PRESS_OPACITY },
});
