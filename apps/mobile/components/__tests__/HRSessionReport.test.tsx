import { render, screen } from '@testing-library/react-native';

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
