#!/usr/bin/env node
/**
 * H14 (#948): the brand rasters in `apps/mobile/assets/images/` still depict the
 * SVG masters in `assets/brand/` they were rendered from, and nothing has changed
 * their bytes unannounced.
 *
 * CLAUDE.md says those rasters are generated from the masters. That was true in
 * substance: each was rendered from its master by hand, in commits 4b80fb02 and
 * 3d19178a. But nothing re-ran that step or checked it, and `check:brand-copies`,
 * which reads as if it guarded brand assets, never opened one of these files.
 * Measured before this check existed, every raster still matches its master: the
 * Android background pixel for pixel, the rest within renderer anti-aliasing.
 *
 * Three checks, all driven by `scripts/brand-rasters.json`:
 *
 * - INTEGRITY. Each raster's SHA-256 is pinned, so any edit fails, down to one
 *   pixel. This is what catches a PNG touched by hand.
 * - FIDELITY. The raster, trimmed to its visible content, is compared with its
 *   master rendered at the same content size. This fails when a master changed
 *   and nobody re-exported, or when the manifest names the wrong master. It
 *   cannot see a one-pixel change, because renderer noise alone moves up to ~1%
 *   of edge pixels; integrity exists for exactly that.
 * - COVERAGE. Every PNG directly in the images folder must be in the manifest,
 *   so a new brand raster cannot arrive unchecked.
 *
 * Tolerances are per asset, recorded beside what they measured. The 96px favicon
 * gets the widest because resampling noise dominates at that size. Every run
 * prints its measurements, so a CI log records what a Linux renderer measures.
 *
 * It needs `sharp`, a root devDependency pinned to the version Next already
 * locks, so this check adds no new package to the lockfile.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const MANIFEST = "scripts/brand-rasters.json";
const IMAGES = "apps/mobile/assets/images";
const OVER = 48; // levels in any channel before a pixel counts as differing
const ASPECT_TOLERANCE = 0.01;

const { rasters } = JSON.parse(readFileSync(MANIFEST, "utf8"));
const failures = [];
const fail = (msg) => failures.push(msg);

const listed = new Set(rasters.map((r) => r.raster));
for (const name of readdirSync(IMAGES).filter((f) => f.toLowerCase().endsWith(".png"))) {
  const path = join(IMAGES, name);
  if (!listed.has(path)) {
    fail(`COVERAGE ${path} is not in ${MANIFEST}. Add it with its master, canvas, sha256 and tolerance, or move it out of ${IMAGES}.`);
  }
}

for (const entry of rasters) {
  const { raster, master, canvas, sha256, maxPctOver48 } = entry;
  if (!existsSync(raster)) { fail(`MISSING raster ${raster}`); continue; }
  if (!existsSync(master)) { fail(`MISSING master ${master} for ${raster}`); continue; }

  const actual = createHash("sha256").update(readFileSync(raster)).digest("hex");
  if (actual !== sha256) {
    fail(`INTEGRITY ${raster} changed: pinned ${sha256.slice(0, 12)}, found ${actual.slice(0, 12)}. If it was re-exported from ${master} on purpose, confirm FIDELITY below passes, then update its sha256 in ${MANIFEST}.`);
  }

  const meta = await sharp(raster).metadata();
  if (meta.width !== canvas[0] || meta.height !== canvas[1]) {
    fail(`FIDELITY ${raster} is ${meta.width}x${meta.height}; the manifest says ${canvas[0]}x${canvas[1]}.`);
    continue;
  }
  const svgMeta = await sharp(master).metadata();
  const density = (72 * meta.width) / svgMeta.width;

  const r = await sharp(raster).ensureAlpha().trim().raw().toBuffer({ resolveWithObject: true });
  const rw = r.info.width, rh = r.info.height;
  const mInfo = (await sharp(master, { density }).ensureAlpha().trim().toBuffer({ resolveWithObject: true })).info;
  const rAspect = rw / rh, mAspect = mInfo.width / mInfo.height;
  if (Math.abs(rAspect - mAspect) / mAspect > ASPECT_TOLERANCE) {
    fail(`FIDELITY ${raster}: content aspect ${rAspect.toFixed(3)} against ${master}'s ${mAspect.toFixed(3)} (over ${ASPECT_TOLERANCE * 100}% apart). A different drawing, or the wrong master.`);
    continue;
  }
  const m = await sharp(master, { density }).ensureAlpha().trim().resize(rw, rh, { fit: "fill" }).raw().toBuffer();
  let over = 0;
  for (let i = 0; i < r.data.length; i += 4) {
    let px = 0;
    for (let c = 0; c < 4; c++) px = Math.max(px, Math.abs(r.data[i + c] - m[i + c]));
    if (px > OVER) over++;
  }
  const pct = (100 * over) / (rw * rh);
  const line = `${raster}  <-  ${master}: ${pct.toFixed(2)}% of content pixels differ by >${OVER} (allowed ${maxPctOver48}%)`;
  if (pct > maxPctOver48) fail(`FIDELITY ${line}. The master and the raster no longer depict the same thing: re-export the raster from the master.`);
  else console.log(`  ok  ${line}`);
}

if (failures.length > 0) {
  console.error(`check-brand-rasters: ${failures.length} problem(s)\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`check-brand-rasters: ${rasters.length} rasters pinned and faithful to their masters; every PNG in ${IMAGES} is covered`);
