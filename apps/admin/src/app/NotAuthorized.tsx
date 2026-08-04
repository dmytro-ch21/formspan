import { UserButton } from "@clerk/nextjs";

import { VolaLockup } from "./Brand";

/**
 * The screen a signed-in account that isn't on the allowlist gets.
 *
 * Rendered by `users/`, `content/` and `health/`'s layouts, which held three
 * byte-identical copies of it. **Only the screen is shared, not the gate** —
 * each layout still calls `currentUser()` and `isAllowedAdmin` itself, in
 * plain sight, because that check is the load-bearing line and a reader
 * shouldn't have to follow an import to find out whether a route is guarded.
 * (The backend's `RequireAdmin` remains the real boundary; this is defence in
 * depth for the UI.)
 *
 * **The lockup here, unlike the masthead's mark, and it is not a link.** This is
 * a full-page centred surface, which is the arrangement the stacked lockup was
 * measured for. It stays inert because the only place to send someone is the
 * route that just refused them.
 *
 * It carries "ADMIN" beneath it on the signed-out entry but not here: there, the
 * lockup *is* the page's subject and the qualifier is its heading text. Here the
 * heading is the refusal, and a second line of display type above it would
 * compete with the thing the reader actually needs. The wrapper's `aria-label`
 * says which console refused them, which is what the qualifier was carrying.
 */
export function NotAuthorized({ userId }: { userId?: string }) {
  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {/* Named on the wrapper: both brand primitives are unconditionally
          `aria-hidden`, so a standalone lockup is invisible to a screen reader
          with no way to override it from inside. `role="img"` also stops a
          linear pass descending into seven paths. */}
      <span role="img" aria-label="VOLA Admin" className="mb-2">
        <VolaLockup width={104} />
      </span>

      <h1 className="font-barlow-condensed text-2xl font-bold tracking-[0.06em] uppercase">
        Not authorized
      </h1>
      {/*
        The `{" "}` is load-bearing, and its absence shipped: all three copies
        of this screen read "user_2xYz…isn't on the admin allowlist", with the
        id welded to the next word.

        **Do not "correct" this back to a plain space on the strength of what
        Babel does.** Babel keeps it — `cleanJSXElementLiteralChild` trims
        leading whitespace only on lines *after* the first — and a reviewer
        reasonably called the fix unnecessary on exactly that basis. This app
        is built by SWC/Turbopack, which does not agree. Measured here, all
        four variants under the real toolchain:

          {expr} text…            wrapping to a second line  → space LOST
          {expr} text…            all on one line            → space kept
          {expr}\n text…          text starts its own line   → space LOST
          {expr}{" "}             as written below           → space kept

        The first is precisely the shape all three originals had, which is why
        this went out three times: nothing catches it but reading the rendered
        page — no typecheck, no lint, no test.
      */}
      <p className="max-w-sm text-sm text-text-secondary">
        {userId ?? "This account"}{" "}
        isn&apos;t on the admin allowlist. Ask an existing admin to add it to{" "}
        <code>ADMIN_USER_IDS</code>.
      </p>
      <UserButton />
    </main>
  );
}
