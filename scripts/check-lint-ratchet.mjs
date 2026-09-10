#!/usr/bin/env node
/**
 * The lint ratchet — N153/#557, widened from one app to three by N555/#1032.
 *
 * `apps/mobile/package.json`'s `lint` script used to be one flat number:
 * `eslint . --max-warnings=50`. That number can only ever notice the TOTAL
 * moving — a PR that clears 20 `react-hooks/refs` warnings and introduces 20
 * new `import/no-duplicates` ones leaves the total exactly where it was, and
 * the flat gate says nothing happened. This script replaces the flat count
 * with one cap PER RULE, PER APP, so that specific PR fails:
 * `import/no-duplicates` would be over its own cap, regardless of what
 * happened everywhere else.
 *
 * It reads the LIVE warning count from a real ESLint run on every invocation
 * — never a number copied into this file, `eslint.config.mjs`'s comments, or
 * `docs/decisions/history.md`. Those all go stale (this file's own doc
 * comment on the mobile caps records a case where `eslint.config.mjs`'s own
 * comment had already drifted); a live run cannot.
 *
 * Three things can make this fail, and each is a different kind of drift:
 *
 * 1. **A rule exceeds its recorded cap.** The ratchet only ever moves down —
 *    this is that rule, literally: `live > cap` fails, full stop. Lowering a
 *    cap is always allowed (that's a category clearing further); raising one
 *    is never allowed by this script, because there is no code path that
 *    writes a higher number back — the cap tables are hand-edited, and
 *    hand-editing one upward is a change a reviewer will see in the diff.
 * 2. **A rule's live count hits exactly zero while still capped.** The
 *    acceptance criteria call for each rule to "convert back to `error` at
 *    zero, one rule at a time, as it clears" — a zero-warning rule sitting at
 *    `warn` forever is exactly the drift CLAUDE.md's "verify that a check can
 *    fail" section warns about, so this is a hard failure with the exact next
 *    step named, not a suggestion.
 * 3. **A `warn`-severity rule produces live warnings with no cap recorded for
 *    it at all.** Either that app was just brought under the ratchet and the
 *    pre-existing count has not been recorded yet, or a warning is NEW in this
 *    diff. The second is the common case and the cap table is NOT the fix for
 *    it — see `APP_BUDGETS` below.
 *
 * What does NOT fail: a rule whose live count sits below its cap but above
 * zero. The acceptance criteria only require lowering a cap when a category
 * is FULLY cleared (case 2 above) — forcing every partial, incidental
 * reduction to also edit this file would turn "fix the one stray warning you
 * noticed while touching this file anyway" into "and now also touch the
 * ratchet config", which contradicts "cleanup rides along with touched areas"
 * being a lightweight, incidental thing rather than a chore. Case 3's partial
 * reductions get a printed, non-blocking note instead — visible, not
 * enforced, so lowering the cap is always available as the easy next step
 * without ever being mandatory mid-burndown.
 *
 * ---------------------------------------------------------------------------
 *
 * **Caps are PER APP, and they do not pool.** Three apps each run their own
 * ESLint with their own flat config, and a rule cleared to zero in `apps/web`
 * must be promotable to `error` there even while `apps/mobile` still carries
 * twenty-four of it. One shared table across three apps would make each app's
 * cap satisfiable out of another app's debt — the same "the total didn't move"
 * blindness this script was built to end, relocated one level up. The
 * `evaluateApps` self-test below holds that case live.
 *
 * ---------------------------------------------------------------------------
 *
 * **Why three apps and not one (N555/#1032).** The ratchet was mobile-only for
 * its first three weeks, and the gap that found was not a lint-debt gap at all:
 * N551 extracted `pendingSuggestableIndices` into `apps/web/src/lib/api.ts`,
 * gave the RULE 19 tests, and left the WIRING unguarded. Reverting only the
 * call site in `apps/web/src/app/dashboard/sessions/[id]/page.tsx` back to its
 * old inline `set_type !== "warmup"` filter reinstates the #753 defect (a
 * straight-set recommendation written into backoffs and drops) and is caught by
 * NOTHING: `tsc --noEmit` exits 0, `pnpm --filter web lint` exits 0 with the
 * now-unused import as a mere *warning*, and all 301 web tests pass. The same
 * revert applied to `apps/mobile/app/session/[id].tsx` fails this script
 * immediately — measured both ways, 2026-09-09. Mobile was covered; web was
 * not; the difference was this file's scope and nothing else.
 *
 * `apps/admin` is here for the reason CLAUDE.md already records against it by
 * name: `typecheck:admin` was once added to CI and not to `verify`, and an
 * admin type error passed locally and failed in CI. Fixing web and leaving
 * admin out would be that same omission, filed fresh.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * One entry per app under the ratchet; within each, one cap per rule that app
 * currently lints at `warn` severity and that currently has a non-zero live
 * count. Lower a cap (or delete its entry once it hits zero, per case 2 above)
 * as warnings clear; never raise one.
 *
 * **An empty `caps` table is the strongest state, not an unfinished one.** It
 * means the app has zero live warnings, so case 3 turns every newly-introduced
 * warning into a hard failure. `apps/web` is there and should stay there.
 *
 * **Adding a cap entry is for recording debt that ALREADY EXISTED when an app
 * was first brought under the ratchet — never for a warning your own diff
 * introduced.** If a new UNCAPPED failure names a rule and the warning is
 * yours, the fix is the warning. Adding the cap instead is how a ratchet
 * becomes a rubber stamp, and it is the one edit to this file that a reviewer
 * should always stop on.
 *
 * Mobile's numbers were measured 2026-09-06 for N153/#557; web's and admin's
 * 2026-09-09 for N555/#1032. All of them were read from each app's own
 * `node_modules/.bin/eslint . -f json` (the `pnpm exec` wrapper prepends
 * non-JSON banner lines to stdout on this workspace — e.g. "Scope: all 4
 * workspace projects" — so this script shells out to the local binary directly
 * rather than through pnpm), and each app's count was confirmed against that
 * app's OWN `lint` script in the same session, since `apps/web` and
 * `apps/admin` invoke a bare `eslint` where `apps/mobile` passes `.`:
 *
 *   apps/mobile                              50
 *     react-hooks/refs                       24
 *     react-hooks/set-state-in-effect        14
 *     @typescript-eslint/no-require-imports   6
 *     import/no-duplicates                    2
 *     import/first                            2
 *     react/no-unescaped-entities             1
 *     @typescript-eslint/no-redeclare         1
 *   apps/web                                  0
 *   apps/admin                                8
 *     @typescript-eslint/no-unused-vars        8
 *
 * `react-hooks/exhaustive-deps` is deliberately NOT in mobile's table. Its live
 * count measured zero — the 15 sites that would otherwise warn all carry a
 * rule-specific `eslint-disable-next-line react-hooks/exhaustive-deps`, which
 * suppresses the rule regardless of its configured severity, so nothing about
 * flipping the severity touches them (confirmed directly: setting it to
 * `"error"` and re-running still reports zero live errors). A rule already at
 * zero doesn't belong in a cap table at all per case 2 above — it belongs at
 * `error` in `eslint.config.mjs`, which is where N153/#557 moved it in the
 * same change that added this script.
 *
 * Admin's 8 are `_prev`/`_form` parameters in `src/app/content/actions.ts` and
 * `src/app/content/exerciseActions.ts` — React `useActionState` signatures
 * whose leading arguments genuinely are unused. They are recorded rather than
 * fixed here so that bringing admin under the ratchet stays a one-file change;
 * the underscore-prefix convention they already follow suggests the real fix is
 * an `argsIgnorePattern` in `apps/admin/eslint.config.mjs`, which would take
 * this table's only admin entry to zero and promote it out. Not done in N555,
 * deliberately: that is a change to admin's lint config, reviewable on its own.
 */
export const APP_BUDGETS = [
  {
    dir: "apps/mobile",
    caps: {
      "react-hooks/refs": 24,
      "react-hooks/set-state-in-effect": 14,
      "@typescript-eslint/no-require-imports": 6,
      "import/no-duplicates": 2,
      "import/first": 2,
      "react/no-unescaped-entities": 1,
      "@typescript-eslint/no-redeclare": 1,
    },
  },
  { dir: "apps/web", caps: {} },
  {
    dir: "apps/admin",
    caps: { "@typescript-eslint/no-unused-vars": 8 },
  },
];

/**
 * The pure decision logic for ONE app, factored out so it can be exercised
 * with synthetic data below (`selfTest`) without needing a real 24-warning
 * burndown to prove the "a category clears" path works. `caps` and
 * `liveCounts` are both `{ ruleId: count }` maps; `liveCounts` need only carry
 * rules that actually produced a live warning (a rule absent from it is
 * treated as zero).
 */
export function evaluate(caps, liveCounts) {
  const overBudget = [];
  const clearedButStillCapped = [];
  const advisories = [];
  for (const [rule, cap] of Object.entries(caps)) {
    const actual = liveCounts[rule] ?? 0;
    if (actual > cap) {
      overBudget.push({ rule, cap, actual });
    } else if (actual === 0) {
      clearedButStillCapped.push({ rule, cap });
    } else if (actual < cap) {
      advisories.push({ rule, cap, actual });
    }
  }
  const uncapped = [];
  for (const [rule, actual] of Object.entries(liveCounts)) {
    if (actual > 0 && !(rule in caps)) {
      uncapped.push({ rule, actual });
    }
  }
  return { overBudget, clearedButStillCapped, uncapped, advisories };
}

/**
 * `evaluate` applied across every app, keeping each app's verdict attributed
 * to its own directory. This is the part that makes caps not pool: it never
 * merges two apps' live counts or two apps' caps, so a rule can be over budget
 * in one app and cleared in another in the same run, and both get said.
 *
 * `liveByApp` maps an app's `dir` to its `{ ruleId: count }` map; an app
 * missing from it is treated as having no live warnings at all.
 */
export function evaluateApps(appBudgets, liveByApp) {
  return appBudgets.map(({ dir, caps }) => ({
    dir,
    caps,
    live: liveByApp[dir] ?? {},
    result: evaluate(caps, liveByApp[dir] ?? {}),
  }));
}

/**
 * The blocking failures for one app's verdict, as reader-facing strings. Every
 * message names the app, because "`@typescript-eslint/no-unused-vars` is over
 * budget" is not actionable across three apps that all lint it.
 */
export function failureMessages(dir, result) {
  const out = [];
  for (const { rule, cap, actual } of result.overBudget) {
    out.push(
      `OVER BUDGET [${dir}]: ${rule} has ${actual} live warning(s), cap is ${cap} (over by ${actual - cap}). ` +
        `The ratchet only ever moves down (N153/#557) — fix the new warning(s), or if this cap was ` +
        `just raised in this diff, that isn't allowed: lower this app's entry in APP_BUDGETS in ` +
        `scripts/check-lint-ratchet.mjs, never raise it.`,
    );
  }
  for (const { rule, cap } of result.clearedButStillCapped) {
    out.push(
      `CLEARED [${dir}]: ${rule} has 0 live warnings but is still capped at ${cap} and still \`warn\` in ` +
        `${dir}/eslint.config.mjs. Convert it to \`error\` there and delete its entry from this app's ` +
        `caps in APP_BUDGETS (scripts/check-lint-ratchet.mjs) — see N153/#557's acceptance criteria ` +
        `("each rule converts back to error at zero for its category"). Note this is per app: clearing ` +
        `it here says nothing about the other apps, and promoting it here is correct even if they ` +
        `still carry it.`,
    );
  }
  for (const { rule, actual } of result.uncapped) {
    out.push(
      `UNCAPPED [${dir}]: ${rule} produced ${actual} live warning(s) but has no cap recorded for ${dir} ` +
        `in APP_BUDGETS (scripts/check-lint-ratchet.mjs). Almost always this means the warning is NEW ` +
        `in your diff, and the fix is the warning, not the table — an unused import left behind by a ` +
        `call site that stopped calling something is exactly the case N555/#1032 added this app for. ` +
        `Recording a cap is only for debt that already existed when an app was first brought under the ` +
        `ratchet; adding one for your own new warning turns this gate into a rubber stamp.`,
    );
  }
  return out;
}

/**
 * Proves the mechanism itself against synthetic data before trusting it
 * against a real ESLint run — the same shape as `validate_palette.mjs`'s own
 * `selfTest()`. This is also literally the "Steps to test" step 2 from
 * #557 ("clear every warning in one category ... confirm the rule can be
 * flipped") made runnable without an actual 24-warning burndown: the
 * `clearedButStillCapped` scenario below simulates a rule's live count
 * reaching zero and asserts this script's own logic flags it.
 */
function selfTest() {
  const failures = [];
  const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) {
      failures.push(
        `self-test — ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      );
    }
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  };

  // 1. A rule over its cap fails, and only that rule — the exact scenario
  //    #557's "Steps to test" step 1 asks for ("add a new react-hooks/refs
  //    warning deliberately ... the ratchet fails the PR").
  check(
    "a rule exceeding its cap is reported as over budget",
    evaluate({ "rule-a": 5, "rule-b": 3 }, { "rule-a": 6, "rule-b": 3 }).overBudget,
    [{ rule: "rule-a", cap: 5, actual: 6 }],
  );

  // 2. A rule whose live count reaches exactly zero is flagged for
  //    promotion to `error` — #557's "Steps to test" step 2, simulated: this
  //    is what proves the "clear a category" path works without an actual
  //    24-warning burndown.
  check(
    "a rule cleared to zero is flagged ready to convert to error",
    evaluate({ "rule-c": 3 }, {}).clearedButStillCapped,
    [{ rule: "rule-c", cap: 3 }],
  );

  // 3. A rule with live warnings but no recorded cap is unaccounted debt,
  //    not silence.
  check(
    "a live warning with no cap entry is reported as uncapped",
    evaluate({}, { "rule-d": 2 }).uncapped,
    [{ rule: "rule-d", actual: 2 }],
  );

  // 4. Exactly at cap: neither over budget nor a false "cleared" signal.
  check(
    "a rule sitting exactly at its cap raises nothing",
    evaluate({ "rule-e": 4 }, { "rule-e": 4 }),
    { overBudget: [], clearedButStillCapped: [], uncapped: [], advisories: [] },
  );

  // 5. Below cap but not zero: a visible, NON-blocking advisory — the
  //    judgment call from #557's design guidance point 2. Partial burndown
  //    is not required to edit this file in the same PR; the acceptance
  //    criteria only mandate lowering a cap when a category is FULLY
  //    cleared (case 2), not on every incidental partial fix.
  check(
    "a rule below its cap (not zero) is an advisory, not a failure",
    evaluate({ "rule-f": 10 }, { "rule-f": 3 }),
    { overBudget: [], clearedButStillCapped: [], uncapped: [], advisories: [{ rule: "rule-f", cap: 10, actual: 3 }] },
  );

  // ---- N555/#1032: the per-app layer. ----

  // 6. THE point of per-app caps: the same rule, over budget in one app and
  //    fully cleared in another, in one run. A single pooled table could not
  //    represent this — app-b's 7 would cover app-a's cap of 5 and the run
  //    would be silent, which is the "the total didn't move" blindness this
  //    script exists to end, relocated one level up.
  check(
    "caps do not pool: one app over budget while another has cleared the same rule",
    evaluateApps(
      [
        { dir: "app-a", caps: { "rule-g": 5 } },
        { dir: "app-b", caps: { "rule-g": 7 } },
      ],
      { "app-a": { "rule-g": 6 }, "app-b": {} },
    ).map(({ dir, result }) => ({
      dir,
      over: result.overBudget,
      cleared: result.clearedButStillCapped,
    })),
    [
      { dir: "app-a", over: [{ rule: "rule-g", cap: 5, actual: 6 }], cleared: [] },
      { dir: "app-b", over: [], cleared: [{ rule: "rule-g", cap: 7 }] },
    ],
  );

  // 7. An app with an EMPTY caps table is at zero and must stay there: any
  //    live warning is uncapped, i.e. a hard failure. This is `apps/web`'s
  //    entry, and it is the case that catches N555/#1032's measured revert —
  //    a call site that stops calling an imported helper leaves the import
  //    unused, which is one new `no-unused-vars` warning and nothing else.
  check(
    "an app with an empty caps table fails on any new warning",
    evaluateApps([{ dir: "app-zero", caps: {} }], {
      "app-zero": { "@typescript-eslint/no-unused-vars": 1 },
    })[0].result.uncapped,
    [{ rule: "@typescript-eslint/no-unused-vars", actual: 1 }],
  );

  // 8. An app absent from the live map entirely is zero, not a crash — and an
  //    empty caps table against it raises nothing at all, so a clean app is
  //    silent rather than merely quiet.
  check(
    "an app with no live warnings and no caps raises nothing",
    evaluateApps([{ dir: "app-clean", caps: {} }], {})[0].result,
    { overBudget: [], clearedButStillCapped: [], uncapped: [], advisories: [] },
  );

  // 9. Every blocking verdict names its app. Without this, a
  //    `no-unused-vars` failure is ambiguous across three apps that all lint
  //    it — and admin's 8 recorded warnings make that rule genuinely shared.
  check(
    "every failure message names the app it came from",
    failureMessages("apps/example", {
      overBudget: [{ rule: "rule-h", cap: 1, actual: 2 }],
      clearedButStillCapped: [{ rule: "rule-i", cap: 3 }],
      uncapped: [{ rule: "rule-j", actual: 1 }],
      advisories: [],
    }).map((m) => m.includes("[apps/example]")),
    [true, true, true],
  );

  return failures;
}

/**
 * Runs ESLint against one app directory and returns its parsed JSON report.
 *
 * Shells out to the local binary directly (`node_modules/.bin/eslint`) rather
 * than `pnpm exec` or `pnpm --filter <app> exec` — measured directly, both
 * of those prepend non-JSON lines ("Scope: all 4 workspace projects",
 * lockfile/progress banners) to stdout on this workspace, which breaks
 * `JSON.parse` outright. The local binary's stdout is clean JSON with nothing
 * else in it.
 *
 * `.` is passed explicitly even though `apps/web` and `apps/admin` both invoke
 * a bare `eslint` in their own `lint` scripts. Confirmed equivalent rather than
 * assumed: on 2026-09-09 each app's `. -f json` warning counts matched that
 * app's own `lint` output exactly (web 0, admin 8, mobile 50).
 */
function runEslintJson(appDir) {
  const cwd = path.join(REPO_ROOT, appDir);
  const bin = path.join(cwd, "node_modules", ".bin", "eslint");
  if (!existsSync(bin)) {
    throw new Error(
      `check-lint-ratchet: no ESLint binary at ${bin} — run \`pnpm install\` first.`,
    );
  }
  let stdout;
  try {
    stdout = execFileSync(bin, [".", "-f", "json"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // ESLint exits non-zero the moment it reports an ERROR (severity 2) —
    // `react-hooks/rules-of-hooks` is exactly that, deliberately (see
    // eslint.config.mjs). The JSON report is still on stdout in that case;
    // this script only cares about warnings (severity 1), so it recovers the
    // report rather than treating an unrelated error-severity finding as a
    // reason this script itself can't run. A genuine crash (bad config,
    // missing plugin) has no JSON-shaped stdout at all, and that case
    // re-throws rather than being swallowed.
    if (typeof err.stdout === "string" && err.stdout.trim().startsWith("[")) {
      stdout = err.stdout;
    } else {
      throw err;
    }
  }
  return JSON.parse(stdout);
}

function countLiveWarningsByRule(report) {
  const counts = {};
  for (const file of report) {
    for (const msg of file.messages) {
      if (msg.severity !== 1) continue; // 1 = warn, 2 = error; only warnings are ratcheted here.
      const rule = msg.ruleId || "(no-rule)";
      counts[rule] = (counts[rule] || 0) + 1;
    }
  }
  return counts;
}

function main() {
  console.log("Lint ratchet self-test (synthetic data, proves the mechanism before trusting it):");
  const selfTestFailures = selfTest();
  if (selfTestFailures.length) {
    console.log(`\n${selfTestFailures.length} self-test failure(s) — the ratchet's own logic is broken, not the app's lint:\n`);
    for (const f of selfTestFailures) console.log(`  • ${f}`);
    process.exit(1);
  }

  const liveByApp = {};
  for (const { dir } of APP_BUDGETS) {
    console.log(`\nRunning ESLint against ${dir}...`);
    liveByApp[dir] = countLiveWarningsByRule(runEslintJson(dir));
  }

  const verdicts = evaluateApps(APP_BUDGETS, liveByApp);
  const failures = [];
  const advisories = [];

  for (const { dir, caps, live, result } of verdicts) {
    console.log(`\nPer-rule warning budget — ${dir} (live vs. recorded cap):`);
    const rules = [...new Set([...Object.keys(caps), ...Object.keys(live)])].sort();
    if (rules.length === 0) {
      // Said out loud rather than printed as an empty section: zero warnings
      // is this script's strongest state, and a blank heading reads like a run
      // that didn't happen — which is the one thing CLAUDE.md's "absence is
      // not evidence" rule says never to let a check look like.
      console.log("  ok         0 / 0  (no warnings, no caps — any new warning fails)");
    }
    for (const rule of rules) {
      const cap = caps[rule];
      const actual = live[rule] ?? 0;
      const status = cap === undefined ? (actual > 0 ? "UNCAPPED" : "-") : actual > cap ? "OVER" : actual === 0 ? "CLEARED" : "ok";
      console.log(`  ${status.padEnd(8)} ${String(actual).padStart(3)} / ${cap === undefined ? "-" : cap}  ${rule}`);
    }
    failures.push(...failureMessages(dir, result));
    for (const a of result.advisories) advisories.push({ dir, ...a });
  }

  if (advisories.length) {
    console.log("\nNote (non-blocking) — these caps have slack; consider lowering them in the same PR if the reduction is durable, but nothing requires it here:");
    for (const { dir, rule, cap, actual } of advisories) {
      console.log(`  • [${dir}] ${rule}: ${actual} live / cap ${cap}`);
    }
  }

  if (failures.length) {
    console.log(`\n${failures.length} lint-ratchet failure(s):\n`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }

  console.log(`\nLint ratchet: all capped rules within budget across ${APP_BUDGETS.length} app(s).\n`);
}

// Only run when invoked directly (`node scripts/check-lint-ratchet.mjs`), not
// when imported — a future test file importing `evaluate`/`APP_BUDGETS` should
// not also shell out to ESLint as a side effect of importing this module.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
