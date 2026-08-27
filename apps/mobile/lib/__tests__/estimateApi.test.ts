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

import {
  describeMeal,
  isQuotaExhausted,
  itemToEntry,
  photographMeal,
  quotaResetMessage,
  type EstimatedItem,
  type EstimateQuota,
} from '../estimateApi';
import { DEFAULT_TIMEOUT_MS, SLOW_REQUEST_TIMEOUT_MS } from '../authedFetch';

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
  // N114. **Absent is not false**, and the direction matters: every build of
  // this app that predates the field sends nothing, and a server that read that
  // as an opt-out would ship the reuse switched off for everybody who already
  // has the app. So the default is the SERVER'S, and this client states it only
  // to turn it off — two places holding one default is two defaults.
  it('says nothing about reuse unless it is being turned off', async () => {
    await describeMeal(token, { description: 'Pork Shashlik' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty('reuse');

    await describeMeal(token, { description: 'Pork Shashlik', reuse: true });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).not.toHaveProperty('reuse');

    await describeMeal(token, { description: 'Pork Shashlik', reuse: false });
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).reuse).toBe(false);
  });

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
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
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
      saturated_fat_g: null,
      sugar_g: null,
      added_sugar_g: null,
      sodium_mg: null,
      cholesterol_mg: null,
    });
  });
});

/**
 * Both estimate paths wait on a provider, so both need the slow budget (N55).
 *
 * The text path is the one that nearly missed it: it sends no photo, and the
 * constant used to be called `UPLOAD_TIMEOUT_MS`, which argued a request out of
 * a budget it needs on the grounds of a name. Same route, same provider, and a
 * slow provider day does not care whether the prompt had an image in it —
 * left on the default this would have surfaced as a mystery timeout on the text
 * path only. Raised in review.
 */
/**
 * F17 (#403) — the boundary that gates every quota-spending control on the
 * describe screen.
 */
describe('isQuotaExhausted', () => {
  function quota(remaining: number): EstimateQuota {
    return { used: 25 - remaining, limit: 25, remaining, resets_at: null };
  }

  it('is false with one estimate still left — THE transition case', () => {
    // Pinned at remaining = 1, not remaining = 10: a `< 0` guard (off by one
    // in the direction that would let a doomed request through) and a
    // `<= 0` guard agree everywhere except exactly here.
    expect(isQuotaExhausted(quota(1))).toBe(false);
  });

  it('is true at remaining = 0 — the actual boundary, not merely "some small number"', () => {
    expect(isQuotaExhausted(quota(0))).toBe(true);
  });

  it('is true even if the server ever reports a negative remaining', () => {
    // Defensive rather than expected: `<= 0`, not `=== 0`, because this
    // client has no business asserting the server can't go negative — only
    // that anything at or under zero means no more requests.
    expect(isQuotaExhausted(quota(-1))).toBe(true);
  });

  it('is false before any estimate has been made — quota is null before the first response', () => {
    expect(isQuotaExhausted(null)).toBe(false);
  });
});

describe('quotaResetMessage', () => {
  it('states the limit and a clock time when resets_at parses', () => {
    const msg = quotaResetMessage({
      used: 25,
      limit: 25,
      remaining: 0,
      resets_at: '2026-08-27T15:40:00.000Z',
    });
    expect(msg).toMatch(/25 estimates/);
    expect(msg).toMatch(/more at/i);
  });

  it('falls back to a plain statement when resets_at is null', () => {
    const msg = quotaResetMessage({ used: 25, limit: 25, remaining: 0, resets_at: null });
    expect(msg).toMatch(/used all your estimates for today/i);
    // Not the templated form — there is no clock time to put in it.
    expect(msg).not.toMatch(/more at/i);
  });

  it('falls back the same way when resets_at is present but unparseable', () => {
    // A stale server, a proxy, or a future field change could all put
    // something here `Date.parse` cannot read — matches the same defensive
    // pattern `savedAgo` already uses elsewhere in this file's sibling screen.
    const msg = quotaResetMessage({ used: 25, limit: 25, remaining: 0, resets_at: 'not-a-date' });
    expect(msg).toMatch(/used all your estimates for today/i);
  });
});

describe('the deadline each estimate path asks for', () => {
  const deadlineOf = () => {
    const opts = mockFetch.mock.calls[0][2] as { timeoutMs?: number } | undefined;
    return opts?.timeoutMs;
  };

  it('gives the text path the slow budget, not the default', async () => {
    await describeMeal(token, { description: 'two eggs' });
    expect(deadlineOf()).toBe(SLOW_REQUEST_TIMEOUT_MS);
    // Stated as a difference, so a mutation making them equal cannot pass.
    expect(deadlineOf()).not.toBe(DEFAULT_TIMEOUT_MS);
  });

  it('gives the photo path the slow budget too', async () => {
    await photographMeal(token, { uri: 'file:///m.jpg', mimeType: 'image/jpeg' });
    expect(deadlineOf()).toBe(SLOW_REQUEST_TIMEOUT_MS);
  });
});
