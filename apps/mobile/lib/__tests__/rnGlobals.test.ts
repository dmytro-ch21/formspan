/**
 * Four `AbortController` APIs that exist in this test runner and NOT on a
 * phone — so any code using them passes every test and does nothing in the
 * athlete's hand.
 *
 * ## The measurement
 *
 * React Native's `setUpXHR.js` calls
 * `polyfillGlobal('AbortController', () => require('abort-controller/dist/abort-controller').AbortController)`,
 * and `polyfillGlobal` **replaces** the global unconditionally. So on a device,
 * `AbortController` and `AbortSignal` are `abort-controller@3.0.0`. Run against
 * that installed module:
 *
 *     abort('MY_REASON') -> { hasReason: false, reason: undefined,
 *                             AbortSignal.timeout: undefined,
 *                             AbortSignal.any: undefined,
 *                             signal.throwIfAborted: undefined }
 *
 * Node, which is what jest runs on, answers `reason: 'MY_REASON'` and
 * `function` for the other three.
 *
 * ## What that cost
 *
 * Two screens told a timeout apart from a supersede by aborting with a reason
 * and reading `signal.reason` back. Neither comparison could ever match:
 *
 * - `app/library.tsx` — a search abandoned mid-typing fell through to the error
 *   branch and rendered **"Aborted"**, and a superseded request cleared the
 *   newer one's spinner.
 * - `app/position/[id].tsx` — a timeout took the unmount path, so `loading`
 *   stayed true forever. Its own comment said the reason existed to prevent
 *   exactly that spinner.
 *
 * Both had passing tests. This file is the ratchet that stops a third: it is a
 * source scan, because the defect is invisible at runtime *here* — a test that
 * called these APIs would work perfectly.
 *
 * If a future React Native ships a spec-compliant `AbortController`, delete
 * this file rather than working around it — but measure the installed module
 * first, the way this comment did.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOTS = ['app', 'lib', 'components'].map((d) => join(__dirname, '..', '..', d));

/**
 * Each pattern with the name it is banned under.
 *
 * `signal.reason` rather than a bare `.reason`: `Promise.allSettled` results
 * carry a `reason` too, and that one is real.
 */
const BANNED: [RegExp, string][] = [
  [/\bsignal\s*\.\s*reason\b/, 'signal.reason (undefined on a device)'],
  [/\bAbortSignal\s*\.\s*timeout\b/, 'AbortSignal.timeout (absent on a device)'],
  [/\bAbortSignal\s*\.\s*any\b/, 'AbortSignal.any (absent on a device)'],
  [/\bthrowIfAborted\b/, 'signal.throwIfAborted (absent on a device)'],
  // Any argument, not just a string literal. The first version of this
  // required a quote and therefore missed `abort(TIMED_OUT)` — the exact form
  // both screens shipped, and a named constant is the natural way to write it.
  // Caught by the self-test below, which is why that test is here.
  [/\.abort\(\s*[^)\s]/, 'abort(reason) — the reason is dropped on a device'],
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // `__tests__` is exempt: a test may legitimately drive these to prove
      // something about the runtime, and this file's own patterns live there.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (['.ts', '.tsx'].includes(extname(path))) out.push(path);
  }
  return out;
}

/** Comment lines, so this file's own prose about the ban is not a violation. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('the app never reads an AbortSignal API that a phone does not have', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('scans a real set of files', () => {
    // The apparatus check. A scan that walked the wrong directory would report
    // a clean tree forever, which is the failure this whole file is about.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('library.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('authedFetch.ts'))).toBe(true);
  });

  it('finds no banned usage', () => {
    const found: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          for (const [pattern, name] of BANNED) {
            if (pattern.test(line)) found.push(`${file}:${i + 1} — ${name}\n    ${line.trim()}`);
          }
        });
    }
    expect(found).toEqual([]);
  });

  it('would notice one', () => {
    // Proves the patterns match what they claim to, against the exact lines
    // that shipped. Without this the test above could be passing because the
    // regexes are broken rather than because the tree is clean.
    const shipped = [
      'if (controller.signal.reason === SUPERSEDED) return;',
      "const timedOut = signal?.aborted && signal.reason === TIMED_OUT;",
      'const timeout = setTimeout(() => controller.abort(TIMED_OUT), 10_000);',
      "abortRef.current?.abort('superseded');",
      'const c = new AbortController(); c.signal.throwIfAborted();',
      'fetch(url, { signal: AbortSignal.timeout(5000) });',
      'fetch(url, { signal: AbortSignal.any([a, b]) });',
    ];
    for (const line of shipped) {
      expect(BANNED.some(([pattern]) => pattern.test(line))).toBe(true);
    }
  });

  it('does not fire on the things that are fine', () => {
    // A ban nobody can satisfy gets deleted. These are all legitimate and must
    // stay legal: allSettled's `reason`, a bare abort, a variable named
    // `reason` that is not on a signal.
    const fine = [
      'if (p.status === "rejected") setError(String(p.reason));',
      'return () => controller.abort();',
      'const reason = err instanceof Error ? err.message : "unknown";',
      'abortRef.current?.abort();',
      "const [reason, setReason] = useState('');",
    ];
    for (const line of fine) {
      expect(BANNED.some(([pattern]) => pattern.test(line))).toBe(false);
    }
  });
});
