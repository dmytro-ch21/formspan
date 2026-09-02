/**
 * N468/#792 — the dedicated caffeine card, and the one property that matters
 * most: a caffeine entry that ORIGINATED from a logged food item cannot be
 * removed directly from here, and says why rather than silently doing
 * nothing or silently removing it.
 */
import { Alert } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { CaffeineBanner } from '../CaffeineBanner';
import { pairedFoodCaffeineEntryId } from '@/lib/foodCaffeine';
import type { Tracker, TrackerEntry } from '@/lib/trackerModel';

jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const tracker: Tracker = {
  id: 't_caffeine',
  preset: 'caffeine',
  name: 'Caffeine',
  icon: '⚡',
  color_key: 'amber',
  unit: 'mg',
  increment: 80,
  target: 400,
  render_style: 'glyphs',
  sort_order: 30,
  count_noun: 'cup',
  provisioned: false,
  cutoff_minutes: null, // simplifies the foot-line assertions below
};

function entry(over: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    id: 'e1',
    tracker_id: tracker.id,
    logged_on: '2026-08-18',
    logged_at: '2026-08-18T08:00:00.000Z',
    amount: 95,
    ...over,
  };
}

afterEach(() => {
  (Alert.alert as jest.Mock).mockClear();
});

describe('the reference figures — cited, never invented', () => {
  it('states the 400 mg reference and a short effects note', () => {
    render(
      <CaffeineBanner tracker={tracker} entries={[]} onAdd={() => {}} onRemove={() => {}} onEdit={() => {}} />,
    );
    expect(screen.getByText(/400 mg a day/)).toBeTruthy();
    expect(screen.getByText(/Mayo Clinic/)).toBeTruthy();
    expect(screen.getByText(/headache/i)).toBeTruthy();
  });

  it("states today's total", () => {
    render(
      <CaffeineBanner
        tracker={tracker}
        entries={[entry({ amount: 95 }), entry({ id: 'e2', amount: 63 })]}
        onAdd={() => {}}
        onRemove={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByText(/158 mg today/)).toBeTruthy();
  });
});

describe('a food-caused entry cannot be removed directly', () => {
  it('refuses to remove it and explains why, instead of calling onRemove', () => {
    const onRemove = jest.fn();
    const foodCaffeineId = pairedFoodCaffeineEntryId('food-1', 'tail');
    render(
      <CaffeineBanner
        tracker={tracker}
        entries={[entry({ id: foodCaffeineId, amount: 95 })]}
        onAdd={() => {}}
        onRemove={onRemove}
        onEdit={() => {}}
      />,
    );

    fireEvent.press(screen.getByTestId(`caffeine-entry-remove-${foodCaffeineId}`));

    expect(onRemove).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringContaining('logged food'),
      expect.stringContaining('Food'),
    );
  });

  it('removes an ordinary manual entry exactly as before, with no alert', () => {
    const onRemove = jest.fn();
    render(
      <CaffeineBanner
        tracker={tracker}
        entries={[entry({ id: 'manual-1', amount: 80 })]}
        onAdd={() => {}}
        onRemove={onRemove}
        onEdit={() => {}}
      />,
    );

    fireEvent.press(screen.getByTestId('caffeine-entry-remove-manual-1'));

    expect(onRemove).toHaveBeenCalledWith('manual-1');
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('removes a coffee-tap-caused entry exactly as before, with no alert — N431/N432 unaffected', () => {
    const onRemove = jest.fn();
    // coffeeCaffeine.ts's own suffix — deliberately NOT the food infix.
    render(
      <CaffeineBanner
        tracker={tracker}
        entries={[entry({ id: 'coffee-entry-1-caf', amount: 63 })]}
        onAdd={() => {}}
        onRemove={onRemove}
        onEdit={() => {}}
      />,
    );

    fireEvent.press(screen.getByTestId('caffeine-entry-remove-coffee-entry-1-caf'));

    expect(onRemove).toHaveBeenCalledWith('coffee-entry-1-caf');
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('labels a food-caused entry distinctly, so it reads as locked rather than merely unresponsive', () => {
    const foodCaffeineId = pairedFoodCaffeineEntryId('food-1', 'tail');
    render(
      <CaffeineBanner
        tracker={tracker}
        entries={[entry({ id: foodCaffeineId, amount: 95 })]}
        onAdd={() => {}}
        onRemove={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByText(/from a logged food/)).toBeTruthy();
  });
});

describe('adding', () => {
  it('fires onAdd from the log button', () => {
    const onAdd = jest.fn();
    render(<CaffeineBanner tracker={tracker} entries={[]} onAdd={onAdd} onRemove={() => {}} onEdit={() => {}} />);
    fireEvent.press(screen.getByTestId(`caffeine-add-${tracker.id}`));
    expect(onAdd).toHaveBeenCalled();
  });
});
