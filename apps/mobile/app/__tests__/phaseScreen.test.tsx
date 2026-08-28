import { configure, render, screen } from '@testing-library/react-native';

import PhaseScreen from '../phase/index';
import { ApiError, OfflineError, RequestDroppedError, TimeoutError } from '@/lib/apiError';
import { listPhases } from '@/lib/body';
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
