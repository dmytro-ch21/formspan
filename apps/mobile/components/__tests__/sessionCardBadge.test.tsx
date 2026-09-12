import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import { SessionCard } from '@/components/SessionCard';
import type { CardData } from '@/lib/sessionCard';

/**
 * F60 (#1160) — a badge pill may shorten the exercise NAME, never the evidence.
 *
 * The pill is capped at 62% of the card. It used to be one `numberOfLines={1}`
 * string, and React Native truncates from the end, which is where
 * "(2 assisted)" and "PR" sit. So a long catalog name plus an assisted PR could
 * cut exactly the words F59 (#1156) added to stop the card overstating a set.
 *
 * Jest cannot measure text, so this pins the STRUCTURE that decides what gives
 * way: the name is its own single-line text that shrinks first, and the
 * evidence is a text with no line limit that does not shrink. Whether the
 * exported PNG looks right at 1080px is the device check on #1160.
 */

const LONGEST = 'One-Arm Single-Leg Dumbbell Romanian Deadlift · ';

const card = (over: Partial<CardData> = {}): CardData => ({
  id: 'session-1',
  sport: 'strength',
  title: 'Lower — Squat & Hinge',
  eyebrow: 'STRENGTH',
  dateLabel: '9 AUG',
  stats: [],
  badges: [],
  ...over,
});

const styleOf = (testID: string, index = 0) =>
  StyleSheet.flatten(screen.getAllByTestId(testID)[index].props.style);

it('keeps the evidence, assisted note and "PR" in a text that is never truncated', async () => {
  await render(
    <SessionCard
      data={card({ badges: [{ lead: LONGEST, tail: '152kg × 5 (2 assisted) PR' }] })}
      width={360}
    />,
  );

  const tail = screen.getByTestId('session-card-badge-tail');
  expect(tail.props.children).toBe('152kg × 5 (2 assisted) PR');
  // No line limit, so nothing is cut with an ellipsis; it wraps instead.
  expect(tail.props.numberOfLines).toBeUndefined();
  // It does not give up width to the name, and may take the whole pill.
  expect(styleOf('session-card-badge-tail')).toMatchObject({ flexShrink: 0, maxWidth: '100%' });
});

it('lets only the exercise name shorten, on one line', async () => {
  await render(
    <SessionCard
      data={card({ badges: [{ lead: LONGEST, tail: '152kg × 5 (2 assisted) PR' }] })}
      width={360}
    />,
  );

  const lead = screen.getByTestId('session-card-badge-lead');
  expect(lead.props.children).toBe(LONGEST);
  expect(lead.props.numberOfLines).toBe(1);
  expect(styleOf('session-card-badge-lead')).toMatchObject({ flexShrink: 1 });
  // Side by side, so the shrinking is between these two and nothing else.
  expect(styleOf('session-card-badge')).toMatchObject({ flexDirection: 'row', alignItems: 'flex-start' });
});

it('reads the whole badge once to a screen reader, whatever was cut on screen', async () => {
  await render(
    <SessionCard
      data={card({ badges: [{ lead: 'Back Squat · ', tail: '152kg × 5 (2 assisted) PR' }] })}
      width={360}
    />,
  );

  const pill = screen.getByTestId('session-card-badge');
  expect(pill.props.accessible).toBe(true);
  expect(pill.props.accessibilityLabel).toBe('Back Squat · 152kg × 5 (2 assisted) PR');
});

it('renders a badge with nothing to shorten, like the streak, as the tail alone', async () => {
  await render(
    <SessionCard
      data={card({
        badges: [{ lead: 'Back Squat · ', tail: '152kg × 5 PR' }, { tail: '4 weeks unbroken' }],
      })}
      width={360}
    />,
  );

  expect(screen.getAllByTestId('session-card-badge')).toHaveLength(2);
  expect(screen.getAllByTestId('session-card-badge-lead')).toHaveLength(1);
  const tails = screen.getAllByTestId('session-card-badge-tail').map((t) => t.props.children);
  expect(tails).toEqual(['152kg × 5 PR', '4 weeks unbroken']);
  expect(screen.getAllByTestId('session-card-badge')[1].props.accessibilityLabel).toBe('4 weeks unbroken');
});
