/**
 * The Fuel card on Today.
 *
 * Sits directly above `CheckinCard`: both ask for something rather than
 * reporting, and they belong together above the blocks that only report.
 *
 * A PURE RENDER — no fetching. Today owns the data, exactly as it does for the
 * check-in card, so this stays testable without a network.
 *
 * ## What it deliberately does not show
 *
 * Carbs, fat, fibre, water, a ring, weekday bars, a percentage, a chart,
 * per-meal anything, or a streak. `docs/decisions/today-view-design.md` §1: if
 * a number does not change what the athlete does today, it does not belong on
 * Today. Two numbers answer "what do I eat next"; the rest is a dashboard you
 * admire and do not act on.
 *
 * NO SELF-MARGINS — the same rule `CheckinCard` carries. Today's `body` spaces
 * its children with `gap`, and a component that insets itself is only ever
 * correct on the one screen it was written against.
 */

import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { MacroSplit } from '@/components/food/MacroSplit';
import { RemainingBlock } from '@/components/food/RemainingBlock';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { type EatenView, type Food, type TargetView } from '@/lib/nutrition';

export function NutritionCard({
  eaten,
  logged,
  view,
  quickAdd,
  onLog,
  onOpenDay,
  onQuickAdd,
  testID,
}: {
  /** Everything Today knows about what was eaten. See {@link EatenView}. */
  eaten: EatenView;
  /**
   * How many of the last seven days have anything logged, and out of how many.
   *
   * A COUNT, not a streak — `nutrition-design.md` §5 refuses streaks because a
   * missed day becomes a loss and a chain rewards logging a fake day to save
   * it. Null while the read has not answered, so it can say nothing rather
   * than say zero.
   */
  logged: { logged: number; considered: number } | null;
  /** Everything Today knows about the target. See {@link TargetView}. */
  view: TargetView;
  /** The three most-logged foods for the current slot. May be empty. */
  quickAdd: Food[];
  onLog: () => void;
  onOpenDay: () => void;
  onQuickAdd: (food: Food) => void;
  testID?: string;
}) {
  const accent = useAccent();

  return (
    <View style={styles.card} testID={testID ?? 'fuel-card'}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: accent.accent }]} />
        <Text style={[styles.eyebrow, { color: accent.ink }]}>FUEL</Text>
      </View>

      <RemainingBlock eaten={eaten} view={view} compact />

      <MacroSplit eaten={eaten} view={view} />

      {logged && (
        <Text style={styles.logged} testID="fuel-days-logged">
          {/* The denominator travels with the figure — N28's honesty rule —
              and it is also what keeps this readable as "you logged five days"
              rather than as a score you can lose. */}
          {logged.logged} of {logged.considered} days logged this week
        </Text>
      )}

      {quickAdd.length > 0 && (
        <View style={styles.quick}>
          {quickAdd.map((f) => (
            <Pressable
              key={f.id}
              onPress={() => onQuickAdd(f)}
              style={styles.chip}
              accessibilityRole="button"
              accessibilityLabel={`Log ${f.name}`}
              hitSlop={6}
              testID={`fuel-quick-${f.id}`}
            >
              <Icon name="plus" size={12} color={vola.textMuted} />
              <Text style={styles.chipText} numberOfLines={1}>
                {f.name}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.actions}>
        <Pressable
          onPress={onLog}
          style={[styles.primary, { backgroundColor: accent.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Log food"
          testID="fuel-log"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>Log food</Text>
        </Pressable>
        <Pressable
          onPress={onOpenDay}
          style={styles.secondary}
          accessibilityRole="button"
          accessibilityLabel="Open today's food"
          testID="fuel-open-day"
        >
          <Text style={styles.secondaryText}>Day</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  logged: { fontSize: 12, color: vola.textMuted, marginTop: 12 },
  // Radius 14 and padding 14/12, matching CheckinCard and themeCard — its
  // immediate neighbours on Today.
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.4, flex: 1 },
  quick: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    maxWidth: '48%',
  },
  chipText: { fontSize: 12, color: vola.textMuted, flexShrink: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  primary: {
    minHeight: 42,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontWeight: '700', fontSize: 14 },
  secondary: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
  },
  secondaryText: { fontSize: 13, color: vola.textMuted, fontWeight: '600' },
});
