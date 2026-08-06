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
 * Deliberately narrow, mirroring web's: node environment, pure logic only. The
 * console's render path has not earned component tests — no defect has lived
 * there — and a jsdom setup nobody needs yet is maintenance rather than safety.
 * Widen it when a render-path bug argues for it.
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
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
