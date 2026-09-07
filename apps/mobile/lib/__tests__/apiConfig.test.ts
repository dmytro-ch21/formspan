import { resolveApiBaseUrl } from '../apiConfig';

/**
 * N165/#542 — the resolution rule that decides whether a missing/invalid
 * `EXPO_PUBLIC_API_URL` falls back to `localhost` or throws.
 *
 * Tests `resolveApiBaseUrl` directly, as a pure function of
 * `(rawEnvValue, isDevelopment)`, rather than mocking the module-level
 * `process.env`/`__DEV__` reads in `apiConfig.ts` itself — the same shape
 * `scripts/validate-production-config.mjs` uses for `classifyValue`. This is
 * what makes both branches (dev and non-dev) testable without needing to flip
 * a real global mid-suite.
 */
describe('resolveApiBaseUrl', () => {
  describe('development mode', () => {
    it('falls back to localhost when the env var is unset', () => {
      expect(resolveApiBaseUrl(undefined, true)).toBe('http://localhost:8080');
    });

    it('falls back to localhost when the env var is an empty string', () => {
      expect(resolveApiBaseUrl('', true)).toBe('http://localhost:8080');
    });

    it('falls back to localhost when the env var is whitespace only', () => {
      expect(resolveApiBaseUrl('   ', true)).toBe('http://localhost:8080');
    });

    it('uses a real, explicitly-set value instead of the fallback', () => {
      expect(resolveApiBaseUrl('http://192.168.1.50:8080', true)).toBe(
        'http://192.168.1.50:8080',
      );
    });

    it('trims surrounding whitespace off an explicit value', () => {
      expect(resolveApiBaseUrl('  https://api.vola.fitness  ', true)).toBe(
        'https://api.vola.fitness',
      );
    });

    it('still throws on a present-but-malformed value — dev tolerates absence, never garbage', () => {
      expect(() => resolveApiBaseUrl('not-a-url', true)).toThrow(
        /not a valid http\(s\) URL/,
      );
    });
  });

  describe('non-development mode (preview / production)', () => {
    it('throws when the env var is unset, naming the missing variable', () => {
      expect(() => resolveApiBaseUrl(undefined, false)).toThrow(
        /EXPO_PUBLIC_API_URL is not set/,
      );
    });

    it('throws when the env var is an empty string', () => {
      expect(() => resolveApiBaseUrl('', false)).toThrow(/EXPO_PUBLIC_API_URL is not set/);
    });

    it('throws when the env var is whitespace only', () => {
      expect(() => resolveApiBaseUrl('   ', false)).toThrow(/EXPO_PUBLIC_API_URL is not set/);
    });

    it('never mentions localhost as an available fallback in the thrown message', () => {
      // The whole point: an operator reading this error must not conclude the
      // build "just" needs a network fix — it needs the variable set.
      try {
        resolveApiBaseUrl(undefined, false);
        throw new Error('expected resolveApiBaseUrl to throw');
      } catch (e) {
        expect(String(e)).toMatch(/refusing to silently fall back/);
      }
    });

    it('resolves to a real, explicitly-set value', () => {
      expect(resolveApiBaseUrl('https://api.vola.fitness', false)).toBe(
        'https://api.vola.fitness',
      );
    });

    it('throws on a malformed value rather than sending garbage as a host', () => {
      expect(() => resolveApiBaseUrl('apivola-fitness-platform-staging', false)).toThrow(
        /not a valid http\(s\) URL/,
      );
    });
  });
});

/**
 * The module's own top-level constants — evaluated once, at import time, from
 * whatever `process.env.EXPO_PUBLIC_API_URL` and `__DEV__` actually are in
 * THIS jest process (jest-expo sets `__DEV__ = true`, matching the ordinary
 * local-dev case this ticket must not change). Importing the module here (as
 * every migrated call site now does) is itself the "don't break local dev"
 * regression check: if the fallback logic broke, this import would either
 * throw (turning the whole test file red) or resolve to something other than
 * localhost.
 */
describe('the module import itself, under this suite\'s real __DEV__/env', () => {
  it('resolves to the localhost fallback with no env var set, matching pre-N165 behaviour', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { API_URL, API_BASE } = require('../apiConfig') as {
      API_URL: string;
      API_BASE: string;
    };
    expect(API_URL).toBe('http://localhost:8080');
    expect(API_BASE).toBe('http://localhost:8080/v1');
  });
});
