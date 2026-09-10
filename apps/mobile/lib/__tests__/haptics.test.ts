import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * F49/#1061 — which haptic belongs to which moment.
 *
 * The athlete, after testing F48: *"maybe we can do just 10-20% more subtle i
 * mean the vibration feedback but overall i like it."*
 *
 * iOS haptics are discrete STYLES, not a dial — `expo-haptics` has no
 * intensity parameter — so "subtler" means stepping down where a step exists.
 * This file pins where each style belongs, because the difference between an
 * acknowledgement and an alert is a judgement that should be changed
 * deliberately rather than by drift.
 */

const MOBILE = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(MOBILE, rel), 'utf8');
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('haptics: acknowledgements are soft, alerts are not', () => {
  it('a countdown STARTING and a hold BEGINNING are soft', () => {
    // Neither has to be felt from a pocket — something is about to happen and
    // the athlete is looking at the screen that says so.
    for (const rel of ['components/Countdown.tsx', 'components/HoldToConfirm.tsx']) {
      const code = codeOnly(read(rel));
      expect({ rel, soft: code.includes('ImpactFeedbackStyle.Soft') }).toEqual({ rel, soft: true });
      expect({ rel, light: code.includes('ImpactFeedbackStyle.Light') }).toEqual({
        rel,
        light: false,
      });
    }
  });

  it('a rest or a plank ENDING stays a notification', () => {
    // `Countdown.tsx` states the reason in place: "You should not have to be
    // looking at the phone to know a rest is over or a plank is done — that is
    // the entire point in a gym. The haptic covers the phone being in a
    // pocket." Softening this trades against missing the end of a rest, so it
    // is a decision the athlete makes, not a tuning pass.
    for (const rel of [
      'components/Countdown.tsx',
      'components/ClassPlanTimer.tsx',
      'app/session/[id].tsx',
    ]) {
      expect({ rel, alerts: codeOnly(read(rel)).includes('NotificationFeedbackType.Success') })
        .toEqual({ rel, alerts: true });
    }
  });

  it('the set-logging path uses the lightest thing that exists', () => {
    // `selectionAsync()` is the floor — there is nothing lighter in
    // `expo-haptics`, so the tick the athlete presses forty times a session
    // cannot be made subtler without a native Core Haptics module. Recorded
    // here so the next person asking does not go looking.
    const code = codeOnly(read('app/session/[id].tsx'));
    expect(code).toContain('Haptics.selectionAsync()');
    expect(code).not.toContain('ImpactFeedbackStyle.Heavy');
    expect(code).not.toContain('ImpactFeedbackStyle.Medium');
  });

  it('nothing in the app reaches for Heavy', () => {
    // One user action, one haptic, and never a heavy one for a UI event —
    // heavy is for something landing, and nothing in this app does.
    for (const rel of [
      'components/Countdown.tsx',
      'components/HoldToConfirm.tsx',
      'components/ClassPlanTimer.tsx',
      'components/SessionCelebration.tsx',
      'app/session/[id].tsx',
    ]) {
      expect({ rel, heavy: codeOnly(read(rel)).includes('ImpactFeedbackStyle.Heavy') }).toEqual({
        rel,
        heavy: false,
      });
    }
  });
});
