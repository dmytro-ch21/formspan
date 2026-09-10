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

/**
 * F48/#1059 — the migration, measured rather than asserted done.
 *
 * F38 fixed the primitive and left 81 files answering a finger with nothing.
 * This does not assert "all migrated" — it is a tranche at a time, and a test
 * that can only pass at the end is a test nobody can run in the middle.
 * Instead it PINS THE COUNT, so a tranche that stalls is visible and a
 * regression that adds a bare pressable back cannot hide in the noise.
 */

/** Files whose pressables must NOT scale, and why. */
const EXEMPT: Record<string, string> = {
  'app/library.tsx':
    'two full-screen backdrops behind sheets — a backdrop that shrinks when tapped is visibly wrong',
  'components/ShareToFriend.tsx': 'sheet backdrop',
  'components/ui/OptionSelect.tsx': 'scrim behind the option list',
  'components/SessionCelebration.tsx': 'full-screen dismiss target',
};

/**
 * Feedback-less files remaining, as of the tranche that last touched this.
 *
 * Lower it when a tranche lands. It may never rise: a new bare `<Pressable>`
 * in a file that had none is exactly the regression F38 and F48 exist to end.
 */
const REMAINING = 73;

describe('the PressableScale primitive', () => {
  /**
   * The same assertions `Button` gets, on the component 346 pressables are
   * migrating onto. A mutation removing its `pressRetentionOffset` survived
   * the first cut of this file: the migration would have shipped without the
   * single fix that motivated it, and every test still passed.
   */
  const SCALE = readFileSync(join(MOBILE, 'components/ui/PressableScale.tsx'), 'utf8');

  it('carries the retention offset so no call site has to', () => {
    expect(codeOnly(SCALE)).toMatch(/pressRetentionOffset=\{/);
    expect(codeOnly(SCALE)).toMatch(/PRESS_RETENTION/);
  });

  it('reads the shared tokens rather than its own numbers', () => {
    // Two primitives with two hand-typed durations is how the four-opacity
    // drift F38 just consolidated started.
    const code = codeOnly(SCALE);
    expect(code).toMatch(/PRESS_MS/);
    expect(code).toMatch(/PRESS_SCALE/);
    expect(code).toMatch(/PRESS_BEZIER/);
    expect(code).not.toMatch(/transitionDuration: '\d/);
  });

  it('animates the release only, like Button', () => {
    const transition = codeOnly(SCALE).match(/const pressTransition[\s\S]*?\};/);
    expect(transition).not.toBeNull();
    expect(transition![0]).toContain('scale: 1');
    expect(transition![0]).toMatch(/transitionProperty: 'transform'/);
  });

  it('forwards a caller\'s own press handlers rather than swallowing them', () => {
    // It owns `onPressIn`/`onPressOut` for the scale, so a call site that also
    // needs them — a long-press, a haptic — would silently lose them.
    const code = codeOnly(SCALE);
    expect(code).toMatch(/rest\.onPressIn\?\.\(/);
    expect(code).toMatch(/rest\.onPressOut\?\.\(/);
  });
});

describe('F48 — the press-feedback migration', () => {
  function feedbackLessFiles(): string[] {
    const out: string[] = [];
    for (const f of tsxFiles(MOBILE)) {
      const src = codeOnly(readFileSync(f, 'utf8'));
      // `(?!Scale)` is load-bearing: `<PressableScale` CONTAINS `<Pressable`,
      // so a plain substring test counts every migrated file as unmigrated.
      // Caught by this guard failing at 81 when the tranche had just taken it
      // to 79 — over-reporting, which is the direction a miscount should fail
      // in.
      const bare = /<Pressable(?!Scale)\b/.test(src);
      if (!bare) continue;
      const responds =
        /\{\s*pressed\s*\}|pressed &&|PRESS_OPACITY|PRESS_SCALE|pressTransition/.test(src);
      if (!responds) out.push(f.replace(`${MOBILE}/`, ''));
    }
    return out.sort();
  }

  it('is not going backwards', () => {
    // A COUNT, not a list: naming all 79 would make this test a changelog that
    // fails on every unrelated rename. The direction is what matters.
    expect(feedbackLessFiles().length).toBeLessThanOrEqual(REMAINING);
  });

  it('has finished the food-logging path — the highest-frequency logging there is', () => {
    // Tranche two. `vola-athlete-ux` calls nutrition the highest-frequency
    // logging in the app, 3-6x a day — more often than training. 59
    // pressables across the six screens that make up describing, scanning,
    // picking and correcting a meal.
    const left = feedbackLessFiles();
    for (const f of [
      'app/food/add.tsx',
      'app/food/scan.tsx',
      'app/food/describe.tsx',
      'app/food/entry/[id].tsx',
      'components/food/IngredientPicker.tsx',
      'components/food/MealCard.tsx',
    ]) {
      expect({ f, left: left.includes(f) }).toEqual({ f, left: false });
    }
  });

  it('has finished the set-logging path — the surface touched most', () => {
    // Tranche 1: the live session and its timer, 37 pressables between them.
    // This is the screen an athlete touches twenty to forty times in a
    // session, standing up, one-handed, which is the whole argument for press
    // feedback existing at all.
    const left = feedbackLessFiles();
    expect(left).not.toContain('app/session/[id].tsx');
    expect(left).not.toContain('components/Timer.tsx');
  });

  it('leaves backdrops and scrims alone, on purpose', () => {
    // Named here so the exemption is a decision on the record rather than a
    // file somebody forgot. If one of these ever gains a scale, this fails and
    // asks why.
    for (const [file, why] of Object.entries(EXEMPT)) {
      const src = codeOnly(readFileSync(join(MOBILE, file), 'utf8'));
      expect({ file, why, scales: src.includes('PressableScale') }).toEqual({
        file,
        why,
        scales: false,
      });
    }
  });
});
