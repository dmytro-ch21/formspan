/**
 * The estimate wire layer.
 *
 * What is worth testing here is not that fetch was called — it is the two
 * things that are silently wrong if they break: the multipart request must
 * carry no hand-set Content-Type (or the boundary is missing and the server
 * cannot parse it), and a draft item must lose its confidence and assumption
 * on the way into the log (or a model's uncertainty ends up in the athlete's
 * own history).
 */

import { describeMeal, itemToEntry, photographMeal, type EstimatedItem } from '../estimateApi';

const mockFetch = jest.fn();
// Spread over the real module rather than replacing it: `authedFetch` also
// exports `API_BASE` (which `apiRequest` builds every URL from) and the two
// timeout constants, and a bare object mock silently makes all three
// `undefined` — the request would still be made, to `undefined/nutrition/...`,
// with no deadline and nothing red.
jest.mock('../authedFetch', () => ({
  ...jest.requireActual('../authedFetch'),
  netFetch: (...a: unknown[]) => mockFetch(...a),
}));

const token = async () => 'tok';

function ok(body: unknown) {
  return {
    status: 200,
    ok: true,
    json: async () => body,
  };
}

const draft = {
  estimate: { items: [], note: '', model: 'claude-opus-5', source: 'text' },
  quota: { used: 1, limit: 25, remaining: 24, resets_at: null },
};

/** What was handed to FormData.append, before it stringifies anything. */
let appended: Map<string, unknown>;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(ok(draft));
  appended = new Map();
  // Records AND calls through. A spy that only records leaves the FormData
  // empty, so every `form.get()` assertion beside it silently reads null —
  // which is how the first version of this failed.
  const realAppend = FormData.prototype.append;
  jest.spyOn(FormData.prototype, 'append').mockImplementation(function (
    this: FormData,
    ...args: unknown[]
  ) {
    appended.set(args[0] as string, args[1]);
    return (realAppend as (...a: unknown[]) => unknown).apply(this, args);
  } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('describeMeal', () => {
  it('sends JSON and asks for the meal slot', async () => {
    await describeMeal(token, { description: 'two eggs', meal: 'breakfast' });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ description: 'two eggs', meal: 'breakfast' });
  });
});

describe('photographMeal', () => {
  it('sends FormData and sets NO Content-Type', async () => {
    // The one that matters. A multipart Content-Type carries a generated
    // boundary, and fetch appends it only when it writes the header itself.
    // Setting it by hand produces `multipart/form-data` with no boundary — a
    // body the server cannot parse, failing in a way that reads as a bad
    // upload rather than as a missing header.
    await photographMeal(token, { uri: 'file:///meal.jpg', mimeType: 'image/jpeg' });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers['Content-Type']).toBeUndefined();
    // And the auth header still goes, which the same code path could have
    // dropped along with it.
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('carries the description alongside the image when there is one', async () => {
    // A photo plus "the sauce is peanut" is the strongest input there is: it
    // pairs what the camera sees with what it cannot.
    await photographMeal(token, {
      uri: 'file:///meal.jpg',
      mimeType: 'image/jpeg',
      description: 'the sauce is peanut',
      meal: 'dinner',
    });
    const [, init] = mockFetch.mock.calls[0];
    // The standard FormData API rather than React Native's `_parts` internal:
    // the first version of this reached for `_parts`, which the test
    // environment's FormData does not have, so the assertion threw rather than
    // failing on its own claim.
    const form = init.body as FormData;
    expect(form.get('description')).toBe('the sauce is peanut');
    expect(form.get('meal')).toBe('dinner');
    // NOT `form.get('image')`: this environment's FormData stringifies the RN
    // file object to "[object Object]", so a `not.toBeNull()` there stays green
    // even if `uri` is dropped — and `uri` is the whole part, since the bridge
    // streams the file from it. Spying on append is the only way to see the
    // object that was actually handed over. Raised in review.
    expect(appended.get('image')).toMatchObject({
      uri: 'file:///meal.jpg',
      type: 'image/jpeg',
    });
  });
});

describe('itemToEntry', () => {
  const item: EstimatedItem = {
    name: 'Scrambled eggs',
    serving_label: '1 medium egg',
    servings: 2,
    kcal: 180,
    protein_g: 12,
    carb_g: 1,
    fat_g: 14,
    fibre_g: null,
    portion_confidence: 'low',
    assumption: 'assumed a medium egg',
  };

  it('drops the confidence and the assumption', () => {
    // A logged entry records WHAT WAS EATEN, not how confident a model was
    // about it. Carrying these through would put a model's uncertainty into
    // the athlete's own history, where every derived number would inherit it.
    const entry = itemToEntry(item) as Record<string, unknown>;
    expect(entry.portion_confidence).toBeUndefined();
    expect(entry.assumption).toBeUndefined();
  });

  it('keeps every number the log needs, including unstated fibre', () => {
    const entry = itemToEntry(item);
    expect(entry).toEqual({
      name: 'Scrambled eggs',
      servings: 2,
      serving_label: '1 medium egg',
      kcal: 180,
      protein_g: 12,
      carb_g: 1,
      fat_g: 14,
      // Null stays null: "not stated" is not zero, the same contract the rest
      // of the module holds.
      fibre_g: null,
    });
  });
});
