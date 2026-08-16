import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { Stat, StatRow } from '@/components/ui/Stat';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { accentGlow } from '@/lib/palette';
import { sportColor } from '@/components/ui/sport';
import { formatDuration } from '@/lib/history';
import { labelFor, type Module } from '@/lib/modules';
import { dayString, monthGrid, weekDays } from '@/lib/calendar';
import { matchPlans, pendingPlans } from '@/lib/adherence';
import { type PlannedSession } from '@/lib/plan';
import type { Session } from '@/lib/sessions';
import { listLocalSessions } from '@/lib/sessionStore';
import { formatVolume, type UnitSystem } from '@/lib/units';
import { totalWeightKg } from '@/lib/sessions';

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
 * **Trained and planned are different facts, and the SHAPE says so.** A
 * session that happened is a filled dot; one that is planned is a hollow ring.
 * Colour agrees — green and lime — but does not carry it: the two measure
 * 1.18:1 apart in greyscale, i.e. the same blob, so hue alone would make "I
 * trained Tuesday" and "I intend to train Tuesday" indistinguishable to a
 * colour-blind reader. That is the one distinction a training calendar exists
 * to draw.
 *
 * Where a day has both, the session wins — what happened outranks what was
 * intended. That is a rule about the DOT, which can only be one mark; the
 * accessible labels name both states independently, because speech has no such
 * limit and a both-day is exactly the day worth telling someone about.
 */

/** Working, non-warm-up sets — the backend's own rule, mirrored. */
function workingSets(s: Session): number {
  return s.sets.filter((x) => x.completed && x.set_type !== 'warmup').length;
}

function sessionVolume(s: Session): number {
  let kg = 0;
  for (const set of s.sets) {
    if (set.completed && set.set_type !== 'warmup' && set.weight_kg != null && set.reps != null) {
      kg += totalWeightKg(set) * set.reps;
    }
  }
  return kg;
}

/** Plans keyed by their day. Module scope so the memos below have no stale dep. */
function byDayOf(rows: PlannedSession[]): Map<string, PlannedSession[]> {
  const map = new Map<string, PlannedSession[]>();
  for (const p of rows) {
    const list = map.get(p.day);
    if (list) list.push(p);
    else map.set(p.day, [p]);
  }
  return map;
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
  const accent = useAccent();
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

  const week = useMemo(() => weekDays(now), [now]);
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

  /**
   * Which plans the athlete has already met — computed, never stored. See
   * `lib/adherence.ts` for the rule and for why it is a query.
   *
   * Against `pool` rather than `sessions`, so the month sheet does not report a
   * plan as still owed on a day it can see was trained. `pool` is the merged
   * live + month-snapshot list; `sessions` alone is the last 30.
   */
  const adherence = useMemo(() => matchPlans(pool, planned), [pool, planned]);

  // Only what is still owed. A met plan is not deleted or hidden from the Plan
  // tab — it simply stops being drawn a second time next to the session that
  // met it, which read as two sessions when there was one.
  const plannedByDay = useMemo(
    () => byDayOf(pendingPlans(planned, adherence)),
    [planned, adherence],
  );

  /**
   * Every plan, met or not — for the SPOKEN labels only.
   *
   * The dot can carry one mark and "done outranks planned" decides which. Speech
   * has no such limit, and the labels below deliberately say both on a day that
   * is both, because that is the day a reader most needs told. Keying them off
   * the pending list instead would silently drop "planned" the moment a plan
   * was met — achieving by filtering exactly what the comments at those two
   * sites forbid doing by ternary.
   */
  const allPlannedByDay = useMemo(
    () => byDayOf(planned),
    [planned],
  );

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

  /**
   * The day's marker: what it means, and how it says so WITHOUT relying on
   * hue.
   *
   * Green and lime are adjacent, and a 4pt dot is the least legible place in
   * the app to be carrying a distinction by colour alone — a day trained is
   * not a day planned, and those are the only two states this mark has. So the
   * shape carries it too: **filled for what happened, a hollow ring for what
   * is intended**. Same treatment as the web calendar's chips, so the mapping
   * is learned once.
   *
   * Colour stays, because it is the fastest channel for anyone who can use it.
   * It is simply no longer the only one.
   */
  function dotFor(key: string): { colour: string; filled: boolean } | null {
    // Done outranks planned — see the header comment.
    if (byDay.has(key)) return { colour: vola.green, filled: true };
    if (plannedByDay.has(key)) return { colour: vola.lime, filled: false };
    return null;
  }

  /** The style pair for a marker, or an invisible placeholder that holds the row's height. */
  function dotStyle(d: { colour: string; filled: boolean } | null) {
    if (!d) return null;
    return d.filled
      ? // No borderColor here: with no borderWidth it draws nothing, and the
        // combination can take a different draw path on Android for no gain.
        { backgroundColor: d.colour }
      : // A ring: transparent centre, so the hole is the signal. Sized up a
        // touch from the filled dot because a 4pt ring has no visible hole.
        { backgroundColor: 'transparent', borderColor: d.colour, borderWidth: 1.5 };
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
                // Independent, not a ternary — a day that is both trained and
                // planned must say both. The dot can only be one colour; the
                // label has no such limit.
                byDay.has(key) ? 'trained' : null,
                allPlannedByDay.has(key) ? 'planned' : null,
              ]
                .filter(Boolean)
                .join(', ')}
            >
              <Text style={[styles.weekday, isFuture && styles.dimmed]}>
                {d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase()}
              </Text>
              <RNView
                style={[
                  styles.date,
                  isToday && [
                    styles.dateToday,
                    { backgroundColor: accent.accent }, accentGlow(accent.accent),
                  ],
                ]}
              >
                <Text
                  style={[
                    styles.dateText,
                    isToday && [styles.dateTextToday, { color: accent.on }],
                    isFuture && styles.dimmed,
                  ]}
                >
                  {/* Padded so columns don't jump between the 9th and 10th. */}
                  {String(d.getDate()).padStart(2, '0')}
                </Text>
              </RNView>
              {/* Always laid out, lit conditionally — an absent dot would let
                  the cells above it shift up on untrained days. */}
              <RNView style={[styles.dot, dotStyle(dot)]} />
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
              metBy={adherence.metBy}
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
              <Text style={[styles.close, { color: accent.ink }]}>Done</Text>
            </Pressable>
          </RNView>

          <ScrollView contentContainerStyle={styles.sheetBody}>
            <RNView style={styles.gridHead}>
              {weekDays(now).map((d) => (
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
                      // The state is named, matching the week strip above.
                      // Without it the dot is the only signal a month cell
                      // carries, and a screen reader got the date and nothing
                      // else — the same erasure the web calendar's cells had.
                      //
                      // Both states are listed INDEPENDENTLY rather than by a
                      // ternary. "Done outranks planned" is a rule about the
                      // dot, which can only be one colour; a spoken label has
                      // no such constraint, and a ternary silently drops
                      // "planned" on a day that is both — which is exactly the
                      // day a reader most needs told, and which the web
                      // calendar already names in full.
                      accessibilityLabel={[
                        cell.date.toLocaleDateString(undefined, {
                          weekday: 'long',
                          day: 'numeric',
                          month: 'long',
                        }),
                        cell.key === todayKey ? 'today' : null,
                        byDay.has(cell.key) ? 'trained' : null,
                        allPlannedByDay.has(cell.key) ? 'planned' : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                      testID={`calendar-day-${cell.key}`}
                    >
                      <RNView
                        style={[
                          styles.gridDate,
                          isSelected && styles.gridDateSelected,
                          isToday && [styles.gridDateToday, { backgroundColor: accent.accent }],
                        ]}
                      >
                        <Text
                          style={[
                            styles.gridDateText,
                            !cell.inMonth && styles.dimmed,
                            isToday && [styles.dateTextToday, { color: accent.on }],
                          ]}
                        >
                          {cell.date.getDate()}
                        </Text>
                      </RNView>
                      <RNView
                        style={[styles.dot, dotStyle(dot)]}
                      />
                    </Pressable>
                  );
                })}
              </RNView>
            ))}

            <RNView style={styles.legend}>
              <Legend filled label="Trained" colour={vola.green} />
              <Legend filled={false} label="Planned" colour={vola.lime} />
            </RNView>

            <Text style={styles.sectionLabel}>
              {anchor.toLocaleDateString(undefined, { month: 'long' }).toUpperCase()} SO FAR
            </Text>
            {/* `fit` on every one: a month's figures are strictly larger than
                a week's, so this row clips before the week row does — 12,450lb
                and 553.7k lb both overflow a third-width column without it. */}
            <StatRow>
              <Stat label="Sessions" value={String(monthTotals.count)} size={22} fit />
              <Stat label="Days" value={String(monthTotals.days)} size={22} fit />
              {monthTotals.volumeKg > 0 ? (
                <Stat
                  label="Volume"
                  value={formatVolume(monthTotals.volumeKg, units)}
                  size={22}
                  fit
                />
              ) : (
                <Stat
                  label="Time"
                  value={monthTotals.seconds > 0 ? formatDuration(monthTotals.seconds) : '—'}
                  size={22}
                  fit
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
                  metBy={adherence.metBy}
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

/**
 * Shows the ACTUAL marker, filled or ring, rather than a colour swatch.
 *
 * A legend of two coloured dots teaches only the colour — which is precisely
 * the channel a colour-blind reader cannot use, so it taught them nothing.
 */
function Legend({ colour, filled, label }: { colour: string; filled: boolean; label: string }) {
  return (
    <RNView style={styles.legendItem}>
      <RNView
        style={[
          styles.legendDot,
          filled
            ? { backgroundColor: colour }
            : { backgroundColor: 'transparent', borderColor: colour, borderWidth: 2 },
        ]}
      />
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
  metBy,
}: {
  date: Date;
  sessions: Session[];
  /** Only what is still owed — a met plan is filtered out upstream. */
  planned: PlannedSession[];
  modules: Module[];
  units: UnitSystem;
  onOpenSession: (s: Session) => void;
  headless?: boolean;
  /** Session id → the plan it met, so a logged row can say it was planned. */
  metBy?: Map<string, string>;
}) {
  const accent = useAccent();
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
              // The plan that this session met is no longer drawn as its own
              // row, so the intention would otherwise disappear entirely. It
              // goes last: what was done outranks what was meant.
              metBy?.has(s.id) ? 'planned' : null,
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
              <RNView
                style={[
                  styles.entryRule,
                  { backgroundColor: sportColor(p.sport) ?? accent.accent },
                ]}
              />
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
  /**
   * Today's chip, and the one place in this app that uses a shadow.
   *
   * The glow is `shadowColor` set to the chip's own fill rather than to black,
   * which on a near-black ground reads as light coming off the chip instead of
   * the chip sitting above the card. Nothing else here casts one — a dark UI
   * where several things glow is a dark UI where nothing stands out, and this
   * marker has to win against six neighbours that are the same size and shape.
   *
   * Android takes `elevation` and ignores the rest, so it gets a plain lift
   * rather than a coloured one. That is a real difference and an acceptable
   * one: the fill already carries the meaning, and the glow is emphasis.
   */
  dateToday: {
    // Fill and glow are the accent's, set at the call site — the shadow has to
    // match the fill or it reads as a drop shadow rather than light.
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  dateText: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // Ink set inline: what can be written on the fill is the accent's own.
  dateTextToday: {},
  dimmed: { color: vola.textDim, opacity: 0.5 },
  // 8pt, not the original 4 and not the 6 this first grew to.
  //
  // The ring's hole IS the signal, and it has to survive a glance mid-workout
  // at arm's length. At 6/1.5 the hole is 3pt — 25% of the marker's area, 9
  // device pixels at 3x — which is perceivable in a screenshot and not much
  // else. 8/1.5 gives a 5pt hole at 39% of the area, 15 device pixels.
  //
  // That sizing matters more here than the equivalent on web, because on
  // mobile the SHAPE carries the whole distinction on its own: filled #42F58D
  // and a #B8FF2C ring are 1.18:1 apart in greyscale, i.e. the same blob. Web
  // has a ✓/○ glyph doing that job; this does not.
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent' },

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
  close: { fontWeight: '700', fontSize: 15 },
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
  gridDateToday: { borderWidth: 0 },
  gridDateText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },

  legend: { flexDirection: 'row', gap: 16, justifyContent: 'center', paddingVertical: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Bigger than the in-grid marker on purpose. The grid's dot is sized for
  // density; the legend's job is to teach the filled/ring distinction, so it
  // is the one place the shape must be unmistakable beside 11pt text.
  legendDot: { width: 12, height: 12, borderRadius: 6 },
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
