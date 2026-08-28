import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SequenceScreen from '../../app/sequence/[id]';
import SequencesScreen from '../../app/sequence/index';

/**
 * Reading a chain back on the phone — N80 / issue #414.
 *
 * **What was actually wrong.** `shared/index.tsx` told an athlete who accepted
 * a shared sequence that "your copy is in the Library", and there was no
 * sequence route in this app at all. The audit that found it filed it above
 * every other phone-impossible gap because it was the only one where the app
 * SAID something untrue rather than merely omitting a surface — an athlete
 * would go and look, and the Library tab is the technique catalog, so they
 * would look twice and find nothing.
 *
 * What is pinned here is not the rendering. It is the four pieces of state
 * that a read-back screen gets wrong in ways that all look like success:
 *
 *   - a failed LIST must not render as "you have no chains", and must still
 *     show the ones this device is holding in its outbox. Rounding a 500 down
 *     to an empty list is this codebase's most repeated defect.
 *   - a local capture has NO library fields on its steps, so a screen that
 *     renders `step.name` naively shows blanks — or, worse, falls back to the
 *     raw technique id and passes it off as a name.
 *   - offline is not 404. `getSequence` resolves to `null` for a chain this
 *     device has never held, and telling someone their chain is gone when the
 *     truth is "we could not ask" is the same class of lie as the one above.
 *   - the order IS the content. A chain rendered out of order is not a
 *     degraded chain, it is a different one.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockList = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockPending = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
const mockGet = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(null));
jest.mock('@/lib/sequences', () => ({
  // The pure helpers are the REAL ones — they are the thing under test in
  // `sequences.test.ts` and stubbing them here would let a screen render
  // whatever a stub returned and still pass.
  ...jest.requireActual('@/lib/sequences'),
  listSequences: (...a: unknown[]) => mockList(...a),
  pendingSequences: (...a: unknown[]) => mockPending(...a),
  getSequence: (...a: unknown[]) => mockGet(...a),
}));

const mockFetchTechniques = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: (...a: unknown[]) => mockFetchTechniques(...a),
}));

jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'u1' }) }));

const mockPush = jest.fn();
// See `sharedScreen.test.tsx` for why this is `mockUseEffect` rather than a
// `require('react')` inside the factory: the require costs a lint warning
// against the mobile ratchet, and the ratchet has no headroom.
const mockUseEffect = useEffect;
// The focus callback is captured as well as run, so a test can fire it a
// SECOND time. Nothing else can: `load`'s deps are all stable by design (that
// stability is what stops the screen refetch-looping), so a re-render does not
// re-run the effect — which means the refocus path, the one an athlete hits
// every time they come back to a screen, is otherwise unreachable from here.
let refocus: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'seq-1' }),
  useFocusEffect: (cb: () => void) => {
    refocus = cb;
    mockUseEffect(() => cb(), [cb]);
  },
  Stack: { Screen: () => null },
}));

const serverChain = (over: Record<string, unknown> = {}) => ({
  id: 'seq-1',
  name: 'Knee cut off the break',
  description: '',
  start_position_id: 'closed-guard',
  start_position_name: 'Closed guard',
  step_count: 2,
  editable: true,
  steps: [
    {
      technique_id: 'standing-break',
      name: 'Standing guard break',
      position: 'closed guard',
      category: 'pass',
      notes: 'posture first',
      ends_at_position_id: null,
      ends_at_position_name: '',
    },
    {
      technique_id: 'knee-cut',
      name: 'Knee cut pass',
      position: 'combat base',
      category: 'pass',
      notes: '',
      ends_at_position_id: 'side-control',
      ends_at_position_name: 'Side control',
    },
  ],
  ...over,
});

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([]);
  mockPending.mockReset().mockResolvedValue([]);
  mockGet.mockReset().mockResolvedValue(null);
  mockFetchTechniques.mockReset().mockResolvedValue([]);
  mockPush.mockReset();
  refocus = null;
});

describe('the list', () => {
  it('opens a chain by its own id', async () => {
    mockList.mockResolvedValue([
      { id: 'seq-1', name: 'A', description: '', start_position_id: null, step_count: 3, editable: true },
      { id: 'seq-2', name: 'B', description: '', start_position_id: null, step_count: 1, editable: true },
    ]);

    render(<SequencesScreen />);
    fireEvent.press(await screen.findByTestId('sequence-row-seq-2'));

    // Pinned to the literal path. The screen builds it from a template, so an
    // assertion derived from the same expression would survive the route being
    // renamed out from under it.
    expect(mockPush).toHaveBeenCalledWith('/sequence/seq-2');
  });

  it('falls back to the outbox when the list fails, and says it failed', async () => {
    // `listSequences` rejects the WHOLE promise on a 500 — including the local
    // half it had already read — so an outage would otherwise hide this
    // phone's own captures, while being OFFLINE showed them. Inconsistent, and
    // the wrong way round.
    mockList.mockRejectedValue(new Error('Request failed (500).'));
    mockPending.mockResolvedValue([
      {
        id: 'local-1',
        name: 'Captured after class',
        description: '',
        start_position_id: null,
        step_count: 2,
        editable: true,
        pending: true,
      },
    ]);

    render(<SequencesScreen />);

    const err = await screen.findByTestId('sequences-error');
    expect(err).toHaveTextContent('Request failed (500).');
    // An error that appears without moving focus is silent to a screen reader
    // unless it announces itself. Asserted on the prop and pinned to the
    // literal 'polite', which is this app's convention — reading it back off a
    // constant would pass whatever the constant said.
    expect(err.props.accessibilityLiveRegion).toBe('polite');
    expect(await screen.findByTestId('sequence-row-local-1')).toBeTruthy();
    // The claim that must not be made: "you have none".
    expect(screen.queryByTestId('sequences-empty')).toBeNull();
  });

  it('does not say "no chains" when it could not ask and is holding none', async () => {
    // The nastier half of the previous test. The outbox fallback covers the
    // athlete who has unsynced captures; someone whose captures are all synced
    // gets an EMPTY fallback, and then the list is empty for two completely
    // different reasons — you have none, or we could not ask. "No chains yet"
    // is a claim about their training, and it is false in the second.
    mockList.mockRejectedValue(new Error('Request failed (500).'));
    mockPending.mockResolvedValue([]);

    render(<SequencesScreen />);

    expect(await screen.findByTestId('sequences-error')).toBeTruthy();
    expect(screen.queryByTestId('sequences-empty')).toBeNull();
  });

  it('shows the empty state only when the answer really is empty', async () => {
    // The arm that makes the previous test mean anything — without it, a
    // screen that never rendered `sequences-empty` at all would pass.
    render(<SequencesScreen />);
    expect(await screen.findByTestId('sequences-empty')).toBeTruthy();
    expect(screen.queryByTestId('sequences-error')).toBeNull();
  });

  it('marks a chain the server has never seen', async () => {
    // The difference between "your partner can see this" and "only you can".
    mockList.mockResolvedValue([
      {
        id: 'local-1',
        name: 'Captured after class',
        description: '',
        start_position_id: null,
        step_count: 2,
        editable: true,
        pending: true,
      },
      { id: 'seq-9', name: 'Synced', description: '', start_position_id: null, step_count: 2, editable: true },
    ]);

    render(<SequencesScreen />);

    expect(await screen.findByTestId('sequence-pending-local-1')).toBeTruthy();
    // And not on the one that HAS reached the server, or the marker means
    // nothing.
    expect(screen.queryByTestId('sequence-pending-seq-9')).toBeNull();
  });
});

describe('the detail', () => {
  it('renders the steps in the order they were recorded', async () => {
    mockGet.mockResolvedValue(serverChain());

    render(<SequenceScreen />);

    await screen.findByTestId('sequence-screen');
    // Position, not just presence: the order IS the content of a chain, and a
    // `toBeTruthy` on each name passes against a reversed list.
    expect(await screen.findByTestId('sequence-step-0')).toHaveTextContent(/Standing guard break/);
    expect(await screen.findByTestId('sequence-step-1')).toHaveTextContent(/Knee cut pass/);
  });

  it('shows where a step leaves you, and stays quiet when nothing was recorded', async () => {
    mockGet.mockResolvedValue(serverChain());

    render(<SequenceScreen />);

    expect(await screen.findByTestId('sequence-node-1')).toHaveTextContent(/ends in Side control/);
    // Step 0 has no `ends_at_position_name`. Rendering "Not recorded" on every
    // step of a chain captured on the mat is twenty lines of noise.
    expect(screen.queryByTestId('sequence-node-0')).toBeNull();
  });

  it('opens the technique behind a step', async () => {
    mockGet.mockResolvedValue(serverChain());

    render(<SequenceScreen />);
    fireEvent.press(await screen.findByTestId('sequence-step-1'));

    expect(mockPush).toHaveBeenCalledWith('/technique/knee-cut');
  });

  it('resolves the names on a local capture from the library', async () => {
    // A row still in the outbox carries only the technique ids the reflection
    // wizard tagged — the server resolves `name` on read and has never seen
    // this one.
    mockGet.mockResolvedValue({
      id: 'seq-1',
      name: 'Captured after class',
      description: '',
      start_position_id: null,
      step_count: 1,
      editable: true,
      pending: true,
      steps: [{ technique_id: 'knee-cut', ends_at_position_id: null, notes: '' }],
    });
    mockFetchTechniques.mockResolvedValue([{ id: 'knee-cut', name: 'Knee cut pass' }]);

    render(<SequenceScreen />);

    expect(await screen.findByTestId('sequence-step-0')).toHaveTextContent(/Knee cut pass/);
    expect(await screen.findByTestId('sequence-pending')).toBeTruthy();
  });

  it('says a name is unavailable rather than passing off the id as one', async () => {
    // The cold-launch-with-no-signal case: the technique library is memory-only
    // (a known gap), so there is nothing to resolve against. `knee-cut` is not
    // a name and rendering it as one is a false claim dressed as a fallback.
    mockGet.mockResolvedValue({
      id: 'seq-1',
      name: 'Captured after class',
      description: '',
      start_position_id: null,
      step_count: 1,
      editable: true,
      pending: true,
      steps: [{ technique_id: 'knee-cut', ends_at_position_id: null, notes: '' }],
    });
    mockFetchTechniques.mockRejectedValue(new Error('Network request failed'));

    render(<SequenceScreen />);

    expect(await screen.findByTestId('sequence-step-unresolved-0')).toBeTruthy();
    expect(screen.queryByText('knee-cut')).toBeNull();
    // And the chain itself still renders — a failed decoration must not take
    // the screen down with it.
    expect(await screen.findByTestId('sequence-screen')).toBeTruthy();
  });

  it('distinguishes a dead request from a chain that is gone', async () => {
    // `getSequence` resolves to `null` when the request got no answer, for a
    // chain this device has never held. Rendering that as a 404 tells the
    // athlete their chain was deleted — a different and much worse claim.
    mockGet.mockResolvedValue(null);

    render(<SequenceScreen />);

    expect(await screen.findByTestId('sequence-unreachable')).toBeTruthy();
    expect(screen.queryByTestId('sequence-error')).toBeNull();
  });

  it('does not blame the athlete\u2019s signal for a dead request', async () => {
    // **The N55 (#365) regression this screen could have shipped.** Since that
    // ticket `getSequence` returns `null` for ANY `isTransportFailure` — no
    // route, a timeout, or a dropped connection — so an athlete on four bars
    // whose request timed out lands here. "You're offline" is false for them,
    // and sending them to look for signal is the exact complaint N55 fixed.
    //
    // Asserted as the ABSENCE of a word, against the literal, because the
    // failure mode is copy drifting back to naming a cause nothing observed.
    // Note even `OfflineError` says "Can't reach VOLA" rather than "offline".
    mockGet.mockResolvedValue(null);

    render(<SequenceScreen />);

    const card = await screen.findByTestId('sequence-unreachable');
    expect(card).toHaveTextContent(/Can't reach VOLA/);
    expect(card).not.toHaveTextContent(/offline/i);
    expect(card).not.toHaveTextContent(/signal/i);
  });

  it('keeps a chain already on screen when a refocus gets no answer', async () => {
    // The common path, not an exotic one: read a chain, background the app,
    // lose signal, come back. This screen reloads on FOCUS, `getSequence`
    // resolves `null` offline for a chain this device does not hold, and
    // assigning that would replace the steps the athlete is reading with a
    // full-screen "you're offline". Honest, and strictly worse than what was
    // already on the page.
    mockGet.mockResolvedValueOnce(serverChain()).mockResolvedValue(null);

    render(<SequenceScreen />);
    await screen.findByTestId('sequence-step-1');

    // Fire the focus callback again — see the `expo-router` mock for why a
    // re-render cannot do this.
    await act(async () => {
      refocus?.();
    });

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('sequence-step-1')).toHaveTextContent(/Knee cut pass/);
    expect(screen.queryByTestId('sequence-unreachable')).toBeNull();
  });

  it('surfaces a real failure as an error, not as an unreachable server', async () => {
    // The arm that makes the previous test mean anything.
    mockGet.mockRejectedValue(new Error('Request failed (500).'));

    render(<SequenceScreen />);

    const err = await screen.findByTestId('sequence-error');
    expect(err).toHaveTextContent('Request failed (500).');
    expect(err.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.queryByTestId('sequence-unreachable')).toBeNull();
  });

  it('does not fetch the whole library when the server resolved the names', async () => {
    // ~197 KB on a cold cache, for nothing. Guarded because the obvious
    // implementation fetches unconditionally and nothing else would notice.
    mockGet.mockResolvedValue(serverChain());

    render(<SequenceScreen />);

    await screen.findByTestId('sequence-step-1');
    expect(mockFetchTechniques).not.toHaveBeenCalled();
  });

  it('points at the web builder for a change it cannot make', async () => {
    // Web being RICHER is allowed; web being the ONLY place is what the
    // mobile-first rule forbids, and reading is now here. Saying where the
    // rest lives beats a screen that silently has no edit affordance.
    mockGet.mockResolvedValue(serverChain());

    render(<SequenceScreen />);

    expect(await screen.findByText(/on the web app/)).toBeTruthy();
  });

  it('calls a VOLA reference chain what it is', async () => {
    mockGet.mockResolvedValue(serverChain({ editable: false }));

    render(<SequenceScreen />);

    expect(await screen.findByText(/reference chain/)).toBeTruthy();
  });
});
