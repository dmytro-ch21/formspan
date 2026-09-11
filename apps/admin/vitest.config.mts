import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Tests for `apps/admin`, which had none.
 *
 * Added with the environment badge, and for the same shape of reason
 * `apps/web` got its first test: the badge exists to stop an operator editing
 * production while believing they are on staging, so a badge that classifies
 * wrongly is worse than no badge — it is a wrong answer to a question the
 * operator has stopped asking. Its fallback logic has three branches and no
 * other guard.
 *
 * Started deliberately narrow, mirroring web's: node environment, pure logic
 * only, on the argument that "the console's render path has not earned
 * component tests — no defect has lived there — and a jsdom setup nobody needs
 * yet is maintenance rather than safety."
 *
 * **N170/#547 widened it, and the reason is the ticket's own text rather than
 * a change of taste.** Its acceptance criteria ask for "component/integration
 * tests", and its Steps to test require that a failed mutation *renders* as an
 * error state the operator can act on, *asserted by a test*. The action-level
 * suite proves the action returns the right shape; nothing proved the operator
 * ever sees it. `ac-verifier` named that gap explicitly, along with
 * `RevisionHistory`'s "no restore on the newest revision" rule, which had no
 * coverage of any kind.
 *
 * The old argument was reasonable and was also the argument that held right up
 * until `load_mode`, `implements` and `note` each blanked authored data with no
 * test noticing (CLAUDE.md's backend section). "No defect has lived here" is a
 * statement about the past.
 *
 * **Environment is per-file, not global**, so the logic tests keep running in
 * node — jsdom is slower and gives them nothing. A render test opts in with a
 * `@vitest-environment jsdom` docblock. This is the first render test anywhere
 * in `apps/web` or `apps/admin`; CLAUDE.md records the standing gap as "0 of 40
 * web/admin pages have a test that renders them".
 */
export default defineConfig({
  // `@/` is Next's own alias from tsconfig, which vitest does not read.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // `.tsx` included so render tests are collected; they select jsdom
    // themselves with a `@vitest-environment` docblock.
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
  },
});
