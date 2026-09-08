/**
 * N132 (#536), relocated by N529 (#960) — a build must never be mistaken for
 * production by looking at it.
 *
 * `EXPO_PUBLIC_APP_ENV` is inlined at bundle time from each EAS build
 * profile's `env` block (`apps/mobile/eas.json`) and from `.env.example`'s
 * local-dev default. This returns a label whenever it resolves to anything
 * other than exactly `"production"`, and `null` when it does.
 *
 * **Fails safe in the direction that matters for a safety instrument**: an
 * unset or misspelled value is treated as non-production (a label is shown)
 * rather than silently hidden — the only way this can be wrong is by showing
 * on a real production build, never the reverse. The single profile allowed
 * to suppress it (`EXPO_PUBLIC_APP_ENV === "production"`) is asserted
 * separately, statically, by `scripts/validate-production-config.mjs`'s
 * `--check` (wired into `pnpm run verify`), so eas.json's production profile
 * cannot drift to some OTHER value and silently show the label on a release.
 *
 * **Where it is shown moved, and why.** N132 rendered this as a `DEV` pill in
 * a fixed corner of every screen, over the splash included. The user's
 * household builds are all dev-env builds, so that corner said `DEV` on every
 * screen forever — and N529 gave the corner to a control an athlete actually
 * taps (`components/ShareBell.tsx`). The label now lives on the Settings
 * screen's footer (`settings-environment`), beside the crash-reporting
 * diagnostic it belongs with: still discoverable in one tap from You, still
 * absent on production, no longer chrome. What is given up is the
 * first-frame guarantee — a build talking to the wrong backend no longer says
 * so before the athlete reaches a screen — and that trade was the user's own
 * call, made in as many words.
 *
 * Pure, so both arms are pinned by `lib/__tests__/environmentLabel.test.ts`
 * without rendering Settings.
 */
export function environmentLabel(env: string | undefined): string | null {
  if (env === 'production') return null;
  return env ? env.toUpperCase() : 'DEV';
}
