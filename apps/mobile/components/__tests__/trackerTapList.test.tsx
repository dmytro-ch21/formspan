import { AccessibilityInfo } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { TrackerCard } from '../TrackerCard';
import type { Tracker, TrackerEntry } from '@/lib/trackerModel';

/**
 * N578: a bar-style card's taps can each be corrected and removed.
 *
 * Rendered through `TrackerCard` rather than `TrackerTapList` alone, because the
 * property is that a card which draws a BAR offers the list, and a card which
 * draws glyphs does not need one. What the correction writes is
 * `lib/__tests__/trackers.test.ts`; which remove a coffee row uses is
 * `trackerList.test.tsx`.
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

const taps = (n: number): TrackerEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    tracker_id: 'wat',
    logged_on: '2026-08-20',
    logged_at: '2026-08-20T16:05:00.000Z',
    amount: 250,
  }));

async function renderCard(over: Partial<React.ComponentProps<typeof TrackerCard>> = {}) {
  const onRemove = jest.fn();
  const onEditEntry = jest.fn();
  await render(
    <TrackerCard
      tracker={water}
      // Fifteen of eight: past the twelve-glyph cap, so the card is a bar.
      entries={taps(15)}
      units="metric"
      unitsReady
      onAdd={() => {}}
      onRemove={onRemove}
      onEdit={() => {}}
      onEditEntry={onEditEntry}
      {...over}
    />,
  );
  return { onRemove, onEditEntry };
}

async function openList() {
  await fireEvent.press(screen.getByTestId('tracker-taps-toggle-wat'));
}

test('a bar card offers its taps behind a closed disclosure that states the count', async () => {
  await renderCard();
  // The apparatus: this IS the bar rendering, not glyphs.
  expect(screen.getByTestId('tracker-bar-wat')).toBeTruthy();

  const toggle = screen.getByTestId('tracker-taps-toggle-wat');
  expect(toggle.props.accessibilityLabel).toBe('Show all 15 cups');
  expect(toggle.props.accessibilityState).toEqual({ expanded: false });
  expect(screen.queryByTestId('tracker-taps-wat')).toBeNull();

  await openList();
  expect(screen.getByTestId('tracker-taps-wat')).toBeTruthy();
  expect(screen.getByTestId('tracker-taps-toggle-wat').props.accessibilityLabel).toBe('Hide the cups');
  expect(screen.getByTestId('tracker-taps-toggle-wat').props.accessibilityState).toEqual({ expanded: true });

  await openList();
  expect(screen.queryByTestId('tracker-taps-wat')).toBeNull();
});

test('a row opens the correction for THAT tap, and removes nothing', async () => {
  const { onRemove, onEditEntry } = await renderCard();
  await openList();

  const row = screen.getByTestId('tracker-tap-edit-e3');
  expect(row.props.accessibilityLabel).toBe('Water, 250 ml at 09:05');
  await fireEvent.press(row);

  expect(onEditEntry).toHaveBeenCalledWith('e3');
  expect(onRemove).not.toHaveBeenCalled();
});

test('a row\'s × removes THAT tap, and opens nothing', async () => {
  const { onRemove, onEditEntry } = await renderCard();
  await openList();

  const remove = screen.getByTestId('tracker-tap-remove-e4');
  expect(remove.props.accessibilityLabel).toBe('Remove 250 ml at 09:05 from Water');
  await fireEvent.press(remove);

  expect(onRemove).toHaveBeenCalledWith('e4');
  expect(onEditEntry).not.toHaveBeenCalled();
});

test('the rows follow the fluid preference', async () => {
  await renderCard({ units: 'imperial' });
  await openList();
  expect(screen.getByTestId('tracker-tap-edit-e0').props.accessibilityLabel).toBe('Water, 8.5 fl oz at 09:05');
});

test('no row names an amount before the unit preference is read', async () => {
  await renderCard({ unitsReady: false });
  await openList();
  expect(screen.queryByTestId('tracker-taps-wat')).toBeNull();
});

test('without a correction the rows still remove, and offer nothing else', async () => {
  const { onRemove } = await renderCard({ onEditEntry: undefined });
  await openList();
  expect(screen.queryByTestId('tracker-tap-edit-e0')).toBeNull();
  await fireEvent.press(screen.getByTestId('tracker-tap-remove-e0'));
  expect(onRemove).toHaveBeenCalledWith('e0');
});

test('a glyph card has no list, because every tap already has its glyph', async () => {
  await renderCard({ entries: taps(3) });
  expect(screen.getByTestId('tracker-glyph-wat-0')).toBeTruthy();
  expect(screen.queryByTestId('tracker-taps-toggle-wat')).toBeNull();
});

test('a bar card with nothing logged has nothing to list', async () => {
  await renderCard({ tracker: { ...water, render_style: 'bar' }, entries: [] });
  expect(screen.getByTestId('tracker-bar-wat')).toBeTruthy();
  expect(screen.queryByTestId('tracker-taps-toggle-wat')).toBeNull();
});
