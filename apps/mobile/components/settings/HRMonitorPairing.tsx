import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { liveHRStatusLabel } from '@/lib/hrMonitor/heartRateProfile';
import { forgetMonitor, readRememberedMonitor, rememberMonitor, type RememberedMonitor } from '@/lib/hrMonitor/hrMonitorStore';
import { ensureBluetoothPermissions, isBluetoothSupported, scanForMonitors, stopLiveHR, type FoundMonitor } from '@/lib/hrMonitor/liveHR';
import { connectIfRemembered } from '@/lib/hrMonitor/orchestrator';
import { useLiveHR } from '@/lib/hrMonitor/useLiveHR';

/**
 * N528/#958 — Settings → Integrations → "Heart-rate monitor": scan, pick,
 * remember, forget. One remembered monitor per phone; connecting happens on
 * its own from then on (`lib/hrMonitor/orchestrator.ts`). Copy names the
 * Amazfit step because that is the watch that produced the ticket, and it
 * is the one whose broadcasting is off by default.
 */
export function HRMonitorPairing({ userId, testID = 'settings-hr-monitor' }: { userId: string | null | undefined; testID?: string }) {
  const live = useLiveHR();
  const [remembered, setRemembered] = useState<RememberedMonitor | null | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<FoundMonitor[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const stopScan = useRef<(() => void) | null>(null);
  /**
   * W21/#992 — did THIS screen open the link?
   *
   * Pairing connects once so the athlete sees the strap actually reporting
   * rather than discovering mid-run that broadcasting was never switched on.
   * That verification link has to be released again, and until review caught
   * it nothing did: the orchestrator used to drop the link on app background,
   * W21 removed that (a locked screen mid-run raises 'background' too), and
   * this screen never had a counterpart teardown of its own. Pairing a strap
   * and pocketing the phone therefore held the connection open indefinitely
   * — both batteries paying for a monitor nobody was reading, which is the
   * exact thing the athlete asked for the opposite of.
   *
   * Only what this screen opened is released, so a run started from another
   * tab while Settings is still mounted underneath keeps the link it owns.
   */
  const openedHere = useRef(false);
  const supported = isBluetoothSupported();

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    readRememberedMonitor(userId)
      .then((m) => {
        if (alive) setRemembered(m);
      })
      .catch(() => {
        if (alive) setRemembered(null);
      });
    return () => {
      alive = false;
      stopScan.current?.();
      if (openedHere.current) {
        openedHere.current = false;
        void stopLiveHR();
      }
    };
  }, [userId]);

  const scan = useCallback(async () => {
    if (!userId || scanning) return;
    setNote(null);
    setFound([]);
    if (!(await ensureBluetoothPermissions())) {
      setNote(
        Platform.OS === 'android'
          ? 'Bluetooth permission was declined. Allow "Nearby devices" for VOLA in Android settings, then scan again.'
          : 'Bluetooth access was declined. Allow it for VOLA in iOS Settings, then scan again.',
      );
      return;
    }
    setScanning(true);
    const s = scanForMonitors((d) => setFound((prev) => (prev.some((p) => p.id === d.id) ? prev : [...prev, d])));
    stopScan.current = s.stop;
    await s.done;
    stopScan.current = null;
    setScanning(false);
    setFound((prev) => {
      if (prev.length === 0) {
        setNote(
          'No heart-rate monitor found. On an Amazfit, open Zepp → your watch → Heart rate broadcasting and turn it on, then start a workout on the watch; Garmin and Polar have a similar "broadcast heart rate" setting. Chest straps broadcast on their own.',
        );
      }
      return prev;
    });
  }, [userId, scanning]);

  const pick = useCallback(
    async (d: FoundMonitor) => {
      if (!userId) return;
      stopScan.current?.();
      const m = await rememberMonitor(userId, d);
      setRemembered(m);
      setFound([]);
      setNote(null);
      openedHere.current = true;
      void connectIfRemembered();
    },
    [userId],
  );

  const forget = useCallback(async () => {
    if (!userId) return;
    await forgetMonitor(userId);
    setRemembered(null);
    setNote(null);
    // With nothing remembered, `connectIfRemembered` drops the link — so it
    // is already released and unmount has nothing left to do.
    openedHere.current = false;
    void connectIfRemembered();
  }, [userId]);

  if (!supported) {
    return (
      <RNView style={styles.block} testID={testID}>
        <Text style={styles.label}>Heart-rate monitor</Text>
        <Text style={styles.muted}>Bluetooth isn&apos;t available in this build.</Text>
      </RNView>
    );
  }

  return (
    <RNView style={styles.block} testID={testID}>
      <Text style={styles.label}>Heart-rate monitor</Text>
      <Text style={styles.muted}>
        Heart rate straight from your watch or chest strap over Bluetooth during a run — including while your screen
        is locked, and with no waiting for Apple Health or Health Connect to sync. VOLA connects when a run starts and
        disconnects when it ends — and once here when you pair one, to check it is broadcasting. Apple Health / Health
        Connect still fill in any gaps.
      </Text>

      {remembered === undefined ? (
        <ActivityIndicator accessibilityLabel="Loading" style={styles.spinner} />
      ) : remembered ? (
        <RNView style={styles.device} testID={`${testID}-remembered`}>
          <Icon name="heart" size={16} color={live.status === 'connected' ? vola.green : vola.textDim} />
          <RNView style={styles.deviceBody}>
            <Text style={styles.deviceName}>{remembered.name}</Text>
            <Text style={styles.muted} testID={`${testID}-status`}>
              {live.status === 'off' ? 'Not connected' : liveHRStatusLabel(live)}
            </Text>
          </RNView>
          <Pressable onPress={() => void forget()} accessibilityRole="button" accessibilityLabel="Forget this monitor" hitSlop={8} testID={`${testID}-forget`}>
            <Text style={styles.forget}>Forget</Text>
          </Pressable>
        </RNView>
      ) : (
        <Text style={styles.muted} testID={`${testID}-none`}>
          No monitor paired.
        </Text>
      )}

      <RNView style={styles.actions}>
        <Button
          label={scanning ? 'Scanning…' : remembered ? 'Scan for a different monitor' : 'Scan for a monitor'}
          variant="secondary"
          disabled={scanning || !userId}
          onPress={() => void scan()}
          accessibilityHint="Looks for nearby Bluetooth heart-rate monitors for about ten seconds"
          testID={`${testID}-scan`}
        />
        {scanning && <ActivityIndicator accessibilityLabel="Scanning" />}
      </RNView>

      {found.length > 0 && (
        <RNView style={styles.found} testID={`${testID}-found`}>
          {found.map((d) => (
            <Pressable
              key={d.id}
              onPress={() => void pick(d)}
              style={styles.foundRow}
              accessibilityRole="button"
              accessibilityLabel={`Use ${d.name}`}
              testID={`${testID}-found-${d.id}`}
            >
              <Icon name="heart" size={14} color={vola.text} />
              <Text style={styles.foundName}>{d.name}</Text>
              <Text style={styles.use}>Use</Text>
            </Pressable>
          ))}
        </RNView>
      )}

      {note && (
        <Text style={styles.note} accessibilityLiveRegion="polite" testID={`${testID}-note`}>
          {note}
        </Text>
      )}
      <Text style={styles.muted}>
        On an Amazfit: turn on heart-rate broadcasting in Zepp first (Profile → your watch → Heart rate broadcasting).
      </Text>
    </RNView>
  );
}

const styles = StyleSheet.create({
  block: { paddingVertical: 12, gap: 8 },
  label: { fontSize: 15, fontWeight: '600', color: vola.text },
  muted: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  spinner: { alignSelf: 'flex-start' },
  device: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  deviceBody: { flex: 1, gap: 2 },
  deviceName: { fontSize: 14, fontWeight: '600', color: vola.text },
  forget: { fontSize: 13, fontWeight: '600', color: vola.danger },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  found: { gap: 2, borderWidth: 1, borderColor: vola.line, borderRadius: 12, overflow: 'hidden' },
  foundRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  foundName: { flex: 1, fontSize: 14, color: vola.text },
  use: { fontSize: 13, fontWeight: '700', color: vola.text },
  note: { fontSize: 12, color: vola.text, lineHeight: 17 },
});
