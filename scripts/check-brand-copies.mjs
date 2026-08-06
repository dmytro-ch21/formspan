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
 * `assets/brand/logos/source/`, the way `scripts/generate_icons.mjs` now
 * generates the mobile icon set from `assets/brand/icons/`. Note the old
 * reason that could not cover `apps/mobile` — "the app deliberately has no
 * react-native-svg" — no longer holds: it turned out to ship inside Expo Go,
 * so the mobile app renders real SVG now and a generator can reach it too.
 */
import { createHash } from "node:crypto";
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

/**
 * The belt renders, which are copied rather than shared for a different reason.
 *
 * They are supplied artwork with no SVG upstream — see `BeltPhoto.tsx` — so
 * unlike the icon set there is nothing to generate them from, and unlike the
 * Brand components there is nothing to compare but the bytes. `apps/web` needs
 * them for the curriculum cards and cannot reach into `apps/mobile/assets`, so
 * there are two copies of each.
 *
 * Hashed rather than eyeballed because the failure is silent: a re-export at a
 * different size or with a different background leaves an app rendering a belt
 * that does not match the one beside it, and nothing complains.
 */
const BELT_COPIES = ["white", "blue", "purple", "brown", "black"].map((belt) => ({
  belt,
  mobile: `apps/mobile/assets/images/belts/${belt}.webp`,
  web: `apps/web/public/belts/${belt}.webp`,
}));

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

for (const { belt, mobile, web: webCopy } of BELT_COPIES) {
  const a = sha(mobile);
  const b = sha(webCopy);
  if (a !== b) {
    console.error(
      `check-brand-copies: the ${belt} belt render has drifted.\n` +
        `  ${mobile}: ${a.slice(0, 12)}\n` +
        `  ${webCopy}: ${b.slice(0, 12)}\n\n` +
        "These are byte-identical copies of supplied artwork. Re-export once " +
        "and copy to both, or the two apps render different belts.",
    );
    process.exit(1);
  }
}

console.log(
  `check-brand-copies: ${FILES.length} copies identical ` +
    `(${web.body.split("\n").length} lines compared), ` +
    `${BELT_COPIES.length} belt renders identical`,
);
