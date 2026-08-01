import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * SQL lives in JS template literals, so a backtick in a `--` comment ends the
 * literal.
 *
 * This has now cost two debugging rounds — `db.ts` and `sessionStore.ts` — and
 * both times the symptom was a wall of unrelated syntax errors twenty lines
 * further down, which reads like the code is broken rather than the comment.
 * TypeScript does catch it, but only after you have lost the time working out
 * what it is telling you.
 *
 * Cheaper to make it a named failure. Prose in these comments should use
 * plain words or 'single quotes'.
 */

const FILES = ['db.ts', 'sessionStore.ts'];

for (const file of FILES) {
  it(`${file} has no backticks inside SQL comments`, () => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^\s*--/.test(line) && line.includes('`'));

    expect(
      offenders.map(({ n, line }) => `${file}:${n} ${line.trim()}`),
    ).toEqual([]);
  });
}
