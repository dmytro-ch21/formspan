import { refusalCopy } from '../../app/goals/trend';
import { fromPlanProjection, type Projection } from '@/lib/trendSeries';

/**
 * The refusal sentence on the weight trend screen (N101).
 *
 * ## Why this is a pure test and not a component one
 *
 * The property is which WORDS get chosen, and that is a function of the
 * projection alone — no fetch, no focus, no lifecycle. A component test would
 * mount three API mocks to assert a string, and `goalsScreen.test.tsx` earns
 * its mounting because its properties are about remount and staleness. This
 * one has something pure to extract, so it is extracted.
 *
 * The seam that a pure test cannot see is the screen passing the whole
 * projection rather than one field of it — which is exactly what the old
 * signature (`refusalCopy(projection.reason, …)`) got wrong, since a caller
 * destructuring `.reason` is how the server's words were being dropped one
 * layer further down. It takes the object now, so there is no field left to
 * forget.
 *
 * ## The invariant that outranks the wording
 *
 * **Every refusal renders a sentence.** Not one of these may return empty.
 * Blank space where a date would be is the failure this whole area was built
 * to avoid — the athlete's question is "why is there no date", and nothing
 * answers it with nothing.
 */

const GOAL = '80';
const UNIT = 'kg';

/** The two strings `project` in nutrition/target.go actually emits. */
const SERVER_REASONS = [
  'this phase holds your weight where it is',
  'this phase moves your weight away from that goal',
];

/** Every refusal the screen can be handed, with no server prose attached. */
const LOCAL_REFUSALS: Projection[] = [
  { kind: 'none', reason: 'no-goal' },
  { kind: 'none', reason: 'no-trend' },
  { kind: 'none', reason: 'stalled' },
  { kind: 'none', reason: 'moving-away' },
  { kind: 'none', reason: 'reached' },
];

function refusal(p: Projection): Extract<Projection, { kind: 'none' }> {
  if (p.kind !== 'none') throw new Error('expected a refusal');
  return p;
}

test("the server's own words are what the athlete reads", () => {
  for (const reason of SERVER_REASONS) {
    const p = refusal(
      fromPlanProjection(
        {
          reached_on: '',
          target_weight_kg: 80,
          kg_to_go: 5,
          weeks_to_go: 0,
          already: false,
          unreachable: true,
          unreachable_reason: reason,
        },
        null,
      ),
    );
    const copy = refusalCopy(p, GOAL, UNIT);
    expect(copy).toContain(reason);
    // And NOT the invented sentence it replaces. Rendering both would be the
    // same vagueness with the specific version bolted on.
    expect(copy).not.toContain("doesn't move toward");
    // Still names the absence and the goal, which is what any refusal owes.
    expect(copy).toContain(`${GOAL} ${UNIT}`);
    expect(copy).toContain('never reaches');
  }
});

test('the two server reasons produce two different sentences', () => {
  // The whole gap this closes: both used to collapse into one string. If this
  // ever passes trivially the carrying has been undone somewhere upstream.
  const [hold, away] = SERVER_REASONS.map((r) =>
    refusalCopy({ kind: 'none', reason: 'moving-away', serverReason: r }, GOAL, UNIT),
  );
  expect(hold).not.toEqual(away);
});

test('mobile and web make the same claim in the same order', () => {
  // apps/web's `Feasibility` renders:
  //   This plan never reaches {goal} kg — {reason}. Change the goal weight or
  //   the phase.
  // Two surfaces disagreeing about how much they tell an athlete about one
  // plan is the thing N101 is fixing, so the phrasing tracks web's rather than
  // being separately invented a second time.
  const copy = refusalCopy(
    { kind: 'none', reason: 'moving-away', serverReason: SERVER_REASONS[1] },
    GOAL,
    UNIT,
  );
  expect(copy).toBe(
    `This plan never reaches ${GOAL} ${UNIT} — ${SERVER_REASONS[1]}. Change the goal weight or the phase.`,
  );
});

test('with no server reason the screen still says why there is no date', () => {
  // The fallbacks are not dead code: `reached`, `no-trend` and a locally
  // computed `stalled` never carry prose, and each still owes a sentence.
  for (const p of LOCAL_REFUSALS) {
    const copy = refusalCopy(refusal(p), GOAL, UNIT);
    expect(copy.trim().length).toBeGreaterThan(0);
    expect(copy).toContain(`${GOAL} ${UNIT}`);
    // No server prose, so none of web's phrasing should appear either — a
    // fallback claiming "never reaches" would be asserting a judgement nobody
    // made.
    expect(copy).not.toContain('never reaches');
  }
});

test('a refusal never renders a dangling dash', () => {
  // `fromPlanProjection` normalises blank to absent, and this is the assertion
  // that the render site depends on that rather than re-checking it. A `''`
  // reaching here would print "— ." with nothing between.
  //
  // A REGEX, and the first version of this was a `toContain('—  .')` literal
  // that caught neither mutant: drop the normalisation and a `'   '` renders
  // the dash followed by FOUR spaces, a `''` by one, and the two-space literal
  // matches neither. It passed under exactly the mutation it names — this
  // file's own instance of CLAUDE.md's "verify that a check can fail", found in
  // review. Measured against both mutant renders and all five correct
  // sentences: catches both, fires on none.
  const blank = refusal(
    fromPlanProjection(
      {
        reached_on: '',
        target_weight_kg: 80,
        kg_to_go: 5,
        weeks_to_go: 0,
        already: false,
        unreachable: true,
        unreachable_reason: '   ',
      },
      null,
    ),
  );
  const copy = refusalCopy(blank, GOAL, UNIT);
  expect(copy).not.toMatch(/—\s*\./);
  expect(copy).toContain("doesn't move toward");
});
