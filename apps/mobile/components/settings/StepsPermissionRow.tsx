import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { dayString } from '@/lib/calendar';
import {
  localStepsView,
  onStepsChanged,
  readStepsAsked,
  stepsSourceName,
  type StepSource,
  type StepsView,
} from '@/lib/steps';

/**
 * The deliberate ask for steps — N569 (#1130).
 *
 * **Why steps get their own row rather than riding the Health toggle above.**
 * That toggle's grant was given for workouts, heart rate and VO2max. Steps is a
 * new type, and a permission already granted does not cover it, so an existing
 * install has to be asked again. The Health read passes run on every foreground
 * return and would have shown the system sheet with nothing on screen saying
 * why, so they deliberately leave steps out until this row has been used. The
 * copy says what steps are for, where they come from, that they stay on the
 * phone, and that the platform will ask once.
 *
 * After asking, the row reports what the latest read found. On iOS a refusal
 * cannot be re-asked from inside the app (HealthKit never shows its sheet twice),
 * so the row says where the switch is instead of offering a button that would
 * do nothing.
 */
export function StepsPermissionRow({
  userId,
  source,
  onAsk,
}: {
  userId: string;
  source: StepSource;
  onAsk: () => Promise<void>;
}) {
  const accent = useAccent();
  const [asked, setAsked] = useState<boolean | null>(null);
  const [view, setView] = useState<StepsView | null>(null);
  const [busy, setBusy] = useState(false);

  // Reads land after focus, after a steps read elsewhere, and after the ask —
  // any of which can outlive the row if the athlete leaves Settings first.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const load = useCallback(() => {
    readStepsAsked(userId).then(
      (v) => {
        if (mounted.current) setAsked(v);
      },
      () => {},
    );
    localStepsView(userId, dayString(new Date())).then(
      (v) => {
        if (mounted.current) setView(v);
      },
      () => {},
    );
  }, [userId]);

  useFocusEffect(load);
  useEffect(() => onStepsChanged(load), [load]);

  const name = stepsSourceName(source);
  const canAskAgain = source === 'health_connect' && view?.state === 'refused';
  const showButton = asked === false || canAskAgain;

  return (
    <View style={styles.row} testID="settings-steps">
      <Text style={styles.label}>Steps</Text>
      <Text style={styles.hint} testID="settings-steps-hint">
        {hintFor(asked, view, source, name)}
      </Text>
      {showButton && (
        <PressableScale
          style={[styles.button, { backgroundColor: accent.accent }, busy && styles.busy]}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            onAsk()
              .catch(() => {})
              .finally(() => {
                setBusy(false);
                load();
              });
          }}
          accessibilityRole="button"
          accessibilityLabel={asked ? 'Ask for steps again' : 'Allow steps'}
          testID="settings-steps-allow"
        >
          {/* `accent.on`, not `vola.bg`: this label sits on the accent fill, and
              only `on` is contrast-checked against it (3.9:1 on purple otherwise). */}
          <Text style={[styles.buttonText, { color: accent.on }]}>{asked ? 'Ask again' : 'Allow steps'}</Text>
        </PressableScale>
      )}
    </View>
  );
}

function hintFor(asked: boolean | null, view: StepsView | null, source: StepSource, name: string): string {
  if (asked === null) return '';
  if (!asked) {
    return `Show today's step count on VOLA. VOLA reads it from ${name}, keeps it on this phone, and never writes anything back. Steps is a separate permission from workouts and heart rate, so ${name} will ask you once.`;
  }
  switch (view?.state) {
    case 'read':
      return `Reading steps from ${name}. Today's count shows on VOLA.`;
    case 'refused':
      return source === 'health_connect'
        ? `Health Connect isn't giving VOLA access to steps. Ask again, or allow Steps for VOLA in Health Connect.`
        : `Apple Health isn't sharing steps with VOLA. To change it, open the Settings app, then Privacy & Security, Health, VOLA, and turn on Steps.`;
    case 'no_data':
      return `Allowed, but ${name} has no step data yet. Steps show once your phone or a fitness app records them.`;
    default:
      return `Allowed. Today's count shows on VOLA after the next read.`;
  }
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.lineSoft,
  },
  label: { fontSize: 16, fontWeight: '600' },
  hint: { color: vola.textMuted, fontSize: 13 },
  button: {
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  busy: { opacity: 0.5 },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
