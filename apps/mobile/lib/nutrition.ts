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

/**
 * How a saved food was produced — and it is not decoration either.
 *
 * `ai` is a food saved from a draft the athlete confirmed; nobody measured it.
 * `user` is one they typed. The server's own vocabulary is wider (`seed`,
 * `usda`, `off` are written by importers), so an unrecognised value must read
 * as "something else", never be coerced into one of these two — the same rule
 * the server states about its own enum, in the direction that matters here.
 *
 * The distinction has to survive, because a model cannot reliably say which of
 * its own numbers to distrust. Fold it into `user` and nothing downstream can
 * ever weight the two differently, or find the drafted ones again to re-check.
 */
export type FoodSource = 'user' | 'ai' | (string & {});

export type Food = Macros & {
  id: string;
  kind: 'food' | 'recipe';
  name: string;
  brand: string;
  serving_label: string;
  serving_grams: number | null;
  /**
   * Optional on the TYPE because rows pulled by a build that predates N114 do
   * not carry it, and because the server treats an absent source on an update
   * as "keep what is stored" rather than as `user`. Sending `undefined` is
   * therefore the correct thing to do when a screen has no opinion, and is not
   * the same as sending `'user'`.
   */
  source?: FoodSource;
};

/**
 * Where a target's number came from, and it is not decoration.
 *
 * A derived target carries an explanation and a typed one does not, so the
 * screen has to know which it is holding before it offers to show the
 * arithmetic. Getting this wrong renders a "why this number" affordance over a
 * number that has no why.
 */
export type TargetSource = 'derived' | 'manual' | 'adjustment';

export type Target = {
  effective_on: string;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
  /**
   * **Optional because the local cache does not store it**, not because the
   * server sometimes omits it. `nutrition_targets` in `db.ts` has no `source`
   * column, so a target read back offline genuinely does not know — and
   * `undefined` is the honest answer there. Anything rendering a provenance
   * label has to handle its absence rather than defaulting to `derived`, which
   * would put an explanation next to a number that never had one.
   */
  source?: TargetSource;
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

/**
 * Which DAYS of the week carry a food entry.
 *
 * A third view union, for the same reason as the two below it and arrived at
 * the same way — by getting it wrong. N108's week strip and `LOGGING` card were
 * handed a bare `ReadonlySet<string>`, and the call site wrote
 * `foodDays ?? new Set()` twenty lines under a docstring saying *"`null` until
 * read — never an empty set, which would draw seven empty dots as though the
 * week were known and blank."* The type said one thing and the boundary did
 * another.
 *
 * **A property enforced in a type and discarded with `??` at the call site is
 * not enforced.** Making the absence unrepresentable is the only version of
 * this that holds, so the set cannot be reached without naming a state.
 *
 * `off` is distinct from `unavailable`: the nutrition module being disabled is
 * a deployment fact, not a failure, and a screen must not report "0 of 7 days
 * logged" forever to somebody who has no food log at all.
 */
export type LoggedDaysView =
  | { state: 'checking' }
  | { state: 'unavailable' }
  | { state: 'off' }
  | { state: 'ready'; days: ReadonlySet<string> };

/** The days in a view, or null in every state that has none. */
export function viewLoggedDays(view: LoggedDaysView): ReadonlySet<string> | null {
  return view.state === 'ready' ? view.days : null;
}

/**
 * What this device knows about what was EATEN.
 *
 * The mirror of {@link TargetView}, and it exists for the same reason. Entries
 * were passed around as a bare `Entry[]`, so an empty array meant three
 * different things at once — the read has not finished, the read failed, or
 * the athlete has genuinely logged nothing — and all three rendered as a zero.
 *
 * That is the failure N28's reviewer caught on web, where a failed fetch
 * printed forty-two "Nothing logged" rows under an error banner. **"Nothing
 * logged" and "we could not load it" are different statements, and an empty
 * list means both.** A zero is a claim that somebody ate nothing.
 *
 * It is also the reported N54 bug from a real device: the day total was only
 * ever rendered inside the has-a-target branch, so an athlete with no target
 * saw per-meal subtotals and no day total anywhere — a fourth way for the same
 * empty array to be misread.
 *
 * - `loading` — the read has not settled.
 * - `unavailable` — the local read failed. Rare, and it must not say "0".
 * - `ready` — a real answer, including a genuine zero with `entries: 0`.
 */
export type EatenView =
  | { state: 'loading' }
  | { state: 'unavailable' }
  /**
   * `rows` and `totals` together, with the count derived from `rows` rather
   * than stored beside it — a separate `entries: number` is a second source of
   * truth for the same fact, and this module's own package doc is about
   * exactly that class of drift.
   */
  | { state: 'ready'; rows: Entry[]; totals: Macros };

/**
 * The totals in a view, or null in every state that has none.
 *
 * Deliberately **not** a zeroed `Macros` fallback. Returning zeros here would
 * put the misreading back one level down, where every caller would inherit it
 * without being able to see it — which is precisely how the bare `Entry[]`
 * behaved.
 */
export function viewTotals(view: EatenView): Macros | null {
  return view.state === 'ready' ? view.totals : null;
}

/** An `EatenView` from rows that loaded. The one place a total is derived. */
export function eatenFrom(rows: Entry[]): EatenView {
  return { state: 'ready', rows, totals: dayTotals(rows) };
}

/**
 * One macro against its goal, for the row Today draws.
 *
 * `goal` is null when there is no target — NOT zero. A zero goal renders as
 * "12 / 0g", which reads as being over a limit nobody set, and it is the same
 * misreading `viewTotals` refuses one level up.
 */
export type MacroProgress = {
  key: 'protein_g' | 'carb_g' | 'fat_g';
  label: string;
  eaten: number;
  goal: number | null;
};

/**
 * The macro split, in the order a label lists them.
 *
 * **Deliberately three, and deliberately one row.** `nutrition-design.md` §5
 * rejects "six stacked ring-and-bar cards" as the dashboard graveyard Today's
 * design doc exists to prevent, and that objection is to the STACK. Three
 * figures on one line is a split, not a dashboard — and calories are not
 * repeated here because `RemainingBlock` already leads with them.
 *
 * N52 has since landed saturated fat, sugar, sodium, added sugar and
 * cholesterol on the entry. They are deliberately NOT here: they are label
 * detail for a single food, not a daily split an athlete steers by, and adding
 * them is how three figures becomes the six the doc refuses.
 */
export function macroSplit(totals: Macros | null, target: Target | null): MacroProgress[] {
  return [
    { key: 'protein_g', label: 'Protein', eaten: totals?.protein_g ?? 0, goal: target?.protein_g ?? null },
    { key: 'carb_g', label: 'Carbs', eaten: totals?.carb_g ?? 0, goal: target?.carb_g ?? null },
    { key: 'fat_g', label: 'Fat', eaten: totals?.fat_g ?? 0, goal: target?.fat_g ?? null },
  ];
}

/**
 * How many of the last `days` days have anything logged on them.
 *
 * **A count, not a streak, and the difference is the whole point.**
 * `nutrition-design.md` §5 rejects streaks: "a missed day becomes a loss, and a
 * streak rewards logging a fake day to save it. Against the no-shame rule." A
 * chain has a length you can lose; a count is a number that goes up and down
 * and cannot be broken, so there is nothing to protect by inventing a meal.
 *
 * It also carries N28's honesty rule by construction — the denominator travels
 * with the figure, so "5" is never shown without "of 7". `logged` counts days
 * with at least one entry; a day nobody logged is a gap, and the count says so
 * by being smaller rather than by asserting a zero.
 */
export function daysLogged(
  datesWithEntries: readonly string[],
  today: string,
  days: number,
): { logged: number; considered: number } {
  const window = new Set<string>();
  for (let i = 0; i < days; i++) window.add(addDaysISO(today, -i));
  const hit = new Set<string>();
  for (const d of datesWithEntries) if (window.has(d)) hit.add(d);
  return { logged: hit.size, considered: days };
}

/** Calendar arithmetic on `YYYY-MM-DD`, in UTC so every day is 24 hours —
 *  the same reasoning `lib/calendar.ts` and web's `history.ts` both record. */
function addDaysISO(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

/**
 * "536 kcal left today · 28g protein · 48g carbs · 13g fat", or null.
 *
 * The counter-proposal to the one thing `nutrition-design.md` §5 rejects by
 * name. Their objection is to ALLOCATING a budget per meal — "it requires
 * knowing a day the app cannot see, it is wrong the moment you eat a big lunch,
 * and it manufactures four budgets to fail against instead of one honest
 * running total". This is the DAY's remaining, computed once, shown in the
 * placement the athlete asked for. "left today" is load-bearing in that
 * sentence, and the caller is responsible for only rendering it on today.
 *
 * **Null rather than a partial line** in every state that cannot support one:
 * no target means nothing is "left", and an unread day means the eaten half is
 * unknown. A line assembled from half an answer is the failure N54 was for.
 *
 * Lives here rather than in the screen because it is a rule, and a rule in a
 * component is a rule no test can reach — the first version of it was in
 * `food.tsx` and its "tests" asserted on hand-written literals instead, so
 * deleting the function left them all green. Found in review.
 */
export function mealBudgetLine(eaten: EatenView, view: TargetView): string | null {
  const totals = viewTotals(eaten);
  const target = viewTarget(view);
  if (!totals || !target) return null;
  // Floored at zero: "−140 kcal left" is a contradiction, and `RemainingBlock`
  // already says "140 over" in its own words. Two surfaces phrasing one
  // overage differently is the drift the shared component exists to prevent.
  const left = (goal: number, eatenAmount: number) => Math.max(0, Math.round(goal - eatenAmount));
  return (
    `${left(target.kcal, totals.kcal)} kcal left today · ` +
    `${left(target.protein_g, totals.protein_g)}g protein · ` +
    `${left(target.carb_g, totals.carb_g)}g carbs · ` +
    `${left(target.fat_g, totals.fat_g)}g fat`
  );
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
