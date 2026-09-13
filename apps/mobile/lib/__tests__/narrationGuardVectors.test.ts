import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NarrationSentence } from '../dayNarration';
import { guardSentences, type BackedFact } from '../narrationGuard';

/**
 * N570 (#1131), part 2a: the phone's guard against the SAME cases the server's
 * guard answers (`backend/internal/modules/narration/guard_test.go`). A change
 * to either guard that the other does not make turns one of the two red.
 *
 * Read with `fs` rather than `require`, which the lint ratchet caps.
 */
type Vector = {
  name: string;
  sentence: NarrationSentence;
  kept: boolean;
  reason?: string;
  detail?: string;
};

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../evals/day-narration/guard_vectors.json'), 'utf8'),
) as { facts: BackedFact[]; cases: Vector[] };

describe('the shared guard cases', () => {
  it('are all there to answer', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const verdict = guardSentences([c.sentence], vectors.facts);
    if (c.kept) {
      expect(verdict).toEqual({ kept: [c.sentence], dropped: [] });
    } else {
      expect(verdict).toEqual({
        kept: [],
        dropped: [{ sentence: c.sentence, reason: c.reason, detail: c.detail }],
      });
    }
  });
});
