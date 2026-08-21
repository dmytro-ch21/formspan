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
  deletionEffect,
  editCost,
  historyRows,
  historyWindow,
  sourceLabel,
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
