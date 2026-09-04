import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import CheckinScreen from '../../app/checkin/[date]';
import { listCheckins, saveCheckin } from '@/lib/body';
import { getProfile } from '@/lib/profile';
import type { UnitSystem } from '@/lib/units';

/**
 * N125 (#519): two silent drifts in `apps/mobile/app/checkin/[date].tsx`,
 * both pre-dating N112 and both invisible to `checkinGirthUnits.test.tsx`,
 * because every test there starts from a **typed** value.
 *
 * ## 1. An untouched Save re-derives a field it never read the mind of
 *
 * `save()` used to write back every non-blank draft field unconditionally.
 * On an imperial profile the draft holds a DISPLAY value (inches), and
 * converting it back to storage on every save — even when the athlete never
 * touched the field — is a lossy round trip: stored `84.0` cm loads as
 * `33.1` in, and saving that untouched re-derives `84.1` cm. Nothing on
 * screen changes; only the stored centimetres move.
 *
 * The fix tracks which fields were actually edited (`touched`, set only by a
 * field's own `onChangeText`) and writes an untouched field back exactly as
 * it was loaded, never through the display conversion.
 *
 * ## 2. A unit flip with an unsaved draft, on a day with no check-in yet
 *
 * `load()` only refilled the draft when a check-in already existed for the
 * day. On a fresh day, typing a girth, flipping the account's unit system in
 * Profile, and coming back left the stale draft in place — so Save stored
 * the typed digits read as the OTHER unit's number: 33 (meant as inches)
 * saved as 33 centimetres.
 *
 * The chosen fix is DISCARD, not reinterpret (stated here and in the
 * screen's own comment): a draft whose unit system has moved on since it was
 * last built is cleared rather than converted, on both a fresh day and a day
 * that already has a check-in — the same behaviour either way, which is what
 * the ticket's "consistent between the two" criterion asks for.
 *
 * ## Why `rerender` stands in for "navigate to Profile and back"
 *
 * This file reuses `checkinGirthUnits.test.tsx`'s own `useFocusEffect` mock —
 * a plain `useEffect(cb, [cb])` — which is naive as a stand-in for the real
 * hook (see `suggestionPrefsRefocus.test.tsx`'s header for the general
 * caveat) but is exactly the right shape here: `load`'s own identity already
 * depends on `units`, so re-rendering the same mounted instance after
 * `mockUnits` changes reproduces "the account-wide unit setting changed
 * while this screen was already open", which is the scenario under test —
 * without needing a real navigation stack in this suite.
 */

jest.mock('@/lib/body', () => ({
  ...jest.requireActual('@/lib/body'),
  listCheckins: jest.fn(),
  saveCheckin: jest.fn(),
  deleteCheckin: jest.fn(),
  uploadCheckinPhoto: jest.fn(),
}));
jest.mock('@/lib/profile', () => ({
  ...jest.requireActual('@/lib/profile'),
  getProfile: jest.fn(),
}));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', on: '#000' }),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ date: '2026-08-20' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useFocusEffect: (cb: () => void) => {
    const { useEffect } = jest.requireActual('react');
    useEffect(cb, [cb]);
  },
}));

let mockUnits: UnitSystem = 'metric';
jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({
    units: mockUnits,
    unitsReady: true,
    setUnits: jest.fn(),
    unsynced: false,
  }),
}));

// 83.82 cm is exactly 33.0 in. weight_kg 80 is 176.4 lb.
const CHECKIN = {
  checkin_date: '2026-08-20',
  weight_kg: 80,
  waist_cm: 83.82,
  hips_cm: 101.6,
  neck_cm: 38.1,
  notes: 'Felt good today',
  photo_url: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUnits = 'metric';
  (listCheckins as jest.Mock).mockResolvedValue([CHECKIN]);
  (saveCheckin as jest.Mock).mockResolvedValue(CHECKIN);
  (getProfile as jest.Mock).mockResolvedValue({
    user_id: 'u1',
    sex: 'male',
    height_cm: 180.34,
    unit_system: 'metric' as UnitSystem,
  });
});

async function open() {
  render(<CheckinScreen />);
  await waitFor(() => expect(screen.getByTestId('checkin-girths-toggle')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('checkin-waist_cm')).toBeTruthy());
}

function payload() {
  return (saveCheckin as jest.Mock).mock.calls[0][2];
}

describe('an untouched Save leaves every stored value byte-identical', () => {
  it('in metric, pressing Save with no changeText at all', async () => {
    mockUnits = 'metric';
    await open();
    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    expect(payload().weight_kg).toBe(CHECKIN.weight_kg);
    expect(payload().waist_cm).toBe(CHECKIN.waist_cm);
    expect(payload().hips_cm).toBe(CHECKIN.hips_cm);
    expect(payload().neck_cm).toBe(CHECKIN.neck_cm);
  });

  it('in imperial, pressing Save with no changeText at all', async () => {
    mockUnits = 'imperial';
    await open();
    // Confirms the draft really did round-trip through inches, so this test
    // could actually fail against the bug.
    expect(screen.getByTestId('checkin-waist_cm').props.value).toBe('33');
    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    // The bug: 33 in converts back to 83.8 cm, not the stored 83.82.
    expect(payload().weight_kg).toBe(CHECKIN.weight_kg);
    expect(payload().waist_cm).toBe(CHECKIN.waist_cm);
    expect(payload().hips_cm).toBe(CHECKIN.hips_cm);
    expect(payload().neck_cm).toBe(CHECKIN.neck_cm);
  });

  it('the weight field has the identical mechanism and is covered the same way', async () => {
    // A stored weight_kg whose pounds round trip is NOT a fixed point, so an
    // untouched re-derivation would move it (unlike 84.0/33.1's coincidence).
    const notFixedPoint = { ...CHECKIN, weight_kg: 79.4 };
    (listCheckins as jest.Mock).mockResolvedValue([notFixedPoint]);
    mockUnits = 'imperial';
    await open();
    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    expect(payload().weight_kg).toBe(notFixedPoint.weight_kg);
  });

  it('editing only the notes still leaves every girth untouched — the exact scenario in the ticket', async () => {
    mockUnits = 'imperial';
    await open();
    fireEvent.changeText(screen.getByTestId('checkin-notes'), 'fixed a typo');
    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    expect(payload().notes).toBe('fixed a typo');
    expect(payload().weight_kg).toBe(CHECKIN.weight_kg);
    expect(payload().waist_cm).toBe(CHECKIN.waist_cm);
    expect(payload().hips_cm).toBe(CHECKIN.hips_cm);
    expect(payload().neck_cm).toBe(CHECKIN.neck_cm);
  });

  it('a field the athlete DOES edit is still converted from what was typed', async () => {
    mockUnits = 'imperial';
    await open();
    fireEvent.changeText(screen.getByTestId('checkin-waist_cm'), '34');
    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    // 34 in is 86.4 cm — a real edit still round-trips normally.
    expect(payload().waist_cm).toBe(86.4);
    // The untouched fields beside it are still byte-identical.
    expect(payload().hips_cm).toBe(CHECKIN.hips_cm);
    expect(payload().neck_cm).toBe(CHECKIN.neck_cm);
  });
});

describe('a unit flip discards an unsaved draft rather than reinterpreting it', () => {
  it('on a day with no check-in yet', async () => {
    mockUnits = 'imperial';
    (listCheckins as jest.Mock).mockResolvedValue([]);
    const { rerender } = render(<CheckinScreen />);
    await waitFor(() => expect(screen.getByTestId('checkin-weight')).toBeTruthy());

    // Open the girths section too — the ticket's own bug-2 narrative is a
    // GIRTH ("type 33 meaning inches"), not the weight field. Covering only
    // weight here left the girth-discard loop (a separate line in `load()`)
    // unpinned: a targeted mutation that no-ops just that loop still left
    // every test in this file green.
    fireEvent.press(screen.getByTestId('checkin-girths-toggle'));
    await waitFor(() => expect(screen.getByTestId('checkin-waist_cm')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('checkin-weight'), '33');
    expect(screen.getByTestId('checkin-weight').props.value).toBe('33');
    fireEvent.changeText(screen.getByTestId('checkin-waist_cm'), '33');
    expect(screen.getByTestId('checkin-waist_cm').props.value).toBe('33');

    mockUnits = 'metric';
    await act(async () => {
      rerender(<CheckinScreen />);
    });

    // Discarded, not silently kept — an untouched field means nothing typed.
    await waitFor(() => expect(screen.getByTestId('checkin-weight').props.value).toBe(''));
    expect(screen.getByTestId('checkin-waist_cm').props.value).toBe('');

    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    // The bug: 33 (meant as pounds, or inches) stored as 33 kilograms/cm.
    expect(payload().weight_kg).toBeUndefined();
    expect(payload().waist_cm).toBeUndefined();
  });

  it('discards even when the reload after the flip fails — the discard does not wait on the network', async () => {
    // Frontend review on this ticket: the first version of this fix ran the
    // discard only after `load`'s fetch resolved successfully, so a flip
    // followed by a FAILED reload (offline, timeout) left the stale-unit
    // digits on screen under the wrong label for as long as the network
    // stayed down — the exact bug-2 reinterpretation, reachable through a
    // door the original fix didn't cover. The discard now runs before the
    // fetch, reading only the ref and the unit this render captured, so it
    // cannot be skipped by the fetch failing.
    mockUnits = 'imperial';
    (listCheckins as jest.Mock).mockResolvedValueOnce([]);
    const { rerender } = render(<CheckinScreen />);
    await waitFor(() => expect(screen.getByTestId('checkin-weight')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('checkin-weight'), '33');
    expect(screen.getByTestId('checkin-weight').props.value).toBe('33');

    mockUnits = 'metric';
    (listCheckins as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      rerender(<CheckinScreen />);
    });

    // Discarded despite the reload failing — never left at '33' under the
    // new unit's label, which is what saving it would reinterpret as 33kg.
    await waitFor(() => expect(screen.getByTestId('checkin-weight').props.value).toBe(''));
  });

  it('on a day that already has a check-in — same behaviour, not a special case', async () => {
    // NOTE for whoever mutation-tests this file: this test is a CONSISTENCY
    // document, not an independent guard on the discard block above. Even
    // with the discard code deleted outright, the pre-existing today-exists
    // refill (which was already correct before N125) still turns "999" back
    // into "80" on its own, so this test cannot tell the discard block apart
    // from its absence. The test above ("on a day with no check-in yet") is
    // the one that actually breaks if the discard is removed or gutted —
    // mutate that code path and confirm THAT test red, not this one.
    mockUnits = 'imperial';
    const { rerender } = render(<CheckinScreen />);
    await waitFor(() => expect(screen.getByTestId('checkin-weight')).toBeTruthy());
    // 80 kg loads as 176.4 lb.
    await waitFor(() => expect(screen.getByTestId('checkin-weight').props.value).toBe('176.4'));

    fireEvent.changeText(screen.getByTestId('checkin-weight'), '999');
    expect(screen.getByTestId('checkin-weight').props.value).toBe('999');

    mockUnits = 'metric';
    await act(async () => {
      rerender(<CheckinScreen />);
    });

    // Discarded the unsaved "999" and refilled from the stored 80 kg —
    // not "999" reinterpreted as kilograms, and not left stuck at "999".
    await waitFor(() => expect(screen.getByTestId('checkin-weight').props.value).toBe('80'));
  });
});
