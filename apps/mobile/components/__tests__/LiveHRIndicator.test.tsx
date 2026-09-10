import { act, render, screen } from '@testing-library/react-native';

import { LiveHRIndicator } from '../LiveHRIndicator';
import { __dispatchLiveHRForTests } from '@/lib/hrMonitor/liveHR';

/**
 * N528/#958 — what the indicator SAYS for each live state, driven through
 * the store's test seam (no Bluetooth in jest; `react-native-ble-plx` has no
 * native module here, and the component never touches it directly).
 */

const dev = { id: 'dev-1', name: 'Amazfit GTR 4' };
const now = () => new Date().toISOString();

beforeEach(async () => {
  await act(() => __dispatchLiveHRForTests({ type: 'stop' }));
});

describe('LiveHRIndicator', () => {
  test('renders nothing at all when no monitor is in play — a session without one is unchanged', async () => {
    await render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.queryByTestId('live-hr')).toBeNull();
    await act(() => __dispatchLiveHRForTests({ type: 'unsupported' }));
    expect(screen.queryByTestId('live-hr')).toBeNull();
  });

  test('connecting: says so, with the monitor named, before any number exists', async () => {
    await act(() => __dispatchLiveHRForTests({ type: 'start', device: dev }));
    await render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('—');
    expect(screen.getByTestId('live-hr-status').props.children).toMatch(/Connecting to Amazfit GTR 4/);
  });

  test('a fresh reading shows the number and its zone against the given HRmax', async () => {
    await act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'connected' });
      __dispatchLiveHRForTests({ type: 'reading', bpm: 165, at: now() });
    });
    await render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('165');
    expect(screen.getByTestId('live-hr-zone').props.children).toEqual(['Z', 4]);
  });

  test('no HRmax: the number renders without a zone rather than against a guessed ceiling', async () => {
    await act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'reading', bpm: 165, at: now() });
    });
    await render(<LiveHRIndicator hrMaxBPM={null} />);
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('165');
    expect(screen.queryByTestId('live-hr-zone')).toBeNull();
  });

  test('a drop keeps the last number on screen, says "disconnected — reconnecting", and shows no zone for a stale value', async () => {
    await act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'reading', bpm: 150, at: now() });
      __dispatchLiveHRForTests({ type: 'dropped' });
    });
    await render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('150');
    expect(screen.getByTestId('live-hr-status').props.children).toMatch(/disconnected — reconnecting/);
    expect(screen.queryByTestId('live-hr-zone')).toBeNull();
    expect(screen.queryByTestId('live-hr-retry')).toBeNull();
  });

  test('gave up: "disconnected" plus a Reconnect control — never silence', async () => {
    await act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'gave_up' });
    });
    await render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.getByTestId('live-hr-status').props.children).toMatch(/Monitor disconnected/);
    expect(screen.getByTestId('live-hr-retry')).toBeTruthy();
  });

  test('card variant carries the same number, the monitor name, and a big-number layout', async () => {
    await act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'reading', bpm: 122, at: now() });
    });
    await render(<LiveHRIndicator variant="card" hrMaxBPM={200} testID="today-live-hr" />);
    expect(screen.getByTestId('today-live-hr-bpm').props.children).toBe('122');
    expect(screen.getByTestId('today-live-hr-zone').props.children).toEqual(['zone ', 2]);
    expect(screen.getByText('Amazfit GTR 4')).toBeTruthy();
  });
});
