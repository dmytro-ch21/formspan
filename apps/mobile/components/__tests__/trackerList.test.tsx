import { fireEvent, render, screen } from '@testing-library/react-native';

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
  provisioned: false,
  cutoff_minutes: null,
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

function day(
  trackers: Tracker[],
  entries: Record<string, number> = {},
  loadedOn = '2026-08-20',
): TrackerDay {
  return {
    view: { state: 'ready', trackers },
    // frontend-reviewer, W16 review: a fixture that ignores `on` entirely
    // cannot detect `TrackerList` failing to thread it through to
    // `entriesFor` — the exact class of bug this ticket fixes. Mirrors the
    // real guard (`entriesForLoadedDay`): entries for a day other than the
    // one this fixture was "loaded" for come back empty, same as a genuine
    // day switch still mid-refresh.
    entriesFor: (id: string, on: string) => (on === loadedOn ? entry(id, entries[id] ?? 0) : []),
    refresh: () => () => {},
    addTap: async () => {},
    removeEntry: async () => {},
    addCoffeeTap: async () => {},
    removeCoffeeTap: async () => {},
    openSettings: () => {},
  };
}

const props = {
  dayAtTap: () => '2026-08-20',
  on: '2026-08-20',
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

/*
 * Today NEVER UNMOUNTS — it stays mounted for the life of the process, which is
 * the same fact `dayAtTap` exists for. So a plain `useState` here is a one-shot:
 * tap "2 more trackers" once and the collapse is defeated for every day after,
 * including tomorrow's, and the feature quietly stops existing for anyone who
 * ever expanded it.
 *
 * The vectors are what separate "keyed" from "sticky": expand, re-render with
 * the SAME key (must stay open — this is not a control that fights you), then
 * re-render with a NEW one (must collapse). A test that only checked the second
 * would pass against a component that collapsed on every render.
 */
it('stays expanded within a day and collapses when the day changes', () => {
  const ts = ['a', 'b', 'c', 'd', 'e'].map((id) => tracker(id));
  const { rerender } = render(
    <TrackerList day={day(ts)} collapseAfter={3} collapseKey="2026-08-20" {...props} />,
  );
  expect(screen.queryByTestId('tracker-card-e')).toBeNull();

  fireEvent.press(screen.getByTestId('today-trackers-more'));
  expect(screen.getByTestId('tracker-card-e')).toBeTruthy();

  rerender(<TrackerList day={day(ts)} collapseAfter={3} collapseKey="2026-08-20" {...props} />);
  expect(screen.getByTestId('tracker-card-e')).toBeTruthy();

  rerender(<TrackerList day={day(ts)} collapseAfter={3} collapseKey="2026-08-21" {...props} />);
  expect(screen.queryByTestId('tracker-card-e')).toBeNull();
});

/**
 * N432 — the ONE preset-aware branch in this screen: a coffee card gets a
 * drink-type picker and, if the athlete has a caffeine tracker, its tap
 * fans out to it. `TrackerCard` itself stays generic (see its own header);
 * these assertions are about `TrackerList` actually wiring the two up.
 */
describe('N432: coffee taps also post to caffeine, when the athlete has one', () => {
  const coffee = tracker('coffee-1', { preset: 'coffee', name: 'Coffee', target: null });
  const caffeine = tracker('caf-1', { preset: 'caffeine', name: 'Caffeine', target: 400 });
  const water = tracker('water-1', { preset: 'water', name: 'Water' });

  it('offers a drink-type picker on the coffee card, and not on water', () => {
    render(<TrackerList day={day([coffee, water])} {...props} />);

    fireEvent.press(screen.getByTestId('tracker-add-coffee-1'));
    expect(screen.getByTestId('tracker-choice-coffee-1-espresso')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tracker-add-water-1'));
    expect(screen.queryByTestId('tracker-choices-water-1')).toBeNull();
  });

  it('passes the caffeine tracker and the picked mg figure through to addCoffeeTap', () => {
    const addCoffeeTap = jest.fn(async () => {});
    const d = { ...day([coffee, caffeine]), addCoffeeTap };
    render(<TrackerList day={d} {...props} />);

    fireEvent.press(screen.getByTestId('tracker-add-coffee-1'));
    fireEvent.press(screen.getByTestId('tracker-choice-coffee-1-espresso'));

    expect(addCoffeeTap).toHaveBeenCalledWith(coffee, caffeine, 63, '2026-08-20');
  });

  it('passes null for the caffeine tracker when the athlete does not have one', () => {
    // No caffeine tracker at all in this athlete's list — the criterion that
    // a coffee tap must behave as if this ticket never shipped.
    const addCoffeeTap = jest.fn(async () => {});
    const d = { ...day([coffee]), addCoffeeTap };
    render(<TrackerList day={d} {...props} />);

    fireEvent.press(screen.getByTestId('tracker-add-coffee-1'));
    fireEvent.press(screen.getByTestId('tracker-choice-coffee-1-drip'));

    expect(addCoffeeTap).toHaveBeenCalledWith(coffee, null, 95, '2026-08-20');
  });

  it('passes null mg for "Other" — never an invented figure', () => {
    const addCoffeeTap = jest.fn(async () => {});
    const d = { ...day([coffee, caffeine]), addCoffeeTap };
    render(<TrackerList day={d} {...props} />);

    fireEvent.press(screen.getByTestId('tracker-add-coffee-1'));
    fireEvent.press(screen.getByTestId('tracker-choice-coffee-1-other'));

    expect(addCoffeeTap).toHaveBeenCalledWith(coffee, caffeine, null, '2026-08-20');
  });

  it('removing a coffee tap goes through removeCoffeeTap, which also undoes the paired entry', () => {
    const removeCoffeeTap = jest.fn(async () => {});
    const removeEntry = jest.fn(async () => {});
    const d = { ...day([coffee], { 'coffee-1': 1 }), removeCoffeeTap, removeEntry };
    render(<TrackerList day={d} {...props} />);

    fireEvent.press(screen.getByTestId('tracker-glyph-coffee-1-0'));

    expect(removeCoffeeTap).toHaveBeenCalledWith('coffee-1-0', '2026-08-20');
    expect(removeEntry).not.toHaveBeenCalled();
  });

  it('removing a WATER tap still goes through the ordinary removeEntry — water carries no caffeine', () => {
    const removeCoffeeTap = jest.fn(async () => {});
    const removeEntry = jest.fn(async () => {});
    const d = { ...day([water], { 'water-1': 1 }), removeCoffeeTap, removeEntry };
    render(<TrackerList day={d} {...props} />);

    fireEvent.press(screen.getByTestId('tracker-glyph-water-1-0'));

    expect(removeEntry).toHaveBeenCalledWith('water-1-0', '2026-08-20');
    expect(removeCoffeeTap).not.toHaveBeenCalled();
  });
});
