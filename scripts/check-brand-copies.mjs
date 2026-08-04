#!/usr/bin/env node
/**
 * Fails if `apps/web` and `apps/admin`'s copies of the brand components have
 * drifted.
 *
 * The two files are deliberate duplicates — see either file's doc comment, and
 * the 2026-08-04 history entry, for why a shared package was not the answer.
 * The mitigation written alongside that decision was a comment telling the next
 * person to change both. That guarantee lasted exactly one commit: the first
 * copy shipped with `apps/web`'s theme tokens and a reference to `ThemeScript`,
 * neither of which exists in `apps/admin`. Hence this.
 *
 * Only the component bodies are compared, from the `import type` line onward.
 * The doc comments above it are expected to differ — each describes its own
 * app, and forcing those to match is what produced the wrong comment in the
 * first place.
 *
 * This is a stopgap. The real fix is generating both files from
 * `assets/brand/logos/source/`, which would also cover `apps/mobile`'s copy of
 * the lockup ratios — a React package cannot reach that one, since the app
 * deliberately has no `react-native-svg`.
 */
import { readFileSync } from "node:fs";

const MARKER = "import type { CSSProperties }";
const FILES = [
  "apps/web/src/app/Brand.tsx",
  "apps/admin/src/app/Brand.tsx",
];

const bodies = FILES.map((file) => {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(MARKER);
  if (at === -1) {
    // Not a pass. If the marker is gone the files were restructured, and a
    // check that silently succeeds on a file it cannot find its way into is
    // worse than no check.
    console.error(
      `check-brand-copies: could not find ${JSON.stringify(MARKER)} in ${file}.\n` +
        "The comparison anchor is gone, so drift can no longer be detected. " +
        "Update MARKER in scripts/check-brand-copies.mjs to the new boundary " +
        "between the doc comment and the component bodies.",
    );
    process.exit(1);
  }
  return { file, body: source.slice(at) };
});

const [web, admin] = bodies;
if (web.body !== admin.body) {
  const webLines = web.body.split("\n");
  const adminLines = admin.body.split("\n");
  const firstDiff = webLines.findIndex((line, i) => line !== adminLines[i]);
  console.error(
    `check-brand-copies: ${web.file} and ${admin.file} have drifted.\n\n` +
      `First difference at body line ${firstDiff + 1}:\n` +
      `  ${web.file}:   ${JSON.stringify(webLines[firstDiff] ?? "<end of file>")}\n` +
      `  ${admin.file}: ${JSON.stringify(adminLines[firstDiff] ?? "<end of file>")}\n\n` +
      "These are deliberate copies — change one and you must change the other. " +
      "Only the doc comments above the import are allowed to differ.",
  );
  process.exit(1);
}

console.log(
  `check-brand-copies: ${FILES.length} copies identical (${web.body.split("\n").length} lines compared)`,
);
