import { StyleSheet, View as RNView } from 'react-native';

import { LiveHRIndicator } from '@/components/LiveHRIndicator';
import { useHRMax } from '@/lib/hrMonitor/useHRMax';
import { useLiveHR } from '@/lib/hrMonitor/useLiveHR';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * N528/#958 — Today's live heart-rate module: *"even make a nice module in
 * today showing my current HR"*. The card variant of the one indicator every
 * session screen uses, so the number here and the number mid-set are the
 * same number. Renders nothing at all without a connected monitor — a Today
 * without one is unchanged — which is why the parent needs no condition and
 * no plumbing: the card reads its own token for the zone's HRmax.
 */
export function LiveHRCard({ testID = 'today-live-hr' }: { testID?: string }) {
  const getToken = useAuthToken();
  const state = useLiveHR();
  const on = state.status !== 'off' && state.status !== 'unsupported';
  const hrMax = useHRMax(getToken, on);
  if (!on) return null;
  return (
    <RNView style={styles.section}>
      <LiveHRIndicator variant="card" hrMaxBPM={hrMax} testID={testID} />
    </RNView>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 16 },
});
