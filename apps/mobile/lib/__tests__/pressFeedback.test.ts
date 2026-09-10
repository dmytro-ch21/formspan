import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { PRESS_MS, PRESS_OPACITY, PRESS_RETENTION, PRESS_SCALE } from '@/constants/Motion';

/**
 * F38/#1037 — a finger that lands gets an answer, and the app agrees with
 * itself about what that answer is.
 *
 * 411 of 493 pressables had no press state at all, and the 82 that responded
 * disagreed across four opacity values in the press band. There is no hover
 * on a phone: press IS the feedback channel.
 *
 * These are source-level assertions because none of it is reachable from a
 * logic test — `apps/mobile/lib/__tests__` is deliberately not component
 * tests, and how a press FEELS cannot be tested at all (the ticket carries
 * three device criteria for that). What can be pinned is the contract: the
 * primitive's numbers, the retention offset nobody remembers per site, and
 * the absence of the drift this consolidates.
 */

const MOBILE = join(__dirname, '..', '..');
const BUTTON = readFileSync(join(MOBILE, 'components/ui/Button.tsx'), 'utf8');
const TRACKER = readFileSync(join(MOBILE, 'components/TrackerCard.tsx'), 'utf8');

/**
 * Source with comments removed.
 *
 * Every absence assertion below uses this, and the reason is a trap this repo
 * keeps walking into: a well-commented fix DOCUMENTS the thing it removed, so
 * `expect(src).not.toContain('friction: 7')` fails on the comment explaining
 * why `friction: 7` is gone. W22 hit it, W23's first draft hit it, and this
 * file hit it twice. "This code is absent" is the claim; comments are not
 * code, so they should not be able to falsify it.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '.expo') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('the press-feedback numbers', () => {
  it('are the band a control tapped forty times a session can afford', () => {
    // The frequency gate allows press feedback only as near-imperceptible:
    // under 150ms, and small enough not to read as its own event.
    expect(PRESS_MS).toBeLessThanOrEqual(150);
    expect(PRESS_MS).toBeGreaterThanOrEqual(100);
    expect(PRESS_SCALE).toBeGreaterThanOrEqual(0.95);
    expect(PRESS_SCALE).toBeLessThan(1);
  });
});

describe('the shared Button primitive', () => {
  it('scales on press rather than only dimming', () => {
    // Scale takes the label and icon with it, which is what makes a control
    // read as a physical thing rather than a rectangle that dimmed.
    expect(BUTTON).toMatch(/pressed: \{ transform: \[\{ scale: PRESS_SCALE \}\] \}/);
  });

  it('animates the release only — the press itself is instant', () => {
    // The transition sits on the RESTING style. Declared on `pressed` it
    // would animate the way IN too, and 120ms of wondering whether the tap
    // registered is the exact latency this ticket exists to remove.
    const transition = BUTTON.match(/const pressTransition[\s\S]*?\};/);
    expect(transition).not.toBeNull();
    expect(transition![0]).toContain('transitionProperty');
    expect(transition![0]).toContain('scale: 1');
  });

  it('only ever transitions a free property', () => {
    // transform and opacity are the two that skip layout. Anything else here
    // re-runs Yoga on every frame of every press.
    expect(BUTTON).toMatch(/transitionProperty: 'transform'/);
  });

  it('carries the retention offset so no call site has to remember it', () => {
    expect(BUTTON).toMatch(/pressRetentionOffset=\{PRESS_RETENTION\}/);
    expect(PRESS_RETENTION).toBeGreaterThan(0);
  });
});

describe('the tracker glyph', () => {
  it('never grows from nothing', () => {
    // `scaleY: t` bound raw starts at zero. Nothing in the real world appears
    // from nothing, and at four taps a second the first frame is the only one
    // the athlete sees.
    expect(TRACKER).toMatch(/outputRange: \[0\.9, 1\]/);
    expect(codeOnly(TRACKER)).not.toMatch(/transform: \[\{ scaleY: t \}\]/);
  });

  it('uses a timing curve, not a bouncy spring', () => {
    // A spring is right when a finger carried velocity in. A boolean flipping
    // has none, and `friction: 7` overshoots into the next tap.
    // `friction:` as a WORD still appears — in the comment explaining why it
    // was removed. An absence check on a file that documents its own history
    // fails for the one reason that is not a defect (the same trap W22 hit).
    // So the assertion is about the CALL, not the word.
    const code = codeOnly(TRACKER);
    expect(code).not.toMatch(/friction:/);
    expect(code).not.toMatch(/Animated\.spring\(/);
    expect(code).toMatch(/Animated\.timing\(t,/);
  });
});

describe('one press opacity, not four', () => {
  it('leaves no in-band value hand-typed anywhere', () => {
    // 0.6 / 0.7 / 0.8 / 0.85 were 26 definitions doing one job. The low
    // outliers (0.5, 0.55) are deliberately NOT folded in: at half strength
    // they are almost certainly saying "disabled" or "de-emphasised", and
    // reclassifying them is a visual decision this ticket cannot make.
    const offenders: string[] = [];
    for (const f of tsxFiles(MOBILE)) {
      for (const m of codeOnly(readFileSync(f, 'utf8')).matchAll(
        /[A-Za-z]*[Pp]ressed: \{[^}]*opacity: (0\.[0-9]+)/g,
      )) {
        const v = Number(m[1]);
        if (v >= 0.6 && v <= 0.85) offenders.push(`${f.replace(MOBILE, '')} -> ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is one exported token', () => {
    expect(PRESS_OPACITY).toBeGreaterThanOrEqual(0.6);
    expect(PRESS_OPACITY).toBeLessThanOrEqual(0.85);
  });
});

describe('the live-session screen is out of scope, by rule', () => {
  it('has no duration, easing or Reanimated import', () => {
    // `app/session/[id].tsx` contains no animation AT ALL, and that is the
    // feature rather than an omission: a 160ms tick draw times forty sets is
    // six seconds a session spent watching, against a twenty-second
    // between-sets budget. This test exists so the next enthusiasm pass has
    // to argue with something.
    const live = codeOnly(readFileSync(join(MOBILE, 'app/session/[id].tsx'), 'utf8'));
    expect(live).not.toMatch(/react-native-reanimated/);
    expect(live).not.toMatch(/\bEasing\b/);
    // NOT a bare `duration:` check: this screen legitimately carries
    // `duration: DurationUnit` for a set measured in seconds. The rule is
    // about animation, so it is animation calls that must be absent.
    expect(live).not.toMatch(/Animated\.(timing|spring|sequence|loop)\(/);
    expect(live).not.toMatch(/withTiming|withSpring/);
  });
});
