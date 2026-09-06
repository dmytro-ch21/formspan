import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { clampTimeOfDay, formatPlanTime, TIME_OF_DAY_PRESETS } from '@/lib/planTime';

/**
 * "What time, roughly?" — N126/#520's mobile entry point for
 * `PlannedSession.timeOfDayMinutes`.
 *
 * One step after {@link PickSessionSheet} in the Plan tab's add flow: a
 * discipline (and optional template) is already chosen by the time this
 * opens, and this asks the one remaining optional fact. **Optional means
 * skippable in one tap** — "No specific time" is the first, most reachable
 * row, not a buried default, because most plans made in a hurry will not
 * carry a time and that must stay the fast path.
 *
 * **Presets write the SAME field a precise time would.** Morning/Midday/
 * Evening are convenience taps onto 07:00/12:00/18:00 — there is no separate
 * slot concept anywhere downstream, so a caller reading `timeOfDayMinutes`
 * cannot tell a preset tap from a dialed-in one, and never needs to.
 *
 * **The custom stepper is +/- buttons, not a spinner or a typed field.**
 * This sheet opens one-handed, mid-plan, the same as every other control in
 * `WeekPlanner` — a native wheel picker needs a dependency this app does not
 * carry (`@react-native-community/datetimepicker`), and a typed "19:00" field
 * invites exactly the kind of malformed input a tap-only control cannot
 * produce. Large targets, five-minute steps: precise enough for a training
 * plan, never fussy enough to need a keyboard.
 */
export function PlanTimeSheet({
  visible,
  title,
  initialMinutes,
  onPick,
  onClose,
}: {
  visible: boolean;
  /** e.g. "What time is Push Day?" */
  title: string;
  /** Pre-fills the custom stepper when editing an already-timed plan. */
  initialMinutes: number | null;
  /** `null` means "no specific time" — the skip/clear action. */
  onPick: (minutes: number | null) => void;
  onClose: () => void;
}) {
  const accent = useAccent();
  const start = initialMinutes ?? 9 * 60;
  const [hour24, setHour24] = useState(Math.floor(start / 60));
  const [minute, setMinute] = useState(Math.round((start % 60) / 5) * 5);

  const custom = clampTimeOfDay(hour24, minute);
  const period = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  function step(field: 'hour' | 'minute', delta: number) {
    if (field === 'hour') setHour24((h) => (h + delta + 24) % 24);
    else setMinute((m) => (m + delta + 60) % 60);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} lightColor={vola.bg} darkColor={vola.bg}>
        <RNView style={styles.head}>
          <Text style={styles.title}>{title}</Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="plan-time-close"
          >
            <Text style={[styles.close, { color: accent.ink }]}>Cancel</Text>
          </Pressable>
        </RNView>

        <RNView style={styles.body}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => onPick(null)}
            accessibilityRole="button"
            accessibilityLabel="No specific time"
            testID="plan-time-none"
          >
            <Text style={styles.rowTitle}>No specific time</Text>
          </Pressable>

          <Text style={styles.groupLabel}>QUICK PICK</Text>
          <RNView style={styles.presetRow}>
            {TIME_OF_DAY_PRESETS.map((p) => (
              <Pressable
                key={p.label}
                style={({ pressed }) => [
                  styles.preset,
                  { borderColor: accent.accent },
                  pressed && styles.rowPressed,
                ]}
                onPress={() => onPick(p.minutes)}
                accessibilityRole="button"
                accessibilityLabel={`${p.label}, ${formatPlanTime(p.minutes)}`}
                testID={`plan-time-preset-${p.label.toLowerCase()}`}
              >
                <Text style={[styles.presetLabel, { color: accent.ink }]}>{p.label}</Text>
                <Text style={styles.presetTime}>{formatPlanTime(p.minutes)}</Text>
              </Pressable>
            ))}
          </RNView>

          <Text style={styles.groupLabel}>OR SET ONE</Text>
          <RNView style={styles.stepperCard}>
            <RNView style={styles.stepperRow}>
              <Stepper
                label="Hour"
                value={String(hour12)}
                onDown={() => step('hour', -1)}
                onUp={() => step('hour', 1)}
                testIDBase="plan-time-hour"
              />
              <Stepper
                label="Minute"
                value={String(minute).padStart(2, '0')}
                onDown={() => step('minute', -5)}
                onUp={() => step('minute', 5)}
                testIDBase="plan-time-minute"
              />
              <RNView style={styles.periodBox}>
                <Text style={styles.stepperLabel}>{' '}</Text>
                <Text style={styles.periodText}>{period}</Text>
              </RNView>
            </RNView>

            <Pressable
              style={[styles.setButton, { backgroundColor: accent.accent }]}
              onPress={() => onPick(custom)}
              accessibilityRole="button"
              accessibilityLabel={`Set ${formatPlanTime(custom)}`}
              testID="plan-time-set"
            >
              <Text style={styles.setButtonText}>Set {formatPlanTime(custom)}</Text>
            </Pressable>
          </RNView>
        </RNView>
      </View>
    </Modal>
  );
}

function Stepper({
  label,
  value,
  onDown,
  onUp,
  testIDBase,
}: {
  label: string;
  value: string;
  onDown: () => void;
  onUp: () => void;
  testIDBase: string;
}) {
  return (
    <RNView style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <RNView style={styles.stepperControls}>
        <Pressable
          onPress={onDown}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${label.toLowerCase()}`}
          testID={`${testIDBase}-down`}
          style={styles.stepperButton}
        >
          <Text style={styles.stepperButtonText}>−</Text>
        </Pressable>
        <Text style={styles.stepperValue} testID={`${testIDBase}-value`}>
          {value}
        </Text>
        <Pressable
          onPress={onUp}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Increase ${label.toLowerCase()}`}
          testID={`${testIDBase}-up`}
          style={styles.stepperButton}
        >
          <Text style={styles.stepperButtonText}>+</Text>
        </Pressable>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', flexShrink: 1, paddingRight: 12 },
  close: { fontWeight: '700', fontSize: 15 },
  body: { paddingHorizontal: 20, paddingBottom: 32, gap: 14 },
  groupLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: vola.textDim,
    marginTop: 6,
  },
  row: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  rowPressed: { backgroundColor: vola.surfaceHover },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  presetRow: { flexDirection: 'row', gap: 8 },
  preset: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    gap: 2,
  },
  presetLabel: { fontSize: 13, fontWeight: '700' },
  presetTime: { fontSize: 12, color: vola.textDim },
  stepperCard: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    padding: 16,
    gap: 16,
  },
  stepperRow: { flexDirection: 'row', gap: 14, justifyContent: 'center' },
  stepper: { alignItems: 'center', gap: 6 },
  stepperLabel: { fontSize: 11, color: vola.textDim, fontWeight: '700', letterSpacing: 0.6 },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepperButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: { fontSize: 18, fontWeight: '700' },
  stepperValue: { fontSize: 20, fontWeight: '800', minWidth: 34, textAlign: 'center' },
  periodBox: { alignItems: 'center', gap: 6, justifyContent: 'flex-end' },
  periodText: { fontSize: 15, fontWeight: '800', paddingBottom: 8 },
  setButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  setButtonText: { fontSize: 15, fontWeight: '800', color: vola.bg },
});
