import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DescribeMealScreen from '../../app/food/describe';
import { todayString } from '../../lib/nutrition';

/**
 * N194 — "the same as yesterday" on the describe screen.
 *
 * What the ticket and its decisions require of the PHONE, each asserted on
 * what is drawn and what is written rather than on the response:
 *
 *   - one match is a draft on the SAME confirm screen, carrying the prior
 *     entry's food and amount, still editable, logged only on Log;
 *   - several matches are a list, and nothing is logged — or even shown as a
 *     draft — until the athlete picks one;
 *   - no match says so plainly and puts nothing on screen to log;
 *   - a draft from the log saves NO new food.
 */

const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockDescribe = jest.fn();
jest.mock('@/lib/estimateApi', () => {
  const real = jest.requireActual('@/lib/estimateApi');
  return {
    ...real,
    describeMeal: (...a: unknown[]) => mockDescribe(...a),
    photographMeal: jest.fn(),
  };
});

const mockLogFood = jest.fn();
const mockSaveFood = jest.fn();
const mockLocalFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  logFood: (...a: unknown[]) => mockLogFood(...a),
  saveFoodLocally: (...a: unknown[]) => mockSaveFood(...a),
  localFood: (...a: unknown[]) => mockLocalFood(...a),
}));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));
jest.mock('@/lib/barcodeCache', () => ({ rememberBarcode: jest.fn(), cachedBarcode: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({ SaveFormat: { JPEG: 'jpeg' } }));

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() }),
  Stack: { Screen: () => null },
}));

function logItem(over: Record<string, unknown> = {}) {
  return {
    name: 'Oatmeal',
    serving_label: '1 cup',
    servings: 1.5,
    portion_confidence: 'high',
    assumption: '',
    kcal: 412,
    protein_g: 14,
    carb_g: 70,
    fat_g: 8,
    fibre_g: 6.5,
    saturated_fat_g: null,
    sugar_g: 12,
    added_sugar_g: null,
    sodium_mg: 410,
    cholesterol_mg: null,
    source_food_id: 'food-oats',
    category: 'grain',
    entry_id: 'entry-1',
    ...over,
  };
}

function recent(candidates: unknown[], over: Record<string, unknown> = {}) {
  return {
    estimate: {
      items: [],
      note: '',
      meal_name: '',
      model: '',
      source: 'text',
      recent: {
        recognized_by: 'phrase',
        window: { from: '2026-09-01', to: '2026-09-14', days: 14 },
        reference: { day: 'yesterday', days_ago: null, weekday: null, month_day: null, meal: null, food_words: [] },
        candidates,
        more: 0,
        ...over,
      },
    },
    quota: { used: 0, limit: 25, remaining: 25, resets_at: null },
  };
}

const yesterdaysBreakfast = { eaten_on: '2026-09-13', meal: 'breakfast', items: [logItem()] };
const thursdaysBreakfast = {
  eaten_on: '2026-09-10',
  meal: 'breakfast',
  items: [logItem({ name: 'Smoothie', serving_label: '1 glass', servings: 1, kcal: 380, entry_id: 'entry-2', source_food_id: null, category: null })],
};

async function ask(text = 'the same as yesterday') {
  await render(<DescribeMealScreen />);
  await fireEvent.changeText(screen.getByTestId('describe-input'), text);
  await act(async () => {
    await fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(mockDescribe).toHaveBeenCalled());
}

function textOf(testID: string): string {
  const c = screen.getByTestId(testID).props.children;
  return Array.isArray(c) ? c.join('') : String(c);
}

beforeEach(() => {
  mockParams = { meal: 'lunch', date: '2026-09-14' };
  mockDescribe.mockReset();
  mockLogFood.mockReset().mockResolvedValue('entry-new');
  mockSaveFood.mockReset().mockResolvedValue('food-new');
  mockLocalFood.mockReset().mockResolvedValue({ id: 'food-oats' });
});

it('sends this phone’s own calendar day with every description', async () => {
  mockDescribe.mockResolvedValue(recent([]));
  await ask();
  const input = mockDescribe.mock.calls[0][1];
  // "Yesterday" is relative to where the athlete is standing; without the
  // phone's own date the server resolves no reference at all.
  expect(input.today).toBe(todayString());
  expect(input.recent).toBe(true);
});

describe('one match', () => {
  it('is an editable draft on the same confirm screen, and says where it came from', async () => {
    mockDescribe.mockResolvedValue(recent([yesterdaysBreakfast]));
    await ask();

    await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
    expect(screen.getByText('FROM YOUR RECENT LOG')).toBeTruthy();
    expect(screen.queryByText('CHECK THESE BEFORE LOGGING')).toBeNull();
    expect(textOf('describe-recent-source')).toBe('Yesterday’s breakfast, from your log. No estimate used.');
    // The prior AMOUNT, in the fields the athlete edits.
    expect(screen.getByTestId('describe-servings-0').props.value).toBe('1.5');
    expect(screen.getByTestId('describe-kcal-0').props.value).toBe('412');
    // Nothing is logged by arriving.
    expect(mockLogFood).not.toHaveBeenCalled();
  });

  it('logs the prior food and amount, as edited, onto this screen’s day and slot — and saves no new food', async () => {
    mockDescribe.mockResolvedValue(recent([yesterdaysBreakfast]));
    await ask();
    await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('describe-kcal-0'), '450');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    const [, entry] = mockLogFood.mock.calls[0];
    expect(entry).toMatchObject({
      eaten_on: '2026-09-14',
      meal: 'lunch',
      name: 'Oatmeal',
      servings: 1.5,
      serving_label: '1 cup',
      kcal: 450,
      sodium_mg: 410,
      sugar_g: 12,
      source_food_id: 'food-oats',
      category: 'grain',
    });
    // A re-log mints nothing: the pile of duplicates N114 exists to prevent.
    expect(mockSaveFood).not.toHaveBeenCalled();
  });

  it('drops provenance to a saved food this phone no longer has, rather than stranding the entry', async () => {
    mockDescribe.mockResolvedValue(recent([yesterdaysBreakfast]));
    mockLocalFood.mockResolvedValue(null);
    await ask();
    await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    expect(mockLocalFood).toHaveBeenCalledWith(expect.anything(), 'food-oats');
    expect(mockLogFood.mock.calls[0][1].source_food_id).toBeNull();
    expect(mockSaveFood).not.toHaveBeenCalled();
  });

  it('says an estimate was spent when the model had to read the words', async () => {
    mockDescribe.mockResolvedValue(recent([yesterdaysBreakfast], { recognized_by: 'model' }));
    await ask('that oatmeal from the other morning');
    await waitFor(() => expect(screen.getByTestId('describe-recent-source')).toBeTruthy());
    expect(textOf('describe-recent-source')).toContain('One estimate was used');
  });
});

describe('several matches', () => {
  it('is a list, and nothing is a draft until one is picked', async () => {
    mockDescribe.mockResolvedValue(recent([yesterdaysBreakfast, thursdaysBreakfast]));
    await ask('my usual breakfast');

    await waitFor(() => expect(screen.getByTestId('describe-recent-candidate-1')).toBeTruthy());
    expect(screen.getByText('WHICH ONE DID YOU MEAN?')).toBeTruthy();
    expect(screen.getByText('Yesterday’s breakfast')).toBeTruthy();
    expect(screen.getByText('Thursday’s breakfast')).toBeTruthy();
    // THE PROPERTY: never a silent pick between two different breakfasts.
    expect(screen.queryByTestId('describe-log')).toBeNull();
    expect(screen.queryByTestId('describe-servings-0')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('describe-recent-candidate-1'));
    });
    await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
    expect(screen.getByText('Smoothie')).toBeTruthy();
    expect(screen.queryByText('Oatmeal')).toBeNull();
    expect(textOf('describe-recent-source')).toContain('Thursday’s breakfast');

    await act(async () => {
      await fireEvent.press(screen.getByTestId('describe-log'));
    });
    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    expect(mockLogFood.mock.calls[0][1]).toMatchObject({ name: 'Smoothie', kcal: 380, source_food_id: null });
    expect(mockSaveFood).not.toHaveBeenCalled();
  });

  it('can go back to the list after picking', async () => {
    mockDescribe.mockResolvedValue(recent([yesterdaysBreakfast, thursdaysBreakfast]));
    await ask('my usual breakfast');
    await waitFor(() => expect(screen.getByTestId('describe-recent-candidate-0')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(screen.getByTestId('describe-recent-candidate-0'));
    });
    await waitFor(() => expect(screen.getByTestId('describe-recent-back')).toBeTruthy());
    await act(async () => {
      await fireEvent.press(screen.getByTestId('describe-recent-back'));
    });
    await waitFor(() => expect(screen.getByTestId('describe-recent-candidate-1')).toBeTruthy());
    expect(screen.queryByTestId('describe-log')).toBeNull();
  });

  it('says how many more matched than it shows', async () => {
    mockDescribe.mockResolvedValue(recent([yesterdaysBreakfast, thursdaysBreakfast], { more: 3 }));
    await ask('my usual breakfast');
    await waitFor(() => expect(screen.getByTestId('describe-recent-more')).toBeTruthy());
    expect(textOf('describe-recent-more')).toContain('3 more');
  });
});

describe('no match', () => {
  it('says so plainly, puts nothing on screen to log, and offers a fresh estimate', async () => {
    mockDescribe.mockResolvedValue(recent([]));
    await ask();

    await waitFor(() => expect(screen.getByTestId('describe-recent-none')).toBeTruthy());
    expect(textOf('describe-recent-none')).toBe('Nothing in the last 14 days matches “the same as yesterday”.');
    expect(screen.queryByTestId('describe-log')).toBeNull();
    // Not the generic "nothing recognisable" copy, which would advise the
    // athlete to describe food they just pointed at.
    expect(screen.queryByTestId('describe-empty')).toBeNull();

    mockDescribe.mockResolvedValue({
      estimate: {
        items: [{ name: 'Porridge', serving_label: '1 bowl', servings: 1, portion_confidence: 'medium', assumption: '', kcal: 300, protein_g: 10, carb_g: 50, fat_g: 6, fibre_g: 5 }],
        note: '',
        meal_name: '',
        model: 'm',
        source: 'text',
      },
      quota: { used: 1, limit: 25, remaining: 24, resets_at: null },
    });
    await act(async () => {
      await fireEvent.press(screen.getByTestId('describe-recent-estimate'));
    });
    await waitFor(() => expect(mockDescribe).toHaveBeenCalledTimes(2));
    expect(mockDescribe.mock.calls[1][1].recent).toBe(false);
    await waitFor(() => expect(screen.getByText('CHECK THESE BEFORE LOGGING')).toBeTruthy());
  });
});
