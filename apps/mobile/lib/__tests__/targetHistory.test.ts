/**
 * The target record, and what correcting it costs.
 *
 * Every vector here is chosen so that a plausible WRONG implementation fails
 * it. That is not a style note — the guard this suite was written alongside
 * survived its own mutation on the first attempt because every fixture had the
 * same shape, and a guard is only exercised by the input it is meant to reject.
 * So: the spans are asymmetric, the rows are deliberately handed to
 * `buildHistory` out of order, `deletionEffect` is asked about the middle of a
 * list rather than only its ends, and the `unknown` branch has a vector that
 * differs from the `nothing` branch by ONE field.
 */

import { addDays } from '../history';
import type { Target } from '../nutrition';
import {
  BACKDATE_DAYS,
  MAX_WINDOW_DAYS,
  SCHEDULE_DAYS,
  buildHistory,
  canBackdateTo,
  canStepWeek,
  deletionEffect,
  editCost,
  historyRows,
  historyWindow,
  sourceLabel,
  stepWeek,
  weekStrip,
  type TargetRead,
} from '../targetHistory';

const ON = '2026-08-21';

function target(effective_on: string, kcal: number, source?: Target['source']): Target {
  return { effective_on, kcal, protein_g: 180, carb_g: 250, fat_g: 70, fibre_g: 30, source };
}

/** A read that succeeded, with the window this screen actually asks for. */
function read(targets: Target[], from = historyWindow(ON).from): TargetRead {
  return { status: 'read', targets, from };
}

describe('buildHistory — the five states', () => {
  it('keeps "not asked yet" distinct from "nothing there"', () => {
    expect(buildHistory({ status: 'unread' }, ON).kind).toBe('unread');
    expect(buildHistory(read([]), ON).kind).toBe('none');
  });

  it('reports a failed read as unavailable and NEVER as none', () => {
    // The whole point of the union. `apps/web`'s targets page collapses these
    // two — a failed load leaves its array empty and it renders "No target
    // yet", a positive claim about somebody's data from a request that never
    // returned. A `kind` of 'none' here would be that bug, ported.
    const h = buildHistory({ status: 'unavailable' }, ON);
    expect(h.kind).toBe('unavailable');
    expect(h.kind).not.toBe('none');
    expect(historyRows(h)).toEqual([]);
  });

  it('N94: carries the caller\'s composed diagnosis through unavailable, rather than discarding it', () => {
    // The screen composes `transportDiagnosis(err)` in its catch and hands it
    // here — `buildHistory` must pass it through unchanged, not fold it away.
    // Losing this field is exactly the regression that made every failed read
    // assert "this one needs a connection" for a server 500 as readily as for
    // a dead radio.
    const withDiagnosis = buildHistory(
      { status: 'unavailable', diagnosis: "Can't reach VOLA." },
      ON,
    );
    expect(withDiagnosis.kind).toBe('unavailable');
    expect('diagnosis' in withDiagnosis && withDiagnosis.diagnosis).toBe("Can't reach VOLA.");

    // A server-answered ApiError composes to `null` (see `transportDiagnosis`),
    // and that null must survive the passthrough too — it is the screen's own
    // signal to fall back to neutral wording rather than inventing a network
    // sentence for a failure that was never about the network.
    const serverAnswered = buildHistory({ status: 'unavailable', diagnosis: null }, ON);
    expect('diagnosis' in serverAnswered && serverAnswered.diagnosis).toBeNull();

    // And the field is genuinely optional — a read that never supplies one
    // (the pre-N94 shape) still builds cleanly, so this stays backward
    // compatible with any other caller of the union.
    const noDiagnosis = buildHistory({ status: 'unavailable' }, ON);
    expect('diagnosis' in noDiagnosis && noDiagnosis.diagnosis).toBeUndefined();
  });

  it('calls a history complete only when it can prove nothing precedes it', () => {
    // The oldest row starts INSIDE the window. The endpoint carries in the row
    // live at `from` when there is one, so its absence is proof there is none.
    const from = historyWindow(ON).from;
    const h = buildHistory(read([target(addDays(from, 5), 2400)]), from);
    expect(h.kind).toBe('complete');
  });

  it('calls it partial when the oldest row was carried in from before the window', () => {
    // ONE day earlier than the vector above, and that single day is the whole
    // difference between "this is your history" and "this is the last year of
    // it". A `>=` slipped to `>` inverts both.
    const from = historyWindow(ON).from;
    const h = buildHistory(read([target(addDays(from, -1), 2400)]), from);
    expect(h.kind).toBe('partial');
    expect(historyRows(h)).toHaveLength(1);
  });

  it('does not mark a NEWER row carried-in just because an older one is missing', () => {
    // Only the oldest row can be the carry-in. A carriedIn computed per-row
    // from `effective_on < from` alone would be true for nothing here, but a
    // version that dropped the index check would still pass a single-row
    // fixture — so this one has two, both before `from`.
    const from = historyWindow(ON).from;
    const h = buildHistory(read([target(addDays(from, -2), 2400), target(addDays(from, -9), 2200)]), from);
    const rows = historyRows(h);
    expect(rows.map((r) => r.carriedIn)).toEqual([false, true]);
  });
});

describe('buildHistory — spans', () => {
  // Deliberately UNEVEN gaps and deliberately out of order on the way in. An
  // implementation that trusted the wire order would pass an already-sorted
  // fixture; one that hard-coded a fixed span would pass evenly spaced dates.
  const rows = historyRows(
    buildHistory(
      read([
        target('2026-07-02', 2200, 'derived'),
        target('2026-08-18', 2350, 'manual'),
        target('2026-03-11', 2500, 'derived'),
      ]),
      ON,
    ),
  );

  it('orders newest first regardless of the order it was handed', () => {
    expect(rows.map((r) => r.from)).toEqual(['2026-08-18', '2026-07-02', '2026-03-11']);
  });

  it('ends each span the day BEFORE the next target starts', () => {
    // Off by one in either direction produces a plausible date, which is why
    // this is asserted rather than eyeballed: a row ending on 2026-08-18 would
    // claim two targets governed the same day.
    expect(rows[1].until).toBe('2026-08-17');
    expect(rows[2].until).toBe('2026-07-01');
  });

  it('leaves the newest span open-ended rather than ending it today', () => {
    expect(rows[0].until).toBeNull();
  });

  it('marks the newest row on or before today as the live one', () => {
    expect(rows.map((r) => r.phase)).toEqual(['live', 'past', 'past']);
  });
});

describe('buildHistory — a target dated in the future', () => {
  // Not hypothetical: accepting the weekly adjustment stores a target dated
  // TOMORROW. If this row were treated as live, the screen would say the
  // athlete is already eating to a number that starts tomorrow.
  const rows = historyRows(
    buildHistory(read([target(addDays(ON, 1), 2300, 'adjustment'), target('2026-08-01', 2500)]), ON),
  );

  it('is scheduled, not live', () => {
    expect(rows.map((r) => r.phase)).toEqual(['scheduled', 'live']);
  });

  it('still ends the live span the day before it starts', () => {
    expect(rows[1].until).toBe(ON);
  });

  it('finds the live row by scanning rather than taking index 0', () => {
    // Two scheduled rows, so "index 0 is live" and "index 1 is live" are both
    // wrong and distinguishable.
    const r = historyRows(
      buildHistory(
        read([target(addDays(ON, 5), 2100), target(addDays(ON, 2), 2200), target('2026-08-01', 2500)]),
        ON,
      ),
    );
    expect(r.map((x) => x.phase)).toEqual(['scheduled', 'scheduled', 'live']);
  });
});

describe('deletionEffect', () => {
  const rows = historyRows(
    buildHistory(read([target('2026-08-18', 2350), target('2026-07-02', 2200), target('2026-03-11', 2500)]), ON),
  );

  it('names the EARLIER target that takes over, not the later one', () => {
    // Rows are newest-first, so the row that takes over is at index+1. Reading
    // index-1 instead names a real target and the wrong one — a confirmation
    // that is confidently, plausibly false.
    const e = deletionEffect(rows, 0)!;
    expect(e.then).toEqual({ kind: 'earlier', target: rows[1].target });
    expect(e.from).toBe('2026-08-18');
  });

  it('works in the MIDDLE of a list, not only at its ends', () => {
    const e = deletionEffect(rows, 1)!;
    expect(e.from).toBe('2026-07-02');
    expect(e.until).toBe('2026-08-17');
    expect(e.then).toEqual({ kind: 'earlier', target: rows[2].target });
  });

  it('says "nothing" only when it can see there is nothing behind it', () => {
    const e = deletionEffect(rows, 2)!;
    expect(e.then).toEqual({ kind: 'nothing' });
  });

  it('says "unknown" instead when the oldest row was carried in', () => {
    // This fixture differs from the one above by the oldest row's DATE alone —
    // moved outside the window so it is the carry-in. Everything else is held
    // constant, so a `then` that ignored `carriedIn` passes the test above and
    // fails only here.
    const from = historyWindow(ON).from;
    const carried = historyRows(
      buildHistory(read([target('2026-08-18', 2350), target(addDays(from, -1), 2500)]), from),
    );
    expect(deletionEffect(carried, 1)!.then).toEqual({ kind: 'unknown' });
  });

  it('returns null for a row that is not there rather than inventing an effect', () => {
    expect(deletionEffect(rows, 3)).toBeNull();
    expect(deletionEffect([], 0)).toBeNull();
  });
});

describe('the window', () => {
  it('stays inside what the endpoint will actually serve', () => {
    // The handler refuses `daysBetween(from, to) >= 366`. A window one day too
    // wide is a 400, which this screen can only render as `unavailable` — the
    // history would be permanently missing for everybody, and no fixture-based
    // test of `buildHistory` would ever notice.
    const w = historyWindow(ON);
    const span = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;
    expect(span).toBe(MAX_WINDOW_DAYS);
    expect(span).toBeLessThan(366);
  });

  it('reads forward far enough to include a target the adjustment scheduled', () => {
    expect(SCHEDULE_DAYS).toBeGreaterThanOrEqual(1);
    expect(historyWindow(ON).to > addDays(ON, 1)).toBe(true);
  });

  it('spends its forward days out of the backward allowance', () => {
    expect(BACKDATE_DAYS + SCHEDULE_DAYS).toBe(MAX_WINDOW_DAYS);
  });
});

describe('canBackdateTo', () => {
  it('allows today and yesterday', () => {
    expect(canBackdateTo(ON, ON)).toBe(true);
    expect(canBackdateTo(addDays(ON, -1), ON)).toBe(true);
  });

  it('refuses tomorrow — reading forward and writing forward are different', () => {
    expect(canBackdateTo(addDays(ON, 1), ON)).toBe(false);
  });

  it('allows the very first day the list can show, and refuses the one before it', () => {
    // The bound IS the read window, because a target written outside it is one
    // the athlete can never see or correct again — this ticket's own defect,
    // recreated by the fix for it. Both sides asserted so an off-by-one in
    // either direction fails.
    const first = historyWindow(ON).from;
    expect(canBackdateTo(first, ON)).toBe(true);
    expect(canBackdateTo(addDays(first, -1), ON)).toBe(false);
  });

  it('honours a floor from the read that DISAGREES with the computed one', () => {
    // The midnight case, in the direction that actually loses data.
    //
    // `on` is re-read on FOCUS, so a screen held open across midnight keeps
    // yesterday's `on` — while a reload after a write refetches with the real
    // today, so `read.from` moves forward and `on` does not. The screen's
    // oldest chip is then a day the list it is looking at can no longer show,
    // and a target saved there becomes invisible: this ticket's own defect,
    // arriving through the bound meant to prevent it.
    const stale = ON; // what the screen still thinks today is
    const refetched = historyWindow(addDays(ON, 1)).from; // what the reload asked for
    const computed = historyWindow(stale).from;
    // The vector is only meaningful if the two genuinely differ — asserted, so
    // this cannot quietly become a test of one value against itself.
    expect(refetched > computed).toBe(true);

    // Left to compute its own floor, it allows a day the list cannot show.
    expect(canBackdateTo(computed, stale)).toBe(true);
    // Handed the floor that was actually read, it refuses it.
    expect(canBackdateTo(computed, stale, refetched)).toBe(false);
    // …and still allows the true edge of what the list holds.
    expect(canBackdateTo(refetched, stale, refetched)).toBe(true);
  });

  it('still refuses tomorrow however low the floor is dropped', () => {
    // The ceiling is not the floor's business. A `floor` threaded through a
    // single combined comparison could relax both ends at once.
    expect(canBackdateTo(addDays(ON, 1), ON, addDays(ON, -3650))).toBe(false);
  });
});

describe('the week strip can always reach today again', () => {
  /**
   * The strip is the seven days ENDING at an anchor, and the anchor steps by a
   * week — clamped to today rather than refused for overshooting it.
   *
   * The first version anchored on the SELECTION, which made forward travel
   * impossible: choosing `today-3` slid the strip to `today-9..today-3`, the
   * forward arrow disabled because `today+4` is not backdatable, and the last
   * three days became unreachable with no way back except leaving the screen.
   * This is that fault in one assertion — walk back a few weeks, then walk
   * forward, and today must be on the strip again.
   */
  // The REAL functions, not a copy of their arithmetic. A test that
  // reimplements what it is checking proves the maths and says nothing about
  // the screen — the same reason SQL behaviour here belongs in a fixture rather
  // than a regex over the query string.
  const step = (anchor: string) => stepWeek(anchor, ON, 'forward');
  const week = weekStrip;

  it('returns to today from any anchor, and lands ON it rather than past it', () => {
    for (const back of [1, 2, 3, 9, 40]) {
      let anchor = addDays(ON, -7 * back);
      // The loop bound is the guard against a step that does not advance.
      for (let i = 0; i < back + 2 && anchor < ON; i++) anchor = step(anchor);
      expect(anchor).toBe(ON);
      expect(week(anchor)).toContain(ON);
    }
  });

  it('reaches a day three back from today without stranding the ones after it', () => {
    // The exact reported vector: an anchor that is NOT a whole week from today.
    const stranded = addDays(ON, -3);
    expect(step(stranded)).toBe(ON);
    expect(week(step(stranded))).toEqual(
      expect.arrayContaining([addDays(ON, -2), addDays(ON, -1), ON]),
    );
  });

  it('never puts a future day on the strip', () => {
    for (const anchor of [ON, addDays(ON, -1), addDays(ON, -6)]) {
      expect(week(anchor).every((d) => d <= ON)).toBe(true);
    }
  });

  it('offers the forward control whenever the anchor is behind today, and not once it is on it', () => {
    // The disabled state is what made the dead end silent, so it is asserted
    // separately from the step. A control gated on "a whole week fits" reports
    // false for every one of the first three.
    expect(canStepWeek(addDays(ON, -1), ON, 'forward')).toBe(true);
    expect(canStepWeek(addDays(ON, -3), ON, 'forward')).toBe(true);
    expect(canStepWeek(addDays(ON, -6), ON, 'forward')).toBe(true);
    expect(canStepWeek(ON, ON, 'forward')).toBe(false);
  });

  it('stops offering the backward control at the edge of what can be written', () => {
    const floor = historyWindow(ON).from;
    // An anchor whose previous week's newest day is exactly the floor: still
    // offered. One day earlier: refused. Both sides, so an off-by-one either
    // way fails.
    expect(canStepWeek(addDays(floor, 7), ON, 'back')).toBe(true);
    expect(canStepWeek(addDays(floor, 6), ON, 'back')).toBe(false);
  });
});

describe('sourceLabel', () => {
  it('names each of the three real sources distinctly', () => {
    const labels = [sourceLabel('derived'), sourceLabel('manual'), sourceLabel('adjustment')];
    expect(new Set(labels).size).toBe(3);
    expect(labels.every((l) => l.length > 0)).toBe(true);
  });

  it('says the source was not recorded rather than guessing one', () => {
    // `Target.source` is optional because the offline SQLite cache has no such
    // column. `apps/web` indexes its lookup table unguarded and renders a bare
    // trailing separator for the miss.
    expect(sourceLabel(undefined)).toMatch(/not recorded/i);
    expect(sourceLabel(undefined)).not.toBe(sourceLabel('derived'));
  });
});

describe('editCost', () => {
  it('warns that a derived row loses its stored derivation', () => {
    expect(editCost(target(ON, 2400, 'derived'))).toBe('loses_derivation');
  });

  it('does not claim an adjustment row loses an explanation it never stored', () => {
    // An adjustment is saved with `basis: null`, so there is nothing to
    // destroy — only the label changes. A boolean would have merged this with
    // the case above and raised a false alarm.
    expect(editCost(target(ON, 2400, 'adjustment'))).toBe('label_only');
  });

  it('says nothing about a manual row, or one whose source was never recorded', () => {
    expect(editCost(target(ON, 2400, 'manual'))).toBe('none');
    expect(editCost(target(ON, 2400, undefined))).toBe('none');
  });
});
