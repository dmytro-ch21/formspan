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
    rules: {
      // THE rule this was added for. Anything it flags is a crash, not a smell.
      "react-hooks/rules-of-hooks": "error",

      /*
       * Everything below is a WARNING on purpose, and this is a deliberate
       * choice rather than a way to get to green.
       *
       * Turning lint on for the first time on a 30-screen app that has never
       * had it surfaced 54 errors. None is a crash; the two large groups are
       * `react-hooks/refs` (24 — refs touched during render) and
       * `set-state-in-effect` (15 — cascading renders). Both are real and both
       * are worth fixing, but folding 54 unrelated edits into a one-line crash
       * fix would make the fix unreviewable, and the alternative — switching
       * the rules off — throws the information away.
       *
       * So they report, `verify` passes, and the backlog stays visible every
       * time anyone runs it. Promote them to `error` as they are cleared, a
       * group at a time. Do not add to them.
       */
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react/no-unescaped-entities": "warn",
      "import/first": "warn",
      "import/no-duplicates": "warn",
    },
  },
]);
