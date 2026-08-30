import { render, screen } from '@testing-library/react-native';

import { SessionCard } from '@/components/SessionCard';
import { MOUNTAINS, mountainFor } from '@/lib/mountains';
import type { CardData } from '@/lib/sessionCard';

/**
 * N449 (#747): an athlete's own photo, in place of the deterministic
 * mountain — `data.backgroundUri` on `CardData`.
 *
 * This is the ONE property that decides what actually gets exported into the
 * PNG (`ShareCardHost` renders this exact component off-screen and
 * `captureRef`s it — see `SessionShare.tsx`), so pinning what `SessionCard`
 * puts into the `<Image source={...}>` prop is the closest a jest test gets
 * to confirming the acceptance criterion "the resulting PNG reflects the
 * chosen photo, not the mountain" without a real device.
 */

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

it('falls back to the deterministic mountain when no photo was picked', () => {
  const data = card();
  render(<SessionCard data={data} width={360} />);

  const photo = screen.getByTestId('session-card-photo');
  expect(photo.props.source).toBe(MOUNTAINS[mountainFor(data.id)]);
});

it('renders the athlete\'s own photo in the mountain\'s place when one is set', () => {
  const data = card({ backgroundUri: 'file:///cache/picked-1080.jpg' });
  render(<SessionCard data={data} width={360} />);

  const photo = screen.getByTestId('session-card-photo');
  // THE assertion this ticket is about — not merely "an Image exists", but
  // that the SOURCE is the athlete's own file, not the curated asset. A
  // build that ignored `backgroundUri` and always rendered the mountain
  // would satisfy every other check in this file.
  expect(photo.props.source).toEqual({ uri: 'file:///cache/picked-1080.jpg' });
  expect(photo.props.source).not.toBe(MOUNTAINS[mountainFor(data.id)]);
});

it('an empty string is treated as "no photo" rather than an empty image source', () => {
  // Defensive: a caller that clears the picked photo by resetting to '' (as
  // opposed to `undefined`) must still see the mountain, not a broken Image
  // pointed at nothing.
  const data = card({ backgroundUri: '' });
  render(<SessionCard data={data} width={360} />);

  const photo = screen.getByTestId('session-card-photo');
  expect(photo.props.source).toBe(MOUNTAINS[mountainFor(data.id)]);
});
