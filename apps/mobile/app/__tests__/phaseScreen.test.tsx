import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import PhaseScreen from '../phase/index';
import { ApiError, OfflineError, RequestDroppedError, TimeoutError } from '@/lib/apiError';
import { createPhase, endPhase, listPhases } from '@/lib/body';
import type { UnitSystem } from '@/lib/units';

/**
 * N94 — the read that decides whether a phase exists.
 *
 * `refresh`'s `.catch` used to be unconditional: `if (alive)
 * setProblem('Could not reach the server.')` for ANY failure, a server 500 as
 * readily as a dead radio. That is the defect N55 introduced the transport
 * family to name, one screen further out — see `apiError.ts`'s
 * `transportDiagnosis()` and `food/scan.tsx`'s `messageForLookupFailure` for
 * the established compose-with-a-local-action pattern this mirrors.
 *
 * `phaseWeightUnits.test.tsx` covers the write path's unit conversion; this
 * file covers only the read failure's wording.
 */
configure({ asyncUtilTimeout: 10_000 });

jest.mock('@/lib/body', () => ({
  ...jest.requireActual('@/lib/body'),
  listPhases: jest.fn(),
  createPhase: jest.fn(),
  endPhase: jest.fn(),
}));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => mockTokenGetter,
}));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', on: '#000' }),
}));

const mockUnits: UnitSystem = 'metric';
jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({
    units: mockUnits,
    unitsReady: true,
    setUnits: jest.fn(),
    unsynced: false,
  }),
}));

const mockList = listPhases as jest.MockedFunction<typeof listPhases>;
const mockCreate = createPhase as jest.MockedFunction<typeof createPhase>;
const mockEnd = endPhase as jest.MockedFunction<typeof endPhase>;

beforeEach(() => {
  jest.clearAllMocks();
});

/** A regex from a diagnosis string — `toHaveTextContent` matches a plain
 *  string only EXACTLY, and every composed failure sentence here is the
 *  diagnosis alone (this screen adds no local action of its own). Kept
 *  anyway, rather than an exact match, so the composition can grow a suffix
 *  later without every test here needing to change with it. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('why the read failed', () => {
  it('never says "could not reach the server" for a failure the server answered', async () => {
    mockList.mockRejectedValue(new ApiError('could not list phases', 'internal', 500));
    render(<PhaseScreen />);

    const problem = await screen.findByTestId('phase-problem');
    expect(problem).not.toHaveTextContent(/reach the server/i);
  });

  it.each([
    ['no route to the API', new OfflineError()],
    ['a timeout', new TimeoutError()],
    ['a dropped connection', new RequestDroppedError()],
  ] as const)('composes the transport’s own diagnosis for %s', async (_label, err) => {
    mockList.mockRejectedValue(err);
    render(<PhaseScreen />);

    const problem = await screen.findByTestId('phase-problem');
    expect(problem).toHaveTextContent(new RegExp(escapeRe(err.diagnosis)));
  });

  it('still tells the three transport failures apart from one another', async () => {
    // The regression this whole ticket describes: an unconditional `.catch`
    // that folds every cause into "Could not reach the server." would pass
    // each test above individually if the assertion only checked for SOME
    // text — this checks the three renders are not all the same sentence.
    const renders: string[] = [];
    for (const err of [new OfflineError(), new TimeoutError(), new RequestDroppedError()]) {
      mockList.mockRejectedValue(err);
      const { unmount } = render(<PhaseScreen />);
      const problem = await screen.findByTestId('phase-problem');
      renders.push(problem.props.children);
      unmount();
    }
    expect(new Set(renders).size).toBe(3);
  });

  it('waits for a genuine answer rather than jumping to "no phase" on a failed read', async () => {
    // `loaded` only flips true on a SUCCESSFUL response. Without that
    // distinction a failed read would fall through to "no live phase, show
    // the start form" — a false negative about a phase that may well exist.
    mockList.mockRejectedValue(new OfflineError());
    render(<PhaseScreen />);

    await screen.findByTestId('phase-problem');
    expect(screen.queryByTestId('phase-start')).toBeNull();
  });
});

/**
 * N94 (follow-up, same ticket): the two WRITE catches, `start` and `stop`,
 * carried the identical unconditional-network-blame defect the ticket's
 * named `refresh` catch was fixed for — just one function down in the same
 * file. Not in the issue's own three named sites, but the same class of bug
 * in the same screen, caught in review and fixed alongside it rather than
 * left half-done.
 */
describe('why start/stop failed', () => {
  beforeEach(() => {
    mockList.mockResolvedValue([]);
  });

  it('start: never says "could not reach the server" for a failure the server answered', async () => {
    mockCreate.mockRejectedValue(new ApiError('could not create phase', 'internal', 500));
    render(<PhaseScreen />);

    await waitFor(() => expect(screen.getByTestId('phase-start')).toBeTruthy());
    fireEvent.press(screen.getByTestId('phase-start'));

    const problem = await screen.findByTestId('phase-problem');
    expect(problem).not.toHaveTextContent(/reach the server/i);
  });

  it('stop: never says "could not reach the server" for a failure the server answered', async () => {
    mockList.mockResolvedValue([
      {
        id: 'p1',
        user_id: 'u1',
        kind: 'cut',
        started_on: '2026-08-01',
        target_on: null,
        target_weight_kg: null,
        ended_on: null,
        notes: '',
      },
    ]);
    mockEnd.mockRejectedValue(new ApiError('could not end phase', 'internal', 500));
    render(<PhaseScreen />);

    await waitFor(() => expect(screen.getByTestId('phase-end')).toBeTruthy());
    fireEvent.press(screen.getByTestId('phase-end'));

    const problem = await screen.findByTestId('phase-problem');
    expect(problem).not.toHaveTextContent(/reach the server/i);
  });

  it.each([
    ['no route to the API', new OfflineError()],
    ['a timeout', new TimeoutError()],
    ['a dropped connection', new RequestDroppedError()],
  ] as const)('start composes the transport’s own diagnosis for %s', async (_label, err) => {
    mockCreate.mockRejectedValue(err);
    render(<PhaseScreen />);

    await waitFor(() => expect(screen.getByTestId('phase-start')).toBeTruthy());
    fireEvent.press(screen.getByTestId('phase-start'));

    const problem = await screen.findByTestId('phase-problem');
    expect(problem).toHaveTextContent(new RegExp(escapeRe(err.diagnosis)));
  });

  it('still tells the three transport failures apart for a failed start — a fold-back to one sentence would pass individually but not this', async () => {
    const renders: string[] = [];
    for (const err of [new OfflineError(), new TimeoutError(), new RequestDroppedError()]) {
      mockCreate.mockRejectedValue(err);
      const { unmount } = render(<PhaseScreen />);
      await waitFor(() => expect(screen.getByTestId('phase-start')).toBeTruthy());
      fireEvent.press(screen.getByTestId('phase-start'));
      const problem = await screen.findByTestId('phase-problem');
      renders.push(problem.props.children);
      unmount();
    }
    expect(new Set(renders).size).toBe(3);
  });
});
