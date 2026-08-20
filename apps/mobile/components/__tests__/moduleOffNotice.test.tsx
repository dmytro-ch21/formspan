import { render, screen } from '@testing-library/react-native';

import { ModuleOffNotice } from '../ModuleOffNotice';
import type { Module } from '@/lib/modules';

/**
 * N61 / #423 — the sentence an athlete reads when a tab they can now reach
 * leads to a module they have turned off.
 *
 * A component test rather than a pure one because the thing under test IS the
 * copy: which of the two states is being described, and whether the module is
 * named. `moduleGating.test.ts` covers which state applies; this covers what
 * gets said in each.
 *
 * The property that matters is that the two states are DIFFERENT sentences.
 * "Turned off, here is how to turn it on" and "this deployment does not have
 * it" are opposite claims, and rendering the first for the second promises a
 * feature the server does not have — the same lie as hiding one it does,
 * pointing the other way.
 */

function mod(over: Partial<Module> & { key: string }): Module {
  return {
    key: over.key,
    label: over.label ?? over.key,
    is_sport: over.is_sport ?? false,
    default_on: over.default_on ?? true,
    enabled: over.enabled ?? false,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: true,
      record_kinds: [],
      ...(over.capabilities ?? {}),
    },
  };
}

it('names the module that is off, and says where to turn it back on', () => {
  render(<ModuleOffNotice module={mod({ key: 'nutrition', label: 'Nutrition' })} action="log food" />);

  expect(screen.getByText('Nutrition is turned off')).toBeTruthy();
  // The destination is NAMED. #370's whole finding was that the athlete never
  // reached the screen that would explain itself; an explanation with no next
  // step repeats that failure one screen later.
  expect(screen.getByText(/Sports in your profile/)).toBeTruthy();
  expect(screen.getByText(/log food/)).toBeTruthy();
});

// The registry's LABEL, not the key. "1 discipline is off" does not tell an
// athlete it is the one they went looking for, and capitalising a key gives
// "Bjj" where the registry says "BJJ".
it('uses the registry label rather than the key', () => {
  render(<ModuleOffNotice module={mod({ key: 'bjj', label: 'BJJ' })} action="log rolls" />);

  expect(screen.getByText('BJJ is turned off')).toBeTruthy();
  expect(screen.queryByText(/bjj is turned off/)).toBeNull();
});

/**
 * **The third state, and the test that makes the branch worth having.**
 *
 * With no such module in this deployment there is nothing to turn on. Offering
 * it anyway names a module that does not exist and sends the athlete to a
 * settings screen that will not contain it.
 *
 * A guard is only exercised by the input it is meant to reject — the lesson
 * #468 paid for — so this asserts the ABSENCE of the offer, not merely the
 * presence of some other text. Without the assertion on "turned off" a
 * component that rendered both blocks would pass.
 */
it('makes no offer when this deployment has no such module', () => {
  render(<ModuleOffNotice module={undefined} action="log food" />);

  expect(screen.getByText('Not available')).toBeTruthy();
  expect(screen.getByText(/Nothing here is set up to log food/)).toBeTruthy();
  expect(screen.queryByText(/turned off/)).toBeNull();
  expect(screen.queryByText(/Sports in your profile/)).toBeNull();
});
