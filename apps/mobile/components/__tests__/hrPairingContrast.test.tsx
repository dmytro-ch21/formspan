import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { HRMonitorPairing } from '../settings/HRMonitorPairing';
import { vola } from '@/constants/Colors';
import { contrastRatio } from '@/lib/macroRings';

/**
 * N552/#1021 review — the copy this ticket exists FOR has to be legible.
 *
 * The commit under review promoted one line (`pathHeadline`) to `textMuted`
 * on an explicit contrast argument, wrote the two measurements into its own
 * doc comment, and left every paragraph underneath it on `textDim` — the
 * explanation of what to do, the one gesture that changes the report, the
 * note about wearables that can never appear in a scan, and the broadcast
 * instructions. A Settings block whose entire purpose is that an Apple Watch
 * owner stops concluding the app is broken cannot render its substance below
 * the floor this repo's own palette calls a failure.
 *
 * So this asserts the PROPERTY rather than the token: every string an athlete
 * has to read here clears 4.5:1 against the ground it is drawn on. A future
 * edit that reaches for `styles.muted` for a new paragraph fails here, which
 * is the regression a doc comment could not catch — the last two times this
 * reasoning was needed in this file (W20's `foundDetail`, N552's
 * `pathHeadline`) it was written out as a comment and the next paragraph
 * added went dim anyway.
 *
 * Measured, and the verdict does not depend on which ground:
 *   textDim   #667085   3.96:1 on bg   3.67:1 on surface   FAIL
 *   textMuted #949FB3   7.38:1 on bg   6.85:1 on surface   PASS
 */

/** WCAG AA for body text, and the number `constants/Colors.ts` calls the floor. */
const FLOOR = 4.5;

const mockBle = { supported: true };

jest.mock('@/lib/hrMonitor/liveHR', () => {
  const actual = jest.requireActual('@/lib/hrMonitor/liveHR');
  return { ...actual, isBluetoothSupported: () => mockBle.supported };
});

jest.mock('@/lib/hrMonitor/hrMonitorStore', () => ({
  readRememberedMonitor: jest.fn(async () => null),
  rememberMonitor: jest.fn(async () => {}),
  forgetMonitor: jest.fn(async () => {}),
}));

jest.mock('@/lib/hrMonitor/orchestrator', () => ({ connectIfRemembered: jest.fn(async () => {}) }));

jest.mock('@/lib/hrPathProbe', () => ({
  healthStoreHasRecentHeartRate: jest.fn(async () => true),
  HEALTH_HR_PROBE_HOURS: 24,
}));

/** The ink a rendered node actually paints, after Themed's default is merged. */
function inkOf(testID: string): string {
  const flat = StyleSheet.flatten(screen.getByTestId(testID).props.style) as { color?: string };
  expect(typeof flat.color).toBe('string');
  return flat.color as string;
}

function expectReadable(testID: string) {
  const ink = inkOf(testID);
  // Both grounds, because a settings row is drawn over `bg` and the cards
  // elsewhere in this screen over `surface` — and the darker of the two is
  // not the harder one here (a light ink on a darker ground has MORE
  // contrast), so the binding number is `surface`.
  for (const ground of [vola.bg, vola.surface]) {
    expect(contrastRatio(ink, ground)).toBeGreaterThanOrEqual(FLOOR);
  }
}

beforeEach(() => {
  mockBle.supported = true;
});

describe('the heart-rate path block is legible', () => {
  it('every line of the path answer clears the body-text floor', async () => {
    await render(<HRMonitorPairing userId="u1" healthSource="healthkit" healthSyncOn />);

    // The headline only appears once the probe has settled — before that the
    // block is deliberately a spinner rather than a guess.
    await waitFor(() => expect(screen.getByTestId('settings-hr-monitor-path-headline')).toBeTruthy());

    for (const id of [
      'settings-hr-monitor-path-headline',
      'settings-hr-monitor-path-detail',
      'settings-hr-monitor-health-tip',
      'settings-hr-monitor-non-broadcasting',
    ]) {
      expectReadable(id);
    }
  });

  it('the broadcast instructions clear it too — a step nobody can read is no step', async () => {
    const user = userEvent.setup();
    await render(<HRMonitorPairing userId="u1" healthSource="healthkit" healthSyncOn />);
    await waitFor(() => expect(screen.getByTestId('settings-hr-monitor-broadcast-toggle')).toBeTruthy());

    await user.press(screen.getByTestId('settings-hr-monitor-broadcast-toggle'));

    expectReadable('settings-hr-monitor-broadcast-rule');
    const steps = screen.getAllByTestId('settings-hr-monitor-broadcast-step');
    expect(steps.length).toBeGreaterThanOrEqual(6);
    for (const step of steps) {
      const flat = StyleSheet.flatten(step.props.style) as { color?: string };
      for (const ground of [vola.bg, vola.surface]) {
        expect(contrastRatio(flat.color as string, ground)).toBeGreaterThanOrEqual(FLOOR);
      }
    }
  });

  it('the no-Bluetooth build says why, readably — it is the only prose that branch has', async () => {
    mockBle.supported = false;
    await render(<HRMonitorPairing userId="u1" healthSource="healthkit" healthSyncOn />);

    await waitFor(() => expect(screen.getByTestId('settings-hr-monitor-no-bluetooth')).toBeTruthy());
    expectReadable('settings-hr-monitor-no-bluetooth');
    // The path block renders in this branch too, and is the only useful thing
    // it can say — so it is held to the same floor.
    await waitFor(() => expect(screen.getByTestId('settings-hr-monitor-path-headline')).toBeTruthy());
    expectReadable('settings-hr-monitor-path-detail');
  });

  /**
   * The apparatus check. If `contrastRatio` or these tokens ever stopped
   * disagreeing about `textDim`, every assertion above would pass for the
   * wrong reason — a floor nothing can fall below is not a floor.
   */
  it('the floor can actually fail: textDim is what the promoted lines were', () => {
    expect(contrastRatio(vola.textDim, vola.bg)).toBeLessThan(FLOOR);
    expect(contrastRatio(vola.textDim, vola.surface)).toBeLessThan(FLOOR);
    expect(contrastRatio(vola.textMuted, vola.surface)).toBeGreaterThanOrEqual(FLOOR);
  });
});
