import { useCallback, useEffect, useRef } from 'react';
import { act, configure, render, screen, waitFor } from '@testing-library/react-native';

import { RoadmapLine } from '@/components/RoadmapLine';
import { RoadmapOffer } from '@/components/RoadmapOffer';
import type { Criteria, Curriculum, CurriculumItem, Progress } from '@/lib/curriculum';

/**
 * The two roadmap entry points on Today, as a SIGHTED athlete actually meets
 * them — N96.
 *
 * `lib/__tests__/roadmapEntry.test.ts` covers the two decisions. It cannot
 * cover the thing the ticket is actually about, which is whether anything
 * reaches the screen: a component that computes the right milestone and never
 * renders it passes every assertion in that file. The whole complaint was "its
 * very hidden and not noticable", so a test that stops at the derivation is a
 * test of the half that was never broken.
 *
 * Three properties here, and each was a live failure mode rather than a
 * plausible one:
 *
 *  - **The offer must not appear once the athlete is on a roadmap.** It reads
 *    on FOCUS, not on mount, because a tab screen stays mounted for the life
 *    of the process and enrolling happens on a screen pushed over it. Read
 *    once, it would keep offering a roadmap the athlete had already started —
 *    the exact bug `CurriculaStrip` documents having had.
 *  - **A failed read must render nothing**, not an empty or broken card. This
 *    is the offline case, and rendering "Start a roadmap" with no name in it
 *    is worse than silence.
 *  - **The milestone has to be legible without the bar.** A percentage is what
 *    the ticket forbids leading with, so the assertions are on words.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockListCurricula = jest.fn(
  (..._a: unknown[]): Promise<Curriculum[]> => Promise.resolve([]),
);
// Spread the real module: `RoadmapLine` and `roadmapEntry` both call
// `nextStep` out of it, and listing exports by hand is how a helper added
// later arrives here as `undefined`.
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  listCurricula: (...a: unknown[]) => mockListCurricula(...a),
}));

/*
  ONE getter, returned by every call — because that is what the real hook
  guarantees, and the difference is not cosmetic here.

  `lib/useAuthToken.ts` opens with "A token getter whose identity never
  changes", and everything downstream is built on it: `load` is
  `useCallback([getToken])`, the focus callback is `useCallback([load])`, so a
  stable getter means the effect runs on mount and on a real refocus, and
  nothing else.

  Returning `async () => 'token'` inline instead — which is what this mock did
  first — hands out a NEW function on every render, so `load` changes identity,
  the effect re-runs, and the component refetches after every `setState`. That
  is a refetch loop the real app does not have, and it silently REPAIRS the bug
  under test: `setOffer(stale)` is immediately overwritten by a fresh read, so
  the stale-read test below passed with the abort guard deleted. Measured, not
  reasoned — both abort mutations survived until this line changed.
*/
const mockGetToken = async () => 'token';
jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => mockGetToken,
}));

// `mock`-prefixed so jest's out-of-scope rule allows them inside the factory,
// and so the factory needs no `require('react')` — each one of those costs a
// lint warning against the mobile ratchet.
const mockUseCallback = useCallback;
const mockUseEffect = useEffect;
const mockUseRef = useRef;
/** Fires the focus effect again, as returning to the tab would. */
let refocus: () => void = () => {};
const mockHrefs: string[] = [];

jest.mock('expo-router', () => ({
  /*
    Fires on MOUNT and on an explicit `refocus()`, and on nothing else.

    Two properties, both learned the hard way. It has to fire more than once,
    or "reads on focus" is indistinguishable from "reads on mount" and the
    stale-offer bug is invisible. And it must **not** re-fire on every render:
    the first version of this mock called `run()` in the render body, so any
    `setOffer` triggered an immediate refetch that overwrote the value under
    test — which made two mutations of the abort guard pass. Measured, not
    reasoned: remove the abort from `RoadmapOffer` and the render-time version
    of this mock stays green.

    `mockUseEffect` with `[run]` is the faithful shape — after mount, once,
    since `run` is memoised on a `cb` that never changes identity.
  */
  useFocusEffect: (cb: () => void | (() => void)) => {
    const cleanup = mockUseRef<(() => void) | void>(undefined);
    const run = mockUseCallback(() => {
      if (typeof cleanup.current === 'function') cleanup.current();
      cleanup.current = cb();
    }, [cb]);
    refocus = run;
    mockUseEffect(run, [run]);
  },
  // Records where the card points, so "reachable in a tap" is asserted rather
  // than assumed. `asChild` renders the child as-is, like the real one.
  Link: ({ href, children }: { href?: string; children?: unknown }) => {
    if (typeof href === 'string' && !mockHrefs.includes(href)) mockHrefs.push(href);
    return children as never;
  },
}));

const CRITERIA: Criteria = {
  target_scored: 10,
  target_defended: null,
  target_sessions: 5,
  min_hit_rate: null,
  target_drilled_sessions: null,
};

const PROGRESS = (mastered: boolean): Progress => ({
  scored: mastered ? 10 : 0,
  defended: 0,
  sessions: mastered ? 5 : 0,
  attempts: mastered ? 10 : 0,
  hit_rate: null,
  drilled_sessions: 0,
  mastered,
});

let n = 0;
const step = (phase: number | null, mastered: boolean, name?: string): CurriculumItem => ({
  kind: 'technique',
  technique_id: `t${(n += 1)}`,
  name: name ?? `Technique ${n}`,
  position: 'guard',
  category: 'sweep',
  order: n,
  phase,
  notes: '',
  criteria: CRITERIA,
  progress: PROGRESS(mastered),
});

const curriculum = (over: Partial<Curriculum>): Curriculum =>
  ({
    id: over.id ?? 'r',
    name: over.name ?? 'White belt: learn the map',
    description: '',
    belt: over.belt ?? 'white',
    track: over.track ?? 'belt',
    editable: false,
    official: over.official ?? true,
    visibility: 'public',
    enrolled: over.enrolled ?? true,
    started_on: '2026-01-01',
    item_count: over.item_count ?? 0,
    countable_items: over.countable_items ?? 0,
    mastered_items: over.mastered_items ?? 0,
    phases: over.phases,
    items: over.items,
  }) as Curriculum;

const phases = (...titles: string[]) =>
  titles.map((title, order) => ({ order, title, description: '' }));

beforeEach(() => {
  mockListCurricula.mockReset();
  mockListCurricula.mockResolvedValue([]);
  mockHrefs.length = 0;
});

describe('RoadmapLine — where you are, on Today', () => {
  it('leads with the milestone in words, and still names the next step', () => {
    render(
      <RoadmapLine
        curriculum={curriculum({
          phases: phases('The map', 'Mount: get out, then hold', 'Escape'),
          items: [step(0, true), step(1, false, 'Trap-and-roll escape'), step(2, false)],
          countable_items: 3,
          mastered_items: 1,
        })}
      />,
    );
    // Both halves, and both by their words: the ticket rules out a bare
    // percentage as the thing an entry point leads with.
    expect(screen.getByText('Milestone 2 of 3 · Mount: get out, then hold')).toBeTruthy();
    expect(screen.getByText(/Trap-and-roll escape/)).toBeTruthy();
    expect(screen.getByText('1 of 3 mastered')).toBeTruthy();
  });

  it('falls back to the next step on a roadmap with no phases', () => {
    // Unphased curricula are legal, and inventing "Milestone 1 of 0" for one
    // is worse than the line this component had before.
    render(
      <RoadmapLine
        curriculum={curriculum({
          items: [step(null, false, 'Arm drag')],
          countable_items: 1,
        })}
      />,
    );
    expect(screen.getByText('Next up: Arm drag')).toBeTruthy();
    expect(screen.queryByText(/Milestone/)).toBeNull();
  });

  it('says nothing about a milestone once the roadmap is finished', () => {
    render(
      <RoadmapLine
        curriculum={curriculum({
          phases: phases('The map', 'Escape'),
          items: [step(0, true), step(1, true)],
          countable_items: 2,
          mastered_items: 2,
        })}
      />,
    );
    expect(screen.getByText('Every technique on this one is done.')).toBeTruthy();
    expect(screen.queryByText(/Milestone/)).toBeNull();
  });
});

describe('RoadmapOffer — the way in, for an athlete on none', () => {
  const offerable = curriculum({
    id: 'novice-fundamentals',
    name: 'Novice fundamentals',
    belt: null,
    track: 'foundations',
    enrolled: false,
    countable_items: 10,
  });

  it('names the roadmap and what moves it, and points at that roadmap', async () => {
    mockListCurricula.mockResolvedValue([offerable]);
    render(<RoadmapOffer />);

    await waitFor(() => expect(screen.getByTestId('today-roadmap-offer')).toBeTruthy());
    expect(screen.getByText('Start a roadmap')).toBeTruthy();
    // The name, because "a roadmap" is the abstraction the athlete had no
    // model for — the diagnosis behind this whole change.
    expect(screen.getByText('Novice fundamentals')).toBeTruthy();
    // The sentence VERBATIM, spaces included. It is assembled from an
    // interpolated string precisely because JSX text across several source
    // lines silently re-spaces itself when the block is re-wrapped, and
    // "sessionsdecide" would go out with nothing red anywhere.
    expect(
      screen.getByText(
        'Novice fundamentals — 10 techniques, in the order they are usually ' +
          'learned. Your logged sessions decide how far along it says you are — ' +
          'there is nothing to tick off by hand.',
      ),
    ).toBeTruthy();
    // One tap away. The ticket asks for "reachable in a tap or two", which is
    // a fact about the destination rather than about the copy.
    expect(mockHrefs).toContain('/curriculum/novice-fundamentals');
  });

  it('renders nothing at all when the read fails', async () => {
    // The gym dead-spot. An empty card saying "Start a roadmap" with no name
    // in it is worse than silence, and a banner here would make an offline
    // Today look broken over something nobody asked for.
    mockListCurricula.mockRejectedValue(new Error('offline'));
    render(<RoadmapOffer />);

    await act(async () => {});
    expect(screen.queryByTestId('today-roadmap-offer')).toBeNull();
  });

  it('stops offering a roadmap the athlete has since started', async () => {
    // READ ON FOCUS, not on mount. Enrolling happens on the roadmap screen
    // pushed over the tabs, and this tab stays mounted for the life of the
    // process — so a mount-only read leaves Today offering something the
    // athlete is already working. `CurriculaStrip` shipped that bug once.
    mockListCurricula.mockResolvedValue([offerable]);
    render(<RoadmapOffer />);
    await waitFor(() => expect(screen.getByTestId('today-roadmap-offer')).toBeTruthy());

    mockListCurricula.mockResolvedValue([{ ...offerable, enrolled: true }]);
    await act(async () => {
      refocus();
    });

    await waitFor(() => expect(screen.queryByTestId('today-roadmap-offer')).toBeNull());
  });

  it('drops a read that was still in flight when the tab lost focus', async () => {
    /*
      The stale-read race, and the reason it is not covered by the test above:
      there both reads resolve in order. Blur Today mid-request on a slow
      connection, enrol, come back, and TWO reads are alive — if the first one,
      built from a list where nothing was enrolled, lands last, it puts the
      offer back on top of a roadmap the athlete just started. This is the same
      shape Today's own `planSeq` and the Plan tab's `readSeq` guard, and here
      it is solved by cancelling on blur instead of sequencing.

      The stub rejects when its signal aborts because that is what `fetch`
      does — the contract `app/library.tsx` already relies on in production.
      Note React Native swaps in `abort-controller@3.0.0`, which has no
      `reason`; nothing here reads one, so `signal.aborted` is the whole
      mechanism on both runtimes.

      `signal?.` is deliberate: an implementation that stopped passing the
      signal at all must fail this test rather than crash the stub into a
      rejection that looks like the guard working.
    */
    let landStale: (c: Curriculum[]) => void = () => {};
    mockListCurricula.mockImplementationOnce(
      (...a: unknown[]) =>
        new Promise<Curriculum[]>((resolve, reject) => {
          landStale = resolve;
          (a[1] as AbortSignal | undefined)?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        }),
    );
    render(<RoadmapOffer />);

    // Away and back — and in between, the athlete enrolled.
    mockListCurricula.mockResolvedValue([{ ...offerable, enrolled: true }]);
    await act(async () => {
      refocus();
    });

    // Only now does the abandoned first read come back, carrying the world as
    // it was before they enrolled.
    await act(async () => {
      landStale([offerable]);
    });

    expect(screen.queryByTestId('today-roadmap-offer')).toBeNull();
  });
});
