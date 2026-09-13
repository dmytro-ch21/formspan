import { AccessibilityInfo } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { TrackerCard } from '../TrackerCard';
import type { Tracker, TrackerEntry } from '@/lib/trackerModel';

/**
 * N437: a logged tap can be corrected from the card.
 *
 * The render path only — what the long press and the accessibility action are
 * wired to. What the correction writes is `lib/__tests__/trackers.test.ts`, and
 * the screen it opens is `trackerEntryScreen.test.tsx`.
 */

jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});

const water: Tracker = {
  id: 'wat',
  preset: 'water',
  name: 'Water',
  icon: '💧',
  color_key: 'water',
  unit: 'ml',
  increment: 250,
  target: 2000,
  render_style: 'glyphs',
  sort_order: 10,
  count_noun: 'cup',
  provisioned: true,
  cutoff_minutes: null,
};

const entries: TrackerEntry[] = [0, 1, 2].map((i) => ({
  id: `e${i}`,
  tracker_id: 'wat',
  logged_on: '2026-08-20',
  logged_at: `2026-08-20T0${8 + i}:00:00.000Z`,
  amount: 250,
}));

async function renderCard(over: Partial<React.ComponentProps<typeof TrackerCard>> = {}) {
  const onAdd = jest.fn();
  const onRemove = jest.fn();
  const onEditEntry = jest.fn();
  await render(
    <TrackerCard
      tracker={water}
      entries={entries}
      units="metric"
      unitsReady
      onAdd={onAdd}
      onRemove={onRemove}
      onEdit={() => {}}
      onEditEntry={onEditEntry}
      {...over}
    />,
  );
  return { onAdd, onRemove, onEditEntry };
}

test('a long press on a filled glyph opens the correction for THAT tap, and removes nothing', async () => {
  const { onRemove, onEditEntry } = await renderCard();
  await fireEvent(screen.getByTestId('tracker-glyph-wat-1'), 'longPress');
  expect(onEditEntry).toHaveBeenCalledWith('e1');
  expect(onRemove).not.toHaveBeenCalled();
});

test('a long press on an empty glyph does nothing, because there is no tap to correct', async () => {
  const { onAdd, onEditEntry } = await renderCard();
  await fireEvent(screen.getByTestId('tracker-glyph-wat-5'), 'longPress');
  expect(onEditEntry).not.toHaveBeenCalled();
  expect(onAdd).not.toHaveBeenCalled();
});

test('the correction is a named accessibility action on a filled glyph, and the hint says so', async () => {
  const { onEditEntry } = await renderCard();
  const filled = screen.getByTestId('tracker-glyph-wat-0');
  expect(filled.props.accessibilityActions).toEqual([{ name: 'longpress', label: 'Change amount' }]);
  expect(filled.props.accessibilityHint).toBe('Double tap to remove it. Change amount is in actions');
  expect(screen.getByTestId('tracker-glyph-wat-5').props.accessibilityActions).toBeUndefined();

  await fireEvent(filled, 'accessibilityAction', { nativeEvent: { actionName: 'longpress' } });
  expect(onEditEntry).toHaveBeenCalledWith('e0');
});

test('a tap on a filled glyph still removes it, whether or not a correction is offered', async () => {
  const { onRemove, onEditEntry } = await renderCard();
  await fireEvent.press(screen.getByTestId('tracker-glyph-wat-2'));
  expect(onRemove).toHaveBeenCalledWith('e2');
  expect(onEditEntry).not.toHaveBeenCalled();
});

test('a card with no correction behaves exactly as before', async () => {
  const { onRemove } = await renderCard({ onEditEntry: undefined });
  const filled = screen.getByTestId('tracker-glyph-wat-0');
  expect(filled.props.accessibilityActions).toBeUndefined();
  expect(filled.props.accessibilityHint).toBe('Double tap to remove it');
  await fireEvent.press(filled);
  expect(onRemove).toHaveBeenCalledWith('e0');
});
