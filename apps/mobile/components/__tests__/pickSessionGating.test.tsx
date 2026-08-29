import { fireEvent, render, screen } from '@testing-library/react-native';

import { PickSessionSheet } from '../ui/PickSessionSheet';
import type { Module } from '@/lib/modules';

/**
 * N61 — "bjj logging is not there".
 *
 * The user reported that from a real phone. It was there; BJJ was turned off,
 * so it was absent from this sheet and nothing said why.
 *
 * **This sheet is the only ad-hoc route to BJJ logging.** `/bjj/log` is linked
 * from exactly one other place in the app — tapping a PLANNED BJJ session on
 * Today — so with the discipline off and nothing planned, the feature has no
 * entry point at all. An absent row here is the whole thing gone.
 *
 * The destination screen already explains itself properly ("BJJ tracking is
 * off. Turn it back on under What you train in your profile" — see N471/
 * #471, which fixed this sentence's destination in all seven places it was
 * rendered). Nothing linked to it, so the athlete never reached the screen
 * that would say so.
 */

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn() }),
}));

jest.mock('@/lib/sessionStore', () => ({
  cachedWorkouts: jest.fn(async () => []),
}));

function mod(over: Partial<Module> & { key: string }): Module {
  return {
    key: over.key,
    label: over.label ?? over.key,
    is_sport: over.is_sport ?? true,
    default_on: true,
    enabled: over.enabled ?? true,
    capabilities: {
      catalog: '', facets: [], has_goals: false, has_progression: false,
      has_food_log: false, record_kinds: [],
    },
  };
}

const strength = mod({ key: 'strength', label: 'Strength' });
const bjjOff = mod({ key: 'bjj', label: 'BJJ', enabled: false });
const nutritionOff = mod({ key: 'nutrition', label: 'Nutrition', is_sport: false, enabled: false });

function show(modules: Module[]) {
  return render(
    <PickSessionSheet
      visible
      modules={modules}
      userId="u1"
      title="Start something"
      onPick={jest.fn()}
      onClose={jest.fn()}
    />,
  );
}

beforeEach(() => mockPush.mockClear());

it('names the discipline that is turned off instead of just omitting it', () => {
  show([strength, bjjOff]);
  // The row exists AND names BJJ. "1 discipline is off" would not tell an
  // athlete it is the one they were looking for.
  expect(screen.getByTestId('pick-disabled-sports')).toBeTruthy();
  expect(screen.getByText(/BJJ/)).toBeTruthy();
});

it('leads somewhere that can actually turn it on', () => {
  show([strength, bjjOff]);
  fireEvent.press(screen.getByTestId('pick-disabled-sports'));
  // A row that explains but cannot act is the same dead end as the Sports row
  // in You, which displayed the answer and was inert.
  expect(mockPush).toHaveBeenCalledWith('/profile/edit');
});

it('says nothing when every discipline is already on', () => {
  show([strength, mod({ key: 'bjj', label: 'BJJ' })]);
  expect(screen.queryByTestId('pick-disabled-sports')).toBeNull();
});

// Nutrition is a module you can turn off, and "log a nutrition session" is
// nonsense — so offering to turn it on from a SESSION picker would be too.
it('does not offer to turn on something you cannot log a session for', () => {
  show([strength, nutritionOff]);
  expect(screen.queryByTestId('pick-disabled-sports')).toBeNull();
});

// With nothing enabled the sheet already says "You haven't chosen what you
// train yet". Two prompts saying the same thing is worse than one.
it('defers to the existing empty state when nothing is on at all', () => {
  show([bjjOff, mod({ key: 'strength', label: 'Strength', enabled: false })]);
  expect(screen.queryByTestId('pick-disabled-sports')).toBeNull();
  expect(screen.getByText(/haven't chosen what you train/i)).toBeTruthy();
});
