import { environmentLabel } from '@/lib/environmentLabel';

/**
 * The environment instrument (N132, relocated by N529/#960).
 *
 * Two arms, and the second is the one that matters: production must render
 * NOTHING, and everything else — including the misspelled and the unset —
 * must render SOMETHING. The only way this can be wrong is by showing on a
 * real release; a label on a dev build is the whole point.
 */

it('is absent on production, and only on exactly "production"', () => {
  expect(environmentLabel('production')).toBeNull();
});

it('names a non-production build', () => {
  expect(environmentLabel('staging')).toBe('STAGING');
  expect(environmentLabel('development')).toBe('DEVELOPMENT');
});

it('fails safe: an unset value is a label, not silence', () => {
  // A plain dev-client run with no .env sets nothing. That is a dev build,
  // and it must say so.
  expect(environmentLabel(undefined)).toBe('DEV');
  expect(environmentLabel('')).toBe('DEV');
});

it('fails safe: a misspelled or mis-cased "production" still shows', () => {
  // Case-sensitive on purpose — `validate-production-config.mjs` asserts the
  // production profile says exactly "production", so anything else is a
  // build that did not go through that gate.
  expect(environmentLabel('Production')).toBe('PRODUCTION');
  expect(environmentLabel('prod')).toBe('PROD');
});
