import { suggestedTarget } from '../nutritionApi';

/**
 * What `?activity=` looks like on the wire.
 *
 * **Split from `activityLevel.test.ts` because it covers a different kind of
 * mistake.** That file covers the RULE — which side wins. This covers the one
 * line that turns the rule into a URL, and the specific way it goes wrong:
 *
 *     new URLSearchParams({ on, activity })   // activity === undefined
 *
 * serialises the STRING `"undefined"`. The server validates the vocabulary and
 * rejects it, so every derivation on the screen 400s — not just the pills —
 * over a value nobody typed. Nothing above this line can see it: the caller
 * passed `undefined` correctly, the rule returned `undefined` correctly, and
 * the screen tests mock this function away entirely.
 */

const okBody = { suggestion: null, missing: [], activities: [], activity: 'light' };

let seen: string;
jest.mock('../apiRequest', () => ({
  apiRequest: jest.fn(async (_t: unknown, path: string) => {
    seen = path;
    return okBody;
  }),
}));

const token = async () => 'tok';

beforeEach(() => {
  seen = '';
});

it('omits the parameter entirely when there is nothing to override with', async () => {
  await suggestedTarget(token, '2026-08-20');
  // Not `activity=`, and emphatically not `activity=undefined`. An absent
  // parameter is what tells the server to answer from the athlete's profile,
  // which is the only path by which a level chosen in a browser reaches this
  // phone.
  expect(seen).toBe('/nutrition/targets/suggested?on=2026-08-20');
  expect(seen).not.toContain('activity');
});

it('sends the level when one is being overridden', async () => {
  await suggestedTarget(token, '2026-08-20', 'active');
  expect(seen).toBe('/nutrition/targets/suggested?on=2026-08-20&activity=active');
});

it('treats an empty string as no override rather than sending a blank level', async () => {
  // Reachable from a cached value that has been cleared. `activity=` is an
  // unknown level to the server, not an absent one, so it 400s — the same
  // failure as "undefined" wearing different clothes.
  await suggestedTarget(token, '2026-08-20', '');
  expect(seen).toBe('/nutrition/targets/suggested?on=2026-08-20');
});
