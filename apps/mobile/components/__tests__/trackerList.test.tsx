import { render, screen } from '@testing-library/react-native';

import { TrackerList } from '@/components/TrackerList';
import type { Tracker, TrackerEntry } from '@/lib/trackerModel';
import type { TrackerDay } from '@/lib/useTrackerDay';

/**
 * The collapse — N78's answer to "several trackers on Today do not crowd out
 * what Today is for".
 *
 * A component test, which this suite otherwise avoids on principle ("what
 * breaks in this app is concurrency and state reconciliation, not rendering").
 * The exception is earned: what is being asserted here is not that a view
 * renders, it is **which trackers an athlete can still see**, and getting that
 * wrong hides the creatine somebody added specifically so they would not forget
 * it. That is a data-visibility property wearing a rendering costume.
 */

const tracker = (id: string, over: Partial<Tracker> = {}): Tracker => ({
  id,
  preset: '',
  name: id.toUpperCase(),
  icon: '',
  color_key: 'mint',
  unit: 'dose',
  increment: 1,
  target: 1,
  render_style: 'auto',
  sort_order: 10,
  count_noun: 'dose',
  ...over,
});

const entry = (trackerID: string, n: number): TrackerEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${trackerID}-${i}`,
    tracker_id: trackerID,
    logged_on: '2026-08-20',
    logged_at: '2026-08-20T08:00:00.000Z',
    amount: 1,
  }));

function day(trackers: Tracker[], entries: Record<string, number> = {}): TrackerDay {
  return {
    view: { state: 'ready', trackers },
    entriesFor: (id: string) => entry(id, entries[id] ?? 0),
    refresh: () => () => {},
    addTap: async () => {},
    removeEntry: async () => {},
    openSettings: () => {},
  };
}

const props = {
  dayAtTap: () => '2026-08-20',
  units: 'metric' as const,
  unitsReady: true,
  testID: 'today-trackers',
};

it('draws every tracker when no limit is given — Food gets all of them', () => {
  const ts = ['a', 'b', 'c', 'd', 'e'].map((id) => tracker(id));
  render(<TrackerList day={day(ts)} {...props} />);

  for (const t of ts) expect(screen.getByTestId(`tracker-card-${t.id}`)).toBeTruthy();
  expect(screen.queryByTestId('today-trackers-more')).toBeNull();
});

it('collapses past the limit, and the hidden ones are genuinely not drawn', () => {
  const ts = ['a', 'b', 'c', 'd', 'e'].map((id) => tracker(id));
  render(<TrackerList day={day(ts)} collapseAfter={3} {...props} />);

  expect(screen.getByTestId('tracker-card-a')).toBeTruthy();
  expect(screen.getByTestId('tracker-card-c')).toBeTruthy();
  // Not merely styled away: absent. A hidden card that still rendered would
  // keep every glyph in it as a VoiceOver stop.
  expect(screen.queryByTestId('tracker-card-d')).toBeNull();
  expect(screen.queryByTestId('tracker-card-e')).toBeNull();
});

it('does not collapse when the list exactly fits', () => {
  // The boundary. `> limit` and `>= limit` differ by exactly this case, and
  // the wrong one hides a card behind a row reading "0 more".
  const ts = ['a', 'b', 'c'].map((id) => tracker(id));
  render(<TrackerList day={day(ts)} collapseAfter={3} {...props} />);
  expect(screen.getByTestId('tracker-card-c')).toBeTruthy();
  expect(screen.queryByTestId('today-trackers-more')).toBeNull();
});

it('says how many of the hidden ones still have something to log', () => {
  const ts = ['a', 'b', 'c', 'd', 'e'].map((id) => tracker(id));
  // `d` is done (1 of 1), `e` is not. The whole reason the row states this
  // rather than "2 more": a finished tracker is not a reason to expand, and
  // being on Today is about the ones you have NOT done.
  render(<TrackerList day={day(ts, { d: 1 })} collapseAfter={3} {...props} />);

  expect(screen.getByText('2 more trackers, 1 still to log')).toBeTruthy();
});

it('says so plainly when nothing hidden is outstanding', () => {
  const ts = ['a', 'b', 'c', 'd'].map((id) => tracker(id));
  render(<TrackerList day={day(ts, { d: 1 })} collapseAfter={3} {...props} />);
  // Singular, and no scolding. This project does not do shame-based messaging,
  // and praise is the same mechanism wearing a friendlier face.
  expect(screen.getByText('1 more tracker, all done')).toBeTruthy();
});

it('never counts a tracker with no target as outstanding', () => {
  // A count with no ceiling can never be finished, so counting it as
  // outstanding would make the row permanently urgent and therefore useless.
  const ts = [
    tracker('a'),
    tracker('b'),
    tracker('c'),
    tracker('d', { target: null }),
  ];
  render(<TrackerList day={day(ts)} collapseAfter={3} {...props} />);
  expect(screen.getByText('1 more tracker, all done')).toBeTruthy();
});

it('says nothing at all when this device has never been told', () => {
  const unknown: TrackerDay = { ...day([]), view: { state: 'unknown' } };
  render(<TrackerList day={unknown} collapseAfter={3} {...props} />);
  // Not "you have no trackers" — that is a claim from a read that never
  // happened, on the screen whose whole job is the reminder.
  expect(screen.queryByTestId('today-trackers-empty')).toBeNull();
  expect(screen.queryByTestId('today-trackers-more')).toBeNull();
});
