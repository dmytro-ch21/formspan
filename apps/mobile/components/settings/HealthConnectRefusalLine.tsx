import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  onHealthConnectRefusalsChanged,
  readHealthConnectRefusals,
  refusalLineCopy,
  type ToggleRecordType,
} from '@/lib/healthConnectRefusals';

/**
 * N527 (#949) — which grant Health Connect refused on the last pass, under the
 * Health Connect toggle, with the way to fix it.
 *
 * Android only, and the check is here as well as at the call site: on iOS the
 * inner row never mounts, so nothing is rendered and nothing is read.
 * HealthKit cannot report a denied read, so there is no iOS version of this.
 *
 * Appears and disappears with no animation. It is a sentence that became true
 * or stopped being true, not an event.
 */
export function HealthConnectRefusalLine({ userId, onOpen }: { userId: string; onOpen: () => void }) {
  if (Platform.OS !== 'android') return null;
  return <RefusalLine userId={userId} onOpen={onOpen} />;
}

function RefusalLine({ userId, onOpen }: { userId: string; onOpen: () => void }) {
  const accent = useAccent();
  const [refused, setRefused] = useState<ToggleRecordType[]>([]);

  // A read can land after the athlete has left Settings.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const load = useCallback(() => {
    readHealthConnectRefusals(userId).then(
      (v) => {
        if (mounted.current) setRefused(v);
      },
      () => {},
    );
  }, [userId]);

  // On focus, and whenever a pass records a new answer — the pass that runs on
  // returning from Health Connect is what clears the line.
  useFocusEffect(load);
  useEffect(() => onHealthConnectRefusalsChanged(load), [load]);

  const copy = refusalLineCopy(refused);
  if (copy === null) return null;

  return (
    <View style={styles.row} testID="settings-health-connect-refused">
      <Text style={styles.hint} testID="settings-health-connect-refused-text">
        {copy}
      </Text>
      <PressableScale
        style={[styles.button, { backgroundColor: accent.accent }]}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel="Open Health Connect"
        testID="settings-health-connect-open"
      >
        {/* `accent.on`: the only text colour contrast-checked against the accent
            fill — same reasoning as StepsPermissionRow's button. */}
        <Text style={[styles.buttonText, { color: accent.on }]}>Open Health Connect</Text>
      </PressableScale>
    </View>
  );
}

// The Steps row's shape, so the two Health Connect lines under the toggle read
// as one group.
const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.lineSoft,
  },
  hint: { color: vola.textMuted, fontSize: 13 },
  button: {
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
