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

beforeEach(() => {
  act(() => __dispatchLiveHRForTests({ type: 'stop' }));
});

describe('LiveHRIndicator', () => {
  test('renders nothing at all when no monitor is in play — a session without one is unchanged', () => {
    render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.queryByTestId('live-hr')).toBeNull();
    act(() => __dispatchLiveHRForTests({ type: 'unsupported' }));
    expect(screen.queryByTestId('live-hr')).toBeNull();
  });

  test('connecting: says so, with the monitor named, before any number exists', () => {
    act(() => __dispatchLiveHRForTests({ type: 'start', device: dev }));
    render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('—');
    expect(screen.getByTestId('live-hr-status').props.children).toMatch(/Connecting to Amazfit GTR 4/);
  });

  test('a fresh reading shows the number and its zone against the given HRmax', () => {
    act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'connected' });
      __dispatchLiveHRForTests({ type: 'reading', bpm: 165, at: now() });
    });
    render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('165');
    expect(screen.getByTestId('live-hr-zone').props.children).toEqual(['Z', 4]);
  });

  test('no HRmax: the number renders without a zone rather than against a guessed ceiling', () => {
    act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'reading', bpm: 165, at: now() });
    });
    render(<LiveHRIndicator hrMaxBPM={null} />);
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('165');
    expect(screen.queryByTestId('live-hr-zone')).toBeNull();
  });

  test('a drop keeps the last number on screen, says "disconnected — reconnecting", and shows no zone for a stale value', () => {
    act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'reading', bpm: 150, at: now() });
      __dispatchLiveHRForTests({ type: 'dropped' });
    });
    render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.getByTestId('live-hr-bpm').props.children).toBe('150');
    expect(screen.getByTestId('live-hr-status').props.children).toMatch(/disconnected — reconnecting/);
    expect(screen.queryByTestId('live-hr-zone')).toBeNull();
    expect(screen.queryByTestId('live-hr-retry')).toBeNull();
  });

  test('gave up: "disconnected" plus a Reconnect control — never silence', () => {
    act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'gave_up' });
    });
    render(<LiveHRIndicator hrMaxBPM={200} />);
    expect(screen.getByTestId('live-hr-status').props.children).toMatch(/Monitor disconnected/);
    expect(screen.getByTestId('live-hr-retry')).toBeTruthy();
  });

  test('card variant carries the same number, the monitor name, and a big-number layout', () => {
    act(() => {
      __dispatchLiveHRForTests({ type: 'start', device: dev });
      __dispatchLiveHRForTests({ type: 'reading', bpm: 122, at: now() });
    });
    render(<LiveHRIndicator variant="card" hrMaxBPM={200} testID="today-live-hr" />);
    expect(screen.getByTestId('today-live-hr-bpm').props.children).toBe('122');
    expect(screen.getByTestId('today-live-hr-zone').props.children).toEqual(['zone ', 2]);
    expect(screen.getByText('Amazfit GTR 4')).toBeTruthy();
  });
});
