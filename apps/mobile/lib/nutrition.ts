/**
 * What the athlete ate, and what is left.
 *
 * Pure arithmetic and no React, so every rule below is testable without a
 * renderer — the same split `anthropometry.ts` holds for the check-in card.
 *
 * ## The two numbers this file exists to produce
 *
 * **Remaining calories and remaining protein.** Not consumed. A consumed figure
 * is a report; a remaining figure is what changes what you order at dinner, and
 * `docs/decisions/today-view-design.md` §2.4 calls protein-left-today probably
 * the single most behaviour-changing number on the screen.
 *
 * ## What is deliberately NOT here
 *
 * **Nothing adds training back into the target.** The target already includes a
 * 28-day training average, the phase's rate band already assumes a training
 * week, and a target that moved with yesterday's session would make
 * `weeklyRate` unreadable — you could no longer tell a bad week of eating from
 * a moved goalpost. A session appears on the day screen as a row that is
 * STATED, NOT SPENT, and `remaining` below is invariant under it. There is a
 * test asserting exactly that, because it is a one-line change away at any
 * point and nothing else would catch it.
 *
 * **No per-meal allocation.** "536 calories now available for breakfast"
 * requires knowing a day the app cannot see; it is wrong the moment you eat a
 * big lunch, and it manufactures four budgets to fail against instead of one
 * honest running total. Slots group the day — they are how people remember food
 * — and that is all they do.
 */

import { dayString } from './calendar';

/** The slot vocabulary, in DAY order. The server sends this too; see below. */
export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type Meal = (typeof MEALS)[number];

export type Macros = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  /** Null is "not stated", never zero — see the server's own note. */
  fibre_g: number | null;
};

export type Entry = Macros & {
  id: string;
  eaten_on: string;
  meal: Meal;
  name: string;
  servings: number;
  serving_label: string;
  source_food_id: string | null;
  notes: string;
};

export type Food = Macros & {
  id: string;
  kind: 'food' | 'recipe';
  name: string;
  brand: string;
  serving_label: string;
  serving_grams: number | null;
};

export type Target = {
  effective_on: string;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
};

/**
 * Sum a day.
 *
 * Fibre sums only if at least one entry states it, so a day nobody recorded
 * fibre for reports null rather than a confident zero. Every other macro is
 * genuinely zero when nothing was eaten.
 */
export function dayTotals(entries: Entry[]): Macros {
  const out: Macros = { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fibre_g: null };
  let fibre = 0;
  let anyFibre = false;
  for (const e of entries) {
    out.kcal += e.kcal;
    out.protein_g += e.protein_g;
    out.carb_g += e.carb_g;
    out.fat_g += e.fat_g;
    if (e.fibre_g != null) {
      fibre += e.fibre_g;
      anyFibre = true;
    }
  }
  if (anyFibre) out.fibre_g = fibre;
  return out;
}

/**
 * What this device knows about the day's target.
 *
 * A union rather than `Target | null` plus a `loaded` boolean, because the
 * fourth state is the one that matters and a pair of booleans lets it collapse
 * silently. The target is the ONE number the phone cannot compute — it needs
 * training history the device does not hold — so a failed fetch is a real and
 * ordinary outcome, and "I could not check" must never render as "you have not
 * set one". The second is an instruction to go and do homework the athlete may
 * already have done on web.
 *
 * - `checking` — the first read has not settled.
 * - `unknown` — no cached target and this device has never successfully asked.
 * - `none` — the server has answered, and no target covers this day.
 * - `set` — a target, from the server or from the cache.
 */
export type TargetView =
  | { state: 'checking' }
  | { state: 'unknown' }
  | { state: 'none' }
  | { state: 'set'; target: Target };

/** The target in a view, or null in every state that has none. */
export function viewTarget(view: TargetView): Target | null {
  return view.state === 'set' ? view.target : null;
}

export type Remaining = {
  kcal: number;
  protein_g: number;
  /** True once the day is over its calorie target. */
  over: boolean;
};

/**
 * What is left of the day.
 *
 * Returns null with no target — and that is a first-class state, not a
 * degenerate one. Logging without a target is legitimate: it shows eaten totals
 * and no remaining, which is what stops the feature being gated behind
 * homework. A zero here would read as "you have nothing left", which is the
 * opposite of the truth.
 *
 * `kcal` goes NEGATIVE past the target rather than clamping at zero, because
 * "240 over" is the honest figure and the caller renders it in muted text
 * rather than as an error.
 */
export function remaining(totals: Macros, target: Target | null): Remaining | null {
  if (!target) return null;
  const kcal = target.kcal - totals.kcal;
  return {
    kcal,
    protein_g: target.protein_g - totals.protein_g,
    over: kcal < 0,
  };
}

/**
 * The Atwater sum, offered only as a HINT while somebody types a new food.
 *
 * Never used to correct a stated kcal. Real labels do not reconcile — rounding,
 * fibre, sugar alcohols and Atwater's own approximations put them 5-10% apart
 * routinely — so the packet's number wins and this one fills the field in when
 * the packet does not state it.
 */
export function atwater(m: Pick<Macros, 'protein_g' | 'carb_g' | 'fat_g'>): number {
  return m.protein_g * 4 + m.carb_g * 4 + m.fat_g * 9;
}

/** How far a stated kcal may sit from the Atwater sum before it is worth a nudge. */
export const ATWATER_TOLERANCE = 0.1;

/**
 * Whether a typed kcal is far enough from its macros to be worth mentioning.
 *
 * A nudge, never a block: the athlete is copying a label and the label is
 * right. Silent below the tolerance, because flagging every ordinary rounding
 * difference teaches people to ignore the one that matters.
 */
export function kcalLooksOff(stated: number, m: Pick<Macros, 'protein_g' | 'carb_g' | 'fat_g'>): boolean {
  const sum = atwater(m);
  if (sum <= 0 || stated <= 0) return false;
  return Math.abs(stated - sum) / sum > ATWATER_TOLERANCE;
}

/**
 * Which slot a log belongs to, from the wall clock.
 *
 * Assigned once, at log time, and then STORED. Never re-derived on read: a
 * dinner logged at 23:00 is dinner, and a rule that recomputed it from the
 * timestamp would quietly move it to "snack" the next time anybody opened the
 * day.
 *
 * Takes the Date rather than reading a clock, so a test can assert 23:00
 * without waiting for it.
 */
export function slotForClock(at: Date): Meal {
  const h = at.getHours();
  if (h < 11) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

/** Entries grouped by slot, in day order, including slots with nothing in them. */
export function bySlot(entries: Entry[]): { meal: Meal; entries: Entry[]; kcal: number }[] {
  return MEALS.map((meal) => {
    const mine = entries.filter((e) => e.meal === meal);
    return { meal, entries: mine, kcal: mine.reduce((n, e) => n + e.kcal, 0) };
  });
}

/**
 * How recently a food was used still counts for this many days.
 *
 * Thirty, because a food you ate once last month is worse evidence than one you
 * ate twice this week, and beyond a month the difference stops meaning
 * anything.
 */
export const RECENCY_HALF_LIFE_DAYS = 30;

export type Recent = {
  food: Food;
  /** Times logged into THIS slot. */
  uses: number;
  /** "YYYY-MM-DD" of the most recent use, or null if never. */
  lastUsedOn: string | null;
};

/**
 * Rank the quick-add list.
 *
 * Recency-weighted frequency, scoped to the slot being logged into: porridge
 * ranks first at breakfast and nowhere at dinner, which is the difference
 * between a two-tap log and a scroll.
 *
 * Frequency alone pins whatever somebody ate most in their first fortnight to
 * the top forever; recency alone loses the staple they eat every day but not
 * today. The product of the two is what makes the first three rows usually
 * right — and the first three rows are the whole feature, because a list you
 * have to read is not faster than typing.
 *
 * `today` is a parameter. No function in this file reads a clock.
 */
export function rankRecents(recents: Recent[], today: string, limit = 3): Food[] {
  return recents
    .map((r) => {
      if (r.uses <= 0) return { food: r.food, score: 0 };
      const age = r.lastUsedOn ? daysBetween(r.lastUsedOn, today) : RECENCY_HALF_LIFE_DAYS;
      // Linear decay to zero at the half-life, floored just above zero so a
      // stale-but-frequent food still outranks one used once today. It is a
      // ranking, not a measurement; an exponential here would be false rigour.
      const recency = Math.max(0.05, 1 - Math.max(0, age) / RECENCY_HALF_LIFE_DAYS);
      return { food: r.food, score: r.uses * recency };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name))
    .slice(0, limit)
    .map((r) => r.food);
}

/** Whole days from a to b, positive when b is later. Both "YYYY-MM-DD". */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  // UTC on both sides so the subtraction cannot straddle a DST boundary and
  // come back as 0.958 of a day.
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86_400_000);
}

/** Today, in the athlete's own calendar. The one place this module reads a clock. */
export function todayString(): string {
  return dayString(new Date());
}

/**
 * Scale a saved food to a number of servings.
 *
 * The CLIENT multiplies and sends absolute macros; the server never scales and
 * never parses `serving_label`. That is what keeps the label a human string
 * ("1 scoop (30 g)") instead of something with a grammar.
 */
export function scale(food: Food, servings: number): Macros {
  return {
    kcal: round1(food.kcal * servings),
    protein_g: round1(food.protein_g * servings),
    carb_g: round1(food.carb_g * servings),
    fat_g: round1(food.fat_g * servings),
    fibre_g: food.fibre_g == null ? null : round1(food.fibre_g * servings),
  };
}

/**
 * Restate a logged entry at a different number of servings.
 *
 * Rescales from the entry's OWN per-serving figures, never from what is
 * currently displayed: scaling the shown numbers compounds their rounding every
 * time the stepper moves. Dividing back out of the stored absolutes instead
 * bounds the error at ONE rounding step whatever route the stepper took —
 * measured: 355 kcal at two servings goes 266.3 at 1.5 and comes back 355.1,
 * not 355. A tenth of a kilocalorie, once, rather than a drift that grows.
 *
 * A zero or negative `servings` on the stored entry cannot be divided by, so it
 * is read as one serving — the row is already wrong and inventing an infinity
 * on top of it helps nobody.
 */
export function rescale(entry: Macros & { servings: number }, servings: number): Macros {
  const per = entry.servings > 0 ? entry.servings : 1;
  const f = servings / per;
  return {
    kcal: round1(entry.kcal * f),
    protein_g: round1(entry.protein_g * f),
    carb_g: round1(entry.carb_g * f),
    fat_g: round1(entry.fat_g * f),
    fibre_g: entry.fibre_g == null ? null : round1(entry.fibre_g * f),
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Where "fix your profile first" should actually send you.
 *
 * The Food target refuses to derive until it has four things, and the screen's
 * one button used to go to `/profile` — a route that **does not exist**. There
 * is `/profile/edit`; there has never been a `/profile`. So the button did
 * nothing an athlete could interpret: Expo Router lands on `+not-found`, from a
 * screen whose whole job is to explain why it cannot answer yet.
 *
 * Pointing it at `/profile/edit` would fix the crash and only half the bug,
 * because **one of the four is not on that screen**. `weight_kg` is a
 * weigh-in — it comes from a check-in, not from the profile — so an athlete
 * with a complete profile and no weigh-in would have been sent to a form with
 * nothing on it to fill in. The server can and does return that case alone
 * (`Suggest` appends each of the four independently).
 *
 * Hence a rule rather than a route. Profile fields win when both kinds are
 * missing: you have to go there anyway, and the weigh-in is one tap from Today
 * afterwards — whereas the reverse order strands you a second time.
 *
 * Returns `null` when nothing is missing — and also when the server names ONLY
 * fields this build does not know, because then there is no screen we can
 * honestly send anyone to. The caller renders the explanation either way and
 * the button only when there is one; a button that fixes nothing is worse than
 * no button beside a sentence that at least names what is wrong.
 */
export type ProfileGap = {
  /**
   * WHICH screen, not the path to it.
   *
   * Deliberately not an href. Returning a string would force the call site to
   * cast it into `Href`, and that cast is the exact type-checking that catches
   * a route which does not exist — the check this whole function exists
   * because nothing performed. The literals stay in the screen, where Expo
   * Router's generated types can see them.
   */
  kind: 'profile' | 'weigh-in';
  /** The button's words, which have to match where it goes. */
  label: string;
};

/** The three the profile form actually edits — see `app/profile/edit.tsx`. */
const PROFILE_FIELDS = ['height_cm', 'date_of_birth', 'sex'];
/** The fourth thing a target waits on, and the one that is NOT on that form. */
const MISSING_WEIGHT = 'weight_kg';

export function profileGap(missing: string[]): ProfileGap | null {
  if (missing.some((f) => PROFILE_FIELDS.includes(f))) {
    return { kind: 'profile', label: 'Open profile' };
  }
  if (missing.includes(MISSING_WEIGHT)) {
    // The weigh-in is outstanding, and that is a check-in, not the profile.
    return { kind: 'weigh-in', label: 'Record a weigh-in' };
  }
  // Nothing missing, or nothing we recognise. Raised in review: routing an
  // unknown field to the check-in is the same silent mis-send as routing it to
  // the profile — the athlete records a weigh-in that fixes nothing and is
  // stranded with no idea why. Server vocabulary can lead the app.
  return null;
}
