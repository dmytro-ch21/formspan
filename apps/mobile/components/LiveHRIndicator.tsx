import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { liveHRStatusLabel, zoneForBPM, type LiveHRState } from '@/lib/hrMonitor/heartRateProfile';
import { retryLiveHR } from '@/lib/hrMonitor/liveHR';
import { useLiveHR, useLiveHRFresh } from '@/lib/hrMonitor/useLiveHR';
// N534 moved the zone vocabulary to `lib/hrZones.ts` so the run library,
// the zone derivation and the live trainer could share one answer with the
// post-session report instead of four copies. Same function, new home.
import { zoneColor } from '@/lib/hrZones';

/**
 * N528/#958 — the live heart rate, wherever a session runs and on Today.
 *
 * Two sizes of one thing, so the number the athlete sees mid-set and the one
 * on Today are the same number in the same colour: `chip` sits under a
 * session screen's header (one line: beating heart, bpm, zone, status);
 * `card` is Today's module (big number, zone name, the monitor's name, and
 * what to do if the link dropped). Both render NOTHING when no monitor is
 * remembered or started (`status: 'off'`) and when the binary has no
 * Bluetooth — a session without a monitor is unchanged, per the ticket.
 *
 * The heart beats once per reading (a real pulse, not a loop), and the number
 * dims the moment readings stop arriving — `useLiveHRFresh` — so a frozen
 * value never reads as live. A drop is a sentence, never silence.
 */
export function LiveHRIndicator({
  variant = 'chip',
  hrMaxBPM = null,
  testID = 'live-hr',
}: {
  variant?: 'chip' | 'card';
  /** For the zone colour; null renders the number without a zone. */
  hrMaxBPM?: number | null;
  testID?: string;
}) {
  const state = useLiveHR();
  const fresh = useLiveHRFresh(state);
  // `useState`, not `useRef(...).current` — the same one-shot-construction
  // idiom `MacroRings`' `Ring` uses for its `Animated.Value`s, and the one
  // `react-hooks/refs` accepts.
  const [beat] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!state.at) return;
    Animated.sequence([
      Animated.timing(beat, { toValue: 1.28, duration: 90, useNativeDriver: true }),
      Animated.timing(beat, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [state.at, beat]);

  if (state.status === 'off' || state.status === 'unsupported') return null;

  const zone = state.bpm != null && fresh ? zoneForBPM(state.bpm, hrMaxBPM) : 0;
  const color = fresh && state.bpm != null ? (zone > 0 ? zoneColor(zone) : vola.text) : vola.textDim;
  const label = liveHRStatusLabel(state);
  const number = state.bpm != null ? String(state.bpm) : '—';

  if (variant === 'chip') {
    return (
      <RNView style={styles.chip} testID={testID} accessibilityRole="text" accessibilityLabel={liveA11y(state, fresh, zone)}>
        <Animated.View style={{ transform: [{ scale: beat }] }}>
          <Icon name="heart" size={14} color={color} />
        </Animated.View>
        <Text style={[styles.chipNumber, { color }]} testID={`${testID}-bpm`}>
          {number}
        </Text>
        <Text style={styles.chipUnit}>bpm</Text>
        {zone > 0 && (
          <Text style={[styles.chipZone, { color }]} testID={`${testID}-zone`}>
            Z{zone}
          </Text>
        )}
        <Text style={styles.chipStatus} numberOfLines={1} testID={`${testID}-status`}>
          {label}
        </Text>
        {state.status === 'disconnected' && <RetryButton testID={testID} />}
      </RNView>
    );
  }

  return (
    <RNView style={styles.card} testID={testID} accessibilityLabel={liveA11y(state, fresh, zone)}>
      <RNView style={styles.cardHeader}>
        <Text style={styles.cardTitle}>LIVE HEART RATE</Text>
        <Text style={styles.cardDevice} numberOfLines={1}>
          {state.device?.name ?? ''}
        </Text>
      </RNView>
      <RNView style={styles.cardBody}>
        <Animated.View style={{ transform: [{ scale: beat }] }}>
          <Icon name="heart" size={28} color={color} />
        </Animated.View>
        <Text style={[styles.cardNumber, { color }]} testID={`${testID}-bpm`}>
          {number}
        </Text>
        <RNView>
          <Text style={styles.cardUnit}>bpm</Text>
          {zone > 0 && (
            <Text style={[styles.cardZone, { color }]} testID={`${testID}-zone`}>
              zone {zone}
            </Text>
          )}
        </RNView>
      </RNView>
      {state.status !== 'connected' && (
        <RNView style={styles.cardFooter}>
          <Text style={styles.cardStatus} testID={`${testID}-status`}>
            {label}
          </Text>
          {state.status === 'disconnected' && <RetryButton testID={testID} />}
        </RNView>
      )}
    </RNView>
  );
}

function RetryButton({ testID }: { testID: string }) {
  return (
    <Pressable
      onPress={() => void retryLiveHR()}
      accessibilityRole="button"
      accessibilityLabel="Reconnect heart-rate monitor"
      hitSlop={8}
      style={styles.retry}
      testID={`${testID}-retry`}
    >
      <Text style={styles.retryText}>Reconnect</Text>
    </Pressable>
  );
}

function liveA11y(state: LiveHRState, fresh: boolean, zone: number): string {
  if (state.status === 'connected' && fresh && state.bpm != null) {
    return `Heart rate ${state.bpm} beats per minute${zone > 0 ? `, zone ${zone}` : ''}`;
  }
  return liveHRStatusLabel(state) || 'Heart-rate monitor';
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    maxWidth: '100%',
  },
  chipNumber: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  chipUnit: { fontSize: 11, color: vola.textDim },
  chipZone: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  chipStatus: { fontSize: 11, color: vola.textDim, flexShrink: 1, marginLeft: 4 },
  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 12, letterSpacing: 1.1, color: vola.text, fontWeight: '700' },
  cardDevice: { fontSize: 12, color: vola.textDim, flexShrink: 1 },
  cardBody: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardNumber: { fontSize: 44, fontWeight: '800', fontVariant: ['tabular-nums'], lineHeight: 48 },
  cardUnit: { fontSize: 13, color: vola.textDim },
  cardZone: { fontSize: 13, fontWeight: '700' },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardStatus: { fontSize: 12, color: vola.textDim, flexShrink: 1 },
  retry: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: vola.line },
  retryText: { fontSize: 12, fontWeight: '700', color: vola.text },
});
