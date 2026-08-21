import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { MacroRings } from '@/components/today/MacroRings';
import { macroColors, monoMacroRing, vola, isMono } from '@/constants/Colors';
import { readRings, RING_SHORT, type RingKey } from '@/lib/macroRings';
import {
  viewTarget,
  viewTotals,
  type EatenView,
  type Food,
  type TargetView,
} from '@/lib/nutrition';

/**
 * `TODAY'S MOMENTUM` — the nutrition centrepiece.
 *
 * **Pure render. It fetches nothing** — Today owns the data, exactly as
 * `NutritionCard` does, and for the same reason: two components on one screen
 * fetching the same derivation is a bug this codebase has already had.
 *
 * ## Every absence is a different sentence
 *
 * `EatenView` and `TargetView` each carry their states for a reason recorded at
 * length in `lib/nutrition.ts`: an empty list means "still loading", "we could
 * not read it" and "you have genuinely eaten nothing", and rendering all three
 * as `0` is a claim that somebody ate nothing. This card keeps that
 * distinction all the way to the pixels — **no zero is ever shown as an
 * achievement**, and a missing target draws an empty ring track rather than a
 * ring at zero.
 *
 * ## `Over target` states a fact
 *
 * It is a neutral pill in the macro's own colour, never `danger`, and the copy
 * says what happened rather than judging it. `MacroSplit` and `RemainingBlock`
 * both already record this rule ("one day over is not an error state"); this is
 * the third surface to obey it.
 */
export type MomentumCardProps = {
  eaten: EatenView;
  view: TargetView;
  rings: readonly RingKey[];
  /**
   * The week's logged-day count, or null when it could not be read.
   *
   * **A count, not a chain** — N53's ruling, carried over from `NutritionCard`
   * verbatim. Absent entirely when null: `0 of 7` from a failed read is the
   * confident discouraging zero the whole `EatenView`/`TargetView` apparatus
   * exists to prevent.
   */
  logged: { logged: number; considered: number } | null;
  /**
   * Two-tap quick add, ranked for the current meal slot.
   *
   * **Carried over from `NutritionCard` rather than dropped.** The reference
   * does not show these chips, which is not the same as the reference removing
   * them — this card replaced that one in place, and quietly losing a shipped
   * feature because a mockup omitted it is not a design decision anybody made.
   */
  quickAdd: Food[];
  onLog: () => void;
  onQuickAdd: (food: Food) => void;
  onOpenDay: () => void;
  onConfigureRings: () => void;
  testID?: string;
};

export function MomentumCard({
  eaten,
  view,
  rings,
  logged,
  quickAdd,
  onLog,
  onQuickAdd,
  onOpenDay,
  onConfigureRings,
  testID,
}: MomentumCardProps) {
  const totals = viewTotals(eaten);
  const target = viewTarget(view);
  const readings = readRings(rings, totals, target);

  const kcal = readings.find((r) => r.key === 'kcal');
  const macroRows = readings.filter((r) => r.key !== 'kcal');

  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.title}>TODAY’S MOMENTUM</Text>
      <StatePill eaten={eaten} view={view} />

      <RNView style={styles.body}>
        <MacroRings readings={readings} testID="today-macro-rings">
          <Centre eaten={eaten} view={view} />
        </MacroRings>

        <RNView style={styles.rows}>
          {macroRows.length > 0 ? (
            macroRows.map((r) => <MacroRow key={r.key} reading={r} />)
          ) : (
            // Configuring every macro ring off is allowed; claiming there are
            // no macros is not.
            <Text style={styles.absent}>No macro rings turned on.</Text>
          )}
        </RNView>
      </RNView>

      {/* N28's denominator rule: the count is meaningless without the span it
          was taken over, so the two are one sentence or neither is shown. */}
      {logged ? (
        <Text style={styles.logged} testID="today-momentum-logged">
          {logged.logged} of {logged.considered} days logged this week
        </Text>
      ) : null}

      {quickAdd.length > 0 ? (
        <RNView style={styles.chips}>
          {quickAdd.slice(0, 3).map((f) => (
            <Pressable
              key={f.id}
              onPress={() => onQuickAdd(f)}
              accessibilityRole="button"
              accessibilityLabel={`Log ${f.name}`}
              style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
              testID={`today-quick-${f.id}`}
            >
              <Icon name="plus" size={11} color={vola.textMuted} />
              <Text style={styles.chipLabel} numberOfLines={1}>
                {f.name}
              </Text>
            </Pressable>
          ))}
        </RNView>
      ) : null}

      <Pressable
        onPress={onLog}
        accessibilityRole="button"
        accessibilityLabel="Log food"
        style={({ pressed }) => [styles.primary, pressed && styles.chipPressed]}
        testID="today-log-food"
      >
        <Text style={styles.primaryLabel}>Log food</Text>
      </Pressable>

      <Pressable
        onPress={onConfigureRings}
        accessibilityRole="button"
        accessibilityLabel="Macros target — choose what the rings track"
        style={styles.configure}
        testID="today-macros-target"
      >
        <Text style={styles.configureLabel}>Macros target</Text>
        <Icon name="settings" size={14} color={vola.textMuted} />
      </Pressable>

      {/* Kept separate from the ring configuration: one opens the day, the
          other changes what is drawn. The reference shows only the latter. */}
      <Pressable
        onPress={onOpenDay}
        accessibilityRole="button"
        accessibilityLabel="Open today's food log"
        style={styles.openDay}
        testID="today-open-food"
      >
        <Text style={styles.openDayLabel}>
          {kcal && kcal.percent !== null ? "See today's food" : 'Open food'}
        </Text>
        <Icon name="chevron" size={14} color={vola.textMuted} />
      </Pressable>
    </View>
  );
}

/**
 * The pill under the title.
 *
 * It reports **calories against the day's target and nothing else** — the macro
 * rows carry their own verdicts, and a pill that silently aggregated four
 * readings into one word would be the "one true number" problem N53 solved in
 * the other direction.
 *
 * There is no pill at all when there is nothing to compare against. A default
 * of `On track` with no target set would be an achievement claimed from an
 * absence, which is the failure this screen is most exposed to.
 */
function StatePill({ eaten, view }: { eaten: EatenView; view: TargetView }) {
  const totals = viewTotals(eaten);
  const target = viewTarget(view);
  if (!totals || !target || target.kcal <= 0) return null;

  const over = totals.kcal > target.kcal;
  return (
    <RNView style={styles.pill} testID="today-momentum-state">
      <RNView style={[styles.pillDot, { backgroundColor: over ? vola.textMuted : vola.lime }]} />
      <Text style={styles.pillLabel}>{over ? 'Over target' : 'On track'}</Text>
    </RNView>
  );
}

/** The number in the middle of the rings. */
function Centre({ eaten, view }: { eaten: EatenView; view: TargetView }) {
  const totals = viewTotals(eaten);
  const target = viewTarget(view);

  // Order matters: the eaten read is the one that can fail, and "we could not
  // read your day" outranks "no target set" because it is the more surprising
  // of the two and the one the athlete can do nothing about.
  if (eaten.state === 'loading' || view.state === 'checking') {
    return <Text style={styles.centreAbsent}>Checking…</Text>;
  }
  if (eaten.state === 'unavailable') {
    return <Text style={styles.centreAbsent}>Day unread</Text>;
  }
  if (!target || target.kcal <= 0) {
    return (
      <>
        <Text style={styles.centreBig}>{fmt(totals?.kcal ?? 0)}</Text>
        <Text style={styles.centreUnit}>kcal eaten</Text>
        <Text style={styles.centreMeta}>No target set</Text>
        <Entries eaten={eaten} />
      </>
    );
  }

  const left = target.kcal - (totals?.kcal ?? 0);
  return (
    <>
      <Text style={styles.centreBig}>{fmt(Math.abs(Math.round(left)))}</Text>
      {/* "over" rather than a negative number: a minus sign in a big figure
          reads as an error, and the word is what an athlete would say. */}
      <Text style={styles.centreUnit}>{left >= 0 ? 'kcal left' : 'kcal over'}</Text>
      <Text style={styles.centreMeta}>
        {fmt(Math.round(totals?.kcal ?? 0))} / {fmt(target.kcal)} kcal
      </Text>
      <Entries eaten={eaten} />
    </>
  );
}

/**
 * The entry count.
 *
 * N28's denominator rule in its smallest form: the total above is only as good
 * as the number of things it was added up from, so the two are rendered
 * together. Absent entirely when the day could not be read — a count of zero
 * there would be a claim.
 */
function Entries({ eaten }: { eaten: EatenView }) {
  if (eaten.state !== 'ready') return null;
  const n = eaten.rows.length;
  return (
    <RNView style={styles.entries}>
      <Icon name="food" size={11} color={vola.textDim} />
      <Text style={styles.entriesLabel}>
        {n === 0 ? 'nothing logged yet' : `${n} ${n === 1 ? 'entry' : 'entries'}`}
      </Text>
    </RNView>
  );
}

function MacroRow({ reading }: { reading: ReturnType<typeof readRings>[number] }) {
  const colour = isMono ? monoMacroRing : macroColors[reading.key];
  const pct = reading.percent;
  const over = pct !== null && pct > 100;

  return (
    <RNView style={styles.row} testID={`today-macro-${reading.key}`}>
      <RNView style={styles.rowHead}>
        <RNView style={[styles.dot, { backgroundColor: colour }]} />
        <Text style={styles.rowLabel}>{RING_SHORT[reading.key].toUpperCase()}</Text>
      </RNView>

      <RNView style={styles.rowFigures}>
        <Text style={styles.rowValue}>
          {Math.round(reading.eaten)}
          {/* The denominator only appears when there is one. `MacroSplit`
              already refuses to invent it and so does this. */}
          {reading.goal !== null ? (
            <Text style={styles.rowGoal}> / {Math.round(reading.goal)}g</Text>
          ) : (
            <Text style={styles.rowGoal}>g</Text>
          )}
        </Text>
        <Text style={[styles.rowPct, { color: pct === null ? vola.textDim : colour }]}>
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </Text>
      </RNView>

      <RNView style={styles.track}>
        {pct !== null ? (
          <RNView
            style={[
              styles.fill,
              { backgroundColor: colour, width: `${Math.min(pct, 100)}%` },
            ]}
          />
        ) : null}
      </RNView>

      {over ? (
        <RNView style={styles.overWrap}>
          <RNView style={[styles.overPill, { borderColor: colour }]}>
            {/*
              A fact, in the macro's own colour — not `danger`, not red, and not
              a sentence about the athlete. The number above already says 144%;
              this only names what that means.
            */}
            <Text style={[styles.overLabel, { color: colour }]}>Over target</Text>
          </RNView>
        </RNView>
      ) : null}
    </RNView>
  );
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

const styles = StyleSheet.create({
  // No self-margins: Today's `body` spaces its children with `gap`.
  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  title: { fontSize: 12, letterSpacing: 1.1, color: vola.text, fontWeight: '700' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillLabel: { fontSize: 12, color: vola.textMuted },

  body: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rows: { flex: 1, gap: 12 },
  absent: { fontSize: 13, color: vola.textDim },

  centreBig: {
    fontSize: 38,
    fontWeight: '800',
    color: vola.text,
    fontVariant: ['tabular-nums'],
    lineHeight: 42,
  },
  centreUnit: { fontSize: 12, color: vola.textMuted },
  centreMeta: {
    fontSize: 11,
    color: vola.textDim,
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
  centreAbsent: { fontSize: 14, color: vola.textDim },
  entries: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  entriesLabel: { fontSize: 11, color: vola.textDim },

  row: { gap: 3 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  rowLabel: { fontSize: 10, letterSpacing: 0.8, color: vola.textMuted, fontWeight: '600' },
  rowFigures: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  rowValue: {
    fontSize: 19,
    fontWeight: '700',
    color: vola.text,
    fontVariant: ['tabular-nums'],
  },
  rowGoal: { fontSize: 13, fontWeight: '500', color: vola.textDim },
  rowPct: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  track: { height: 3, borderRadius: 2, backgroundColor: vola.surfaceRaised, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2 },
  overWrap: { alignItems: 'flex-end' },
  overPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  overLabel: { fontSize: 10, fontWeight: '600' },

  logged: { fontSize: 11, color: vola.textDim },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 150,
  },
  chipPressed: { opacity: 0.8 },
  chipLabel: { fontSize: 12, color: vola.textMuted },
  primary: {
    backgroundColor: vola.lime,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  primaryLabel: { fontSize: 14, fontWeight: '700', color: vola.bg },
  configure: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  configureLabel: { fontSize: 12, color: vola.textMuted },
  openDay: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  openDayLabel: { fontSize: 12, color: vola.textMuted },
});
