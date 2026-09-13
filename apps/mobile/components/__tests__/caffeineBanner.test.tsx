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
  it('states the 400 mg reference and a short effects note', async () => {
    await render(
      <CaffeineBanner tracker={tracker} entries={[]} onAdd={() => {}} onRemove={() => {}} onEdit={() => {}} />,
    );
    expect(screen.getByText(/400 mg a day/)).toBeTruthy();
    expect(screen.getByText(/Mayo Clinic/)).toBeTruthy();
    expect(screen.getByText(/headache/i)).toBeTruthy();
  });

  it("states today's total", async () => {
    await render(
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
  it('refuses to remove it and explains why, instead of calling onRemove', async () => {
    const onRemove = jest.fn();
    const foodCaffeineId = pairedFoodCaffeineEntryId('food-1', 'tail');
    await render(
      <CaffeineBanner
        tracker={tracker}
        entries={[entry({ id: foodCaffeineId, amount: 95 })]}
        onAdd={() => {}}
        onRemove={onRemove}
        onEdit={() => {}}
      />,
    );

    await fireEvent.press(screen.getByTestId(`caffeine-entry-remove-${foodCaffeineId}`));

    expect(onRemove).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringContaining('logged food'),
      expect.stringContaining('Food'),
    );
  });

  it('removes an ordinary manual entry exactly as before, with no alert', async () => {
    const onRemove = jest.fn();
    await render(
      <CaffeineBanner
        tracker={tracker}
        entries={[entry({ id: 'manual-1', amount: 80 })]}
        onAdd={() => {}}
        onRemove={onRemove}
        onEdit={() => {}}
      />,
    );

    await fireEvent.press(screen.getByTestId('caffeine-entry-remove-manual-1'));

    expect(onRemove).toHaveBeenCalledWith('manual-1');
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('removes a coffee-tap-caused entry exactly as before, with no alert — N431/N432 unaffected', async () => {
    const onRemove = jest.fn();
    // coffeeCaffeine.ts's own suffix — deliberately NOT the food infix.
    await render(
      <CaffeineBanner
        tracker={tracker}
        entries={[entry({ id: 'coffee-entry-1-caf', amount: 63 })]}
        onAdd={() => {}}
        onRemove={onRemove}
        onEdit={() => {}}
      />,
    );

    await fireEvent.press(screen.getByTestId('caffeine-entry-remove-coffee-entry-1-caf'));

    expect(onRemove).toHaveBeenCalledWith('coffee-entry-1-caf');
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('labels a food-caused entry distinctly, so it reads as locked rather than merely unresponsive', async () => {
    const foodCaffeineId = pairedFoodCaffeineEntryId('food-1', 'tail');
    await render(
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
  it('fires onAdd from the log button', async () => {
    const onAdd = jest.fn();
    await render(<CaffeineBanner tracker={tracker} entries={[]} onAdd={onAdd} onRemove={() => {}} onEdit={() => {}} />);
    await fireEvent.press(screen.getByTestId(`caffeine-add-${tracker.id}`));
    expect(onAdd).toHaveBeenCalled();
  });
});

/**
 * N578 — the banner draws no glyphs, so a dose row is where N437's correction
 * is reached. Three kinds of dose, three answers.
 */
describe('correcting a dose', () => {
  async function renderWith(entries: TrackerEntry[], onEditEntry?: jest.Mock) {
    const onRemove = jest.fn();
    await render(
      <CaffeineBanner
        tracker={tracker}
        entries={entries}
        onAdd={() => {}}
        onRemove={onRemove}
        onEdit={() => {}}
        onEditEntry={onEditEntry}
      />,
    );
    return { onRemove };
  }

  it('opens the correction for a manual dose, and removes nothing', async () => {
    const onEditEntry = jest.fn();
    const { onRemove } = await renderWith([entry({ id: 'manual-1', amount: 80 })], onEditEntry);

    const row = screen.getByTestId('caffeine-entry-edit-manual-1');
    expect(row.props.accessibilityLabel).toBe('Change 80 mg');
    await fireEvent.press(row);

    expect(onEditEntry).toHaveBeenCalledWith('manual-1');
    expect(onRemove).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('opens the correction for a coffee-caused dose too — its mg is a reference figure, not a measurement', async () => {
    const onEditEntry = jest.fn();
    await renderWith([entry({ id: 'coffee-entry-1-caf', amount: 95 })], onEditEntry);

    await fireEvent.press(screen.getByTestId('caffeine-entry-edit-coffee-entry-1-caf'));

    expect(onEditEntry).toHaveBeenCalledWith('coffee-entry-1-caf');
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('refuses a food-caused dose and says where to change it, instead of opening anything', async () => {
    const onEditEntry = jest.fn();
    const foodCaffeineId = pairedFoodCaffeineEntryId('food-1', 'tail');
    await renderWith([entry({ id: foodCaffeineId, amount: 95 })], onEditEntry);

    await fireEvent.press(screen.getByTestId(`caffeine-entry-edit-${foodCaffeineId}`));

    expect(onEditEntry).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringContaining('logged food'),
      expect.stringContaining('Food'),
    );
  });

  it('offers no correction at all when none is wired, and still removes', async () => {
    const { onRemove } = await renderWith([entry({ id: 'manual-1', amount: 80 })]);
    expect(screen.queryByTestId('caffeine-entry-edit-manual-1')).toBeNull();
    await fireEvent.press(screen.getByTestId('caffeine-entry-remove-manual-1'));
    expect(onRemove).toHaveBeenCalledWith('manual-1');
  });
});
