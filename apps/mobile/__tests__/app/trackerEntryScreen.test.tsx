import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import TrackerEntryScreen from '../../app/trackers/entry/[id]';
import type { Tracker } from '@/lib/trackerModel';
import { toDisplayFluid } from '@/lib/units';

/**
 * N437: the screen a long press on a filled glyph opens.
 *
 * The storage functions are mocked here because `lib/__tests__/trackers.test.ts`
 * owns what they write, against real SQLite. What this pins is the screen's own
 * decisions: the unit it shows, that an untouched field writes nothing, which
 * edit a coffee tap goes through, and what it refuses.
 */

const mockUseEffect = useEffect;
const mockBack = jest.fn();
let mockUnits: 'metric' | 'imperial' = 'metric';
let mockId = 'e1';
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
}));
jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));
jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({ units: mockUnits, unitsReady: true, setUnits: jest.fn(), unsynced: false }),
}));
jest.mock('@/lib/AccentProvider', () => ({ useAccent: () => ({ accent: '#8BC34A', on: '#000' }) }));
const mockRequestSync = jest.fn();
jest.mock('@/lib/sync', () => ({ request: (...a: unknown[]) => mockRequestSync(...a) }));
const mockLocalEntry = jest.fn();
const mockLocalTrackers = jest.fn();
const mockEditTap = jest.fn(async () => {});
const mockEditCoffeeTap = jest.fn(async () => {});
jest.mock('@/lib/trackers', () => ({
  localEntry: (...a: unknown[]) => mockLocalEntry(...a),
  localTrackers: (...a: unknown[]) => mockLocalTrackers(...a),
  editTap: (...a: unknown[]) => mockEditTap(...(a as [])),
  editCoffeeTap: (...a: unknown[]) => mockEditCoffeeTap(...(a as [])),
}));

const water: Tracker = {
  id: 'wat', preset: 'water', name: 'Water', icon: '💧', color_key: 'water', unit: 'ml',
  increment: 250, target: 2000, render_style: 'glyphs', sort_order: 10, count_noun: 'cup',
  provisioned: true, cutoff_minutes: null,
};
const coffee: Tracker = {
  id: 'cof', preset: 'coffee', name: 'Coffee', icon: '☕', color_key: 'coffee', unit: 'cup',
  increment: 1, target: null, render_style: 'auto', sort_order: 20, count_noun: 'cup',
  provisioned: false, cutoff_minutes: null,
};

function entry(id: string, trackerId: string, amount: number) {
  return { id, tracker_id: trackerId, logged_on: '2026-08-20', logged_at: '2026-08-20T09:00:00.000Z', amount };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUnits = 'metric';
  mockId = 'e1';
  mockLocalTrackers.mockResolvedValue({ state: 'ready', trackers: [water, coffee] });
});

async function field() {
  await waitFor(() => expect(screen.getByTestId('tracker-entry-amount')).toBeTruthy());
  return screen.getByTestId('tracker-entry-amount');
}

test('shows the amount in the athlete\'s unit and saves a typed correction', async () => {
  mockLocalEntry.mockResolvedValue(entry('e1', 'wat', 250));
  await render(<TrackerEntryScreen />);
  expect((await field()).props.value).toBe('250');

  await fireEvent.changeText(screen.getByTestId('tracker-entry-amount'), '500');
  await fireEvent.press(screen.getByTestId('tracker-entry-save'));

  await waitFor(() => expect(mockBack).toHaveBeenCalled());
  expect(mockEditTap).toHaveBeenCalledWith('u1', 'e1', 500);
  expect(mockEditCoffeeTap).not.toHaveBeenCalled();
  expect(mockRequestSync).toHaveBeenCalled();
});

test('opening a glass and saving without typing writes nothing, even when fl oz rounds', async () => {
  mockUnits = 'imperial';
  mockLocalEntry.mockResolvedValue(entry('e1', 'wat', 250));
  await render(<TrackerEntryScreen />);
  expect((await field()).props.value).toBe(String(toDisplayFluid(250, 'imperial')));

  await fireEvent.press(screen.getByTestId('tracker-entry-save'));

  await waitFor(() => expect(mockBack).toHaveBeenCalled());
  expect(mockEditTap).not.toHaveBeenCalled();
  expect(mockRequestSync).not.toHaveBeenCalled();
});

test('a coffee correction goes through the edit that scales its caffeine', async () => {
  mockId = 'c1';
  mockLocalEntry.mockResolvedValue(entry('c1', 'cof', 1));
  await render(<TrackerEntryScreen />);
  await field();
  expect(screen.getByTestId('tracker-entry-caffeine-hint')).toBeTruthy();

  await fireEvent.changeText(screen.getByTestId('tracker-entry-amount'), '2');
  await fireEvent.press(screen.getByTestId('tracker-entry-save'));

  await waitFor(() => expect(mockEditCoffeeTap).toHaveBeenCalledWith('u1', 'c1', 2));
  expect(mockEditTap).not.toHaveBeenCalled();
});

test('refuses an amount that is not above zero, and stays open', async () => {
  mockLocalEntry.mockResolvedValue(entry('e1', 'wat', 250));
  await render(<TrackerEntryScreen />);
  await field();

  await fireEvent.changeText(screen.getByTestId('tracker-entry-amount'), '0');
  await fireEvent.press(screen.getByTestId('tracker-entry-save'));

  await waitFor(() => expect(screen.getByTestId('tracker-entry-error')).toBeTruthy());
  expect(screen.getByTestId('tracker-entry-error').props.children).toBe('Enter an amount greater than zero.');
  expect(mockEditTap).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

test('a tap that is gone says so rather than showing an empty field', async () => {
  mockLocalEntry.mockResolvedValue(null);
  await render(<TrackerEntryScreen />);
  await waitFor(() => expect(screen.getByTestId('tracker-entry-missing')).toBeTruthy());
  expect(screen.queryByTestId('tracker-entry-amount')).toBeNull();
});

// N578: the caffeine banner opens this screen too, for three kinds of dose.
describe('a caffeine dose', () => {
  const caffeine: Tracker = {
    id: 'caf', preset: 'caffeine', name: 'Caffeine', icon: '⚡', color_key: 'amber', unit: 'mg',
    increment: 80, target: 400, render_style: 'glyphs', sort_order: 30, count_noun: 'cup',
    provisioned: false, cutoff_minutes: 960,
  };
  const { pairedFoodCaffeineEntryId } = jest.requireActual('@/lib/foodCaffeine');

  beforeEach(() => {
    mockLocalTrackers.mockResolvedValue({ state: 'ready', trackers: [water, coffee, caffeine] });
  });

  test('a manual dose corrects through the plain edit', async () => {
    mockId = 'm1';
    mockLocalEntry.mockResolvedValue(entry('m1', 'caf', 80));
    await render(<TrackerEntryScreen />);
    expect((await field()).props.value).toBe('80');
    expect(screen.queryByTestId('tracker-entry-coffee-caffeine-hint')).toBeNull();

    await fireEvent.changeText(screen.getByTestId('tracker-entry-amount'), '150');
    await fireEvent.press(screen.getByTestId('tracker-entry-save'));

    await waitFor(() => expect(mockEditTap).toHaveBeenCalledWith('u1', 'm1', 150));
    expect(mockEditCoffeeTap).not.toHaveBeenCalled();
  });

  test('a coffee-caused dose corrects directly, and says the cups are untouched', async () => {
    mockId = 'c1-caf';
    mockLocalEntry.mockResolvedValue(entry('c1-caf', 'caf', 95));
    await render(<TrackerEntryScreen />);
    await field();
    expect(screen.getByTestId('tracker-entry-coffee-caffeine-hint')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('tracker-entry-amount'), '150');
    await fireEvent.press(screen.getByTestId('tracker-entry-save'));

    await waitFor(() => expect(mockEditTap).toHaveBeenCalledWith('u1', 'c1-caf', 150));
    expect(mockEditCoffeeTap).not.toHaveBeenCalled();
  });

  test('a food-caused dose offers no field, says where to change it, and writes nothing', async () => {
    const id = pairedFoodCaffeineEntryId('food-1', 'abcdef12');
    mockId = id;
    mockLocalEntry.mockResolvedValue(entry(id, 'caf', 95));
    await render(<TrackerEntryScreen />);

    await waitFor(() => expect(screen.getByTestId('tracker-entry-food-caffeine')).toBeTruthy());
    expect(screen.getByTestId('tracker-entry-food-caffeine').props.children).toContain('in Food');
    expect(screen.queryByTestId('tracker-entry-amount')).toBeNull();
    expect(screen.queryByTestId('tracker-entry-save')).toBeNull();
    expect(mockEditTap).not.toHaveBeenCalled();
  });
});
