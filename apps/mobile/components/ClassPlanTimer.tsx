import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import {
  advanced,
  currentBlock,
  deadlineFor,
  remainingAt,
  startRun,
  wentBack,
  type BlockDeadline,
  type RunState,
} from '@/lib/classPlanRun';
import type { ClassPlanBlock } from '@/lib/classplans';
import { formatCountdown } from '@/lib/countdown';
import { playSound } from '@/lib/sounds';

/**
 * The whole guided run: which block is current, and its countdown —
 * deadline-driven, three-part survival mechanism mirrored from
 * `components/Countdown.tsx`'s `useCountdown` (see that file's header for
 * the full argument, and `lib/countdown.ts`'s for why a deadline rather than
 * a decrementing counter): a `setTimeout` aimed at the exact deadline, a
 * 250ms `setInterval` backstop for whatever the timeout missed while the app
 * was suspended, and an `AppState` listener that recomputes on foreground.
 * All three exist because iOS suspends JS timers the moment the app is
 * backgrounded — precisely the case this ticket's device-evidence criterion
 * asks a human to confirm, and precisely the case a test cannot reach
 * because there is no real "backgrounded" to simulate.
 *
 * **Position (`RunState`, from `lib/classPlanRun.ts`) and time (the
 * deadline) live in ONE hook, not two.** They were split at first, with
 * `run.tsx` walking the plan and this hook only timing one block — but
 * advancing the plan and arming the next block's timer are the SAME
 * transition, always done together, and `Countdown.tsx`'s own `finish()`
 * shows why that has to be one piece: its completion handler both calls
 * `advanced()` on the run AND starts the next countdown, in the same
 * function, because splitting them across a callback boundary is exactly
 * the seam where the double-fire bug documented there was found. Mirroring
 * that split here would reintroduce the seam this file exists to avoid.
 *
 * Simpler than `useCountdown` everywhere this domain does not need one: no
 * pause, no ±adjust, no ready/work/rest discrimination, and completion never
 * writes anything back — a class-plan block has no logged set to correct,
 * only a plan position to move past.
 *
 * **The staleness guard survives the merge.** `Countdown.tsx`'s comments
 * document a real double-fire bug found in review — a stale timeout,
 * backstop interval, or AppState handler left over from the PREVIOUS block
 * firing after the run has already moved on, in the window between the
 * block changing and React committing the effect cleanup that would have
 * cancelled them. The realistic trigger there was backgrounding
 * mid-transition, which is exactly this screen's own failure mode. The same
 * identity check — a ref holding the live deadline, compared against the
 * one a callback closed over — closes it here too.
 */
export function useClassPlanRun(): {
  run: RunState | null;
  remaining: number;
  total: number;
  /** True once the run has advanced past its last block. */
  finished: boolean;
  /** Begin a run over this plan's blocks — call once the plan has loaded. */
  start: (blocks: ClassPlanBlock[]) => void;
  /** Manual or automatic advance — both funnel through the same completion
   *  handler, so a timer running out and a tap on Next behave identically. */
  goNext: () => void;
  /** A no-op at the first block — never a crash, never a negative index. */
  goBack: () => void;
} {
  const [run, setRun] = useState<RunState | null>(null);
  const [deadline, setDeadline] = useState<BlockDeadline | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [finished, setFinished] = useState(false);

  const runRef = useRef<RunState | null>(null);
  const firedRef = useRef(false);
  /**
   * The live deadline, updated SYNCHRONOUSLY — mirrors `Countdown.tsx`'s
   * `timerRef`. A timer callback scheduled for a block that is no longer the
   * current one has nothing to say, and only identity (not `firedRef` alone,
   * which every new block legitimately resets to false) can recognise that.
   */
  const deadlineRef = useRef<BlockDeadline | null>(null);

  /** Arms a fresh deadline for one block, or clears it (`arm(null)`) to stop
   *  the timer without arming a new one. */
  const arm = useCallback((block: ClassPlanBlock | null) => {
    firedRef.current = false;
    if (!block) {
      deadlineRef.current = null;
      setDeadline(null);
      setRemaining(0);
      return;
    }
    const d = deadlineFor(block, Date.now());
    // Before the setState calls, not after — the whole point is that this is
    // true the instant `arm` returns, while a queued callback from the
    // previous block may still fire before React commits the next render.
    deadlineRef.current = d;
    setDeadline(d);
    setRemaining(d.total);
  }, []);

  const start = useCallback(
    (blocks: ClassPlanBlock[]) => {
      if (blocks.length === 0) {
        setRun(null);
        runRef.current = null;
        arm(null);
        return;
      }
      const initial = startRun(blocks);
      setRun(initial);
      runRef.current = initial;
      setFinished(false);
      arm(currentBlock(initial));
    },
    [arm],
  );

  const goNext = useCallback(() => {
    const current = runRef.current;
    if (!current) return;
    const next = advanced(current);
    if (next) {
      setRun(next);
      runRef.current = next;
      arm(currentBlock(next));
    } else {
      // The run is over — stop the timer rather than leaving it armed for a
      // block that no longer exists.
      setFinished(true);
      arm(null);
    }
  }, [arm]);

  const goBack = useCallback(() => {
    const current = runRef.current;
    if (!current) return;
    // `wentBack` is already a no-op at the first block — safe to call
    // unconditionally, so the button never has to reason about the edge
    // case itself.
    const back = wentBack(current);
    setRun(back);
    runRef.current = back;
    arm(currentBlock(back));
  }, [arm]);

  useEffect(() => {
    if (!deadline) return;

    function finish() {
      if (firedRef.current) return;
      if (deadlineRef.current !== deadline) return; // stale — see header
      firedRef.current = true;
      // The coach is standing on the mat, not looking at the phone — the
      // haptic covers it being set down, the sound covers it being out of
      // earshot of nobody in particular. Same discipline as every timer
      // completion elsewhere in this app: never throws, never awaited.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      playSound('success');
      goNext();
    }

    const timeout = setTimeout(finish, Math.max(0, deadline.endsAt - Date.now()));
    // 250ms so the digits repaint promptly, and so a completion whose
    // timeout was suspended while the app was backgrounded still gets
    // caught on the next foreground pass.
    const interval = setInterval(() => {
      const left = remainingAt(deadline, Date.now());
      setRemaining(left);
      if (left <= 0 && !firedRef.current) finish();
    }, 250);
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      const left = remainingAt(deadline, Date.now());
      setRemaining(left);
      if (left <= 0 && !firedRef.current) finish();
    });

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
      sub.remove();
    };
  }, [deadline, goNext]);

  return { run, remaining, total: deadline?.total ?? 0, finished, start, goNext, goBack };
}

/**
 * The big, arm's-length-readable digits and a progress bar underneath.
 *
 * Presentational only — `run.tsx` owns `useClassPlanRun` above and
 * everything else on screen (block content, next-up, advance/back). Split
 * out because the numbers are the one thing on this screen that has to be
 * legible without picking the phone up, and a dedicated component is where
 * that gets sized once rather than re-guessed at every call site.
 */
export function ClassPlanTimer({
  remaining,
  total,
  tint,
}: {
  remaining: number;
  total: number;
  /** The athlete's chosen accent — progress is an interaction surface, not a
   *  fixed reading, so it takes the accent rather than a hard-coded colour
   *  (the same rule every other progress fill in this app follows). */
  tint: string;
}) {
  const progress = total > 0 ? Math.max(0, Math.min(1, 1 - remaining / total)) : 0;
  return (
    <View style={styles.wrap}>
      <Text style={styles.digits} testID="classplan-timer-digits">
        {formatCountdown(remaining)}
      </Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${progress * 100}%`, backgroundColor: tint }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 10 },
  // Large enough to read at arm's length on a phone propped against a bag —
  // this is a standing-on-the-mat screen, sized accordingly per the
  // mobile-first rule's live-logging carve-out.
  digits: { fontSize: 64, fontWeight: '800', fontVariant: ['tabular-nums'], color: vola.text },
  track: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: vola.line,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 3 },
});
