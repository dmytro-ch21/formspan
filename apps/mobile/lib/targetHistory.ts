/**
 * The record of what you have been eating to, and what correcting it costs.
 *
 * N72 gave the phone manual target entry. It wrote for today and only today, so
 * an athlete who mis-keyed a target had no way to fix the record from their
 * phone — the history, a backdated effective date and deletion all lived on a
 * laptop. That is the failure the mobile-first rule in `CLAUDE.md` was written
 * to forbid, one step on from the one that produced it: N72 made the *action*
 * reachable, and left the *correction* behind.
 *
 * Pure on purpose, same split as `manualTarget.ts`. What can be wrong here is
 * the arithmetic of spans and the consequences of a delete; none of that needs
 * a screen to be wrong in, and all of it needs to be right before anything
 * destructive is offered.
 *
 * ## The five states, and why it is not three
 *
 * A target history has a shape this codebase has now got wrong twice in one
 * day — a trend card telling an athlete with two years of data to start
 * logging, and a tracker screen telling someone with a month of history that
 * they track nothing. Both were a union with fewer kinds than reality has, and
 * in both the missing kind was *"we have not been told yet"*. `apps/web`'s own
 * targets page still has it: a failed load leaves `targets` at `[]` and it
 * renders **"No target yet. Derive one below, or type your own."** — a positive
 * claim about somebody's data, made from a request that never returned.
 *
 * So the states are enumerated rather than inferred from an array's length:
 *
 *  - `unread` — nothing has been asked yet, or the answer is still in flight.
 *  - `unavailable` — we asked and could not be told. **Not `none`.**
 *  - `none` — we asked, and this athlete has never set a target.
 *  - `complete` — rows, and we can prove there are no older ones.
 *  - `partial` — rows, but the oldest is a carry-in from before the window, so
 *    older ones may exist that this read cannot see.
 *
 * The last two are a real distinction and not defensive padding: `GET
 * /nutrition/targets` returns the rows in `[from,to]` **plus the single row
 * live at `from`**. So an oldest row dated on or after `from` proves there is
 * nothing before it — the query would have carried one in. An oldest row dated
 * *before* `from` IS that carry-in, and says nothing about what sits behind it.
 * Collapsing the two would let the screen print "3 targets" over an account
 * with thirty.
 */

import { addDays } from './history';
import type { Target, TargetSource } from './nutrition';
import type { StoredTarget } from './nutritionApi';

/**
 * What a read of the target window produced — including "it did not".
 *
 * A discriminated union rather than `Target[] | null`, which is what
 * `app/(tabs)/goals.tsx` holds. There, `null` is set both before the first
 * fetch and in the `catch`, and that is survivable because the screen renders
 * nothing about history from it. A screen that OFFERS DELETION cannot afford
 * the same ambiguity: "you have no targets" and "we could not find out" lead to
 * opposite actions.
 */
export type TargetRead =
  | { status: 'unread' }
  | { status: 'unavailable' }
  /** `from` is the window's start, and it is what makes `partial` decidable. */
  | { status: 'read'; targets: StoredTarget[]; from: string };

/** Where a row sits relative to the day being asked about. */
export type Phase = 'past' | 'live' | 'scheduled';

export type HistoryRow = {
  target: StoredTarget;
  /** First day it governs — its own `effective_on`. */
  from: string;
  /** Last day it governs, or null while it is the newest row on the books. */
  until: string | null;
  phase: Phase;
  /**
   * True only for an oldest row dated before the window started. Its numbers
   * are exact; its span reaches back further than this read can see.
   */
  carriedIn: boolean;
};

export type TargetHistory =
  | { kind: 'unread' }
  | { kind: 'unavailable' }
  | { kind: 'none' }
  | { kind: 'complete'; rows: HistoryRow[] }
  | { kind: 'partial'; rows: HistoryRow[]; from: string };

/**
 * Turn a read into rows, newest first, each knowing the span it governed.
 *
 * A target's span runs from its own date to the day before the next one — the
 * server never stores an end, because the next row IS the end. Computing it
 * here rather than in the screen is what lets "you ate to 2,400 between the 5th
 * and the 20th" be a tested sentence instead of a subtraction done in JSX.
 *
 * **`scheduled` is not hypothetical.** Accepting a weekly adjustment files the
 * new target under the server's chosen date, which is TOMORROW — deliberately,
 * because a target applied retroactively re-judges a day already mostly eaten.
 * So a future-dated row is the ordinary consequence of the feature next to this
 * one, and a history window ending today would hide the single most recent
 * thing the athlete did. That is why the caller reads forward as well as back.
 */
export function buildHistory(read: TargetRead, on: string): TargetHistory {
  if (read.status === 'unread') return { kind: 'unread' };
  if (read.status === 'unavailable') return { kind: 'unavailable' };
  if (read.targets.length === 0) return { kind: 'none' };

  // Sorted here rather than trusted from the wire. The endpoint does order by
  // `effective_on DESC`, but the span arithmetic below is silently wrong under
  // any other order — it would hand a row an `until` earlier than its own
  // `from` — and a sort is cheaper than a bug that renders as a plausible date.
  const sorted = [...read.targets].sort((a, b) => (a.effective_on < b.effective_on ? 1 : -1));

  // The newest row on or before `on` is what is in force. Found by scan rather
  // than assumed to be index 0, because index 0 may be a scheduled adjustment.
  const liveIndex = sorted.findIndex((t) => t.effective_on <= on);

  const rows: HistoryRow[] = sorted.map((target, i) => ({
    target,
    from: target.effective_on,
    // The row above ends this one, the day before it starts. Null for the
    // newest, whose span has no end yet.
    until: i === 0 ? null : addDays(sorted[i - 1].effective_on, -1),
    phase: target.effective_on > on ? 'scheduled' : i === liveIndex ? 'live' : 'past',
    carriedIn: i === sorted.length - 1 && target.effective_on < read.from,
  }));

  const oldest = rows[rows.length - 1];
  return oldest.carriedIn
    ? { kind: 'partial', rows, from: read.from }
    : { kind: 'complete', rows };
}

/** The rows a history has, or none — so a caller need not re-match the union. */
export function historyRows(h: TargetHistory): HistoryRow[] {
  return h.kind === 'complete' || h.kind === 'partial' ? h.rows : [];
}

/**
 * What deleting a row actually does to the record.
 *
 * The reviewer question this exists to answer is *can the athlete undo this?*
 * — and the honest answer is that a delete is not undoable by the server, so
 * the screen has to say what it costs BEFORE it happens and offer to put the
 * row back afterwards. Both need this.
 *
 * `then` is three kinds and the third is the point. Deleting the oldest row
 * usually leaves the span with no target at all, which is a strong sentence and
 * a true one — but only when we can see that there is nothing behind it. If the
 * oldest row was carried in, an older target may exist outside the window, and
 * claiming "you will have no target" would be the empty-vs-unknown collapse
 * relocated into a destructive confirmation.
 */
export type DeletionEffect = {
  /** First day that loses this target. */
  from: string;
  /** Last day of the affected span, or null when it is open-ended. */
  until: string | null;
  then:
    | { kind: 'earlier'; target: StoredTarget }
    | { kind: 'nothing' }
    | { kind: 'unknown' };
};

export function deletionEffect(rows: HistoryRow[], index: number): DeletionEffect | null {
  const row = rows[index];
  if (!row) return null;
  // Rows are newest-first, so the one that would take over is the NEXT index,
  // not the previous one. Getting this backwards produces a confirmation that
  // names a real target and the wrong one.
  const earlier = rows[index + 1];
  return {
    from: row.from,
    until: row.until,
    then: earlier
      ? { kind: 'earlier', target: earlier.target }
      : row.carriedIn
        ? { kind: 'unknown' }
        : { kind: 'nothing' },
  };
}

/**
 * How a target got its number, said out loud — including when nobody recorded.
 *
 * `Target.source` is optional in this app and that is not slack in the type:
 * `nutrition_targets` in the local SQLite cache has no `source` column, so a
 * target read back offline genuinely does not know how it was set. `apps/web`
 * indexes a lookup table with it unguarded and renders a bare trailing `·` for
 * the miss, which reads as a rendering fault rather than as missing provenance.
 */
export function sourceLabel(source: TargetSource | undefined): string {
  switch (source) {
    case 'derived':
      return 'Derived';
    case 'manual':
      return 'You typed it';
    case 'adjustment':
      return 'Weekly adjustment';
    default:
      return 'Source not recorded';
  }
}

/**
 * The longest span `GET /nutrition/targets` will serve, mirrored.
 *
 * The handler's rail is `daysBetween(from, to) >= 366` → 400, so 365 is the
 * largest span that is actually served and this is that number, not the
 * constant the backend names. Asking for one day more does not degrade
 * gracefully: it is an `invalid_input`, which this screen can only render as
 * `unavailable`, so the whole history would be permanently missing for
 * everybody — the kind of failure that ships because the happy path was
 * exercised with a two-row fixture and never with a real window.
 */
export const MAX_WINDOW_DAYS = 365;

/**
 * How far FORWARD the history is read.
 *
 * Not zero, and not a taste call: accepting a weekly adjustment stores a target
 * dated TOMORROW. A window ending today would omit it, and the screen would
 * then be missing precisely the row an athlete is most likely to have just got
 * wrong. Generous rather than exactly 1, because `apps/web`'s manual form puts
 * no upper bound on its date field at all — so a target dated weeks ahead is
 * reachable today from a laptop, and anything reachable from a laptop has to be
 * correctable here or this ticket is only half closed.
 */
export const SCHEDULE_DAYS = 30;

/**
 * How far back a target may be filed — the read window, and deliberately so.
 *
 * **A target written outside the window this screen reads is a target the
 * athlete can never see or correct again**, which is this ticket's own defect
 * recreated by the fix for it. So the backdating floor is not a judgement about
 * how far back is reasonable; it is derived from what the list can show, and
 * {@link canBackdateTo} reads it from {@link historyWindow} rather than from a
 * second constant that could drift.
 *
 * The forward days come OUT of the backward allowance rather than on top of it,
 * because the two together have to stay inside {@link MAX_WINDOW_DAYS}.
 */
export const BACKDATE_DAYS = MAX_WINDOW_DAYS - SCHEDULE_DAYS;

/** The window to ask for. Exactly {@link MAX_WINDOW_DAYS} wide, by construction. */
export function historyWindow(on: string): { from: string; to: string } {
  return { from: addDays(on, -BACKDATE_DAYS), to: addDays(on, SCHEDULE_DAYS) };
}

/**
 * Whether a day may be chosen as an effective date.
 *
 * Two bounds, and they are not symmetric. The floor is the read window, for the
 * reason on {@link BACKDATE_DAYS}. The ceiling is TODAY — the phone does not
 * offer forward-dating by hand, because the one thing that legitimately writes
 * a future target is the weekly adjustment, which picks its own date from a
 * rule the athlete can read. Letting somebody hand-schedule a target for next
 * month is a decision with no surface anywhere that explains what it will do to
 * the days in between, and this screen is the correction surface, not a
 * planning one. Reading forward and writing forward are different permissions.
 *
 * **`floor` should be the window that was actually READ**, not the one this
 * function would compute. They agree except across midnight: a screen held
 * focused overnight recomputes a floor one day earlier than the list was
 * fetched with, and the oldest chip then writes a target that list can no
 * longer show — the defect this bound exists to prevent, arriving through the
 * bound itself. The default is the computed window so a caller with no read to
 * hand still gets the right answer.
 */
export function canBackdateTo(day: string, on: string, floor = historyWindow(on).from): boolean {
  return day >= floor && day <= on;
}

/**
 * The seven days a date strip shows, ending at `anchor`.
 *
 * Here rather than inline in the screen because {@link stepWeek} below is where
 * a real bug lived, and a test that reimplements the arithmetic it is checking
 * proves the arithmetic and not the screen. Same rule this repo already applies
 * to SQL: assert the behaviour, not a copy of it.
 */
export function weekStrip(anchor: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(anchor, i - 6));
}

/**
 * Move the strip a week, and CLAMP the forward step to today.
 *
 * The clamp is the whole function. The first version of the picker anchored the
 * strip on the SELECTED day and stepped forward by a bare seven, which made the
 * days just before today unreachable: choose `today-3`, the strip becomes
 * `today-9 … today-3`, and a forward step to `today+4` is refused for
 * overshooting — so `today-2`, `today-1` and today itself could not be got back
 * to without leaving the screen, which nothing said. Found in review.
 *
 * Two things fix it and both are here. The anchor is separate from the
 * selection, so paging never depends on what is chosen; and the forward step
 * lands ON today rather than being refused for wanting to pass it.
 *
 * Backwards is unclamped — {@link canBackdateTo} is what stops the strip
 * walking off the start of the record, and the caller disables the control
 * rather than silently pinning it, so a dead end reads as one.
 */
export function stepWeek(anchor: string, on: string, direction: 'back' | 'forward'): string {
  if (direction === 'back') return addDays(anchor, -7);
  const forward = addDays(anchor, 7);
  return forward > on ? on : forward;
}

/** Whether the strip has anywhere left to go in that direction. */
export function canStepWeek(
  anchor: string,
  on: string,
  direction: 'back' | 'forward',
  floor = historyWindow(on).from,
): boolean {
  // Forward is "not already at today", never "a whole week fits" — gating on a
  // whole week is precisely what stranded the last few days.
  if (direction === 'forward') return anchor < on;
  // Backward is "the newest day of the previous week is still choosable", so
  // the control dies exactly when the strip runs out of writable days rather
  // than a week early or a week late.
  return canBackdateTo(stepWeek(anchor, on, 'back'), on, floor);
}

/**
 * What typing over a row costs it, beyond its numbers.
 *
 * Saving a target sets `source` and `basis` from the request, so an edit always
 * makes the row a manual one. That is correct — the arithmetic no longer
 * produced the number, and keeping a derivation attached to a figure it did not
 * produce would be a lie with a full audit trail behind it — but it is
 * surprising enough to say before the form opens rather than after the save.
 *
 * Three kinds rather than a boolean, and the third is why. A `derived` row
 * carries a stored `basis`, and editing genuinely destroys something the
 * athlete could read. An `adjustment` row has `basis: null` already, so nothing
 * is destroyed — only the label changes — and warning about a lost explanation
 * there would be a false alarm about a row that never had one. A boolean would
 * have merged those two into whichever sentence was written first.
 */
export type EditCost = 'none' | 'label_only' | 'loses_derivation';

export function editCost(target: Target): EditCost {
  if (target.source === 'derived') return 'loses_derivation';
  if (target.source === 'adjustment') return 'label_only';
  // `manual` is already manual, and an unrecorded source is not something to
  // claim a consequence about — see `sourceLabel`.
  return 'none';
}
