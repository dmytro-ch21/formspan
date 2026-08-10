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
       * So they warn, `--max-warnings` in package.json holds the line, and the
       * backlog is visible on every run. Promote them a group at a time.
       *
       * These two are genuine downgrades — errors in eslint-config-expo:
       */
      "react-hooks/refs": "warn", // 24 — refs read or written during render
      "react-hooks/set-state-in-effect": "warn", // 15 — cascading renders
      "react/no-unescaped-entities": "warn", // 1

      /*
       * These three are PINS, not downgrades: already `warn` upstream. Named so
       * an upstream promotion to error cannot land as a surprise in an
       * unrelated PR.
       */
      "react-hooks/exhaustive-deps": "warn",
      "import/first": "warn",
      "import/no-duplicates": "warn",

      /*
       * The `@typescript-eslint/*` findings (6 require-imports in test mocks,
       * 1 unused var, 1 redeclare) are NOT named here, and the reason is
       * precise: eslint-config-expo registers the React plugins GLOBALLY but
       * registers `@typescript-eslint` only for TypeScript globs. So a rules
       * block naming one of its rules must be `files`-scoped to those globs; an
       * unscoped block fails to LOAD the whole config the moment a `.js` file is
       * linted ("could not find plugin"), rather than changing a severity.
       *
       * They are already warnings upstream, so they are simply left alone.
       */
    },
  },
]);
