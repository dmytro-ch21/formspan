import { render, screen } from '@testing-library/react-native';

import TrainScreen from '../../app/(tabs)/train';

/**
 * Train is retired — the ABSENCE half of N182's pair.
 *
 * The reassignment this file covers is only half asserted by the Plan-side
 * test (`app/__tests__/planNextUp.test.tsx`, which proves Plan draws the
 * forward schedule). A move that is really a COPY satisfies that file
 * perfectly, and this repo has shipped exactly that twice — W2 and W4 — so
 * absence is asserted here, from the other side, against the same names.
 *
 * What must stay true:
 *
 * - the route still RESOLVES and still renders. `lib/tabs.ts` keeps `train` in
 *   `OFF_BAR_ROUTES`, so `vola://train` and any in-flight `router.push` land
 *   here; a screen that threw or rendered nothing would break both silently.
 * - it renders none of the four blocks it used to. Each is drawn by a screen
 *   that has a tab button — see the audit table in `app/(tabs)/train.tsx`.
 *
 * `expo-router` is re-mocked here rather than leaning on `jest.setup.js`,
 * because the shared mock deliberately exports only what every screen needs and
 * `Redirect` is not in it. Rendering it as an identifiable element is what lets
 * the destination be asserted at all — a `null` stub would make "redirects to
 * Today" and "renders nothing" the same observation.
 */

jest.setTimeout(30_000);

jest.mock('expo-router', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Redirect: ({ href }: { href: string }) =>
      react.createElement(Text, { testID: 'redirect', accessibilityLabel: String(href) }, String(href)),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useFocusEffect: (cb: () => void | (() => void)) => react.useEffect(cb, [cb]),
  };
});

it('sends anything that still links to Train to Today', () => {
  render(<TrainScreen />);
  // Today, not Plan: an old `vola://train` link was tapped by somebody who
  // wanted to train, and Today is the screen holding the resume card, the
  // day's planned sessions and New log.
  expect(screen.getByTestId('redirect').props.children).toBe('/(tabs)');
});

it('renders none of the four blocks it used to', () => {
  render(<TrainScreen />);

  // The schedule — moved to Plan, and the reason this file exists. Asserted by
  // the testIDs the old screen used, so reinstating any of them fails here
  // rather than quietly giving the app a second forward schedule.
  expect(screen.queryByTestId('train-later')).toBeNull();
  expect(screen.queryByTestId('train-recent-none')).toBeNull();
  // Today's plan and Quick start — dropped, because Today draws both.
  expect(screen.queryByTestId('train-today-none')).toBeNull();
  expect(screen.queryByTestId('train-quick-start')).toBeNull();
  // Resume — dropped, because Today's `resume-session` card is the same card
  // off the same 24-hour constant.
  expect(screen.queryByTestId('train-resume')).toBeNull();
  // And no headings left behind by a block that was gutted but not removed.
  expect(screen.queryByText('Later')).toBeNull();
  expect(screen.queryByText('Recent')).toBeNull();
  expect(screen.queryByText('Quick start')).toBeNull();
});
