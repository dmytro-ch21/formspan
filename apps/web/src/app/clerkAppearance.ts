import type { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";

/**
 * Derived from the provider that consumes them rather than imported from
 * `@clerk/types`, which pnpm's strict layout doesn't expose to this package —
 * nothing here declares it directly. Deriving also means these can never drift
 * from what `ClerkProvider` actually accepts.
 */
type ProviderProps = ComponentProps<typeof ClerkProvider>;
type Appearance = NonNullable<ProviderProps["appearance"]>;
type Localization = NonNullable<ProviderProps["localization"]>;

/**
 * Making Clerk's prebuilt auth UI look like VOLA.
 *
 * Web deliberately does *not* hand-build its auth screens the way
 * `apps/mobile` does. Mobile needs the headless hooks because the flows
 * themselves needed designing — offline-tolerant errors, an interrupted
 * sign-up that resumes, a code that may or may not have been sent. On the
 * desk surface none of that applies: the network is fine, the window is big,
 * and Clerk's component already handles sign-in, sign-up, password reset,
 * OAuth and 2FA correctly. Re-implementing it here would be a third copy of
 * logic that has no product opinion attached to it.
 *
 * What *was* wrong is that it looked like Clerk rather than like VOLA. This
 * closes that without taking ownership of the flows.
 *
 * **Every colour is a `var()`, not a literal.** Web is light by default with
 * an opt-in dark mode, and `ThemeScript` runs in `<head>` to set `data-theme`
 * on `<html>` *before* hydration. So by the time anything mounts, `:root`
 * already carries the user's real preference and these resolve to it — no
 * theme detection here, no second config, and nothing rendered server-side for
 * the client to contradict. Hardcode a hex and dark-mode users get a white
 * modal.
 *
 * **Known constraint, measured:** Clerk resolves `variables` when the modal
 * *mounts* and does not re-resolve if the CSS variables change underneath an
 * already-open modal — flip `data-theme` with the modal open and the card and
 * primary button keep their old colours (the `elements` classes below, being
 * real CSS rules, do follow). That is unreachable today because `ThemeToggle`
 * is rendered only by `dashboard/layout.tsx`, behind auth, so a signed-out
 * user has no way to change theme while this modal is up. **If a theme toggle
 * is ever added to the public landing page, this becomes a real bug** and the
 * modal will need remounting on theme change.
 */
export const clerkAppearance: Appearance = {
  /**
   * Puts Clerk's runtime-injected stylesheet into a named cascade layer, which
   * `globals.css` orders *below* Tailwind's `components`/`utilities`.
   *
   * Without this, Clerk's CSS is **unlayered** — and an unlayered declaration
   * beats every layered one regardless of specificity or source order. That,
   * not specificity, is why the `elements` classes below were no-ops. With it,
   * a Tailwind class passed to `elements` deterministically wins.
   */
  cssLayerName: "clerk",

  variables: {
    // The semantic "solid control" pair: navy-on-light, lime-on-dark. Using
    // --c-lime directly would be wrong on light, where the brand lime is only
    // legible as a rule or a tint, never as a fill.
    colorPrimary: "var(--c-accent-fill)",

    // The label on a primary button. Clerk otherwise derives it by contrast
    // maths and lands on white; VOLA's answer is the lime, stated rather than
    // guessed. Note the `*Foreground` spellings throughout — the older
    // `colorText`/`colorInputText`/`colorTextSecondary` aliases still exist in
    // some @clerk/shared versions but are gone from the one this app resolves,
    // so using them compiles nowhere and silently styles nothing where it does.
    colorPrimaryForeground: "var(--c-accent-on-fill)",

    colorBackground: "var(--c-surface)",
    colorForeground: "var(--c-text)",
    colorMutedForeground: "var(--c-text-muted)",
    colorInput: "var(--c-surface)",
    colorInputForeground: "var(--c-text)",
    colorDanger: "var(--c-danger)",

    // Clerk's default for this is literally `black`, and it drives *borders,
    // dividers, hover fills and focus rings*. Left alone it derives all of
    // them from black — invisible against a near-black dark surface. `--c-text`
    // is the token that already flips the right way (dark ink on light, light
    // ink on dark), which is exactly the shape Clerk documents wanting here.
    colorNeutral: "var(--c-text)",

    // Must be pinned alongside `colorNeutral`: the modal backdrop otherwise
    // defaults to the neutral at ~73% opacity, which after the line above
    // would drop a near-WHITE scrim over the dark theme.
    colorModalBackdrop: "var(--c-navy)",

    // `colorSuccess` and `colorWarning` are deliberately NOT set to VOLA's
    // tokens. Clerk renders both as small text (password-strength feedback,
    // inline alerts), and measured against the light surface `--c-green`
    // (#42f58d) is 1.43:1 and `--c-warn` (#b06a00) is 4.28:1 — one invisible,
    // one under AA. `--c-green` is also identical in both theme blocks, so it
    // has no legible-on-light variant to reach for. Brand consistency loses to
    // legibility on status text; Clerk's own defaults are readable. Revisit if
    // the palette ever grows light-theme success/warning steps.

    // Barlow, the same face the rest of the app uses. Without this the modal
    // is the one element on screen in the browser's default sans.
    fontFamily: "var(--font-barlow), system-ui, sans-serif",

    // The same radius the app's own controls use, via the shared token rather
    // than a second literal that has to be kept in sync by hand. Clerk's
    // default is rounder and reads as a different product sitting on ours.
    borderRadius: "var(--radius-control)",
  },
  /**
   * `elements` appends class names to Clerk's markup. Whether they take effect
   * is decided by the `cssLayerName` above, and that is not a detail:
   *
   * **Before it, three of the four overrides written here were silent no-ops.**
   * `card: "border border-line"` computed to `border-width: 0`,
   * `footer: "bg-surface"` to `rgba(0,0,0,0)`, and `footerActionLink:
   * "text-lime"` never applied at all. Not a specificity problem — Tailwind
   * emits into `@layer utilities` and Clerk's runtime stylesheet was unlayered,
   * and unlayered wins over any layer. Naming Clerk's layer fixed it; verified
   * by giving the card a garish background and watching it take.
   *
   * **The sharp edge:** that fix makes previously-inert config suddenly live.
   * `footerActionLink: "text-lime"` is deliberately NOT restored — with layers
   * working it *would* now apply, and light-theme `--c-lime` (#6f9c00) on white
   * is 3.27:1, an AA failure for small text. It was harmless only because it
   * was broken. Clerk's own link colour, derived from `colorPrimary`, is navy
   * on light and passes.
   *
   * So: prefer `variables` for colour. Anything added here gets checked with
   * `getComputedStyle` on the live dialog **in both themes** — dark alone will
   * not catch it, since `--c-lime` and `--c-accent-fill` are the same colour
   * there. And note a misspelled key compiles clean: the `Elements` union
   * defeats excess-property checking, so TypeScript will not catch the typo.
   */
  elements: {
    // VOLA's own hairline rather than Clerk's shadow-only card edge.
    card: "border border-line",
    // Clerk's footer rule is a light hairline that reads as a seam on dark.
    footer: "border-t border-line-soft",
  },
};

/**
 * Clerk builds its titles from the **application name in the Clerk
 * dashboard**, which is still "Formspan dev" — the VOLA rename covered the
 * repo and the code, never the external service accounts. Until someone
 * renames it there, every athlete signing in reads "Sign in to Formspan dev".
 *
 * These overrides fix the two strings a customer actually sees. They are a
 * patch over a wrong setting, not a fix for it: **Clerk's own transactional
 * emails — verification codes, password resets — are generated server-side
 * and will still say Formspan.** Renaming the application in the dashboard is
 * the real fix, and these lines stay correct after it.
 */
export const clerkLocalization: Localization = {
  signIn: {
    start: {
      title: "Sign in to VOLA",
      subtitle: "Welcome back.",
      titleCombined: "Sign in to VOLA",
      subtitleCombined: "Welcome back.",
    },
  },
  signUp: {
    start: {
      title: "Create your VOLA account",
      subtitle: "One account for your training, sessions and history.",
      titleCombined: "Create your VOLA account",
      subtitleCombined: "One account for your training, sessions and history.",
    },
  },
};

/*
 * Two things known to be incomplete here, both cheap to get wrong silently:
 *
 * 1. `titleCombined`/`subtitleCombined` above are the strings Clerk uses if the
 *    instance is switched to the combined sign-in-or-up flow. They're set so
 *    that flipping that setting in the dashboard doesn't quietly resurrect
 *    "Formspan dev" — the override would otherwise stop being read at all.
 * 2. Only the *first* screen of each flow is overridden. Clerk interpolates the
 *    application name into other defaults too, so the password, email-code and
 *    forgot-password steps may still say Formspan. Not verified — reaching them
 *    needs a real account. The dashboard rename remains the actual fix.
 */
