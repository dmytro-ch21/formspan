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
});
