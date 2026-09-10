import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { HRSessionReport } from '../HRSessionReport';
import type { SessionMetrics } from '@/lib/biometric';

/**
 * N488/#849 — what the report SAYS on screen, as opposed to what
 * `lib/__tests__/hrSessionReport.test.ts` proves about the state it computes.
 * Same split `components/__tests__/trendCard.test.tsx` draws for the same
 * reason: the data-shaping tests prove the three states are told apart
 * correctly; these prove the component doesn't flatten them back into the
 * wrong sentence on the way to the screen.
 */

function metrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    session_id: 'sess-1',
    avg_hr_bpm: 142,
    max_hr_bpm: 168,
    trimp: 90,
    active_kcal: 410,
    hr_max_bpm: 190,
    hr_max_source: 'estimated',
    time_in_zones: { '2': 10, '3': 20, '4': 10 },
    hr_source: 'window',
    sample_count: 40,
    hr_window_start: '2026-09-01T11:00:00Z',
    hr_window_end: '2026-09-01T12:00:00Z',
    computed_at: '2026-09-01T12:00:00Z',
    rule_version: 1,
    ...overrides,
  };
}

test('no metrics at all renders the honest unavailable state, never a zeroed report', () => {
  render(<HRSessionReport metrics={null} />);
  expect(screen.getByTestId('hr-session-report-unavailable')).toBeTruthy();
  expect(screen.queryByTestId('hr-session-report-stats')).toBeNull();
  expect(screen.queryByTestId('hr-session-report-zones')).toBeNull();
});

test('hr_source "none" renders the same unavailable state as no metrics — no fabricated placeholder', () => {
  render(<HRSessionReport metrics={metrics({ hr_source: 'none', avg_hr_bpm: null, max_hr_bpm: null, trimp: null, sample_count: 0 })} />);
  expect(screen.getByTestId('hr-session-report-unavailable')).toBeTruthy();
  expect(screen.getByText(/no heart-rate data/i)).toBeTruthy();
});

describe('the queried-window diagnostic (N522/#934)', () => {
  test('renders nothing when the session times are not passed at all', () => {
    render(<HRSessionReport metrics={metrics()} />);
    expect(screen.queryByTestId('hr-session-report-window-note')).toBeNull();
  });

  test('renders nothing when the queried window matches the session (the ordinary case)', () => {
    render(
      <HRSessionReport
        metrics={metrics({ hr_window_start: '2026-09-01T11:00:00Z', hr_window_end: '2026-09-01T12:00:00Z' })}
        sessionStartedAt="2026-09-01T11:00:00Z"
        sessionEndedAt="2026-09-01T12:00:00Z"
      />,
    );
    expect(screen.queryByTestId('hr-session-report-window-note')).toBeNull();
  });

  test('shows both windows once the mismatch is real — this ticket\'s own incident shape', () => {
    render(
      <HRSessionReport
        metrics={metrics({ hr_window_start: '2026-09-07T11:14:00Z', hr_window_end: '2026-09-07T12:44:00Z' })}
        sessionStartedAt="2026-09-07T14:00:00Z"
        sessionEndedAt="2026-09-07T15:30:00Z"
      />,
    );
    expect(screen.getByTestId('hr-session-report-window-note')).toBeTruthy();
    expect(screen.getByText(/heart rate found/i)).toBeTruthy();
    expect(screen.getByText(/session logged/i)).toBeTruthy();
  });

  test('also renders on the limited state, not only full', () => {
    render(
      <HRSessionReport
        metrics={metrics({
          sample_count: 2,
          hr_window_start: '2026-09-07T11:14:00Z',
          hr_window_end: '2026-09-07T12:44:00Z',
        })}
        sessionStartedAt="2026-09-07T14:00:00Z"
        sessionEndedAt="2026-09-07T15:30:00Z"
      />,
    );
    expect(screen.getByTestId('hr-session-report-limited')).toBeTruthy();
    expect(screen.getByTestId('hr-session-report-window-note')).toBeTruthy();
  });
});

test('sparse samples renders avg/max but not TRIMP, zones, or an effectiveness card', () => {
  render(<HRSessionReport metrics={metrics({ sample_count: 5 })} sessionRPE={7} />);
  expect(screen.getByTestId('hr-session-report-limited')).toBeTruthy();
  expect(screen.getByTestId('hr-session-report-stats')).toBeTruthy();
  expect(screen.getByText(/only 5 readings/i)).toBeTruthy();
  expect(screen.queryByTestId('hr-session-report-zones')).toBeNull();
  expect(screen.queryByTestId('hr-session-report-effectiveness')).toBeNull();
});

test('no HRmax renders avg/max with a reason that points at fixing it, not a sample-count complaint', () => {
  render(<HRSessionReport metrics={metrics({ trimp: null, sample_count: 100 })} />);
  expect(screen.getByTestId('hr-session-report-limited')).toBeTruthy();
  expect(screen.getByText(/date of birth/i)).toBeTruthy();
  expect(screen.queryByText(/readings/i)).toBeNull();
});

test('a full report renders avg, max, training load and every zone row', () => {
  render(<HRSessionReport metrics={metrics()} />);
  expect(screen.getByTestId('hr-session-report-stats')).toBeTruthy();
  expect(screen.getByText('142 bpm')).toBeTruthy();
  expect(screen.getByText('168 bpm')).toBeTruthy();
  expect(screen.getByText('90')).toBeTruthy();
  for (const zone of [1, 2, 3, 4, 5]) {
    expect(screen.getByTestId(`hr-session-report-zone-${zone}`)).toBeTruthy();
  }
});

test('the effectiveness verdict only appears when a sessionRPE is supplied and evidence supports one', () => {
  const { rerender } = render(<HRSessionReport metrics={metrics()} sessionRPE={null} />);
  expect(screen.queryByTestId('hr-session-report-effectiveness')).toBeNull();

  // Entirely zone-4 (weight 4), 40 total minutes -> hrImpliedRPE ~8, "very
  // hard"; a self-reported RPE of 9 is within the calibration threshold, so
  // this reads as aligned rather than a mismatch — either way, real content
  // renders once real evidence exists.
  rerender(
    <HRSessionReport
      metrics={metrics({ trimp: 4 * 40, time_in_zones: { '4': 40 } })}
      sessionRPE={9}
    />,
  );
  expect(screen.getByTestId('hr-session-report-effectiveness')).toBeTruthy();
});

test('zero zone-attributed minutes with a real trimp says so honestly rather than drawing an empty chart', () => {
  render(<HRSessionReport metrics={metrics({ time_in_zones: {}, trimp: 0 })} />);
  expect(screen.getByTestId('hr-session-report-zones-empty')).toBeTruthy();
  expect(screen.queryByTestId('hr-session-report-zones')).toBeNull();
});

test('a custom testID namespaces every sub-element, so the same component on three screens never collides', () => {
  render(<HRSessionReport metrics={metrics()} testID="running-hr" />);
  expect(screen.getByTestId('running-hr-stats')).toBeTruthy();
  expect(screen.getByTestId('running-hr-zone-1')).toBeTruthy();
});

/**
 * `react-native-svg`'s `Text` renders its content inside a `TSpan`, which
 * `getByText` does not reach — so an SVG label is read through its own
 * testID rather than by searching for the string.
 */
function svgTextOf(testID: string): unknown {
  const node = screen.getByTestId(testID);
  const child = node.props.children as { props?: { children?: unknown } } | string;
  return typeof child === 'string' ? child : child?.props?.children;
}

// N491/#852 — the raw HR timeline. `lib/__tests__/hrTimeline.test.ts` already
// proves `buildHRTimeline`'s own arithmetic; these prove the component wires
// an already-built timeline in (or correctly doesn't) without inventing any
// interpretation of it.
describe('the HR timeline (N491/#852)', () => {
  test('omitting hrTimeline renders no timeline — every caller that has not wired it yet', () => {
    render(<HRSessionReport metrics={metrics()} />);
    expect(screen.queryByTestId('hr-session-report-timeline')).toBeNull();
  });

  test('an empty hrTimeline renders no timeline, same as omitting it', () => {
    render(<HRSessionReport metrics={metrics()} hrTimeline={[]} />);
    expect(screen.queryByTestId('hr-session-report-timeline')).toBeNull();
  });

  test('a single point is not a line — still no timeline', () => {
    render(<HRSessionReport metrics={metrics()} hrTimeline={[{ minutesElapsed: 0, bpm: 90 }]} />);
    expect(screen.queryByTestId('hr-session-report-timeline')).toBeNull();
  });

  test('two or more real points render the timeline chart', () => {
    render(
      <HRSessionReport
        metrics={metrics()}
        hrTimeline={[
          { minutesElapsed: 0, bpm: 90 },
          { minutesElapsed: 20, bpm: 95 },
          { minutesElapsed: 21, bpm: 150 },
        ]}
      />,
    );
    expect(screen.getByTestId('hr-session-report-timeline')).toBeTruthy();
    expect(screen.getByTestId('hr-session-report-timeline-chart')).toBeTruthy();
  });

  test('a timeline never renders in the limited state, even if the caller passed one', () => {
    // Sparse-sample sessions are exactly where a two-point line would draw a
    // shape the data cannot support — same reasoning as the zone breakdown
    // not rendering below the threshold.
    render(
      <HRSessionReport
        metrics={metrics({ sample_count: 5 })}
        hrTimeline={[
          { minutesElapsed: 0, bpm: 90 },
          { minutesElapsed: 40, bpm: 150 },
        ]}
      />,
    );
    expect(screen.queryByTestId('hr-session-report-timeline')).toBeNull();
  });

  // N545/#988 — the chart's own arithmetic lives in
  // `lib/__tests__/hrTimelineAxis.test.ts`; these prove the report hands it
  // the right inputs and says the right thing above it.
  test('the caption says 0m is the session start when the windows agree', () => {
    render(
      <HRSessionReport
        metrics={metrics({ hr_window_start: '2026-09-01T11:00:00Z', hr_window_end: '2026-09-01T12:00:00Z' })}
        sessionStartedAt="2026-09-01T11:00:00Z"
        sessionEndedAt="2026-09-01T12:00:00Z"
        hrTimeline={[
          { minutesElapsed: 0, bpm: 120 },
          { minutesElapsed: 30, bpm: 165 },
        ]}
      />,
    );
    expect(screen.getByTestId('hr-session-report-timeline-caption').props.children).toBe(
      'Heart rate across the session',
    );
  });

  test('a window that differs says so, rather than silently renumbering the axis', () => {
    // W19/#985's own shape: the watch's workout started well after the
    // session was logged, so 0m is NOT when the athlete says they started.
    render(
      <HRSessionReport
        metrics={metrics({ hr_window_start: '2026-09-01T11:40:00Z', hr_window_end: '2026-09-01T12:40:00Z' })}
        sessionStartedAt="2026-09-01T11:00:00Z"
        sessionEndedAt="2026-09-01T12:00:00Z"
        hrTimeline={[
          { minutesElapsed: 0, bpm: 120 },
          { minutesElapsed: 30, bpm: 165 },
        ]}
      />,
    );
    const caption = screen.getByTestId('hr-session-report-timeline-caption').props.children as string;
    expect(caption).toContain('Heart rate across the recording');
    expect(caption).toContain('when the readings start');
    // And the fuller both-windows diagnostic is still there underneath it.
    expect(screen.getByTestId('hr-session-report-window-note')).toBeTruthy();
  });

  test('the chart is given the session’s own HRmax and average, not left to re-derive them', () => {
    render(
      <HRSessionReport
        metrics={metrics({ hr_max_bpm: 190, avg_hr_bpm: 142 })}
        hrTimeline={[
          { minutesElapsed: 0, bpm: 120 },
          { minutesElapsed: 30, bpm: 165 },
        ]}
      />,
    );
    // The avg reference line only renders when an average was passed down.
    expect(screen.getByTestId('hr-session-report-timeline-chart-avg')).toBeTruthy();
    // Zone colouring only happens when an HRmax came with it: 120 of 190 is
    // zone 2, so the first run is a zone-2 run rather than an unzoned one.
    expect(screen.getByTestId('hr-session-report-timeline-chart-run-0-zone-2')).toBeTruthy();
  });

  test('the peak is marked, dropped to the axis and labelled with its time', () => {
    render(
      <HRSessionReport
        metrics={metrics()}
        hrTimeline={[
          { minutesElapsed: 0, bpm: 120 },
          { minutesElapsed: 18, bpm: 181 },
          { minutesElapsed: 40, bpm: 140 },
        ]}
      />,
    );
    expect(screen.getByTestId('hr-session-report-timeline-chart-peak-dot')).toBeTruthy();
    expect(screen.getByTestId('hr-session-report-timeline-chart-peak-drop')).toBeTruthy();
    expect(svgTextOf('hr-session-report-timeline-chart-peak-label')).toBe('181 bpm at 18m');
  });

  test('the time axis carries more than two ticks — the whole point of the ticket', () => {
    render(
      <HRSessionReport
        metrics={metrics()}
        hrTimeline={[
          { minutesElapsed: 0, bpm: 120 },
          { minutesElapsed: 45, bpm: 181 },
          { minutesElapsed: 88, bpm: 140 },
        ]}
      />,
    );
    // A 1h28m session: 0m / 20m / 40m / 1h / 1h 28m.
    expect(svgTextOf('hr-session-report-timeline-chart-xtick-0')).toBe('0m');
    expect(svgTextOf('hr-session-report-timeline-chart-xtick-2')).toBe('40m');
    expect(svgTextOf('hr-session-report-timeline-chart-xtick-4')).toBe('1h 28m');
  });

  test('the custom-testID namespace covers the timeline too', () => {
    render(
      <HRSessionReport
        metrics={metrics()}
        testID="running-hr"
        hrTimeline={[
          { minutesElapsed: 0, bpm: 90 },
          { minutesElapsed: 10, bpm: 130 },
        ]}
      />,
    );
    expect(screen.getByTestId('running-hr-timeline')).toBeTruthy();
  });
});

describe('W18/#957 — the no-HR card says WHICH absence this is, and offers "Sync heart rate"', () => {
  const none = async () => ({ status: 'none' as const });

  test('no absence given: the generic sentence, and no button even with a handler', () => {
    render(<HRSessionReport metrics={null} onSyncNow={none} />);
    expect(screen.getByTestId('hr-session-report-absence-loading')).toBeTruthy();
    expect(screen.queryByTestId('hr-session-report-sync-now')).toBeNull();
  });

  test("'checking': names the source, says the data is not there YET, and shows the button", () => {
    render(<HRSessionReport metrics={null} absence="checking" sourceLabel="Apple Health" onSyncNow={none} />);
    const copy = screen.getByTestId('hr-session-report-absence-checking');
    expect(copy.props.children).toMatch(/Apple Health doesn't have heart rate for this session yet/);
    expect(screen.getByTestId('hr-session-report-sync-now-button')).toBeTruthy();
    expect(screen.getByText('Sync heart rate')).toBeTruthy();
  });

  test("'sync_off': points at Settings and hides the button, handler or not", () => {
    render(<HRSessionReport metrics={null} absence="sync_off" sourceLabel="Health Connect" onSyncNow={none} />);
    expect(screen.getByTestId('hr-session-report-absence-sync_off').props.children).toMatch(/Health Connect sync in Settings/);
    expect(screen.queryByTestId('hr-session-report-sync-now')).toBeNull();
  });

  test("'gave_up' still offers the button — nothing else will look again", () => {
    render(<HRSessionReport metrics={null} absence="gave_up" sourceLabel="Apple Health" onSyncNow={none} />);
    expect(screen.getByTestId('hr-session-report-absence-gave_up')).toBeTruthy();
    expect(screen.getByTestId('hr-session-report-sync-now-button')).toBeTruthy();
  });

  test('no handler: the sentence still names the state, but there is no button to press', () => {
    render(<HRSessionReport metrics={null} absence="checking" sourceLabel="Apple Health" />);
    expect(screen.getByTestId('hr-session-report-absence-checking')).toBeTruthy();
    expect(screen.queryByTestId('hr-session-report-sync-now')).toBeNull();
  });

  test('tapping runs exactly one attempt and reports its outcome, in a sentence, under the button', async () => {
    const onSyncNow = jest.fn(none);
    render(<HRSessionReport metrics={null} absence="checking" sourceLabel="Apple Health" onSyncNow={onSyncNow} />);

    fireEvent.press(screen.getByTestId('hr-session-report-sync-now-button'));

    expect(onSyncNow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('hr-session-report-sync-outcome')).toBeTruthy());
    expect(screen.getByTestId('hr-session-report-sync-outcome').props.children).toMatch(/Still nothing in Apple Health/);
    // Back to tappable once the attempt has answered.
    expect(screen.getByText('Sync heart rate')).toBeTruthy();
  });

  test("a 'found' outcome says how many, in words, until the caller's metrics re-read replaces this card", async () => {
    const onSyncNow = jest.fn(async () => ({ status: 'found' as const, sampleCount: 40 }));
    render(<HRSessionReport metrics={null} absence="checking" sourceLabel="Apple Health" onSyncNow={onSyncNow} />);

    fireEvent.press(screen.getByTestId('hr-session-report-sync-now-button'));

    await waitFor(() => expect(screen.getByTestId('hr-session-report-sync-outcome')).toBeTruthy());
    expect(onSyncNow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('hr-session-report-sync-outcome').props.children).toMatch(/^Found 40 heart-rate samples/);
  });

  test('a handler that throws anyway lands as the error sentence, not a crash', async () => {
    const onSyncNow = jest.fn(async () => {
      throw new Error('should have been an outcome');
    });
    render(<HRSessionReport metrics={null} absence="checking" sourceLabel="Apple Health" onSyncNow={onSyncNow} />);

    fireEvent.press(screen.getByTestId('hr-session-report-sync-now-button'));

    await waitFor(() => expect(screen.getByTestId('hr-session-report-sync-outcome')).toBeTruthy());
    expect(screen.getByTestId('hr-session-report-sync-outcome').props.children).toMatch(/Couldn't check right now/);
  });
});

describe('N528/#958 — the report says where its numbers came from', () => {
  test('a source line renders under the header in the full state, with its own testID', () => {
    render(<HRSessionReport metrics={metrics()} hrSourceLine="Live over Bluetooth, from your Amazfit GTR 4 · 3 readings from Apple Health filled gaps" />);
    expect(screen.getByTestId('hr-session-report-source').props.children).toBe(
      'Live over Bluetooth, from your Amazfit GTR 4 · 3 readings from Apple Health filled gaps',
    );
  });

  test('and in the limited state (no TRIMP)', () => {
    render(<HRSessionReport metrics={metrics({ trimp: null, time_in_zones: {} })} hrSourceLine="From Apple Health afterwards" />);
    expect(screen.getByTestId('hr-session-report-source').props.children).toBe('From Apple Health afterwards');
  });

  test('no line without one, and never on the unavailable card', () => {
    render(<HRSessionReport metrics={metrics()} />);
    expect(screen.queryByTestId('hr-session-report-source')).toBeNull();
    render(<HRSessionReport metrics={null} hrSourceLine="From Apple Health afterwards" testID="r2" />);
    expect(screen.queryByTestId('r2-source')).toBeNull();
  });
});

/**
 * N535/#966 — the zones sentence reads `hr_max_source` instead of asserting
 * "estimated".
 *
 * This was hardcoded copy: `'The five zones are bands of your estimated max
 * heart rate'`, true only because nothing in the app could produce anything
 * else. Design doc §3's third step is "never silently switch between them" —
 * and a string literal does not switch at all, so the very first session
 * scored against an athlete's own measured maximum would still have described
 * itself as an estimate. That is the promise breaking in the one place it was
 * supposed to be kept.
 *
 * The sentence lives inside the InfoMark's sheet, so these open it.
 */
describe('which maximum the zones were scored against (N535)', () => {
  function openInfo(m: SessionMetrics) {
    render(<HRSessionReport metrics={m} />);
    fireEvent.press(screen.getByTestId('hr-session-report-info'));
  }

  test('an observed maximum is not described as an estimate', () => {
    openInfo(metrics({ hr_max_bpm: 191, hr_max_source: 'observed' }));
    expect(screen.getByText(/measured maximum of 191 bpm/)).toBeTruthy();
    expect(screen.queryByText(/estimated max/)).toBeNull();
    expect(screen.queryByText(/220 − your age/)).toBeNull();
  });

  test('an estimated maximum still says so, and says what makes it an estimate', () => {
    openInfo(metrics({ hr_max_bpm: 190, hr_max_source: 'estimated' }));
    expect(screen.getByText(/estimated maximum of 190 bpm/)).toBeTruthy();
    expect(screen.getByText(/220 − your age/)).toBeTruthy();
    expect(screen.queryByText(/measured maximum/)).toBeNull();
  });

  test('the zones are quoted in beats, not only as numbers 1-5', () => {
    // 190 bpm: ceil(0.5..0.9 x 190) = 95 / 114 / 133 / 152 / 171.
    openInfo(metrics({ hr_max_bpm: 190, hr_max_source: 'estimated' }));
    expect(screen.getByText(/Z1 95-113 bpm/)).toBeTruthy();
    expect(screen.getByText(/Z5 171\+ bpm/)).toBeTruthy();
  });

  test('no HRmax on the metrics quotes no beats and claims no provenance', () => {
    openInfo(metrics({ hr_max_bpm: null, hr_max_source: null }));
    expect(screen.getByText(/bands of your maximum heart rate/)).toBeTruthy();
    expect(screen.queryByText(/bpm:/)).toBeNull();
  });
});
