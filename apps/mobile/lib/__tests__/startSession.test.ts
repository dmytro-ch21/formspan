import type { Module } from '../modules';
import { startSessionHref } from '../startSession';

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
