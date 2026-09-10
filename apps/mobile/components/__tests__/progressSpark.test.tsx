import { render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ProgressCard } from '../today/ProgressCard';
import type { Checkin } from '@/lib/body';
import { findAllByType } from '@/lib/__tests__/support/tree';

/**
 * What Today's seven-day line actually DRAWS (N201/#637).
 *
 * `lib/__tests__/sparkWeek.test.ts` covers the arithmetic, and every one of
 * those assertions still passes if the component never mounts a circle — a
 * pure function does not care whether anybody drew its output. This file is the
 * other half, and the assertion that matters is a **cross-check between two
 * things rendered independently**: the `cx` of a dot inside the `Svg`, against
 * the horizontal centre of the letter box laid out beneath it in ordinary
 * React Native. Those two agree only if both came from the same date-keyed
 * grid; index positioning breaks the agreement, which is the whole ticket.
 *
 * `2026-08-30` is a Sunday, so the axis reads `M T W T F S S`, exactly as in
 * the reference the user supplied (`~/Desktop/trend-face.jpeg`).
 */

const TODAY = '2026-08-30';
const MON = '2026-08-24';
const TUE = '2026-08-25';
const WED = '2026-08-26';
const THU = '2026-08-27';
const FRI = '2026-08-28';
const SAT = '2026-08-29';
const SUN = '2026-08-30';

/** Matches `SPARK_SLOT` in `ProgressCard.tsx`. */
const SLOT = 18;

/**
 * A check-in with only the field this chart reads. The card takes `Checkin[]`
 * (the wire shape) even though the chart itself needs no more than `Measured`,
 * so the girths are spelled out rather than cast away — a cast here would hide
 * the next field the card starts reading.
 */
function w(measured_on: string, weight_kg: number): Checkin {
  return {
    user_id: 'u1',
    measured_on,
    weight_kg,
    neck_cm: null,
    shoulders_cm: null,
    chest_cm: null,
    waist_cm: null,
    hips_cm: null,
    thigh_cm: null,
    calf_cm: null,
    upper_arm_cm: null,
    forearm_cm: null,
    measured_side: 'right',
    notes: '',
  };
}

async function draw(checkins: Checkin[]) {
  await render(
    <ProgressCard
      checkins={checkins}
      phase={null}
      today={TODAY}
      units="metric"
      unitsReady
      loaded
      onOpen={() => {}}
      testID="today-progress"
    />,
  );
}

/**
 * Every query here passes `includeHiddenElements`, and that is a property of
 * the component rather than a workaround.
 *
 * The whole chart is marked `accessibilityElementsHidden` /
 * `importantForAccessibility="no-hide-descendants"`: the card is ONE button
 * with one spoken label, and seven single letters concatenated onto it is
 * noise on top of an answer already given. React Native Testing Library reads
 * exactly those props as "hidden from accessibility" and excludes the subtree
 * from its default queries — so the flag has to be opted out of here, and if
 * somebody ever removes those props these helpers keep working while the
 * announcement quietly regresses. That trade is deliberate: the a11y
 * behaviour is asserted directly below rather than as a side effect of a
 * query failing.
 */
const OPTS = { includeHiddenElements: true } as const;

const get = (id: string) => screen.getByTestId(id, OPTS);
const query = (id: string) => screen.queryByTestId(id, OPTS);

/** The horizontal centre of day `i`'s letter box, read off the rendered view. */
function letterCentre(i: number): number {
  const flat = StyleSheet.flatten(get(`today-spark-day-${i}`).props.style) as { left: number };
  return flat.left + SLOT / 2;
}

function letterAt(i: number): string {
  return get(`today-spark-letter-${i}`).props.children as string;
}

function dotX(on: string): number {
  return get(`today-spark-point-${on}`).props.cx as number;
}

const everyDay = [
  w(MON, 94.0),
  w(TUE, 93.8),
  w(WED, 93.9),
  w(THU, 93.5),
  w(FRI, 93.4),
  w(SAT, 93.1),
  w(SUN, 92.9),
];

// ---------------------------------------------------------------------------
// The axis exists and says the right thing
// ---------------------------------------------------------------------------

test('the seven day letters are drawn under the line', async () => {
  await draw(everyDay);
  expect(get('today-spark-axis')).toBeTruthy();
  expect([0, 1, 2, 3, 4, 5, 6].map(letterAt)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
});

test("today's letter is the marked one, and only today's", async () => {
  await draw(everyDay);
  expect(screen.getAllByTestId('today-spark-today', OPTS)).toHaveLength(1);
  // Inside the LAST slot, not floating somewhere else on the axis: the grid
  // ends today, so the marked letter is always the seventh.
  expect(
    within(get('today-spark-day-6')).getByTestId('today-spark-today', OPTS),
  ).toBeTruthy();
  expect(letterAt(6)).toBe('S');
});

// ---------------------------------------------------------------------------
// The cross-check: a dot sits over its own letter
// ---------------------------------------------------------------------------

test('every dot is centred on its own day letter', async () => {
  await draw(everyDay);
  const on = [MON, TUE, WED, THU, FRI, SAT, SUN];
  on.forEach((d, i) => expect(dotX(d)).toBeCloseTo(letterCentre(i), 6));
});

/**
 * **The regression.** Wednesday is missing, so six readings share a seven-slot
 * grid. Under the index positioning this replaced, Thursday would be the third
 * of six points and land on Wednesday's letter — the chart reporting a weigh-in
 * on a day it did not happen.
 */
test('with a day missed, the survivors still sit over their own letters', async () => {
  await draw([w(MON, 94.0), w(TUE, 93.8), w(THU, 93.5), w(FRI, 93.4), w(SAT, 93.1), w(SUN, 92.9)]);

  expect(query(`today-spark-point-${WED}`)).toBeNull();

  expect(dotX(MON)).toBeCloseTo(letterCentre(0), 6);
  expect(dotX(TUE)).toBeCloseTo(letterCentre(1), 6);
  expect(dotX(THU)).toBeCloseTo(letterCentre(3), 6);
  expect(dotX(FRI)).toBeCloseTo(letterCentre(4), 6);
  expect(dotX(SAT)).toBeCloseTo(letterCentre(5), 6);
  expect(dotX(SUN)).toBeCloseTo(letterCentre(6), 6);

  // And the gap is a gap: nothing is drawn over Wednesday's letter.
  const wedX = letterCentre(2);
  const drawn = [MON, TUE, THU, FRI, SAT, SUN].map(dotX);
  for (const x of drawn) expect(Math.abs(x - wedX)).toBeGreaterThan(1);
});

test('a week logged only at its start does not stretch across the axis', async () => {
  await draw([w(MON, 94.0), w(TUE, 93.8), w(WED, 93.9)]);
  expect(dotX(WED)).toBeCloseTo(letterCentre(2), 6);
  // The right-hand four sevenths hold nothing, which is the honest drawing.
  for (const d of [THU, FRI, SAT, SUN]) {
    expect(query(`today-spark-point-${d}`)).toBeNull();
  }
});

// ---------------------------------------------------------------------------
// Below two readings, nothing at all
// ---------------------------------------------------------------------------

test('one reading draws no line, no dots and no axis', async () => {
  await draw([w(SUN, 92.9)]);
  expect(query('today-spark')).toBeNull();
  expect(query('today-spark-axis')).toBeNull();
  expect(query(`today-spark-point-${SUN}`)).toBeNull();
  expect(screen.getByText('No trend yet')).toBeTruthy();
});

test('no readings draw nothing either', async () => {
  await draw([]);
  expect(query('today-spark-axis')).toBeNull();
  expect(screen.getByText('No trend yet')).toBeTruthy();
});

test('two readings are enough for a line', async () => {
  await draw([w(SAT, 93.1), w(SUN, 92.9)]);
  expect(get('today-spark-axis')).toBeTruthy();
  expect(screen.queryByText('No trend yet')).toBeNull();
});

// ---------------------------------------------------------------------------
// The line, its glow, and the ring on the latest reading
// ---------------------------------------------------------------------------

// `react-native-svg` renders a `<Polyline>` as a host `RNSVGPath` — there is
// no `RNSVGPolyline`. Asserted by type rather than by testID so an extra
// stroke slipped in later has to be accounted for here.
const polylines = () => findAllByType(screen.root, 'RNSVGPath');

test('the line is drawn once crisp and twice as a glow, all on the same points', async () => {
  await draw(everyDay);
  const lines = polylines();
  expect(lines).toHaveLength(3);
  const pts = lines.map((l) => l.props.points);
  expect(new Set(pts).size).toBe(1);
  // Two dimmed passes under one full-strength one.
  const opacities = lines.map((l) => Number(l.props.strokeOpacity ?? 1));
  expect(opacities.filter((o) => o < 1)).toHaveLength(2);
  expect(opacities.filter((o) => o === 1)).toHaveLength(1);
  // The glow is wider than the line it sits under, or it is not a glow.
  const widths = lines.map((l) => l.props.strokeWidth as number);
  expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
});

test('a drop-line falls from each point to the foot of the plot', async () => {
  await draw(everyDay);
  const drops = findAllByType(screen.root, 'RNSVGLine');
  expect(drops).toHaveLength(7);
  for (const d of drops) {
    expect(d.props.x1).toBe(d.props.x2);
    expect(Number(d.props.y2)).toBeGreaterThan(Number(d.props.y1));
    // All the way to the foot of the box, so they end level with each other
    // and read as an axis rather than as seven ragged ticks.
    expect(d.props.y2).toBe(drops[0].props.y2);
  }
  // Each one is under a point, so the dot and its letter are visibly joined.
  const at = drops.map((d) => d.props.x1 as number).sort((a, b) => a - b);
  const dots = [MON, TUE, WED, THU, FRI, SAT, SUN].map(dotX).sort((a, b) => a - b);
  at.forEach((x, i) => expect(x).toBeCloseTo(dots[i], 6));
});

test('the latest reading is ringed and the rest are filled', async () => {
  await draw(everyDay);
  const latest = get(`today-spark-point-${SUN}`);
  expect(latest.props.stroke).toBeTruthy();
  expect(latest.props.r).toBeGreaterThan(get(`today-spark-point-${SAT}`).props.r);
  expect(get(`today-spark-point-${SAT}`).props.stroke).toBeUndefined();
});

// The ring marks the newest READING, not the current date — an athlete who last
// weighed in on Thursday must not see a ring floating on today's empty slot.
test('the ring follows the last reading when today has none', async () => {
  await draw([w(MON, 94.0), w(TUE, 93.8), w(THU, 93.5)]);
  const latest = get(`today-spark-point-${THU}`);
  expect(latest.props.stroke).toBeTruthy();
  expect(latest.props.cx).toBeCloseTo(letterCentre(3), 6);
});

// ---------------------------------------------------------------------------
// One card, one announcement
// ---------------------------------------------------------------------------

test('the chart adds nothing to what the card says out loud', async () => {
  await draw(everyDay);
  const spark = get('today-spark-wrap');
  expect(spark.props.accessibilityElementsHidden).toBe(true);
  expect(spark.props.importantForAccessibility).toBe('no-hide-descendants');
  // And the label the card DOES say is still the weight and its direction.
  expect(screen.getByLabelText(/^Progress\./)).toBeTruthy();
});
