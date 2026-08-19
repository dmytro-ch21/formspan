import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Tests for `apps/web`, which had none.
 *
 * Added when `lib/roadmapFocus.ts` arrived: it decides which techniques enter a
 * focus list that `PUT /v1/bjj/focus` then REPLACES WHOLESALE, so a wrong
 * branch silently deletes an athlete's own choices. That is not something to
 * ship into a repo whose stated discipline is that every guard should go red
 * when the code it covers is deleted.
 *
 * Deliberately narrow: node environment, pure logic only. `apps/mobile` earned
 * component tests by shipping two defects that existed only in the render path;
 * nothing here had, and a jsdom setup nobody needs yet is a maintenance cost
 * rather than a safety net. The note used to end "widen it when a render-path
 * bug argues for it", and N28 is the argument — so `.tsx` is included now.
 *
 * **Still no jsdom, and still `environment: "node"`.** The one thing that
 * needed covering is what the markup CONTAINS — that an unlogged day draws no
 * bar and that a line breaks across a gap rather than spanning it — and
 * `react-dom/server`'s `renderToStaticMarkup` answers that with a dependency
 * this app already ships. Nothing here clicks anything; the moment something
 * needs to, that is the argument for jsdom and testing-library, and it is a
 * different argument from this one.
 */
export default defineConfig({
  // `@/` is Next's own alias from tsconfig, and vitest does not read that.
  // Without it the first import of `@/lib/api` fails at collection time and the
  // file reports "no tests" rather than an error anyone can act on.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/lib/__tests__/**/*.test.ts", "src/app/**/__tests__/**/*.test.tsx"],
  },
});
