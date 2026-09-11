import {
  finishedRun,
  hrMetrics,
  hrSamples,
  openRun,
  queuedFix,
  renderRunningScreen,
  runDetail,
  RUN_ID,
  RUNNING_BRANCH,
  USER_ID,
} from './support/runningScreen';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

/**
 * The running session screen, rendered (N563/#1068).
 *
 * Until this file the running screen had no render test at all — every
 * invariant about it was a source-text assertion in `hrReportWiring.test.ts`.
 * `support/runningScreen.tsx` is the harness and its doc comment is the
 * design; this file is what it can now catch, in two halves:
 *
 *  - the screen's own branches — loading into live tracking, the permission
 *    answers, a run that is not on this device, a queued fix reaching the
 *    saved track, the finish sequence, and a finished run reopened;
 *  - N563's actual feature: the heart-rate timeline, drawn over the metrics
 *    window when there is heart rate, and nothing at all when there is not.
 *
 * Budgets are generous on purpose: the failure mode of this suite under CPU
 * contention is a missing element, never a wrong value (see the
 * `vola-testing` skill), and a finished run mounts the whole report.
 */
jest.setTimeout(30_000);
const WAIT = { timeout: 10_000 };

/** An SVG `<Text>`'s string — not reachable by `getByText`, which only reads
 *  React Native's own `Text`. Same reader `HRSessionReport.test.tsx` uses. */
function svgTextOf(testID: string): unknown {
  const node = screen.getByTestId(testID);
  const child = node.props.children as { props?: { children?: unknown } } | string;
  return typeof child === 'string' ? child : child?.props?.children;
}

describe('the running screen, rendered', () => {
  it('starts tracking an open run once location is already granted', async () => {
    const m = await renderRunningScreen({ session: openRun() });

    await screen.findByTestId(RUNNING_BRANCH.live, {}, WAIT);

    await waitFor(() => expect(m.tracking.start).toHaveBeenCalledWith(USER_ID, RUN_ID), WAIT);
    expect(m.tracking.start).toHaveBeenCalledTimes(1);
    // Already granted: the OS is never asked a second time.
    expect(m.location.requestPermissions).not.toHaveBeenCalled();
    // The live chip belongs to a run, and only a run (N544/W21).
    expect(screen.getByTestId('running-live-hr')).toBeTruthy();
    // Nothing about heart rate is fetched while the run is still going.
    expect(m.biometric.getSessionMetrics).not.toHaveBeenCalled();
  });

  it('asks for location once when it may, and tracks when the athlete allows it', async () => {
    const m = await renderRunningScreen({
      permission: { granted: false, canAskAgain: true, grantedOnRequest: true },
    });

    await screen.findByTestId(RUNNING_BRANCH.live, {}, WAIT);
    expect(m.location.requestPermissions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(m.tracking.start).toHaveBeenCalledTimes(1), WAIT);
  });

  it('explains itself and tracks nothing when location is refused for good', async () => {
    const m = await renderRunningScreen({ permission: { granted: false, canAskAgain: false } });

    await screen.findByTestId(RUNNING_BRANCH.permissionDenied, {}, WAIT);
    expect(screen.getByText('Location access needed')).toBeTruthy();
    // The OS will not show the prompt again, so asking would be a no-op at best.
    expect(m.location.requestPermissions).not.toHaveBeenCalled();
    expect(m.tracking.start).not.toHaveBeenCalled();
  });

  it('says so when the run is not on this device, rather than tracking a ghost', async () => {
    const m = await renderRunningScreen({ session: null });

    await screen.findByTestId(RUNNING_BRANCH.error, {}, WAIT);
    expect(screen.getByText('This run could not be found on this device.')).toBeTruthy();
    expect(m.location.getPermissions).not.toHaveBeenCalled();
    expect(m.tracking.start).not.toHaveBeenCalled();
  });

  it('refuses a session that is not a run', async () => {
    await renderRunningScreen({ session: openRun({ sport: 'strength' }) });
    await screen.findByTestId(RUNNING_BRANCH.error, {}, WAIT);
  });

  it('folds the background task’s queued fixes into the saved track', async () => {
    // Three moving fixes ~110 m apart. The distance and auto-pause logic stay
    // real, so this fails if a good fix stops reaching the persisted route.
    const m = await renderRunningScreen({
      fixes: [
        queuedFix(1, 51.5, -0.12, '2026-09-06T07:00:03.000Z'),
        queuedFix(2, 51.501, -0.12, '2026-09-06T07:00:40.000Z'),
        queuedFix(3, 51.502, -0.12, '2026-09-06T07:01:17.000Z'),
      ],
    });

    await screen.findByTestId(RUNNING_BRANCH.live, {}, WAIT);
    await waitFor(() => {
      const saved = m.store.saveDetail.mock.calls.at(-1)?.[2];
      expect(saved?.route_points).toHaveLength(3);
    }, WAIT);
    const saved = m.store.saveDetail.mock.calls.at(-1)?.[2];
    expect(saved.distance_m).toBeGreaterThan(200);
  });

  it('drops a fix too inaccurate to trust, and keeps the good ones', async () => {
    const m = await renderRunningScreen({
      fixes: [
        queuedFix(1, 51.5, -0.12, '2026-09-06T07:00:03.000Z'),
        queuedFix(2, 51.6, -0.12, '2026-09-06T07:00:20.000Z', { accuracy_m: 400 }),
        queuedFix(3, 51.501, -0.12, '2026-09-06T07:00:40.000Z'),
      ],
    });

    await screen.findByTestId(RUNNING_BRANCH.live, {}, WAIT);
    await waitFor(() => {
      const saved = m.store.saveDetail.mock.calls.at(-1)?.[2];
      expect(saved?.route_points).toHaveLength(2);
    }, WAIT);
  });

  it('finishes a run in order — track, set, session, then the queue — and shows the report branch', async () => {
    const m = await renderRunningScreen({ session: openRun() });
    await screen.findByTestId(RUNNING_BRANCH.live, {}, WAIT);

    // Held inside `act` until the finish settles (F47, #1057). Unawaited, the
    // press's `act` overlapped the `findByTestId` below, which switches React's
    // act environment off while it polls — so the finish chain's updates
    // printed "not configured to support act(...)" five times per run. Awaited
    // bare, `fireEvent` would close its `act` before the chain's first `await`
    // and the same updates would land outside `act` instead.
    await act(async () => {
      await fireEvent.press(screen.getByTestId('running-finish'));
    });

    await screen.findByTestId(RUNNING_BRANCH.finished, {}, WAIT);
    // FIRST invocations, not last: a queue cleared early and again at the end
    // would still read as in-order by its last call. No fixes were queued, so
    // nothing but `finish()` writes the track here.
    const order = [m.store.saveDetail, m.store.saveSets, m.store.finish, m.tracking.clearQueue].map(
      (fn) => fn.mock.invocationCallOrder[0] ?? -1,
    );
    // Each one was called…
    expect(order.every((n) => n > 0)).toBe(true);
    // …and in that order: the queue is released only once the track it held
    // is saved, so a failed save cannot lose the run's tail.
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Finishing is what makes a run's heart rate worth asking for.
    await waitFor(() => expect(m.biometric.getSessionMetrics).toHaveBeenCalledWith(expect.any(Function), RUN_ID), WAIT);
  });

  it('reopens a finished run as its summary, without re-arming GPS', async () => {
    const detail = runDetail({
      route_points: [
        { lat: 51.5, lng: -0.12, elevation_m: null, recorded_at: '2026-09-06T07:00:03.000Z' },
        { lat: 51.501, lng: -0.12, elevation_m: null, recorded_at: '2026-09-06T07:00:40.000Z' },
      ],
    });
    const m = await renderRunningScreen({ session: finishedRun(), detail });

    await screen.findByTestId(RUNNING_BRANCH.finished, {}, WAIT);
    // W21/#992: every restored track is pruned against, on this branch too.
    expect(m.tracking.prune).toHaveBeenCalledWith(USER_ID, RUN_ID, detail.route_points);
    expect(m.location.getPermissions).not.toHaveBeenCalled();
    expect(m.tracking.start).not.toHaveBeenCalled();
  });
});

describe('the heart-rate timeline on a finished run (N563/#1068)', () => {
  // A 30-minute recording, peaking at 171 twenty minutes in.
  const bpms = Array.from({ length: 30 }, (_, i) => (i === 20 ? 171 : 128 + i));

  it('draws the timeline over the METRICS window, with its peak, when the watch recorded somewhere else', async () => {
    // W19/#985's shape: the watch's workout began 20 minutes after the run was
    // logged. The two windows differ past the 10-minute threshold, so this is
    // the one fixture where fetching over the logged window is distinguishable
    // from fetching over the right one.
    const windowStart = '2026-09-06T07:20:00.000Z';
    const windowEnd = '2026-09-06T07:50:00.000Z';
    const session = finishedRun();
    const m = await renderRunningScreen({
      session,
      detail: runDetail(),
      metrics: hrMetrics({ hr_window_start: windowStart, hr_window_end: windowEnd }),
      samples: { heart_rate: hrSamples(windowStart, bpms) },
    });

    await screen.findByTestId('running-hr-timeline', {}, WAIT);
    expect(m.biometric.listSamples).toHaveBeenCalledWith(expect.any(Function), 'heart_rate', windowStart, windowEnd);
    expect(m.biometric.listSamples).not.toHaveBeenCalledWith(
      expect.anything(),
      'heart_rate',
      session.started_at,
      expect.anything(),
    );

    // The peak, located in time — measured from the recording's own 0m.
    expect(svgTextOf('running-hr-timeline-chart-peak-label')).toBe('171 bpm at 20m');
    // And the axis admits its origin rather than silently renumbering the run.
    expect(screen.getByTestId('running-hr-timeline-caption').props.children).toMatch(
      /^Heart rate across the recording — 0m is .+, when the readings start$/,
    );
    expect(screen.getByTestId('running-hr-window-note')).toBeTruthy();
  });

  it('captions an ordinary run as the session, with no footnote, when the windows agree', async () => {
    const session = finishedRun();
    await renderRunningScreen({
      session,
      detail: runDetail(),
      metrics: hrMetrics(),
      samples: { heart_rate: hrSamples(session.started_at, bpms) },
    });

    await screen.findByTestId('running-hr-timeline', {}, WAIT);
    expect(screen.getByTestId('running-hr-timeline-caption').props.children).toBe('Heart rate across the session');
    expect(screen.queryByTestId('running-hr-window-note')).toBeNull();
  });

  it('renders no chart — no frame, no axis, no zeros — when the run has no heart rate', async () => {
    const m = await renderRunningScreen({ session: finishedRun(), detail: runDetail(), metrics: null });

    // The report still says something honest about the absence…
    await screen.findByTestId('running-hr-unavailable', {}, WAIT);
    // …and draws nothing that looks like a measurement.
    expect(screen.queryByTestId('running-hr-timeline')).toBeNull();
    expect(screen.queryByTestId('running-hr-timeline-chart')).toBeNull();
    expect(screen.queryByTestId('running-hr-timeline-chart-xtick-0')).toBeNull();
    expect(screen.queryByTestId('running-hr-stats')).toBeNull();
    // No metrics row, no window — so no heart-rate fetch over a guessed one.
    const hrCalls = m.biometric.listSamples.mock.calls.filter((c) => c[1] === 'heart_rate');
    expect(hrCalls).toHaveLength(0);
  });

  it("renders no chart for a metrics row whose source is 'none', even with readings on hand", async () => {
    const session = finishedRun();
    await renderRunningScreen({
      session,
      detail: runDetail(),
      metrics: hrMetrics({ hr_source: 'none', avg_hr_bpm: null, max_hr_bpm: null, trimp: null, sample_count: 0 }),
      samples: { heart_rate: hrSamples(session.started_at, bpms) },
    });

    await screen.findByTestId('running-hr-unavailable', {}, WAIT);
    expect(screen.queryByTestId('running-hr-timeline')).toBeNull();
  });

  it('keeps the rest of the report, and draws no chart, when the raw-sample fetch fails', async () => {
    // What this proves: a rejected samples fetch neither breaks the report nor
    // leaves a chart behind. What it does NOT prove is that the hook's `.catch`
    // ran — the timeline starts as `[]`, so an emptied catch body passes this
    // too (frontend-reviewer measured it). That branch only matters when a
    // second fetch follows a successful one, which no session screen does.
    await renderRunningScreen({
      session: finishedRun(),
      detail: runDetail(),
      metrics: hrMetrics(),
      samples: { heart_rate: new Error('offline') },
    });

    await screen.findByTestId('running-hr-stats', {}, WAIT);
    expect(screen.queryByTestId('running-hr-timeline')).toBeNull();
  });
});
