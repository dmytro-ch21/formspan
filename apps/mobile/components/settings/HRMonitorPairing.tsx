import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { isPairedMonitorConnected, pairedMonitorStatusLabel } from '@/lib/hrMonitor/heartRateProfile';
import { forgetMonitor, readRememberedMonitor, rememberMonitor, type RememberedMonitor } from '@/lib/hrMonitor/hrMonitorStore';
import { ensureBluetoothPermissions, isBluetoothSupported, scanForMonitors, stopLiveHR, type FoundMonitor } from '@/lib/hrMonitor/liveHR';
import { monitorRowA11yLabel, monitorRows } from '@/lib/hrMonitor/monitorList';
import { connectIfRemembered } from '@/lib/hrMonitor/orchestrator';
import { useLiveHR } from '@/lib/hrMonitor/useLiveHR';
import {
  BROADCAST_RULE,
  BROADCAST_STEPS,
  hrPathDetail,
  hrPathHeadline,
  hrPathState,
  healthPathTip,
  nonBroadcastingNote,
} from '@/lib/hrPath';
import { healthStoreHasRecentHeartRate } from '@/lib/hrPathProbe';
import { type HealthSource, healthSourceLabel } from '@/lib/vo2MaxSource';
import { PressableScale } from '@/components/ui/PressableScale';

/**
 * N528/#958 — Settings → Integrations → "Heart-rate monitor": scan, pick,
 * remember, forget. One remembered monitor per phone; connecting happens on
 * its own from then on (`lib/hrMonitor/orchestrator.ts`).
 *
 * **N552/#1021 added the half that was missing, and it is the more important
 * half.** This block used to offer a scan and say nothing whatsoever about a
 * device that can never appear in one — so an Apple Watch owner scanned,
 * found nothing, and reasonably concluded the feature was broken. It now
 * opens by naming the two paths heart rate can take, says which one this
 * athlete is on (`lib/hrPath.ts`, plus one bounded read of the health store
 * so that is an observation and not a promise), and states plainly which
 * wearables will never broadcast.
 *
 * The broadcast instructions were also generalised in the same ticket: the
 * copy named one watch — the Amazfit that produced N528 — which read as
 * "VOLA supports Amazfit" to everybody holding anything else, when in fact
 * the scan is vendor-neutral by construction and always was.
 */
export function HRMonitorPairing({
  userId,
  healthSource,
  healthSyncOn,
  testID = 'settings-hr-monitor',
}: {
  userId: string | null | undefined;
  /** This device's health store, or `null` if it has none. */
  healthSource: HealthSource | null;
  /** The health-sync toggle rendered above this block, live — `null` while
   *  its preference read is still in flight. Passed rather than re-read here
   *  so flipping that switch updates this block in the same frame. */
  healthSyncOn: boolean | null;
  testID?: string;
}) {
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
  /**
   * W20/#986 — two straps of the same model advertise the same name, so the
   * list has to say which is which. `monitorRows` adds a detail line ONLY to
   * rows whose name is shared with another row; the common single-monitor
   * scan stays a bare name.
   */
  const rows = useMemo(() => monitorRows(found), [found]);

  /**
   * N552/#1021 — "does the health store actually hold recent heart rate", so
   * the fallback path can be described as an observation rather than as a
   * promise. `null` is "not known"; `settled` is what keeps the block on its
   * loading state instead of flashing "couldn't check" and correcting itself
   * a moment later (the monotonic-screen rule `vo2MaxScreenState` follows).
   *
   * Runs ONLY when the athlete is actually on that path — no monitor paired,
   * a store on this device, and its sync switch already on. So it can never
   * be the thing that provokes a permission prompt nobody asked for, and a
   * paired-strap athlete pays nothing for it.
   */
  const [showBroadcastHelp, setShowBroadcastHelp] = useState(false);
  /**
   * ONE piece of state carrying both the answer and what it is an answer
   * ABOUT, rather than a separate `settled` flag reset from inside the
   * effect. "Settled" is then `probe.key === probeKey` — DERIVED, so a
   * changed input un-settles the block with no setState in an effect body
   * (which the hooks lint rightly refuses, and which would also be a
   * cascading render on every one of these inputs).
   */
  const probeKey = `${healthSource ?? '-'}|${healthSyncOn ?? '-'}|${remembered === undefined ? '?' : remembered ? 'paired' : '-'}|${supported}`;
  const [probe, setProbe] = useState<{ key: string; result: boolean | null } | null>(null);

  useEffect(() => {
    if (!userId || healthSource === null || healthSyncOn !== true) return;
    // Still reading the pairing: skipping now and re-running when it answers
    // is correct — `remembered` is in `probeKey`, which is a dependency.
    if (remembered === undefined) return;
    // The live path is in effect, so nothing below this block will read the
    // probe. Note the `supported &&`: a remembered monitor on a build with
    // no Bluetooth is NOT the live path (`hrPathState` says so), and
    // skipping the probe on the pairing alone would have left that athlete
    // on a spinner forever, because the state they land in is one that waits
    // for a probe that never runs.
    if (supported && remembered !== null) return;
    let alive = true;
    const key = probeKey;
    healthStoreHasRecentHeartRate(healthSource)
      .then((has) => {
        if (alive) setProbe({ key, result: has });
      })
      .catch(() => {
        // `healthStoreHasRecentHeartRate` never throws, so this is belt and
        // braces — but a probe that failed silently would leave the block on
        // 'loading' forever, which is the one outcome worse than "couldn't
        // check".
        if (alive) setProbe({ key, result: null });
      });
    return () => {
      alive = false;
    };
  }, [userId, healthSource, healthSyncOn, remembered, supported, probeKey]);

  const healthProbeSettled = probe !== null && probe.key === probeKey;
  const healthHasRecentHR = healthProbeSettled ? probe.result : null;

  const monitorName = remembered === undefined ? undefined : (remembered?.name ?? null);
  const pathInput = { monitorName, healthSource };
  const path = hrPathState({
    bluetoothSupported: supported,
    monitorName,
    healthSource,
    healthSyncOn,
    healthHasRecentHR,
    healthProbeSettled,
  });
  const sourceLabel = healthSource ? healthSourceLabel(healthSource) : 'your health app';

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
    // N552/#1021: what the scan actually saw, counted here rather than read
    // back out of a `setFound` updater once it finished. That trick worked,
    // but it meant setting OTHER state from inside a state updater — a side
    // effect in a function React is free to call more than once — and it is
    // what stopped the compiler being able to memoize this callback at all
    // once a second setter joined it.
    const seen = new Set<string>();
    const s = scanForMonitors((d) => {
      seen.add(d.id);
      setFound((prev) => (prev.some((p) => p.id === d.id) ? prev : [...prev, d]));
    });
    stopScan.current = s.stop;
    await s.done;
    stopScan.current = null;
    setScanning(false);
    {
      if (seen.size === 0) {
        // N552/#1021: generic, and it points at the expandable steps below
        // rather than naming one brand. The previous copy named the Amazfit
        // that produced N528, which told an athlete holding anything else
        // nothing at all — and told an Apple Watch owner nothing about the
        // fact that no amount of scanning will ever find theirs.
        setNote(
          'No heart-rate monitor found. Some wearables — Apple Watch, Fitbit, Oura, most Samsung and Wear OS watches — never broadcast, so a scan cannot find them; those come in from your health app after the session instead. If yours can broadcast, it usually has to be switched on first: see "How do I turn broadcasting on?" below.',
        );
        setShowBroadcastHelp(true);
      }
    }
    // `setShowBroadcastHelp` is listed even though a `useState` setter is
    // stable: React Compiler infers it as a dependency here and refuses to
    // memoize the callback when the written list disagrees, which downgrades
    // this whole component out of compilation. Harmless to list, and the
    // alternative (not opening the help exactly when a scan found nothing)
    // is the useful behaviour.
  }, [userId, scanning, setShowBroadcastHelp]);

  const pick = useCallback(
    async (d: { id: string; name: string }) => {
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

  /**
   * The block that answers "which path am I on", rendered in EVERY branch
   * below — including the no-Bluetooth build, where it is the only useful
   * thing this section can say. Shared rather than duplicated so the two
   * branches cannot drift.
   */
  const pathBlock = (
    <RNView style={styles.pathBlock} testID={`${testID}-path`}>
      {hrPathHeadline(path, pathInput) == null ? (
        <ActivityIndicator accessibilityLabel="Loading" style={styles.spinner} />
      ) : (
        <>
          <Text style={styles.pathHeadline} testID={`${testID}-path-headline`}>
            {hrPathHeadline(path, pathInput)}
          </Text>
          <Text style={styles.bodyCopy} testID={`${testID}-path-detail`}>
            {hrPathDetail(path, pathInput)}
          </Text>
        </>
      )}
      {healthPathTip(path) != null && (
        <Text style={styles.bodyCopy} testID={`${testID}-health-tip`}>
          {healthPathTip(path)}
        </Text>
      )}
      <Text style={styles.bodyCopy} testID={`${testID}-non-broadcasting`}>
        {nonBroadcastingNote(sourceLabel)}
      </Text>
    </RNView>
  );

  if (!supported) {
    return (
      <RNView style={styles.block} testID={testID}>
        <Text style={styles.label}>Heart rate</Text>
        {pathBlock}
        {/* N552/#1021: this used to be the whole of what an athlete on such a
            build was told, which read as "heart rate is off" rather than as
            "one of the two routes is". The path block above says what they
            actually have. */}
        <Text style={styles.bodyCopy} testID={`${testID}-no-bluetooth`}>
          Bluetooth isn&apos;t available in this build, so the live path is not an option here.
        </Text>
      </RNView>
    );
  }

  return (
    <RNView style={styles.block} testID={testID}>
      <Text style={styles.label}>Heart rate</Text>
      {pathBlock}

      <Text style={styles.subLabel}>Pair a Bluetooth monitor</Text>
      <Text style={styles.muted}>
        A paired watch or chest strap streams heart rate to VOLA during a run — including while your screen is
        locked, and with no waiting for {sourceLabel} to sync. VOLA connects when a run starts and disconnects when
        it ends, and once here when you pair one, to check it really is broadcasting.
      </Text>

      {remembered === undefined ? (
        <ActivityIndicator accessibilityLabel="Loading" style={styles.spinner} />
      ) : remembered ? (
        <RNView style={styles.device} testID={`${testID}-remembered`}>
          <Icon name="heart" size={16} color={isPairedMonitorConnected(live, remembered.id) ? vola.green : vola.textMuted} />
          <RNView style={styles.deviceBody}>
            <Text style={styles.deviceName}>{remembered.name}</Text>
            <Text style={styles.deviceStatus} testID={`${testID}-status`}>
              {pairedMonitorStatusLabel(live, remembered.id)}
            </Text>
          </RNView>
          <PressableScale onPress={() => void forget()} accessibilityRole="button" accessibilityLabel="Forget this monitor" hitSlop={8} testID={`${testID}-forget`}>
            <Text style={styles.forget}>Forget</Text>
          </PressableScale>
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
          {rows.map((row) => (
            <PressableScale
              key={row.id}
              onPress={() => void pick({ id: row.id, name: row.name })}
              style={styles.foundRow}
              accessibilityRole="button"
              accessibilityLabel={monitorRowA11yLabel(row)}
              testID={`${testID}-found-${row.id}`}
            >
              <Icon name="heart" size={14} color={vola.text} />
              <RNView style={styles.foundBody}>
                <Text style={styles.foundName}>{row.name}</Text>
                {row.detail != null && (
                  <Text style={styles.foundDetail} testID={`${testID}-found-detail-${row.id}`}>
                    {row.detail}
                  </Text>
                )}
              </RNView>
              <Text style={styles.use}>Use</Text>
            </PressableScale>
          ))}
        </RNView>
      )}

      {note && (
        <Text style={styles.note} accessibilityLiveRegion="polite" testID={`${testID}-note`}>
          {note}
        </Text>
      )}
      {/* N552/#1021 — the ticket's second criterion: GENERIC broadcast
          guidance. Collapsed by default because an athlete who is already
          paired never needs it, and expanded automatically by a scan that
          found nothing, which is exactly when they do. `BROADCAST_RULE`
          leads: the brand rows are examples of one setting under different
          names, not a list of supported devices. */}
      <PressableScale
        onPress={() => setShowBroadcastHelp((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: showBroadcastHelp }}
        accessibilityLabel="How do I turn broadcasting on?"
        hitSlop={8}
        testID={`${testID}-broadcast-toggle`}
      >
        <Text style={styles.disclosure}>
          {showBroadcastHelp ? 'Hide' : 'How do I turn broadcasting on?'}
        </Text>
      </PressableScale>
      {showBroadcastHelp && (
        <RNView style={styles.help} testID={`${testID}-broadcast-help`}>
          <Text style={styles.bodyCopy} testID={`${testID}-broadcast-rule`}>{BROADCAST_RULE}</Text>
          {BROADCAST_STEPS.map((step) => (
            <Text key={step.device} style={styles.bodyCopy} testID={`${testID}-broadcast-step`}>
              <Text style={styles.helpDevice}>{step.device}</Text>
              {` — ${step.how}`}
            </Text>
          ))}
        </RNView>
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  block: { paddingVertical: 12, gap: 8 },
  label: { fontSize: 15, fontWeight: '600', color: vola.text },
  subLabel: { fontSize: 13, fontWeight: '600', color: vola.text, marginTop: 4 },
  pathBlock: { gap: 6 },
  /**
   * The one line that answers the question the athlete came to this screen
   * with. It is set apart from the paragraph under it by SIZE and WEIGHT,
   * not by ink — both are `textMuted`, because both are above the 4.5:1
   * floor and hierarchy built out of an unreadable second tier is not
   * hierarchy. See `bodyCopy` below for the measurements.
   */
  pathHeadline: { fontSize: 13, fontWeight: '600', color: vola.textMuted, lineHeight: 18 },
  disclosure: { fontSize: 13, fontWeight: '600', color: vola.text, paddingVertical: 4 },
  help: { gap: 8, paddingBottom: 4 },
  helpDevice: { fontWeight: '600', color: vola.textMuted },
  muted: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  /**
   * The prose an athlete has to READ, as opposed to the chrome around it.
   * Identical metrics to `muted` — only the ink differs, because the
   * difference being made here is legibility and not hierarchy.
   *
   * Measured against `vola.bg` (`#080B12`): `textDim` is 3.96:1, under the
   * 4.5:1 floor this file's own palette calls a failure
   * (`constants/Colors.ts`, the `setDone` note: "drops `textMuted` to 3.98:1,
   * which fails"); `textMuted` is 7.38:1. Against `surface` (`#10151F`) the
   * same two are 3.67:1 and 6.85:1, so the verdict does not depend on which
   * ground the settings row is drawn over.
   *
   * **N552/#1021 is the reason this exists as its own style.** That ticket
   * promoted `pathHeadline` on exactly this reasoning and left the paragraphs
   * underneath it — the explanation of what to do, the one gesture that
   * changes the report, the note about wearables that never broadcast, and
   * the broadcast instructions — at 3.96:1. A Settings block that exists so
   * an Apple Watch owner stops concluding the app is broken cannot render its
   * substance below the floor. Anything a reader must actually get through
   * goes here; a state stub ("No monitor paired.") and the description of a
   * control they can already see stay on `muted`.
   */
  bodyCopy: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  spinner: { alignSelf: 'flex-start' },
  device: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  deviceBody: { flex: 1, gap: 2 },
  deviceName: { fontSize: 14, fontWeight: '600', color: vola.text },
  forget: { fontSize: 13, fontWeight: '600', color: vola.danger },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  found: { gap: 2, borderWidth: 1, borderColor: vola.line, borderRadius: 12, overflow: 'hidden' },
  foundRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  foundBody: { flex: 1, gap: 2 },
  foundName: { fontSize: 14, color: vola.text },
  /**
   * `textMuted`, NOT the `textDim` that `styles.muted` uses for this block's
   * prose. Measured against `vola.bg`: `textDim` is 3.96:1, under the 4.5:1
   * floor for body text; `textMuted` is 7.38:1. These two lines are the ones
   * W20 exists to make readable — the tag that separates two identical straps
   * and the state of the paired one — so they are information, not chrome, and
   * a disambiguator the athlete cannot read defeats the whole fix. The
   * surrounding explanatory paragraphs stay `muted`.
   */
  foundDetail: { fontSize: 12, color: vola.textMuted },
  deviceStatus: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  use: { fontSize: 13, fontWeight: '700', color: vola.text },
  note: { fontSize: 12, color: vola.text, lineHeight: 17 },
});
