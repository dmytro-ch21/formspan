import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useSyncState, syncNow, type SyncState } from '@/lib/sync';
import { PressableScale } from '@/components/ui/PressableScale';

/**
 * A one-glance answer to "is my training safe yet?", on every tab.
 *
 * **The state existed; nothing showed it.** `SyncState` has carried
 * `pending`, `deferred`, `online` and `lastError` since PR2, and the only
 * place any of it surfaced was a Retry button on one screen. So the honest
 * answer to the question an athlete actually has after a basement workout —
 * *did that make it off my phone* — was to open the right screen and infer it.
 *
 * **Silent when there is nothing to say.** No chip when everything is synced
 * and online, because a permanent "Synced ✓" badge is furniture: it trains
 * you to stop reading the corner, which is exactly where you need to look on
 * the day it says something else. The chip appearing IS the signal.
 *
 * **Deferred is not failed, and gets its own wording.** A session waiting on
 * a workout that has not reached the server is fine and resolves itself.
 * Calling that "failed" would alarm someone about training that is in no
 * danger. It reads as waiting.
 */

/** What the chip should say, or null to render nothing. */
export function chipFor(s: SyncState): { label: string; tone: 'warn' | 'danger' | 'muted' } | null {
  // Order matters: each branch is the most important true thing.
  //
  // Offline outranks a pending count because it explains it — "3 waiting"
  // beside a phone with no signal invites a pointless retry, while "Offline"
  // says the app is behaving correctly and there is nothing to do.
  if (!s.online) {
    return {
      label: s.pending > 0 ? `Offline · ${s.pending} waiting` : 'Offline',
      tone: 'muted',
    };
  }
  // Online and a row is waiting on a PERSON (N167/#544): refused by the
  // server, and nothing automatic will ever move it. Ahead of `lastError`
  // because it is the more specific and more actionable truth — the same rule
  // the sync screen applies ("a permanent row still wins over the
  // transient-error copy") — and because it is the one that survives a cold
  // start: `lastError` lives in memory, this is recounted from disk.
  //
  // Offline still outranks it, deliberately and unchanged. A refused row is not
  // caused by being offline, but "1 needs attention" beside no signal invites
  // the question "is it failing because I'm offline?", and the answer to that
  // is visible the moment signal returns.
  if (s.needsAttention > 0) {
    return {
      label: `${s.needsAttention} ${s.needsAttention === 1 ? 'needs' : 'need'} attention`,
      tone: 'danger',
    };
  }
  // Online and the last run failed. With the branch above, these two are the
  // only alarming states and the only ones worth `danger`.
  if (s.lastError) return { label: 'Sync failed', tone: 'danger' };
  if (s.syncing) return { label: 'Syncing…', tone: 'muted' };
  // Deferred rows are counted inside `pending`, so this is checked first to
  // give them the wording that fits: they are waiting on a dependency, not
  // queued behind a problem.
  if (s.deferred > 0) return { label: `${s.deferred} waiting on a plan`, tone: 'muted' };
  if (s.pending > 0) return { label: `${s.pending} to sync`, tone: 'warn' };
  // Synced, online, nothing owed. Say nothing.
  return null;
}

/**
 * Whether tapping the chip opens the repair screen rather than retrying.
 *
 * One function, read by both the tap and its announced label, so the two cannot
 * disagree — they used to each test `lastError` inline. That inline test is
 * also exactly what broke N167: a cold start with a refused row has
 * `needsAttention > 0` and no `lastError`, so the chip would have said
 * "N needs attention", announced "Tap to sync now", and retried a request the
 * server refuses forever instead of opening the screen that can fix it.
 */
export function chipOpensRepair(s: SyncState): boolean {
  return Boolean(s.lastError) || s.needsAttention > 0;
}

export function SyncChip() {
  const state = useSyncState();
  const router = useRouter();
  const chip = chipFor(state);
  if (!chip) return null;

  const colour =
    chip.tone === 'danger' ? vola.danger : chip.tone === 'warn' ? vola.warn : vola.textMuted;

  return (
    <PressableScale
      onPress={() => {
        // A failure needs a place to go, not another attempt: the row is
        // refused permanently and retrying from here would do nothing
        // visible. Everything else is a plain "try now" — and it attempts
        // even offline, because `online` is inferred from the LAST request,
        // so disabling it would refuse the one tap that happens right after
        // signal returns, which is the tap people actually make.
        if (chipOpensRepair(state)) router.push('/sync');
        else void syncNow();
      }}
      hitSlop={10}
      accessibilityRole="button"
      // Announced as a status with an action, not as a bare label: a screen
      // reader user gets what it means and what tapping does.
      accessibilityLabel={
        chipOpensRepair(state)
          ? `${chip.label}. Tap to see what went wrong.`
          : `${chip.label}. Tap to sync now.`
      }
      testID="sync-chip"
    >
      <View style={styles.chip}>
        <View style={[styles.dot, { backgroundColor: colour }]} />
        <Text style={[styles.label, { color: colour }]}>{chip.label}</Text>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: vola.surface,
  },
  dot: { width: 7, height: 7, borderRadius: 999 },
  // 12px is small, and deliberately: this is a status, not a headline. It
  // earns attention by appearing at all rather than by being loud.
  label: { fontSize: 12, fontWeight: '600' },
});
