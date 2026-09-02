import type { Module } from '../modules';
import { sessionHref, startSessionHref } from '../startSession';

/**
 * Where a chosen discipline goes — one branch, two callers.
 *
 * Today has made this decision since sessions existed; N176 gave the Train tab
 * the same action, so the branch moved into `lib/startSession.ts` rather than
 * being written a second time. These pin it, because getting it wrong is not
 * subtle on a device and is completely silent here: a technique-shaped
 * discipline sent to `/session/start` renders a set logger over a session that
 * can never hold a set, and the reflection wizard behind `/bjj/log` becomes
 * unreachable — which is exactly what shipped once before.
 */

function mod(over: Partial<Module> & { key: string }): Module {
  return {
    key: over.key,
    label: over.label ?? over.key,
    is_sport: over.is_sport ?? true,
    default_on: true,
    enabled: over.enabled ?? true,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
      record_kinds: [],
      ...(over.capabilities ?? {}),
    },
  } as Module;
}

const strength = mod({ key: 'strength', capabilities: { catalog: 'exercises' } as Module['capabilities'] });
const bjj = mod({ key: 'bjj', capabilities: { catalog: 'techniques' } as Module['capabilities'] });
// Same catalog as strength — running's `session_sets` rows target seeded
// `exercises`, not a technique — which is exactly why `sessionHref` cannot
// tell it apart from strength via `logsAfterwards` and needs its own branch.
// See `running` = mod(...) below for N460's coverage.
const running = mod({ key: 'running', capabilities: { catalog: 'exercises' } as Module['capabilities'] });

describe('startSessionHref', () => {
  it('starts a session for a discipline that is logged as it happens', () => {
    expect(startSessionHref({ sport: 'strength', workoutId: null }, [strength, bjj])).toBe(
      '/session/start?sport=strength',
    );
  });

  it('carries the chosen template through', () => {
    // Without the template the athlete rebuilds their own plan exercise by
    // exercise at the rack, which is the thing the plan existed to avoid.
    expect(startSessionHref({ sport: 'strength', workoutId: 'w7' }, [strength])).toBe(
      '/session/start?sport=strength&workout=w7',
    );
  });

  it('sends a discipline that is logged afterwards to its own log screen', () => {
    expect(startSessionHref({ sport: 'bjj', workoutId: null }, [strength, bjj])).toBe('/bjj/log');
  });

  // **The vector that separates the real predicate from `key === 'bjj'`.** The
  // branch reads the catalog kind, so a second technique-shaped discipline gets
  // the right flow without this file learning its name — the rule the module
  // registry exists to enforce, and one a bjj-only test set cannot check.
  it('reads the catalog kind rather than the module key', () => {
    const judo = mod({ key: 'judo', capabilities: { catalog: 'techniques' } as Module['capabilities'] });
    expect(startSessionHref({ sport: 'judo', workoutId: null }, [judo])).toBe('/bjj/log');
  });

  // The mirror, and the one that fails if the branch is inverted or collapses
  // to a constant: a catalog that is not techniques must NOT take that path,
  // even when a technique discipline is present in the same set.
  it('does not divert a catalog-carrying discipline that logs live', () => {
    expect(startSessionHref({ sport: 'strength', workoutId: 'w1' }, [strength, bjj])).toBe(
      '/session/start?sport=strength&workout=w1',
    );
  });

  // A sport this build has never heard of — the server can ship a discipline
  // before the app that renders it. It is not technique-shaped as far as we
  // know, so it takes the ordinary path rather than crashing on an undefined
  // lookup.
  it('treats an unknown discipline as one that logs live', () => {
    expect(startSessionHref({ sport: 'rowing', workoutId: null }, [strength])).toBe(
      '/session/start?sport=rowing',
    );
  });

  // N460/#771: running still starts from the ordinary chooser — a runner may
  // have an interval template — because the BRANCH that differs for running
  // is where finishing that choice goes, not where starting it does. See
  // `sessionHref` below for that half.
  it('starts running from the ordinary chooser too, template and all', () => {
    expect(startSessionHref({ sport: 'running', workoutId: null }, [strength, running])).toBe(
      '/session/start?sport=running',
    );
    expect(startSessionHref({ sport: 'running', workoutId: 'w9' }, [running])).toBe(
      '/session/start?sport=running&workout=w9',
    );
  });

  // N434/#721 — backfilling a missed session for a past day.
  describe('with a date override', () => {
    it('carries the date through to the BJJ log screen', () => {
      expect(startSessionHref({ sport: 'bjj', workoutId: null }, [bjj], '2026-08-25')).toBe(
        '/bjj/log?date=2026-08-25',
      );
    });

    it('carries the date through to an empty strength session', () => {
      expect(
        startSessionHref({ sport: 'strength', workoutId: null }, [strength], '2026-08-25'),
      ).toBe('/session/start?sport=strength&date=2026-08-25');
    });

    // The vector that separates a real append from string luck: the date has
    // to land AFTER the workout id, not silently before or instead of it.
    it('carries the date through alongside a chosen template', () => {
      expect(
        startSessionHref({ sport: 'strength', workoutId: 'w7' }, [strength], '2026-08-25'),
      ).toBe('/session/start?sport=strength&workout=w7&date=2026-08-25');
    });

    // Omitting the third argument entirely — the ordinary, unaffected
    // call every existing caller makes — has to produce byte-identical
    // output to before this ticket touched the file.
    it('is a no-op when omitted', () => {
      expect(startSessionHref({ sport: 'bjj', workoutId: null }, [bjj])).toBe('/bjj/log');
      expect(startSessionHref({ sport: 'strength', workoutId: 'w1' }, [strength])).toBe(
        '/session/start?sport=strength&workout=w1',
      );
    });
  });
});

/**
 * Where an EXISTING session opens — the sibling branch, and now a shared one.
 *
 * It lived inline in Today, which was fine while Today was the only screen that
 * opened a session. N177's Train tab has a Resume card and a Recent list, both
 * of which open one, so it moved here beside the start branch. The failure it
 * prevents is the same one and is completely silent: the live set logger over a
 * BJJ session renders "Sets 0 · Reps 0 · Volume —" above an empty list, and the
 * reflection wizard — reachable only by `replace` from the log screen —
 * disappears entirely.
 */
describe('sessionHref', () => {
  it('opens a live-logged session in the set logger', () => {
    expect(sessionHref({ id: 's1', sport: 'strength' }, [strength, bjj])).toEqual({
      pathname: '/session/[id]',
      params: { id: 's1' },
    });
  });

  it('opens a logged-afterwards session in its own reader', () => {
    expect(sessionHref({ id: 's2', sport: 'bjj' }, [strength, bjj])).toEqual({
      pathname: '/bjj/session/[id]',
      params: { id: 's2' },
    });
  });

  // The vector that separates the real predicate from `key === 'bjj'` — same
  // reason as above, and the reason this pair sits in one file: if the two
  // branches ever disagree, an athlete starts a BJJ session on one screen and
  // reads it back on a screen built for a different shape.
  it('reads the catalog kind rather than the module key', () => {
    const judo = mod({ key: 'judo', capabilities: { catalog: 'techniques' } as Module['capabilities'] });
    expect(sessionHref({ id: 's3', sport: 'judo' }, [judo])).toEqual({
      pathname: '/bjj/session/[id]',
      params: { id: 's3' },
    });
  });

  it('treats an unknown discipline as one that logs live', () => {
    expect(sessionHref({ id: 's4', sport: 'rowing' }, [strength])).toEqual({
      pathname: '/session/[id]',
      params: { id: 's4' },
    });
  });

  // The id has to reach the route as a PARAM, not be baked into the pathname.
  // A template string here type-checks against `Href` and takes the tap to a
  // route that does not exist, which is N32 relocated into a helper.
  it('carries the id as a route parameter', () => {
    expect(sessionHref({ id: 'abc-123', sport: 'strength' }, [strength])).toMatchObject({
      params: { id: 'abc-123' },
    });
  });

  /**
   * N460/#771 — the bug this whole file exists to catch, reached by a THIRD
   * sport for the first time. `logsAfterwards` cannot see running (its
   * catalog is `exercises`, identical to strength's), so this pins the direct
   * `sport === 'running'` branch by name rather than trusting the catalog
   * check to cover it by accident.
   */
  it('opens a running session in the live GPS tracker, not the set logger', () => {
    expect(sessionHref({ id: 's5', sport: 'running' }, [strength, bjj, running])).toEqual({
      pathname: '/running/[id]',
      params: { id: 's5' },
    });
  });

  // Same failure mode as the "reads the catalog kind" test above, mirrored:
  // running must not be diverted to the BJJ branch just because a technique
  // discipline is present in the same registry.
  it('does not confuse running for a technique-shaped discipline', () => {
    expect(sessionHref({ id: 's6', sport: 'running' }, [bjj, running])).toEqual({
      pathname: '/running/[id]',
      params: { id: 's6' },
    });
  });
});
