import { fireEvent, render, screen } from '@testing-library/react-native';

import { StepsPermissionRow } from '@/components/settings/StepsPermissionRow';
import { recordStepsOutcome, writeStepsAsked } from '@/lib/steps';
import { migratedFixture, type FixtureDb } from '@/lib/__tests__/support/sqlite';

/**
 * The deliberate ask for steps — N569 (#1130). A permission already granted
 * does not cover a new type, so an existing install is asked again HERE, with
 * copy saying why, and never by a foreground pass. Rendered over real SQLite.
 */

let mockFixture: FixtureDb;
jest.mock('../../lib/db', () => {
  const real = jest.requireActual('../../lib/db');
  return { ...real, getDb: async () => mockFixture };
});
jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, [cb]) };
});
jest.mock('@/lib/AccentProvider', () => ({ useAccent: () => ({ accent: '#5B8CFF', ink: '#8FB0FF', on: '#FFFFFF' }) }));
jest.mock('@/components/ui/PressableScale', () => {
  const { Pressable } = jest.requireActual('react-native');
  return { PressableScale: Pressable };
});

const USER = 'u1';

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

describe('StepsPermissionRow (N569, #1130)', () => {
  it('before asking: says what steps are for, where they come from, that they stay on the phone, and that the platform asks once', async () => {
    const onAsk = jest.fn(() => Promise.resolve());

    await render(<StepsPermissionRow userId={USER} source="healthkit" onAsk={onAsk} />);

    expect(
      await screen.findByText(
        "Show today's step count on VOLA. VOLA reads it from Apple Health, keeps it on this phone, and never writes anything back. Steps is a separate permission from workouts and heart rate, so Apple Health will ask you once.",
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-steps-allow'));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Allow steps')).toBeTruthy();
  });

  it('asked and reading: says so, and does not ask again', async () => {
    await writeStepsAsked(USER);
    await recordStepsOutcome(USER, 'healthkit', { kind: 'steps', steps: 8412 }, new Date());

    await render(<StepsPermissionRow userId={USER} source="healthkit" onAsk={jest.fn()} />);

    expect(await screen.findByText("Reading steps from Apple Health. Today's count shows on VOLA.")).toBeTruthy();
    expect(screen.queryByTestId('settings-steps-allow')).toBeNull();
  });

  it('refused on iOS: names where the switch is, and offers no button that would do nothing', async () => {
    await writeStepsAsked(USER);
    await recordStepsOutcome(USER, 'healthkit', { kind: 'refused' }, new Date());

    await render(<StepsPermissionRow userId={USER} source="healthkit" onAsk={jest.fn()} />);

    expect(
      await screen.findByText(
        "Apple Health isn't sharing steps with VOLA. To change it, open the Settings app, then Privacy & Security, Health, VOLA, and turn on Steps.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('settings-steps-allow')).toBeNull();
  });

  it('refused on Android: offers to ask again', async () => {
    await writeStepsAsked(USER);
    await recordStepsOutcome(USER, 'health_connect', { kind: 'refused' }, new Date());

    await render(<StepsPermissionRow userId={USER} source="health_connect" onAsk={jest.fn()} />);

    expect(await screen.findByText('Ask again')).toBeTruthy();
  });
});
