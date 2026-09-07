/**
 * The one place that reads `NEXT_PUBLIC_API_URL`.
 *
 * **N165/#542.** `lib/api.ts` was the only module here with its own copy of:
 *
 *     const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
 *
 * — but a single call site is still worth centralizing in its own module
 * (rather than leaving the constant inline in `api.ts`), for the same reason
 * `apps/web` did: it is the one thing a future second admin API client would
 * otherwise have to remember to copy correctly rather than just import.
 *
 * `NEXT_PUBLIC_*` vars are inlined at BUILD time (`next build`), so a
 * production console built without this one set compiles cleanly and ships
 * every write permanently pointed at `localhost` — baked into the deployed
 * bundle until the next rebuild, with nothing on screen or in the build log
 * saying so. For this console specifically, that also means every content
 * write from an operator who believes they are talking to a real backend goes
 * nowhere, which is a worse failure than an athlete-facing 500: it looks like
 * a save that succeeded.
 *
 * Not `"server-only"`, even though `lib/api.ts` (its only caller) is: this
 * module touches no server-only API (no `auth()`, nothing Node-specific), so
 * there is no reason to forbid it from ever being imported by a client
 * component, and doing so would just be a restriction nothing here needs.
 *
 * `EnvironmentBadge.tsx` reads the SAME raw env var directly, and deliberately
 * does not import this module — that badge exists specifically to render a
 * "safety net" label for the state "the value is unset/unknown", including in
 * a build this module allows (`NODE_ENV !== "production"`) where the fallback
 * below is legitimate. Routing it through a helper that resolves a bare value
 * to a concrete localhost URL would erase the exact distinction the badge is
 * built to show. See that component's own header for the fuller reasoning.
 *
 * **Dev-mode gate: `process.env.NODE_ENV !== "production"`, not
 * `=== "development"`.** Measured directly: `vitest run` sets
 * `NODE_ENV=test`, not `development`, and this repo's own test discipline
 * ("Verify that a check can fail") means that measurement, not the textbook
 * idiom, is what this gate is built on. `!== "production"` keeps the
 * guarantee that matters — Next hard-codes `NODE_ENV=production` for
 * `next build`/`next start`, which is what every real deploy (staging and
 * production alike; there is no separate `NODE_ENV=staging`) runs — without
 * requiring a config value from a test run that ships nowhere.
 *
 * **What "fails loudly" means here.** A Next.js server process that throws
 * while evaluating a module reachable from a request fails to serve that
 * request, visibly, in the process's own logs — and because `NEXT_PUBLIC_*`
 * values are fixed at build time, the failure repeats on every request until
 * the app is rebuilt with the variable set. That is the ticket's own test:
 * "it fails immediately, naming the missing variable."
 */

const DEV_FALLBACK_URL = "http://localhost:8080";

/** A bare, minimal shape check — no dependency on the `URL` global either way. */
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/.+/i.test(value);
}

/**
 * The pure resolution rule, exported for tests. Kept separate from the
 * module-level constants below so both branches are testable without having
 * to flip `process.env.NODE_ENV` mid-suite.
 */
export function resolveApiBaseUrl(
  rawEnvValue: string | undefined,
  isDevelopment: boolean,
): string {
  const trimmed = rawEnvValue?.trim();

  if (!trimmed) {
    if (isDevelopment) return DEV_FALLBACK_URL;
    throw new Error(
      'NEXT_PUBLIC_API_URL is not set, and NODE_ENV is "production" — refusing ' +
        `to silently fall back to ${DEV_FALLBACK_URL}. Set NEXT_PUBLIC_API_URL ` +
        "for this deploy (see apps/admin/.env.example).",
    );
  }

  // A present-but-malformed value is a real misconfiguration in every mode,
  // dev included — dev tolerates ABSENCE (no .env.local yet), never GARBAGE.
  if (!looksLikeUrl(trimmed)) {
    throw new Error(
      `NEXT_PUBLIC_API_URL is set to "${trimmed}", which is not a valid ` +
        "http(s) URL. Fix the value for this deploy.",
    );
  }

  return trimmed;
}

/** The resolved API base URL, e.g. `http://localhost:8080`. */
export const API_URL = resolveApiBaseUrl(
  process.env.NEXT_PUBLIC_API_URL,
  process.env.NODE_ENV !== "production",
);

/** `API_URL` plus the `/v1` prefix every request builds on. */
export const API_BASE = `${API_URL}/v1`;
