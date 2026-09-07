/**
 * The one place that reads `EXPO_PUBLIC_API_URL`.
 *
 * **N165/#542.** Eleven modules each opened with their own copy of:
 *
 *     const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
 *
 * A staging or production build compiles fine with the variable unset — Expo
 * inlines `undefined` at bundle time, `??` quietly wins, and the build ships
 * talking to `localhost`, which is unreachable from a device and different
 * garbage on a Simulator, in CI, and on someone's desk. Nothing on screen or
 * in the build log says so; it looks like a network bug, not a config one.
 *
 * **The fix centralizes the read AND changes what happens when it's
 * missing.** Every other module now imports {@link API_BASE} from here
 * instead of declaring its own fallback.
 *
 * **Why `__DEV__`, not `EXPO_PUBLIC_APP_ENV`, gates the fallback.**
 * `EXPO_PUBLIC_APP_ENV` (N132/#536) is the established convention for
 * *labelling* which build this is — it drives the on-screen
 * `EnvironmentBadge` — but it is itself just another `EXPO_PUBLIC_*` value
 * that can be missing or wrong, and a build that forgot to set
 * `EXPO_PUBLIC_API_URL` has no better reason to have correctly set
 * `EXPO_PUBLIC_APP_ENV` either. Gating the fallback on it would mean a
 * config mistake could suppress the very guard meant to catch config
 * mistakes.
 *
 * `__DEV__` cannot be misconfigured that way: it is a global Hermes/Metro
 * sets from how the JS was bundled, not a value anyone types into an `.env`
 * file or an `eas.json` profile. It is `true` for exactly the case this
 * fallback exists to serve — a development-client bundle loaded from Metro,
 * with no env file at all, `pnpm run dev:mobile` — and `false` for every
 * release-mode bundle, which covers `preview` and `production` alike (eas.json
 * only sets `developmentClient: true` on the `development` profile) and a
 * `--configuration Release` build run locally to check what would ship. This
 * is also already this codebase's established dev/release signal —
 * `lib/shareCard.ts` uses it for the same distinction — so this reuses it
 * rather than introducing a second one.
 *
 * **What "fails loudly" means here, and why it's a throw at import time
 * rather than a caught error routed through `lib/telemetryClient.ts`.** A
 * release-mode React Native bundle cannot "fail the build" the way a Next.js
 * `next build`/`next start` can refuse to serve traffic — the JS is already
 * inside a compiled native binary by the time it runs. The realistic choices
 * were: (a) throw here, at module-evaluation time, so a misconfigured build
 * crashes on every launch, unconditionally, before anything renders; or (b)
 * compute this lazily and let the throw surface wherever the first API call
 * happens, caught by `telemetryClient`'s `ErrorUtils` hook or the
 * `expo-router` `ErrorBoundary` in `app/_layout.tsx`.
 *
 * (b) sounds more graceful and is actually worse here, for two reasons
 * specific to this failure. First, `telemetryClient.ts` itself is one of the
 * eleven modules that used to read this env var — its only way to report a
 * problem is a `fetch` to this same, broken, API base, so routing the report
 * through it is asking the thing that is broken to tell you it is broken.
 * Second, a lazily-thrown error only fires the first time some screen happens
 * to call the API, which could be deep in a rarely-opened screen and would
 * present as "this one feature is broken" rather than "this build is
 * misconfigured" — exactly the "looks like a network bug" failure this ticket
 * exists to fix, just moved one layer down instead of removed.
 *
 * A throw at module-evaluation time is unconditional and instantaneous: the
 * build never gets past launch, every single time, which is the loudest and
 * least ambiguous signal available on this platform. It is also not a new
 * risk — every one of the eleven modules already evaluated their `API_URL`
 * constant at their own import time; this only moves *when a bad value is
 * treated as fatal*, not *when the read happens*. A developer or tester
 * driving the build from Xcode/Android Studio/`adb logcat` sees a clear stack
 * trace naming this file and the missing variable, which is the on-device
 * diagnostic the design brief asked this module to reason about explicitly.
 */

const DEV_FALLBACK_URL = 'http://localhost:8080';

/** A bare, minimal shape check — no `URL` polyfill dependency either way. */
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/.+/i.test(value);
}

/**
 * The pure resolution rule, exported for tests.
 *
 * Kept separate from the module-level constants below so it can be tested
 * directly against every combination of inputs, the same shape
 * `scripts/validate-production-config.mjs`'s `classifyValue` uses — a pure
 * function with fixed inputs, rather than a module whose behaviour depends on
 * a global that's awkward to flip mid-suite.
 */
export function resolveApiBaseUrl(
  rawEnvValue: string | undefined,
  isDevelopment: boolean,
): string {
  const trimmed = rawEnvValue?.trim();

  if (!trimmed) {
    if (isDevelopment) return DEV_FALLBACK_URL;
    throw new Error(
      'EXPO_PUBLIC_API_URL is not set, and this is not a development build ' +
        '(__DEV__ is false) — refusing to silently fall back to ' +
        `${DEV_FALLBACK_URL}. Set EXPO_PUBLIC_API_URL for this build profile ` +
        '(apps/mobile/eas.json\'s "env", or an EAS environment variable for ' +
        'the production profile).',
    );
  }

  // A present-but-malformed value is a real misconfiguration in every mode,
  // dev included — dev tolerates ABSENCE (nobody has set up a `.env.local`
  // yet), never GARBAGE (somebody typed something and got it wrong).
  if (!looksLikeUrl(trimmed)) {
    throw new Error(
      `EXPO_PUBLIC_API_URL is set to "${trimmed}", which is not a valid ` +
        'http(s) URL. Fix the value for this build profile.',
    );
  }

  return trimmed;
}

/**
 * The resolved API base URL, e.g. `http://localhost:8080`.
 *
 * Evaluated once, at import time — see the module doc comment above for why
 * that timing is deliberate rather than incidental.
 */
export const API_URL = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_URL, __DEV__);

/** `API_URL` plus the `/v1` prefix every domain module's requests share. */
export const API_BASE = `${API_URL}/v1`;
