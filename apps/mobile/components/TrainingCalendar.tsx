import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { Stat, StatRow } from '@/components/ui/Stat';
import { vola } from '@/constants/Colors';
import { formatDuration } from '@/lib/history';
import { labelFor, type Module } from '@/lib/modules';
import { dayString, type PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';
import { listLocalSessions } from '@/lib/sessionStore';
import { formatVolume, type UnitSystem } from '@/lib/units';

/**
 * The training calendar: a week you can open, and a month behind it.
 *
 * Three states, cheapest first — which is the whole idea. Most openings of
 * this screen only need "what day is it and have I trained", so that is what
 * costs nothing:
 *
 *  1. **Collapsed** — seven cells, today filled, a dot under each day that has
 *     something on it. Two rows of pixels, no scrolling.
 *  2. **Expanded** — the same week as a list, each day showing what is
 *     actually on it. Opened by the caret, closed by it again.
 *  3. **Month** — a full grid behind the month name, with the month's own
 *     totals underneath and a tapped day's detail below that.
 *
 * The escalation is deliberate: a month grid permanently on the Today screen
 * would push the thing you came to do below the fold to answer a question you
 * ask once a week.
 *
 * **Two dot colours, and they are different facts.** Green is a session that
 * happened; lime is one that is planned. A single colour would make "I trained
 * Tuesday" and "I intend to train Tuesday" the same mark, which is the one
 * distinction a training calendar exists to draw. Where a day has both, the
 * session wins — what happened outranks what was intended.
 */

type DayCell = { date: Date; key: string; inMonth: boolean };

/** Monday 00:00 local. */
function startOfWeek(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // getDay() is 0 on Sunday, which is six days into the week, not minus one.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** The seven `Date`s of `now`'s week, Monday first. */
function weekOf(now: Date): Date[] {
  const monday = startOfWeek(now);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * Whole weeks covering a month — Monday-first, with the neighbouring days that
 * complete the first and last rows.
 *
 * The spill days are rendered dimmed rather than blank: a grid with holes in
 * its corners reads as a rendering fault, and the last days of the previous
 * month are genuinely part of the week you are looking at.
 */
function monthGrid(anchor: Date): DayCell[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const weeks: DayCell[][] = [];
  let cursor = start;
  // Six rows is the maximum a month can span (31 days starting on a Sunday);
  // the loop stops early when a full row has already passed the month's end.
  for (let w = 0; w < 6; w++) {
    const row = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(cursor, i);
      return { date, key: dayString(date), inMonth: date.getMonth() === anchor.getMonth() };
    });
    weeks.push(row);
    cursor = addDays(cursor, 7);
    if (cursor.getMonth() !== anchor.getMonth() && cursor > first) break;
  }
  return weeks;
}

/** Working, non-warm-up sets — the backend's own rule, mirrored. */
function workingSets(s: Session): number {
  return s.sets.filter((x) => x.completed && x.set_type !== 'warmup').length;
}

function sessionVolume(s: Session): number {
  let kg = 0;
  for (const set of s.sets) {
    if (set.completed && set.set_type !== 'warmup' && set.weight_kg != null && set.reps != null) {
      kg += set.weight_kg * set.reps;
    }
  }
  return kg;
}

function durationSeconds(s: Session): number | null {
  if (!s.ended_at) return null;
  return (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000;
}

export function TrainingCalendar({
  now,
  userId,
  sessions,
  planned,
  modules,
  units,
  onOpenSession,
}: {
  now: Date;
  userId: string | null;
  /** The caller's already-loaded sessions — enough for the collapsed week. */
  sessions: Session[];
  /** Planned entries covering at least the visible week. */
  planned: PlannedSession[];
  modules: Module[];
  units: UnitSystem;
  onOpenSession: (s: Session) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [monthOpen, setMonthOpen] = useState(false);
  // The month being browsed, which is not always the month `now` is in — the
  // grid has arrows.
  const [anchor, setAnchor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * A wider read, for the month sheet.
   *
   * The caller hands us its own list, capped at the most recent 30 — plenty
   * for a week and **not** enough to colour a month honestly. A grid that
   * silently omitted older days would claim rest days that were trained, which
   * is the fabricated-zero this codebase refuses everywhere else.
   *
   * **Merged with the caller's list rather than replacing it**, and re-read
   * whenever `anchor` moves. Both halves of that matter and both were wrong:
   *
   *  - Replacing meant that once the sheet had been opened, this stale array
   *    shadowed the live `sessions` prop for the rest of the screen's life —
   *    so finishing a session and returning to Today left the week strip's dot
   *    unlit while the Today screen right above it showed the session.
   *  - Loading once per *opening* meant paging back with the arrows kept
   *    showing the most recent 200 sessions, so a month far enough back
   *    reported 0 sessions and 0 days for a month that was trained.
   */
  const [monthSessions, setMonthSessions] = useState<Session[]>([]);

  const week = useMemo(() => weekOf(now), [now]);
  const todayKey = dayString(now);

  // Both lists, de-duplicated by id, with the CALLER's copy winning — it is
  // the live one, re-read on focus and after every sync, while the month read
  // is a snapshot taken when the sheet opened.
  const pool = useMemo(() => {
    if (monthSessions.length === 0) return sessions;
    const byId = new Map(monthSessions.map((s) => [s.id, s]));
    for (const s of sessions) byId.set(s.id, s);
    return Array.from(byId.values());
  }, [monthSessions, sessions]);

  const byDay = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of pool) {
      const key = dayString(new Date(s.started_at));
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [pool]);

  const plannedByDay = useMemo(() => {
    const map = new Map<string, PlannedSession[]>();
    for (const p of planned) {
      const list = map.get(p.day);
      if (list) list.push(p);
      else map.set(p.day, [p]);
    }
    return map;
  }, [planned]);

  const openMonth = useCallback(() => {
    setAnchor(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelected(todayKey);
    setMonthOpen(true);
  }, [now, todayKey]);

  /**
   * Load the sessions covering the month being browsed — re-run when the
   * arrows move it, not once per opening.
   *
   * `listLocalSessions` returns the most recent N, so a fixed read can only
   * ever describe recent months. Paging back far enough with that made the
   * grid and the totals report zero for a month that was trained. The limit
   * therefore scales with how far back the anchor is: enough rows to reach
   * that month, capped so an idle scroll into 2019 cannot ask for everything.
   */
  useEffect(() => {
    if (!monthOpen || !userId) return;
    let alive = true;

    const monthsBack = Math.max(
      0,
      (now.getFullYear() - anchor.getFullYear()) * 12 + (now.getMonth() - anchor.getMonth()),
    );
    // ~15 sessions/month is a generous training week; +200 keeps the recent
    // window as complete as it was before.
    const limit = Math.min(2000, 200 + monthsBack * 15);

    listLocalSessions(userId, limit)
      .then((rows) => {
        if (alive) setMonthSessions(rows);
      })
      .catch(() => {
        // Falls back to the caller's list. The grid is then only as complete
        // as that list — it can only ever under-report, and the alternative is
        // an empty month.
      });

    return () => {
      alive = false;
    };
  }, [monthOpen, userId, anchor, now]);

  const grid = useMemo(() => monthGrid(anchor), [anchor]);

  // Month-to-date, over the month actually being browsed rather than over
  // `now` — the arrows move it, so the totals have to move with it.
  const monthTotals = useMemo(() => {
    let count = 0;
    let seconds = 0;
    let volumeKg = 0;
    const days = new Set<string>();
    for (const s of pool) {
      const d = new Date(s.started_at);
      if (d.getMonth() !== anchor.getMonth() || d.getFullYear() !== anchor.getFullYear()) continue;
      count++;
      days.add(dayString(d));
      seconds += durationSeconds(s) ?? 0;
      volumeKg += sessionVolume(s);
    }
    return { count, seconds, volumeKg, days: days.size };
  }, [pool, anchor]);

  function dotFor(key: string): string | null {
    // Done outranks planned — see the header comment.
    if (byDay.has(key)) return vola.green;
    if (plannedByDay.has(key)) return vola.lime;
    return null;
  }

  return (
    <View style={styles.wrap} testID="training-calendar">
      <RNView style={styles.head}>
        <Pressable
          onPress={openMonth}
          hitSlop={8}
          style={styles.monthButton}
          accessibilityRole="button"
          accessibilityLabel={`${now.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          })}. Open the month view.`}
          testID="calendar-open-month"
        >
          <Text style={styles.month}>
            {now.toLocaleDateString(undefined, { month: 'long' }).toUpperCase()}
          </Text>
          <Icon name="chevron" size={12} color={vola.textDim} />
        </Pressable>
      </RNView>

      <RNView style={styles.strip}>
        {week.map((d) => {
          const key = dayString(d);
          const isToday = key === todayKey;
          const isFuture = d.getTime() > now.getTime() && !isToday;
          const dot = dotFor(key);
          return (
            <RNView
              key={key}
              style={styles.cell}
              accessible
              accessibilityLabel={[
                d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
                isToday ? 'today' : null,
                byDay.has(key) ? 'trained' : plannedByDay.has(key) ? 'planned' : null,
              ]
                .filter(Boolean)
                .join(', ')}
            >
              <Text style={[styles.weekday, isFuture && styles.dimmed]}>
                {d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase()}
              </Text>
              <RNView style={[styles.date, isToday && styles.dateToday]}>
                <Text
                  style={[
                    styles.dateText,
                    isToday && styles.dateTextToday,
                    isFuture && styles.dimmed,
                  ]}
                >
                  {/* Padded so columns don't jump between the 9th and 10th. */}
                  {String(d.getDate()).padStart(2, '0')}
                </Text>
              </RNView>
              {/* Always laid out, lit conditionally — an absent dot would let
                  the cells above it shift up on untrained days. */}
              <RNView style={[styles.dot, dot != null && { backgroundColor: dot }]} />
            </RNView>
          );
        })}
      </RNView>

      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={styles.expander}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={expanded ? 'Hide the week' : 'Show the week'}
        testID="calendar-expand"
      >
        <Text style={styles.expanderText}>{expanded ? 'HIDE WEEK' : 'WEEK IN REVIEW'}</Text>
        {/* One glyph, rotated — a separate up-chevron would be a second thing
            to keep in sync with this one's weight and size. */}
        <RNView style={{ transform: [{ rotate: expanded ? '-90deg' : '90deg' }] }}>
          <Icon name="chevron" size={12} color={vola.textDim} />
        </RNView>
      </Pressable>

      {expanded && (
        <RNView style={styles.dayList} testID="calendar-week-list">
          {week.map((d) => (
            <DayRow
              key={dayString(d)}
              date={d}
              sessions={byDay.get(dayString(d)) ?? []}
              planned={plannedByDay.get(dayString(d)) ?? []}
              modules={modules}
              units={units}
              onOpenSession={onOpenSession}
            />
          ))}
        </RNView>
      )}

      <Modal
        visible={monthOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setMonthOpen(false)}
      >
        <View style={styles.sheet} lightColor={vola.bg} darkColor={vola.bg}>
          <RNView style={styles.sheetHead}>
            <Pressable
              onPress={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              testID="calendar-prev-month"
            >
              <RNView style={{ transform: [{ rotate: '180deg' }] }}>
                <Icon name="chevron" size={16} color={vola.text} />
              </RNView>
            </Pressable>
            <Text style={styles.sheetTitle}>
              {anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </Text>
            <Pressable
              onPress={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Next month"
              testID="calendar-next-month"
            >
              <Icon name="chevron" size={16} color={vola.text} />
            </Pressable>
            <Pressable
              onPress={() => setMonthOpen(false)}
              hitSlop={12}
              style={styles.sheetClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="calendar-close-month"
            >
              <Text style={styles.close}>Done</Text>
            </Pressable>
          </RNView>

          <ScrollView contentContainerStyle={styles.sheetBody}>
            <RNView style={styles.gridHead}>
              {weekOf(now).map((d) => (
                <Text key={d.toISOString()} style={styles.gridHeadCell}>
                  {d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase()}
                </Text>
              ))}
            </RNView>

            {grid.map((row) => (
              <RNView key={row[0].key} style={styles.gridRow}>
                {row.map((cell) => {
                  const dot = dotFor(cell.key);
                  const isToday = cell.key === todayKey;
                  const isSelected = cell.key === selected;
                  return (
                    <Pressable
                      key={cell.key}
                      style={styles.gridCell}
                      onPress={() => setSelected(cell.key)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={cell.date.toLocaleDateString(undefined, {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                      })}
                      testID={`calendar-day-${cell.key}`}
                    >
                      <RNView
                        style={[
                          styles.gridDate,
                          isSelected && styles.gridDateSelected,
                          isToday && styles.gridDateToday,
                        ]}
                      >
                        <Text
                          style={[
                            styles.gridDateText,
                            !cell.inMonth && styles.dimmed,
                            isToday && styles.dateTextToday,
                          ]}
                        >
                          {cell.date.getDate()}
                        </Text>
                      </RNView>
                      <RNView
                        style={[styles.dot, dot != null && { backgroundColor: dot }]}
                      />
                    </Pressable>
                  );
                })}
              </RNView>
            ))}

            <RNView style={styles.legend}>
              <Legend colour={vola.green} label="Trained" />
              <Legend colour={vola.lime} label="Planned" />
            </RNView>

            <Text style={styles.sectionLabel}>
              {anchor.toLocaleDateString(undefined, { month: 'long' }).toUpperCase()} SO FAR
            </Text>
            <StatRow>
              <Stat label="Sessions" value={String(monthTotals.count)} size={22} />
              <Stat label="Days" value={String(monthTotals.days)} size={22} />
              {monthTotals.volumeKg > 0 ? (
                <Stat label="Volume" value={formatVolume(monthTotals.volumeKg, units)} size={22} />
              ) : (
                <Stat
                  label="Time"
                  value={monthTotals.seconds > 0 ? formatDuration(monthTotals.seconds) : '—'}
                  size={22}
                />
              )}
            </StatRow>

            {selected && (
              <>
                <Text style={styles.sectionLabel}>
                  {new Date(`${selected}T00:00:00`)
                    .toLocaleDateString(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })
                    .toUpperCase()}
                </Text>
                <DayRow
                  date={new Date(`${selected}T00:00:00`)}
                  sessions={byDay.get(selected) ?? []}
                  planned={plannedByDay.get(selected) ?? []}
                  modules={modules}
                  units={units}
                  onOpenSession={(s) => {
                    setMonthOpen(false);
                    onOpenSession(s);
                  }}
                  headless
                />
              </>
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <RNView style={styles.legendItem}>
      <RNView style={[styles.dot, { backgroundColor: colour }]} />
      <Text style={styles.legendText}>{label}</Text>
    </RNView>
  );
}

/**
 * One day: what happened on it, then what was meant to.
 *
 * Sessions above plans, because a plan that has already been trained is no
 * longer the interesting half of the day. `headless` drops the date heading
 * for the month sheet, where the section label above it already says which day
 * this is.
 */
function DayRow({
  date,
  sessions,
  planned,
  modules,
  units,
  onOpenSession,
  headless,
}: {
  date: Date;
  sessions: Session[];
  planned: PlannedSession[];
  modules: Module[];
  units: UnitSystem;
  onOpenSession: (s: Session) => void;
  headless?: boolean;
}) {
  return (
    <RNView style={styles.day}>
      {!headless && (
        <Text style={styles.dayName}>
          {date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </Text>
      )}

      {sessions.length === 0 && planned.length === 0 ? (
        <Text style={styles.noActivity}>No activity</Text>
      ) : (
        <>
          {sessions.map((s) => {
            const secs = durationSeconds(s);
            const kg = sessionVolume(s);
            const n = workingSets(s);
            // Each measure appears only when it exists — a "0 sets" chip on a
            // mat session reads as abandoned rather than as a class.
            const meta = [
              secs != null ? formatDuration(secs) : null,
              n > 0 ? `${n} ${n === 1 ? 'set' : 'sets'}` : null,
              kg > 0 ? formatVolume(kg, units) : null,
            ].filter(Boolean);
            return (
              <Pressable
                key={s.id}
                style={({ pressed }) => [styles.entry, pressed && styles.entryPressed]}
                onPress={() => onOpenSession(s)}
                accessibilityRole="button"
                accessibilityLabel={`${s.name || labelFor(modules, s.sport)}, ${meta.join(', ')}`}
                testID={`calendar-session-${s.id}`}
              >
                <RNView style={[styles.entryRule, { backgroundColor: vola.green }]} />
                <RNView style={styles.entryMain}>
                  <Text style={styles.entrySport}>
                    {labelFor(modules, s.sport).toUpperCase()}
                  </Text>
                  <Text style={styles.entryTitle} numberOfLines={1}>
                    {s.name || `${labelFor(modules, s.sport)} session`}
                  </Text>
                  {meta.length > 0 && <Text style={styles.entryMeta}>{meta.join(' · ')}</Text>}
                </RNView>
                <Icon name="chevron" size={13} color={vola.textDim} />
              </Pressable>
            );
          })}

          {planned.map((p) => (
            <RNView key={p.id} style={styles.entry}>
              <RNView style={[styles.entryRule, { backgroundColor: vola.lime }]} />
              <RNView style={styles.entryMain}>
                <Text style={styles.entrySport}>{labelFor(modules, p.sport).toUpperCase()}</Text>
                <Text style={styles.entryTitle} numberOfLines={1}>
                  {`${labelFor(modules, p.sport)} session`}
                </Text>
                <Text style={styles.entryMeta}>Planned</Text>
              </RNView>
            </RNView>
          ))}
        </>
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 4,
  },
  head: { paddingHorizontal: 6 },
  monthButton: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  month: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, color: vola.textDim },

  strip: { flexDirection: 'row', marginTop: 10 },
  cell: { flex: 1, alignItems: 'center', gap: 4 },
  weekday: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: vola.textDim },
  date: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  dateToday: { backgroundColor: vola.lime },
  dateText: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  dateTextToday: { color: vola.navy },
  dimmed: { color: vola.textDim, opacity: 0.5 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: 'transparent' },

  expander: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    marginTop: 4,
  },
  expanderText: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, color: vola.textDim },

  dayList: { paddingHorizontal: 6, paddingBottom: 8, gap: 14 },
  day: { gap: 6 },
  dayName: { fontSize: 13, fontWeight: '700' },
  noActivity: { fontSize: 12, color: vola.textDim },

  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 10,
    paddingRight: 10,
    overflow: 'hidden',
  },
  entryPressed: { backgroundColor: vola.surfaceHover },
  entryRule: { width: 3, alignSelf: 'stretch' },
  entryMain: { flex: 1, paddingVertical: 9, paddingLeft: 8, gap: 1 },
  entrySport: { fontSize: 9, fontWeight: '700', letterSpacing: 0.9, color: vola.textDim },
  entryTitle: { fontSize: 14, fontWeight: '700' },
  entryMeta: { fontSize: 12, color: vola.textMuted, fontVariant: ['tabular-nums'] },

  sheet: { flex: 1 },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800' },
  sheetClose: { marginLeft: 'auto' },
  close: { color: vola.lime, fontWeight: '700', fontSize: 15 },
  sheetBody: { paddingHorizontal: 16, paddingBottom: 44, gap: 4 },

  gridHead: { flexDirection: 'row', marginBottom: 6 },
  gridHeadCell: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: vola.textDim,
  },
  gridRow: { flexDirection: 'row', marginBottom: 4 },
  gridCell: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: 2 },
  gridDate: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  gridDateSelected: { borderWidth: 1, borderColor: vola.line, backgroundColor: vola.surface },
  gridDateToday: { backgroundColor: vola.lime, borderWidth: 0 },
  gridDateText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },

  legend: { flexDirection: 'row', gap: 16, justifyContent: 'center', paddingVertical: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendText: { fontSize: 11, color: vola.textDim },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: vola.textDim,
    marginTop: 14,
    marginBottom: 8,
  },
});
