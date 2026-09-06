import { defineConfig, globalIgnores } from "eslint/config";
import expo from "eslint-config-expo/flat.js";

/**
 * Lint for `apps/mobile`.
 *
 * Added because this app had none, and the gap was not academic: a BJJ session
 * opened from Today crashed with "Rendered more hooks than during the previous
 * render" — one `useMemo` sitting after an early return, so the loading render
 * called one fewer hook than every render after it. Black screen, every time.
 *
 * `react-hooks/rules-of-hooks` catches exactly that, and nothing else can: hook
 * order is a RUNTIME property, so `typecheck:mobile` is structurally blind to it
 * and `test:mobile` is deliberately not component tests. The app with the most
 * stateful screens in this repo was the one app not being linted.
 *
 * `eslint-config-expo` is Expo's own flat config, so the React and React Hooks
 * rules match this runtime rather than a hand-assembled set that drifts from
 * what Expo ships.
 */
/**
 * N508 — the spacing/radius/fontSize scales, restated as ESLint selectors.
 *
 * Computed here (a plain `.mjs`, so this runs as ordinary JS at config-load
 * time) rather than hand-typed as N separate `no-restricted-syntax` entries,
 * one per number — the numbers themselves are the same ones
 * `constants/Spacing.ts`/`constants/Typography.ts` name, restated here only
 * because ESLint's `no-restricted-syntax` takes a static selector string, not
 * an imported constant.
 *
 * Deliberately an exact-value match, not "any bare numeric literal on these
 * properties". Forcing every existing off-scale literal (`paddingHorizontal:
 * 18`, `fontSize: 17`) onto the scale was explicitly rejected for this ticket
 * — see `Spacing.ts`'s own doc comment on why the scale was widened to fit
 * real usage rather than the reverse. A literal that already equals a named
 * token's value is what the acceptance criteria call "restating a token as a
 * new literal"; an off-scale one-off is neither on the scale nor pretending
 * to be, so it isn't the drift this guards against.
 */
const SPACING_PROP_PATTERN =
  "(padding|paddingHorizontal|paddingVertical|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginHorizontal|marginVertical|marginTop|marginBottom|marginLeft|marginRight|gap|rowGap|columnGap)";
const SPACING_SCALE_VALUES = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 48, 64];
const RADIUS_PROP_PATTERN =
  "(borderRadius|borderTopLeftRadius|borderTopRightRadius|borderBottomLeftRadius|borderBottomRightRadius)";
const RADIUS_SCALE_VALUES = [8, 12, 14, 16, 24, 999];
// The seven sizes `constants/Typography.ts`'s roles actually use — NOT every
// fontSize this app has ever shipped. 16/17/18 etc. stay unrestricted: 16
// alone has 8 real sites in just the six converted screens (measured in
// `Typography.ts`'s own doc comment) that aren't the same role as `emphasis`
// (15) or `title` (20) — folding it into either would be a value change no
// screen asked for, not a token substitution.
const FONT_SIZE_SCALE_VALUES = [11, 12, 13, 14, 15, 20, 28];

const spacingSelector = SPACING_SCALE_VALUES.map(
  (v) => `Property[key.name=/^${SPACING_PROP_PATTERN}$/] > Literal[value=${v}]`,
).join(", ");
const radiusSelector = RADIUS_SCALE_VALUES.map(
  (v) => `Property[key.name=/^${RADIUS_PROP_PATTERN}$/] > Literal[value=${v}]`,
).join(", ");
const fontSizeSelector = FONT_SIZE_SCALE_VALUES.map(
  (v) => `Property[key.name='fontSize'] > Literal[value=${v}]`,
).join(", ");

/**
 * The eight files N508 actually converted. An ALLOWLIST, not a directory
 * glob — ~130 files in this app still mint bare spacing/fontSize literals on
 * purpose (this is the foundational PR, not the full app-wide migration; see
 * this ticket's `docs/decisions/history.md` entry for the follow-up-batch
 * plan), and widening this rule ahead of actually converting a file would be
 * a wall of new warnings with no token reference to fix them with — exactly
 * the trap this session's mobile lint ratchet has zero headroom for.
 */
// Square brackets are ESCAPED (`\\[id\\]`, not `[id]`) — a bare `[id]` is a
// glob CHARACTER CLASS to minimatch (the matcher flat config's `files` uses
// under the hood), meaning "the character i or d", not the literal dynamic-
// route filename. Verified directly: `minimatch('app/running/[id].tsx',
// 'app/running/[id].tsx')` is `false`; the escaped pattern is `true`. Without
// this escaping, this whole rule silently never applied to any of the three
// `[id].tsx` routes below — parens in `(tabs)` don't need the same treatment,
// since plain (non-extglob) minimatch treats `(`/`)` as ordinary characters.
const N508_CONVERTED_FILES = [
  "components/ui/Section.tsx",
  "components/ui/Stat.tsx",
  "components/ScreenHeader.tsx",
  "app/(tabs)/workouts.tsx",
  "app/(tabs)/progress.tsx",
  "app/running/\\[id\\].tsx",
  "app/bjj/session/\\[id\\].tsx",
  "app/session/\\[id\\].tsx",
];

export default defineConfig([
  ...expo,
  globalIgnores([".expo/**", "dist/**", "node_modules/**", "ios/**", "android/**"]),
  {
    /*
     * Jest globals. The test files use `jest`, `describe` and friends, which
     * nothing declares — without this every test file is a wall of `no-undef`
     * and the real findings are unreadable. Tests are linted rather than
     * ignored on purpose: the hook rules apply to them too, and the mocks in
     * this suite call hooks.
     */
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx", "jest.setup.js"],
    languageOptions: {
      globals: {
        jest: "readonly",
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
        global: "readonly",
      },
    },
  },
  {
    /*
     * `db.withTransactionAsync` is unsafe on this app's ONE shared connection:
     * two overlapping calls end each other's transaction, which surfaced as
     * "cannot rollback - no transaction is active" rendered over the Plan tab
     * and, silently, as a lost reconcile. `lib/db.ts`'s `withTransaction`
     * serialises them; this rule is what stops the direct call coming back.
     *
     * `lib/db.ts` is exempt because it is the one legitimate caller — it makes
     * the call the queue wraps.
     *
     * NO `files` NARROWING. It was scoped to TypeScript extensions only, which
     * left `.js`, `.jsx` and `.mjs` unguarded — verified by probe: a `lib/foo.js`
     * calling `db.withTransactionAsync()` linted clean. Every source file here
     * is TypeScript today, so it was theoretical; a rule whose entire job is to
     * stop something coming back should not have a hole that a file extension
     * opens. Nothing forces the narrowing either — `no-restricted-syntax` is a
     * core rule, so it carries none of the plugin-loading constraint this
     * config documents for the `@typescript-eslint` blocks.
     */
    ignores: ["lib/db.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        /*
         * Three selectors, because one is trivially bypassed without meaning
         * to: `db["withTransactionAsync"](...)` puts the name on a Literal
         * where `property.name` is undefined, and destructuring produces no
         * MemberExpression at all. The destructuring form is the one someone
         * writes without thinking about it.
         */
        {
          selector: "MemberExpression[property.name='withTransactionAsync']",
          message:
            "Use withTransaction(db, fn) from lib/db.ts. Calling db.withTransactionAsync directly races other transactions on the shared connection — see the comment there.",
        },
        {
          selector: "MemberExpression[property.value='withTransactionAsync']",
          message:
            "Use withTransaction(db, fn) from lib/db.ts. Calling db.withTransactionAsync directly races other transactions on the shared connection — see the comment there.",
        },
        {
          selector: "ObjectPattern > Property[key.name='withTransactionAsync']",
          message:
            "Use withTransaction(db, fn) from lib/db.ts. Destructuring withTransactionAsync off the database escapes the queue that keeps transactions from destroying each other — see the comment there.",
        },
      ],
    },
  },
  {
    // N508 — see the constants and comment above this file's `export
    // default` for the full argument. Scoped to exactly the eight files this
    // ticket converted; widen this list as future migration batches land.
    files: N508_CONVERTED_FILES,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: spacingSelector,
          message:
            "This value is on constants/Spacing.ts's scale — reference Spacing.* instead of restating the number. See Spacing.ts for the name.",
        },
        {
          selector: radiusSelector,
          message:
            "This value is on constants/Spacing.ts's Radius scale — reference Radius.* (or Card.base) instead of restating the number.",
        },
        {
          selector: fontSizeSelector,
          message:
            "This fontSize matches a constants/Typography.ts role — reference Typography.<role>.fontSize (or spread the role) instead of restating the number.",
        },
      ],
    },
  },
  {
    rules: {
      /*
       * `rules-of-hooks` is THE rule this was added for, and it is an error.
       *
       * It is not the only error, and that is worth stating: v7's recommended
       * set also errors on `purity`, `set-state-in-render`, `immutability`,
       * `static-components`, `preserve-manual-memoization` and others, none of
       * which this file touches. They report zero today, so the gate is green —
       * but new code CAN fail on a rule not named here. Intended, and written
       * down so it is not a surprise.
       */
      "react-hooks/rules-of-hooks": "error",

      /*
       * Turning lint on for the first time on thirty never-linted screens
       * surfaced 55 findings; one was the crash. The rest are real but are not
       * crashes, and folding fifty-odd unrelated edits into a one-line crash fix
       * would make the fix unreviewable. Switching the rules off would throw the
       * information away instead.
       *
       * So they warn, and `scripts/check-lint-ratchet.mjs` (N153/#557) holds a
       * per-rule cap against the LIVE count on every run — never a flat total, and
       * never a number copied into a doc. Promote a rule to `error` one at a time,
       * the moment `check-lint-ratchet.mjs` reports its live count at zero; the
       * script fails loudly with instructions when that happens rather than
       * letting a zero-warning rule sit at `warn` forever. See that script's doc
       * comment for the counts as last measured and the full design.
       *
       * These two are genuine downgrades — errors in eslint-config-expo:
       */
      "react-hooks/refs": "warn", // 24 — refs read or written during render
      "react-hooks/set-state-in-effect": "warn", // 14 — cascading renders
      "react/no-unescaped-entities": "warn", // 1

      /*
       * These two are PINS, not downgrades: already `warn` upstream. Named so
       * an upstream promotion to error cannot land as a surprise in an
       * unrelated PR.
       *
       * `react-hooks/exhaustive-deps` used to be a third pin here. N153/#557
       * measured its LIVE count at zero — the 15 sites that would otherwise warn
       * all carry a rule-specific `eslint-disable-next-line`, which suppresses
       * regardless of severity — so it converts to `error` below rather than
       * staying a third entry in this list. It is a real error now, not a pin:
       * an upstream demotion of it back to `warn` would no longer be silent,
       * either — `check-lint-ratchet.mjs` only walks rules that are `warn` in
       * THIS file, so a demotion upstream is invisible to it precisely because
       * this file overrides it, same as `rules-of-hooks` above.
       */
      "import/first": "warn",
      "import/no-duplicates": "warn",
      "react-hooks/exhaustive-deps": "error",

      /*
       * The `@typescript-eslint/*` findings (6 `no-require-imports` in test
       * mocks, 1 `no-redeclare` — re-measured 2026-09-06 for N153/#557; an
       * earlier version of this comment said "1 unused var" instead of
       * `no-redeclare`, which had already gone stale) are NOT named here, and
       * the reason is precise: eslint-config-expo registers the React plugins
       * GLOBALLY but registers `@typescript-eslint` only for TypeScript globs.
       * So a rules block naming one of its rules must be `files`-scoped to
       * those globs; an unscoped block fails to LOAD the whole config the
       * moment a `.js` file is linted ("could not find plugin"), rather than
       * changing a severity.
       *
       * They are already warnings upstream, so severity is simply left alone
       * here — but both are still capped in `scripts/check-lint-ratchet.mjs`
       * (N153/#557), same as every other rule this app lints at `warn`. That
       * script's cap table is the one place their counts are tracked; this
       * comment is prose, not the source of truth, and the drift above is why.
       */
    },
  },
]);
