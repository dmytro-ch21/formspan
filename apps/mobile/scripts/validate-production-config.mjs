#!/usr/bin/env node
/**
 * N132 (#536) — the guard that stops a production EAS build/submit from
 * silently targeting a staging backend, or shipping with a placeholder App
 * Store Connect id.
 *
 * ## Why this shape
 *
 * `eas.json` used to bake a literal staging hostname straight into the
 * `production` build profile (`EXPO_PUBLIC_API_URL:
 * "https://apivola-fitness-platform-staging.up.railway.app"`) and a literal
 * placeholder into the submit profile (`ascAppId:
 * "REPLACE_WITH_APP_STORE_CONNECT_APP_ID"`). A production build made from
 * that file succeeds, installs, and talks to staging with nothing on screen
 * or in the build log saying so — worse than a build that fails, because it
 * *looks* fine. See docs/decisions/history.md's N132 entry for the full
 * writeup, including why there is currently no real production backend or
 * App Store Connect app to point at yet, and why "this fails today" is the
 * correct, intended state rather than a bug in this guard.
 *
 * One validation module (`classifyValue`/`classifyAscAppId` below), driven
 * from exactly two call sites, per CLAUDE.md's "write the validator once,
 * call it from both a verify-wired npm script and the EAS build-hook
 * script" guidance:
 *
 *   --check          STATIC. Reads the CHECKED-IN apps/mobile/eas.json and
 *                    confirms the committed production profile never bakes
 *                    in a bad literal, and that each build profile is
 *                    explicitly linked to its own EAS environment. Needs no
 *                    network access and no EAS credentials — this is what
 *                    `pnpm run verify` calls (via `check:eas-production-
 *                    safety` in the root package.json), and it is exactly
 *                    the check that would have caught today's bug on sight.
 *                    Always answerable, always green: a value ABSENT from
 *                    the committed file (because it comes from an EAS
 *                    secret instead) is the correct, desired state here,
 *                    not a failure.
 *
 *   --build-hook     RESOLVED. Reads `process.env.EXPO_PUBLIC_API_URL` —
 *                    the value actually resolved for a real build, which
 *                    could come from an EAS secret and is therefore
 *                    invisible to --check. Unlike --check, MISSING is a
 *                    failure here: this is the gate that must stop a real
 *                    production build before it produces an archive, per
 *                    the ticket's acceptance criteria, and "nobody has set
 *                    the real value yet" has to fail exactly as loudly as
 *                    "someone set it to staging". Wired as
 *                    apps/mobile/package.json's `eas-build-pre-install`
 *                    lifecycle hook, gated on `EAS_BUILD_PROFILE ===
 *                    'production'` so it never touches a development or
 *                    preview build. This is the one entry point that runs
 *                    on EAS's own build machine rather than a developer's,
 *                    which is also why it is the one entry point this
 *                    session cannot verify end to end — see the NEEDS HUMAN
 *                    EVIDENCE criterion on issue #536.
 *
 *   --check-submit   The ascAppId equivalent of --build-hook, but reads the
 *                    CHECKED-IN eas.json rather than a resolved env var —
 *                    unlike the API URL, an App Store Connect app id has no
 *                    secret-injection story in eas.json (no $VAR
 *                    interpolation exists for submit profiles; confirmed
 *                    against Expo's own eas.json reference, which documents
 *                    no such syntax for `submit.ios.ascAppId`), so it can
 *                    only ever be a JSON literal — checkable locally,
 *                    reliably, with no EAS credentials at all. MISSING is a
 *                    failure here too, for the same reason as --build-hook.
 *                    Wired as a prerequisite step in apps/mobile/
 *                    package.json's `submit:ios` script, ahead of the real
 *                    `eas submit` call.
 *
 *   --self-test      Mutation-tests classifyValue()/classifyAscAppId()
 *                    against fixed good/bad vectors — proves the guard
 *                    itself still rejects what it is supposed to reject
 *                    before it is ever pointed at a real file or a real
 *                    build. Wired into `pnpm run verify` alongside --check,
 *                    per CLAUDE.md's "Verify that a check can fail" rule.
 *
 * Stdlib only (fs/path/url) — no dependency for a handful of string checks,
 * per CLAUDE.md's "small, focused, testable script" guidance.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EAS_JSON_PATH = path.join(__dirname, '..', 'eas.json');

// ---------------------------------------------------------------------------
// The validator. Everything else in this file is plumbing around these two
// functions.
// ---------------------------------------------------------------------------

/**
 * Does `value` look like a real, filled-in setting, or an unfilled
 * placeholder / a host it must never point at? Returns `null` when it looks
 * fine, or a short human-readable reason (naming the offending value) when
 * it does not. Never throws.
 */
export function classifyValue(value) {
  if (value === undefined || value === null) return 'is missing';
  const v = String(value).trim();
  if (v === '') return 'is missing';

  const lower = v.toLowerCase();
  if (lower.includes('replace_with')) return `is an unfilled placeholder ("${v}")`;
  if (lower.includes('staging')) return `points at a staging host ("${v}")`;
  if (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('0.0.0.0')
  ) {
    return `is a local/loopback address ("${v}")`;
  }
  // Generic "somebody copy-pasted the template and forgot to edit it"
  // shapes, beyond the specific ones above.
  if (/^(your_|example\.com|todo|changeme)/i.test(v)) {
    return `looks like an unfilled template value ("${v}")`;
  }
  return null;
}

/**
 * ascAppId is a numeric Apple ID once real (App Store Connect's "Apple ID"
 * for the app, e.g. "1234567890") — so beyond the generic placeholder
 * checks above, anything non-numeric cannot be a real one either.
 */
export function classifyAscAppId(value) {
  const generic = classifyValue(value);
  if (generic) return generic;
  if (!/^\d+$/.test(String(value).trim())) {
    return `is not a numeric App Store Connect app id ("${value}")`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// --check: static, against the checked-in file.
// ---------------------------------------------------------------------------

const REQUIRED_ENVIRONMENTS = {
  development: 'development',
  preview: 'preview',
  production: 'production',
};

/**
 * @param {object} easJson parsed eas.json
 * @returns {string[]} problems found (empty = clean)
 */
export function checkEasJson(easJson) {
  const problems = [];
  const build = easJson?.build ?? {};

  for (const [profile, expected] of Object.entries(REQUIRED_ENVIRONMENTS)) {
    const cfg = build[profile];
    if (!cfg) {
      problems.push(`build.${profile} profile is missing entirely`);
      continue;
    }
    if (cfg.environment !== expected) {
      problems.push(
        `build.${profile}.environment is ${JSON.stringify(cfg.environment ?? null)}, expected ${JSON.stringify(expected)} — every profile must be explicitly linked to its own EAS environment (AC1 of #536)`,
      );
    }

    // Every profile's own EXPO_PUBLIC_APP_ENV literal, not just
    // production's — found in review (frontend-reviewer, N132/#536): the
    // original check only asserted production said "production", so a
    // typo'd preview/development value (e.g. preview accidentally set to
    // "development") would go undetected. It's inert metadata for the
    // on-screen EnvironmentBadge, never a backend address, so it's safe to
    // commit literally — it still has to say the right thing for each
    // profile, not just for the one this ticket's bug was actually in.
    const appEnv = cfg.env?.EXPO_PUBLIC_APP_ENV;
    if (appEnv !== undefined && appEnv !== expected) {
      problems.push(
        `build.${profile}.env.EXPO_PUBLIC_APP_ENV is ${JSON.stringify(appEnv)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }

  const prodEnv = build.production?.env ?? {};
  for (const [key, value] of Object.entries(prodEnv)) {
    if (key === 'EXPO_PUBLIC_APP_ENV') continue; // checked above, for every profile
    const reason = classifyValue(value);
    if (reason) {
      problems.push(
        `build.production.env.${key} ${reason} — never bake a real value into the checked-in production profile; register it with "eas env:create --environment production" instead`,
      );
    }
  }

  const ascAppId = easJson?.submit?.production?.ios?.ascAppId;
  if (ascAppId !== undefined) {
    // Presence is fine to omit entirely (see checkSubmitConfig) — but if
    // someone DOES commit a literal, it must not be the known-bad shape.
    const reason = classifyAscAppId(ascAppId);
    if (reason) {
      problems.push(
        `submit.production.ios.ascAppId ${reason} — leave it unset until a real App Store Connect app exists, rather than committing a placeholder`,
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// --build-hook: resolved, against process.env at actual build time.
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string | undefined>} env something process.env-shaped
 * @returns {string[]} problems found (empty = clean)
 */
export function checkResolvedApiUrl(env) {
  const problems = [];
  const reason = classifyValue(env.EXPO_PUBLIC_API_URL);
  if (reason) {
    problems.push(`EXPO_PUBLIC_API_URL ${reason}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// --check-submit: the ascAppId equivalent of --build-hook, but reading the
// same checked-in file as --check (there is nowhere else for it to live).
// ---------------------------------------------------------------------------

/**
 * @param {object} easJson parsed eas.json
 * @returns {string[]} problems found (empty = clean)
 */
export function checkSubmitConfig(easJson) {
  const ascAppId = easJson?.submit?.production?.ios?.ascAppId;
  const reason = classifyAscAppId(ascAppId);
  return reason ? [`submit.production.ios.ascAppId ${reason}`] : [];
}

// ---------------------------------------------------------------------------
// Self-test: proves the guard fails CLOSED before it is trusted anywhere.
// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  const expectBad = (label, reason) => {
    if (!reason) failures.push(`expected "${label}" to be REJECTED, but it passed`);
  };
  const expectGood = (label, reason) => {
    if (reason) failures.push(`expected "${label}" to be ACCEPTED, but got: ${reason}`);
  };

  // classifyValue — the shapes the ticket names explicitly, plus the two
  // this repo's own history actually shipped.
  expectBad('undefined', classifyValue(undefined));
  expectBad('empty string', classifyValue(''));
  expectBad('whitespace only', classifyValue('   '));
  expectBad(
    'today\'s real bug',
    classifyValue('https://apivola-fitness-platform-staging.up.railway.app'),
  );
  expectBad('REPLACE_WITH_ placeholder', classifyValue('REPLACE_WITH_APP_STORE_CONNECT_APP_ID'));
  expectBad('localhost', classifyValue('http://localhost:8080'));
  expectBad('loopback IP', classifyValue('http://127.0.0.1:8080'));
  expectBad('generic template value', classifyValue('your_key_here'));
  expectGood('real-looking production URL', classifyValue('https://api.vola.fitness'));
  expectGood(
    'a staging-adjacent but not-staging real host',
    // Deliberately NOT a trick case for the substring rule — a real host
    // that merely CONTAINS "stage" as a word fragment is out of scope for
    // this guard; "staging" as a whole word is what N132's actual bug used,
    // and that is what this guard was written to catch.
    classifyValue('https://api.vola.fitness/v1'),
  );

  // classifyAscAppId — numeric-only once past the generic placeholder gate.
  expectBad('the checked-in placeholder', classifyAscAppId('REPLACE_WITH_APP_STORE_CONNECT_APP_ID'));
  expectBad('missing', classifyAscAppId(undefined));
  expectBad('non-numeric garbage', classifyAscAppId('abc123'));
  expectGood('a real-looking numeric ASC id', classifyAscAppId('1234567890'));

  // checkEasJson — mutation-test the STRUCTURAL assertions against small
  // synthetic fixtures, not the real file, so this never depends on what
  // happens to be committed right now.
  const goodFixture = {
    build: {
      development: { environment: 'development', env: {} },
      preview: { environment: 'preview', env: {} },
      production: { environment: 'production', env: { EXPO_PUBLIC_APP_ENV: 'production' } },
    },
    submit: { production: { ios: {} } },
  };
  if (checkEasJson(goodFixture).length !== 0) {
    failures.push(
      `expected the good eas.json fixture to be CLEAN, got: ${JSON.stringify(checkEasJson(goodFixture))}`,
    );
  }

  const mutations = [
    {
      label: 'production profile missing "environment"',
      apply: (f) => {
        delete f.build.production.environment;
      },
    },
    {
      label: 'production profile linked to the WRONG environment',
      apply: (f) => {
        f.build.production.environment = 'preview';
      },
    },
    {
      label: "today's actual regression: a literal staging URL baked into production.env",
      apply: (f) => {
        f.build.production.env.EXPO_PUBLIC_API_URL =
          'https://apivola-fitness-platform-staging.up.railway.app';
      },
    },
    {
      label: 'production.env.EXPO_PUBLIC_APP_ENV set to the wrong thing',
      apply: (f) => {
        f.build.production.env.EXPO_PUBLIC_APP_ENV = 'staging';
      },
    },
    {
      // Found in review (frontend-reviewer, N132/#536): the original check
      // only asserted production's own EXPO_PUBLIC_APP_ENV — a typo in a
      // NON-production profile (e.g. preview accidentally copy-pasted as
      // "development") went undetected. Mutation-tests the fix.
      label: "preview.env.EXPO_PUBLIC_APP_ENV mistyped as development's value",
      apply: (f) => {
        f.build.preview.env.EXPO_PUBLIC_APP_ENV = 'development';
      },
    },
    {
      label: 'submit.production.ios.ascAppId reverted to the checked-in placeholder',
      apply: (f) => {
        f.submit.production.ios.ascAppId = 'REPLACE_WITH_APP_STORE_CONNECT_APP_ID';
      },
    },
  ];
  for (const { label, apply } of mutations) {
    const fixture = JSON.parse(JSON.stringify(goodFixture));
    apply(fixture);
    const problems = checkEasJson(fixture);
    if (problems.length === 0) {
      failures.push(`mutation "${label}" was NOT caught — checkEasJson reported no problems`);
    }
  }

  // checkResolvedApiUrl / checkSubmitConfig — the two build-time entry
  // points, mutation-tested the same way.
  if (checkResolvedApiUrl({ EXPO_PUBLIC_API_URL: 'https://api.vola.fitness' }).length !== 0) {
    failures.push('checkResolvedApiUrl rejected a good production URL');
  }
  if (checkResolvedApiUrl({}).length === 0) {
    failures.push('checkResolvedApiUrl did not reject a MISSING EXPO_PUBLIC_API_URL');
  }
  if (
    checkResolvedApiUrl({
      EXPO_PUBLIC_API_URL: 'https://apivola-fitness-platform-staging.up.railway.app',
    }).length === 0
  ) {
    failures.push("checkResolvedApiUrl did not reject today's real staging URL");
  }
  if (checkSubmitConfig({ submit: { production: { ios: { ascAppId: '1234567890' } } } }).length !== 0) {
    failures.push('checkSubmitConfig rejected a good numeric ascAppId');
  }
  if (checkSubmitConfig({ submit: { production: { ios: {} } } }).length === 0) {
    failures.push('checkSubmitConfig did not reject a MISSING ascAppId');
  }
  if (
    checkSubmitConfig({
      submit: { production: { ios: { ascAppId: 'REPLACE_WITH_APP_STORE_CONNECT_APP_ID' } } },
    }).length === 0
  ) {
    failures.push("checkSubmitConfig did not reject today's real placeholder ascAppId");
  }

  if (failures.length > 0) {
    process.stderr.write('validate-production-config --self-test: FAILED\n');
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `validate-production-config --self-test: OK (${
      12 + 4 + 1 + mutations.length + 6
    } assertions, all correctly rejected/accepted)\n`,
  );
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

function readEasJson() {
  const raw = readFileSync(EAS_JSON_PATH, 'utf8');
  return JSON.parse(raw);
}

function reportAndExit(problems, context) {
  if (problems.length === 0) {
    process.stdout.write(`validate-production-config ${context}: OK\n`);
    return;
  }
  process.stderr.write(`validate-production-config ${context}: FAILED\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exitCode = 1;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    selfTest();
    return;
  }

  if (args.includes('--check')) {
    const easJson = readEasJson();
    reportAndExit(checkEasJson(easJson), '--check (static, apps/mobile/eas.json)');
    return;
  }

  if (args.includes('--check-submit')) {
    const easJson = readEasJson();
    reportAndExit(checkSubmitConfig(easJson), '--check-submit (submit.production.ios.ascAppId)');
    return;
  }

  if (args.includes('--build-hook')) {
    // Only ever ACTS when it can positively confirm this is the production
    // profile. `EAS_BUILD_PROFILE` is EAS Build's own documented per-job
    // variable naming the profile in use; this session could not exercise a
    // real EAS cloud build to confirm it live (see the NEEDS HUMAN EVIDENCE
    // criterion on #536), so this deliberately fails OPEN — does nothing,
    // rather than blocking — when the variable is absent or unrecognised,
    // so a development/preview build (or a local run with no EAS context at
    // all) is never at risk of being blocked by a detection failure here.
    // The reliable, always-verifiable half of "fails closed" lives in
    // --check (static) and --check-submit (ascAppId) above; this is the one
    // entry point that can see a real EAS secret and therefore the one a
    // human still has to confirm end to end.
    const profile = process.env.EAS_BUILD_PROFILE;
    if (profile !== 'production') {
      process.stdout.write(
        `validate-production-config --build-hook: EAS_BUILD_PROFILE is ${JSON.stringify(
          profile ?? null,
        )}, not "production" — skipping (this hook only ever gates production)\n`,
      );
      return;
    }
    reportAndExit(checkResolvedApiUrl(process.env), '--build-hook (resolved, production profile)');
    return;
  }

  process.stderr.write(
    'usage: validate-production-config.mjs --check | --check-submit | --build-hook | --self-test\n',
  );
  process.exitCode = 1;
}

// Only run the CLI when invoked directly — importing this module (as the
// self-test above effectively does, and as a future test file could) must
// not have side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
