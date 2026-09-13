import { renderHook, waitFor } from '@testing-library/react-native';

import { shiftDate } from '@/lib/anthropometry';
import type { Checkin, Phase } from '@/lib/body';
import { dayString } from '@/lib/calendar';
import { projectionGoal, type PlanOutcome } from '@/lib/trendSeries';
import { planOutcomeOf, useWeightTrend } from '@/lib/useWeightTrend';

/**
 * F63 (#1168): the goal line vanished for an athlete whose phase has a target
 * weight but whose nutrition target cannot be derived (no height, say).
 *
 * These run the REAL hook with only the network mocked, because the fix is in
 * the hook's wiring: it pairs the plan derivation's outcome with its own phase
 * fetch. A test of `fromPlanOutcome` alone passes whether or not the hook
 * hands it the phase target.
 */
const mockListCheckins = jest.fn();
const mockListPhases = jest.fn();
jest.mock('@/lib/body', () => ({
  listCheckins: (...a: unknown[]) => mockListCheckins(...a),
  listPhases: (...a: unknown[]) => mockListPhases(...a),
}));

const TODAY = dayString(new Date());
const weighIn = (daysAgo: number): Checkin =>
  ({ measured_on: shiftDate(TODAY, -daysAgo), weight_kg: 90 }) as unknown as Checkin;
const livePhase = (target: number | null): Phase =>
  ({ started_on: shiftDate(TODAY, -30), ended_on: null, target_weight_kg: target }) as unknown as Phase;
const PLAN = {
  reached_on: '',
  target_weight_kg: 75,
  kg_to_go: 15,
  weeks_to_go: 0,
  already: false,
  unreachable: false,
};

async function trendFor(plan: PlanOutcome, phaseTarget: number | null) {
  mockListCheckins.mockResolvedValue([2, 1, 0].map(weighIn));
  mockListPhases.mockResolvedValue([livePhase(phaseTarget)]);
  const rendered = await renderHook(() => useWeightTrend(async () => 'token', '1M', 30, plan));
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered.result.current;
}

beforeEach(() => {
  mockListCheckins.mockReset();
  mockListPhases.mockReset();
});

describe('the goal the weight surfaces draw', () => {
  it("is the phase's target when the profile is incomplete", async () => {
    const { projection } = await trendFor({ kind: 'incomplete' }, 75);
    expect(projection).toEqual({ kind: 'none', reason: 'no-plan', goal: 75 });
    expect(projectionGoal(projection)).toBe(75);
  });

  it('is nothing when the profile is incomplete and the phase has no target', async () => {
    const { projection } = await trendFor({ kind: 'incomplete' }, null);
    expect(projectionGoal(projection)).toBeNull();
  });

  it('is nothing when the derivation ran and found no goal, even beside a phase target', async () => {
    const { projection } = await trendFor({ kind: 'derived', projection: null }, 80);
    expect(projectionGoal(projection)).toBeNull();
  });

  it('is nothing while the derivation has not answered, even beside a phase target', async () => {
    const { projection } = await trendFor(null, 80);
    expect(projectionGoal(projection)).toBeNull();
  });

  it("is the projection's goal, not a stale phase target, when both exist", async () => {
    const { projection } = await trendFor({ kind: 'derived', projection: PLAN }, 80);
    expect(projectionGoal(projection)).toBe(75);
  });
});

describe('planOutcomeOf reads the derivation response', () => {
  it('a request that has not answered, or failed, is null', () => {
    expect(planOutcomeOf(null)).toBeNull();
  });

  it('a null suggestion is an incomplete profile, not a missing goal', () => {
    expect(planOutcomeOf({ suggestion: null })).toEqual({ kind: 'incomplete' });
  });

  it("a suggestion carries its basis's projection, null included", () => {
    expect(planOutcomeOf({ suggestion: { basis: { projection: PLAN } } as never })).toEqual({
      kind: 'derived',
      projection: PLAN,
    });
    expect(planOutcomeOf({ suggestion: { basis: { projection: null } } as never })).toEqual({
      kind: 'derived',
      projection: null,
    });
    expect(planOutcomeOf({ suggestion: { basis: null } as never })).toEqual({
      kind: 'derived',
      projection: null,
    });
  });
});
