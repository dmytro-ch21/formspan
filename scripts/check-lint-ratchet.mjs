#!/usr/bin/env node
/**
 * The mobile lint ratchet — N153/#557.
 *
 * `apps/mobile/package.json`'s `lint` script used to be one flat number:
 * `eslint . --max-warnings=50`. That number can only ever notice the TOTAL
 * moving — a PR that clears 20 `react-hooks/refs` warnings and introduces 20
 * new `import/no-duplicates` ones leaves the total exactly where it was, and
 * the flat gate says nothing happened. This script replaces the flat count
 * with one cap PER RULE, so that specific PR fails: `import/no-duplicates`
 * would be over its own cap, regardless of what happened everywhere else.
 *
 * It reads the LIVE warning count from a real ESLint run on every invocation
 * — never a number copied into this file, `eslint.config.mjs`'s comments, or
 * `docs/decisions/history.md`. Those all go stale (this file's own doc
 * comment on `RULE_CAPS` records a case where `eslint.config.mjs`'s own
 * comment had already drifted); a live run cannot.
 *
 * Three things can make this fail, and each is a different kind of drift:
 *
 * 1. **A rule exceeds its recorded cap.** The ratchet only ever moves down —
 *    this is that rule, literally: `live > cap` fails, full stop. Lowering a
 *    cap is always allowed (that's a category clearing further); raising one
 *    is never allowed by this script, because there is no code path that
 *    writes a higher number back — RULE_CAPS is hand-edited, and hand-editing
 *    it upward is a change a reviewer will see in the diff.
 * 2. **A rule's live count hits exactly zero while still capped.** The
 *    acceptance criteria call for each rule to "convert back to `error` at
 *    zero, one rule at a time, as it clears" — a zero-warning rule sitting at
 *    `warn` forever is exactly the drift CLAUDE.md's "verify that a check can
 *    fail" section warns about, so this is a hard failure with the exact next
 *    step named, not a suggestion.
 * 3. **A `warn`-severity rule produces live warnings with no cap recorded for
 *    it at all.** Either a brand-new rule started warning (add it to
 *    RULE_CAPS at its current count) or an already-tracked rule's count went
 *    from zero back above zero without anyone adding it back — same fix.
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
 * RULE_CAPS, measured 2026-09-06 against `apps/mobile/node_modules/.bin/eslint
 * . -f json` (the `pnpm exec` wrapper prepends non-JSON banner lines to
 * stdout on this workspace — e.g. "Scope: all 4 workspace projects" — so this
 * script shells out to the local binary directly rather than through pnpm).
 * The ticket that filed this (#557) quoted 24 `react-hooks/refs` and 15
 * `react-hooks/set-state-in-effect` from when it was written; live counts had
 * already drifted to 24 and 14 respectively by the time this script was
 * built — the exact staleness this script exists to stop happening again,
 * now measured against `apps/mobile/package.json`'s own live gate instead of
 * a copy anywhere else:
 *
 *   react-hooks/refs                       24
 *   react-hooks/set-state-in-effect        14
 *   @typescript-eslint/no-require-imports   6
 *   import/no-duplicates                    2
 *   import/first                            2
 *   react/no-unescaped-entities             1
 *   @typescript-eslint/no-redeclare         1
 *                                          ---
 *   total                                  50
 *
 * `react-hooks/exhaustive-deps` is deliberately NOT in this table. Its live
 * count measured zero — the 16 sites that would otherwise warn all carry a
 * rule-specific `eslint-disable-next-line react-hooks/exhaustive-deps`, which
 * suppresses the rule regardless of its configured severity, so nothing about
 * flipping the severity touches them (confirmed directly: setting it to
 * `"error"` and re-running still reports zero live errors). A rule already at
 * zero doesn't belong in a cap table at all per case 2 above — it belongs at
 * `error` in `eslint.config.mjs`, which is where N153/#557 moved it in the
 * same change that added this script.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MOBILE_DIR = path.join(REPO_ROOT, "apps/mobile");

/**
 * One cap per rule this app currently lints at `warn` severity — see the doc
 * comment above for how these numbers were measured and why
 * `react-hooks/exhaustive-deps` isn't here. Lower a cap (or delete its entry
 * once it hits zero, per case 2 above) as warnings clear; never raise one.
 */
export const RULE_CAPS = {
  "react-hooks/refs": 24,
  "react-hooks/set-state-in-effect": 14,
  "@typescript-eslint/no-require-imports": 6,
  "import/no-duplicates": 2,
  "import/first": 2,
  "react/no-unescaped-entities": 1,
  "@typescript-eslint/no-redeclare": 1,
};

/**
 * The pure decision logic, factored out so it can be exercised with synthetic
 * data below (`selfTest`) without needing a real 24-warning burndown to prove
 * the "a category clears" path works. `caps` and `liveCounts` are both
 * `{ ruleId: count }` maps; `liveCounts` need only carry rules that actually
 * produced a live warning (a rule absent from it is treated as zero).
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

  return failures;
}

/**
 * Runs ESLint against `apps/mobile` and returns its parsed JSON report.
 *
 * Shells out to the local binary directly (`node_modules/.bin/eslint`) rather
 * than `pnpm exec` or `pnpm --filter mobile exec` — measured directly, both
 * of those prepend non-JSON lines ("Scope: all 4 workspace projects",
 * lockfile/progress banners) to stdout on this workspace, which breaks
 * `JSON.parse` outright. The local binary's stdout is clean JSON with nothing
 * else in it.
 */
function runEslintJson() {
  const bin = path.join(MOBILE_DIR, "node_modules", ".bin", "eslint");
  if (!existsSync(bin)) {
    throw new Error(
      `check-lint-ratchet: no ESLint binary at ${bin} — run \`pnpm install\` first.`,
    );
  }
  let stdout;
  try {
    stdout = execFileSync(bin, [".", "-f", "json"], {
      cwd: MOBILE_DIR,
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

  console.log("\nRunning ESLint against apps/mobile...");
  const report = runEslintJson();
  const live = countLiveWarningsByRule(report);
  const { overBudget, clearedButStillCapped, uncapped, advisories } = evaluate(RULE_CAPS, live);

  console.log("\nPer-rule warning budget (live vs. recorded cap):");
  const rules = [...new Set([...Object.keys(RULE_CAPS), ...Object.keys(live)])].sort();
  for (const rule of rules) {
    const cap = RULE_CAPS[rule];
    const actual = live[rule] ?? 0;
    const status = cap === undefined ? (actual > 0 ? "UNCAPPED" : "-") : actual > cap ? "OVER" : actual === 0 ? "CLEARED" : "ok";
    console.log(`  ${status.padEnd(8)} ${String(actual).padStart(3)} / ${cap === undefined ? "-" : cap}  ${rule}`);
  }

  const failures = [];

  for (const { rule, cap, actual } of overBudget) {
    failures.push(
      `OVER BUDGET: ${rule} has ${actual} live warning(s), cap is ${cap} (over by ${actual - cap}). ` +
        `The ratchet only ever moves down (N153/#557) — fix the new warning(s), or if this cap was ` +
        `just raised in this diff, that isn't allowed: lower RULE_CAPS in scripts/check-lint-ratchet.mjs, ` +
        `never raise it.`,
    );
  }

  for (const { rule, cap } of clearedButStillCapped) {
    failures.push(
      `CLEARED: ${rule} has 0 live warnings but is still capped at ${cap} and still \`warn\` in ` +
        `apps/mobile/eslint.config.mjs. Convert it to \`error\` there and delete its entry from ` +
        `RULE_CAPS in scripts/check-lint-ratchet.mjs — see N153/#557's acceptance criteria ` +
        `("each rule converts back to error at zero for its category").`,
    );
  }

  for (const { rule, actual } of uncapped) {
    failures.push(
      `UNCAPPED: ${rule} produced ${actual} live warning(s) but has no entry in RULE_CAPS ` +
        `(scripts/check-lint-ratchet.mjs). Either a rule newly went to \`warn\` severity (add a cap ` +
        `for it at its current live count) or a previously-cleared rule regressed above zero without ` +
        `anyone re-adding its cap — either way, this is unaccounted debt, not silence.`,
    );
  }

  if (advisories.length) {
    console.log("\nNote (non-blocking) — these caps have slack; consider lowering them in the same PR if the reduction is durable, but nothing requires it here:");
    for (const { rule, cap, actual } of advisories) {
      console.log(`  • ${rule}: ${actual} live / cap ${cap}`);
    }
  }

  if (failures.length) {
    console.log(`\n${failures.length} lint-ratchet failure(s):\n`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }

  console.log("\nLint ratchet: all capped rules within budget.\n");
}

// Only run when invoked directly (`node scripts/check-lint-ratchet.mjs`), not
// when imported — a future test file importing `evaluate`/`RULE_CAPS` should
// not also shell out to ESLint as a side effect of importing this module.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
