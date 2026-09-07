/**
 * The one place that reads `NEXT_PUBLIC_API_URL`.
 *
 * **N165/#542.** Four modules (`api.ts`, `modules.ts`, `telemetryClient.ts`,
 * `unitSystem.ts`) each opened with their own copy of:
 *
 *     const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
 *
 * `NEXT_PUBLIC_*` vars are inlined at BUILD time (`next build`), so a
 * production or staging build made without this one set compiles cleanly and
 * ships with every request permanently pointed at `localhost` — baked into
 * the deployed bundle until the next rebuild, with nothing on screen or in the
 * build log saying so.
 *
 * Deliberately NOT `"use client"` and NOT `"server-only"`: `api.ts` is a
 * client module and `modules.ts`/`unitSystem.ts` are plain server-callable
 * modules (see their own header comments on why `api.ts`'s directive rules
 * them out as a home for this) — this module has to be importable from both,
 * so it carries neither restriction itself. Next bundles a plain module into
 * whichever graph imports it.
 *
 * **Dev-mode gate: `process.env.NODE_ENV !== "production"`, not
 * `=== "development"`.** The narrower form is Next's own textbook idiom —
 * `next dev` sets `NODE_ENV=development`; `next build`/`next start` do not —
 * and it is *almost* right, but this repo's test runner breaks it: measured
 * directly, `vitest run` sets `NODE_ENV=test`, not `development`, and four
 * existing test files (`curriculumSections`, `mapCrossings`,
 * `roundMapLayout`, `nutritionSeries`) import `@/lib/api` without ever
 * setting `NEXT_PUBLIC_API_URL`. The narrow check would have made every one
 * of those throw on import, in every local run and in CI, the moment this
 * change landed. `!== "production"` keeps the one guarantee that actually
 * matters — Next hard-codes `NODE_ENV=production` for `next build`/`next
 * start`, which is what every staging AND production deploy runs (there is
 * no separate `NODE_ENV=staging`; the two are told apart by which URL was
 * baked in, not by which mode Next thinks it's in) — while not requiring a
 * config value from a test run that ships nowhere.
 *
 * **What "fails loudly" means here.** A Next.js server process that throws
 * while evaluating a module reachable from a request handler fails to serve
 * that request, visibly, in the process's own logs — and because
 * `NEXT_PUBLIC_*` values are fixed at build time, the failure repeats on
 * every request until the app is rebuilt with the variable set. That is a
 * legible operational failure (the ticket's own test: "it fails immediately,
 * naming the missing variable"), unlike today's behaviour of quietly serving
 * every page while talking to `localhost`.
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
        "for this deploy (see apps/web/.env.example).",
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
