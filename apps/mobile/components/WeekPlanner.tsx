import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Alert,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View as RNView,
} from 'react-native';

import { request as requestSync, useSyncState } from '@/lib/sync';

import { SelectAllTextInput } from '@/components/SelectAllTextInput';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { PeriodSwitcher } from '@/components/ui/PeriodSwitcher';
import { PickSessionSheet } from '@/components/ui/PickSessionSheet';
import { WeekStepper, weekStepperDayState, type WeekStepperDay } from '@/components/ui/WeekStepper';
import { vola } from '@/constants/Colors';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { useAccent } from '@/lib/AccentProvider';
import {
  addDays,
  addMonths,
  dayString,
  monthGrid,
  refreshedAnchor,
  startOfMonth,
  weekDays,
} from '@/lib/calendar';
import { labelFor, type Module } from '@/lib/modules';
import {
  listPlannedBetween,
  planSession,
  unplanSession,
  type PlannedSession,
} from '@/lib/plan';
import { cachedWorkouts } from '@/lib/sessionStore';
import {
  cleanThemeTitle,
  deleteTheme,
  fetchThemes,
  MAX_THEME_TITLE,
  setTheme,
  type Theme,
} from '@/lib/themes';
import { useAuthToken, type TokenGetter } from '@/lib/useAuthToken';

/**
 * The workout a planned row opens, or null when it opens nothing.
 *
 * A planned row used to draw a chevron and carry `accessibilityRole="button"`
 * while having no `onPress` at all — so it was inert to a tap, and the chevron
 * promised a screen that did not exist. On a device that reads as a broken row,
 * not as a row that was only ever meant to be long-pressed: three taps at three
 * points did nothing, with the affordance for "tap to open" plainly drawn.
 *
 * **Nowhere to go is a real state, not an edge case.** A plan may name no
 * template at all (a bare "BJJ on Thursday"), and it may name one the cache no
 * longer holds — `lib/plan.ts` deliberately keeps no foreign key, so a template
 * deleted on another device leaves the plan row pointing at nothing. That is
 * already why the title falls back to "<Sport> session". Both cases must not
 * navigate, and must not advertise that they would.
 *
 * Keyed on `names` rather than on `workoutId` alone for exactly that second
 * case: a row whose id resolves to no cached name would otherwise push a detail
 * screen that can only render an error.
 */
export function plannedEntryTarget(
  p: { workoutId: string | null },
  names: Record<string, string>,
): string | null {
  if (!p.workoutId) return null;
  return names[p.workoutId] ? p.workoutId : null;
}

/**
 * The class plan a planned row opens into the N441 guided runner, or null.
 *
 * **Simpler than `plannedEntryTarget` on purpose, and for a reason specific
 * to this field.** A workout id needs the `names` lookup because the local
 * cache is the only place a template's current name lives, and a stale or
 * missing cache entry must not offer a dead link. `classPlanId` has no local
 * name cache to go stale — mobile never authors or caches class plans (see
 * `lib/plan.ts`'s `PlannedSession.classPlanId`), and `/classplans/[id]/run`
 * fetches the plan directly from the server on open rather than reading a
 * name back from anything this device stored. So there is nothing to resolve
 * here: a set id is always somewhere to go, and the run screen's own loading
 * and error states are what a class plan deleted since the last sync shows up
 * as — the identical "degrades to the discipline" answer the server gives
 * once the next sync pull clears the id (see the plan migration's
 * `ON DELETE SET NULL`).
 */
export function plannedClassPlanTarget(p: { classPlanId: string | null }): string | null {
  return p.classPlanId;
}

/**
 * The training week, as something you fill in.
 *
 * This is the authoring half of the Today screen's lead card: plan a day here,
 * and Today opens on it with a Start button. Before this existed, Today's only
 * offer was a stack of "Start <discipline>" buttons — the app could log a
 * session but had no idea what you *intended*, so it could never lead with
 * anything but a menu.
 *
 * **A day holds a list, not a single entry.** Two-a-days are normal in this
 * sport — lift in the morning, mat in the evening — and a one-plan-per-day
 * model would make the second one overwrite the first silently.
 *
 * **Rows, not a 7-across grid.** The grid shape reads beautifully with nothing
 * in it and falls apart the moment a day holds "Maestro Push Day": there is no
 * room for a template name in a 45pt column, so every planned day degrades to
 * a coloured dot and the calendar stops telling you what you planned. Rows
 * give the name the width it needs, and the Today screen's `TrainingCalendar`
 * already covers the at-a-glance shape.
 *
 * **The month grid is a jump target, not a second way to read the plan.** This
 * screen was pinned to the current week and had no navigation at all, so you
 * could not plan next week — the one thing a planner is for. The fix is a week
 * you can move: the arrows step a week, and the month grid picks a distant one
 * in a single tap and then hands it back to the rows. Its cells carry a dot and
 * nothing else, which is exactly why it cannot replace them.
 *
 * Plans sync — `planned_sessions` joined the outbox at schema v15 and
 * `lib/sync.ts` runs `syncPlans`. This comment said "local-only for now" long
 * after that stopped being true, and the claim was carried into a history
 * entry before a reviewer caught it.
 */
export function WeekPlanner({
  userId,
  modules,
}: {
  userId: string | null;
  modules: Module[];
}) {
  const accent = useAccent();
  const router = useRouter();
  const getToken = useAuthToken();
  const [now, setNow] = useState(() => new Date());
  const [plans, setPlans] = useState<PlannedSession[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  // The day being planned, or null when the sheet is closed. Holding the day
  // here rather than a boolean is what lets one sheet serve all seven rows.
  const [planning, setPlanning] = useState<string | null>(null);
  // Any day inside the week the rows are showing. Separate from `now`, which
  // stays the real today — `isPast` and the today marker are claims about the
  // actual date and must not move when you navigate away from this week.
  const [anchor, setAnchor] = useState(() => new Date());
  const [monthOpen, setMonthOpen] = useState(false);
  /**
   * Whether the seven authoring rows are showing.
   *
   * Open by default, which is the opposite of the Today screen's calendar and
   * deliberate: Today's question is "what day is it and have I trained", and
   * the rows are an escalation from it. This screen exists to fill the rows
   * in, so starting collapsed would hide the only thing on it. The collapse is
   * for reading the shape of a month — step through weeks with the strip
   * alone, then open the week you want to change.
   */
  const [expanded, setExpanded] = useState(true);
  // The month the grid is showing, which is not the anchor's month once you
  // page through it looking for a week without picking one yet.
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()));
  const [monthDays, setMonthDays] = useState<Set<string>>(new Set());

  const days = useMemo(() => weekDays(anchor), [anchor]);
  const todayKey = dayString(now);
  const isCurrentWeek = days.some((d) => dayString(d) === todayKey);
  const weekStartKey = dayString(days[0]);

  // Bumped on every anchor change, and captured by each read. A read that
  // resolves after the week moved is dropped rather than rendered.
  //
  // Reachable: tap + Add, pick a template, then tap the arrow while the write
  // is in flight — `add()` calls the `refresh` of the render it was created
  // in, which is issued LAST and so lands last, leaving week A's rows under
  // week B's dates. It fails to an all-"Rest" week rather than to wrong plans,
  // and stays that way until the next focus or sync.
  const readSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!userId) return;
    readSeq.current += 1;
    const seq = readSeq.current;
    // The week on screen, NOT `new Date()`. This read was pinned to today, so
    // it was already the reason navigation could not work: every arrow would
    // have moved the rows and re-fetched this week's plans into them.
    const week = weekDays(anchor);
    try {
      const [rows, cached] = await Promise.all([
        listPlannedBetween(userId, dayString(week[0]), dayString(week[6])),
        cachedWorkouts(userId),
      ]);
      if (seq !== readSeq.current) return;
      setPlans(rows);
      // Resolved from the cache each read rather than stored on the plan, so a
      // renamed template shows its new name instead of a stale copy.
      setNames(Object.fromEntries(cached.map((w) => [w.id, w.name])));
    } catch {
      // An unreadable plan is an empty week here, not an error banner — the
      // templates below it are the screen's main content and still work.
    }
  }, [userId, anchor]);

  /**
   * Which days of the open month hold a plan — the grid's only content.
   *
   * A separate read from `refresh`, over a different range, because the grid
   * spans weeks the rows are not showing. It is loaded when the grid opens and
   * whenever its month changes, rather than kept live: a jump target does not
   * need to react to a sync, and the rows behind it already do.
   */
  const monthSeq = useRef(0);
  const loadMonth = useCallback(
    async (month: Date) => {
      if (!userId) return;
      monthSeq.current += 1;
      const seq = monthSeq.current;
      const cells = monthGrid(month).flat();
      try {
        const rows = await listPlannedBetween(
          userId,
          cells[0].key,
          cells[cells.length - 1].key,
        );
        if (seq !== monthSeq.current) return;
        setMonthDays(new Set(rows.map((r) => r.day)));
      } catch {
        // An unreadable month is a grid of bare dates — the dots are a hint,
        // and the rows behind this sheet are the surface that must be right.
        if (seq !== monthSeq.current) return;
        setMonthDays(new Set());
      }
    },
    [userId],
  );

  // `now` is refreshed on focus, or a tab left open overnight keeps planning
  // into last week — the same staleness the Today screen guards against.
  //
  // The anchor is snapped forward only when it has fallen into a *past* week,
  // which can only happen by time passing. A week you navigated to yourself is
  // left alone: if it is still ahead, you chose it, and resetting every time
  // the tab loses focus would make planning two weeks out a fight.
  //
  // **This must not depend on `refresh`, which changes with the anchor.** With
  // `[refresh]` here the effect re-runs on every navigation and the snap fires
  // against the week you just chose — so picking a past day in the month grid
  // bounced instantly back to today, and the grid's whole left half was dead.
  // The read is a separate effect below for exactly that reason.
  const [reloadAt, setReloadAt] = useState(0);
  useFocusEffect(
    useCallback(() => {
      const today = new Date();
      setNow(today);
      setAnchor((a) => refreshedAnchor(a, today));
      setReloadAt((n) => n + 1);
    }, []),
  );

  // The same staleness arrives without a focus change when the app is
  // foregrounded on the tab it was left on — leave it on Plan on Sunday night,
  // reopen on Monday, and `useFocusEffect` never fires. Without this the snap
  // above is a promise the code does not keep: `todayKey` stays yesterday, so
  // `isPast` is computed against it and `+ Add` is offered on days already
  // gone. Copied from the Today screen, which needed it for the same reason.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const today = new Date();
      setNow(today);
      setAnchor((a) => refreshedAnchor(a, today));
      setReloadAt((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // Re-read when the week on screen changes, when the screen is focused, and
  // whenever a sync finishes. Without that last one the week is only as fresh
  // as the last focus, so a plan made on the web lands in SQLite and stays
  // invisible until the tab is left and returned to — which is precisely the
  // "it synced but nothing changed" the sessions list already fixed.
  const { lastSyncAt } = useSyncState();
  useEffect(() => {
    refresh();
  }, [refresh, reloadAt, lastSyncAt]);

  async function add(day: string, sport: string, workoutId: string | null) {
    if (!userId) return;
    try {
      await planSession(userId, day, sport, workoutId);
      await refresh();
      // Local write first, then ask the orchestrator — it decides whether now
      // is a moment worth a run. The row is already on screen either way, so
      // this never blocks the interaction.
      requestSync('plan-added');
    } catch (err) {
      Alert.alert("Couldn't plan that", err instanceof Error ? err.message : String(err));
    }
  }

  function confirmRemove(p: PlannedSession) {
    if (!userId) return;
    Alert.alert('Remove from plan?', 'This only clears the plan — nothing you logged changes.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await unplanSession(userId, p.id);
            await refresh();
            requestSync('plan-removed');
          } catch (err) {
            Alert.alert("Couldn't remove that", err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);
  }

  /**
   * The month a week belongs to, when it straddles two.
   *
   * ISO 8601's rule: the month holding the Thursday owns the week. Labelling by
   * the Monday instead calls 29 September – 5 October "September" when six of
   * its seven days are October.
   */
  const monthLabel = days[3].toLocaleDateString(undefined, {
    month: 'long',
    // The year only when it is not the current one — "AUGUST 2026" on every
    // screen all year is noise, but a silent jump to next January is a trap.
    ...(days[3].getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });

  /**
   * What the switcher reads, and the ONLY thing saying you have navigated.
   *
   * The old header carried that in a separate "Today" pill, on the argument
   * that it was the one thing telling you you had moved. True then; the pill
   * does not fit a centred three-element row, and it does not have to — a
   * label that says THIS WEEK on one week and a date range on every other says
   * the same thing in the place you are already looking. It is text, so it
   * survives greyscale and a screen reader, which the pill's colour did not.
   *
   * Getting back is the month grid, which marks today and is one tap from
   * here — the same route as jumping anywhere else, rather than a control that
   * does nothing six days out of seven.
   */
  const weekLabel = isCurrentWeek
    ? 'THIS WEEK'
    : `${days[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`.toUpperCase();

  function openMonth() {
    setMonthAnchor(startOfMonth(anchor));
    loadMonth(startOfMonth(anchor));
    setMonthOpen(true);
  }

  function stepMonth(n: number) {
    const next = addMonths(monthAnchor, n);
    setMonthAnchor(next);
    loadMonth(next);
  }

  return (
    <RNView style={styles.wrap} testID="week-planner">
      {/*
        One shape for "which week", shared with everything else that changes a
        period — see `ui/PeriodSwitcher`. It replaces a title on the left, a
        Today pill in the middle and a stepper pair on the right: three
        controls doing one job, in three places.
      */}
      <PeriodSwitcher
        label={weekLabel}
        onPrev={() => setAnchor(addDays(anchor, -7))}
        onNext={() => setAnchor(addDays(anchor, 7))}
        onPress={openMonth}
        icon="calendar"
        prevLabel="Previous week"
        nextLabel="Next week"
        pressLabel={`${monthLabel}, week of ${days[0].toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'long',
        })}. Open the month to jump to another week.`}
        testID="plan-week"
      />

      {/*
        The week's theme — one sentence about what this week is FOR, editable
        here rather than only read on Today (N82). Full parity with web's own
        `ThemeRow`, not a reduction: web edits only `title` too, so there is
        nothing narrower to build.

        **Keyed on the week's Monday, deliberately.** `WeekThemeRow` owns its
        own `theme`/`editing`/`draft` state, and re-mounting it — rather than
        an effect that resets that state on a prop change — is what closes an
        open edit and drops its draft the moment the shown week changes: React
        throws the old instance's state away for free on a `key` change, so
        there is no `useEffect` calling `setState` directly in this file for
        `react-hooks/set-state-in-effect` to catch, and no way for a half-typed
        theme to survive onto the next week by accident.
      */}
      <WeekThemeRow
        key={weekStartKey}
        weekStart={weekStartKey}
        getToken={getToken}
        reloadAt={reloadAt}
        lastSyncAt={lastSyncAt}
        accentInk={accent.ink}
      />

      {/*
        The compact week, which is what remains when the rows are closed.

        **N510: `WeekStepper`, not a second hand-rolled strip.** This used to
        be a bespoke row here — a weekday letter, a date and a hollow-vs-filled
        dot for "has a plan or not". `WeekStepper` is the same job generalised
        into a reusable module (see its own doc comment for the full
        reasoning): four states instead of two (`done`/`current`/`upcoming`/
        `rest`, via {@link weekStepperDayState}) and a distinct rest-day glyph
        instead of an absent dot, which is a real improvement over what was
        here before — a planned Tuesday and a rest Tuesday used to draw
        identically once Tuesday itself was in the past.
      */}
      <WeekStepper
        testID="plan-week-stepper"
        days={days.map((d): WeekStepperDay => {
          const key = dayString(d);
          return {
            key,
            number: d.getDate(),
            state: weekStepperDayState({
              isToday: key === todayKey,
              isPast: key < todayKey,
              hasPlan: plans.some((pl) => pl.day === key),
            }),
            label: d.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }),
          };
        })}
      />

      <Pressable
        onPress={() => setExpanded((v) => !v)}
        hitSlop={10}
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={expanded ? 'Hide the week' : 'Show the week'}
        testID="plan-toggle-week"
      >
        <Text style={styles.toggleText}>{expanded ? 'HIDE WEEK' : 'SHOW WEEK'}</Text>
        <RNView style={expanded ? styles.up : styles.down}>
          <Icon name="chevron" size={11} color={vola.textDim} />
        </RNView>
      </Pressable>

      {expanded && (
      <View style={styles.card}>
        {days.map((d, i) => {
          const key = dayString(d);
          const mine = plans.filter((p) => p.day === key);
          const isToday = key === todayKey;
          // Yesterday is not a planning target — it is history, and offering
          // to fill it in invites a plan that can never be started.
          const isPast = key < todayKey;

          return (
            <RNView key={key} style={[styles.day, i > 0 && styles.dayDivided]}>
              <RNView style={styles.dayHead}>
                <RNView style={styles.dayName}>
                  <Text
                    style={[
                      styles.weekday,
                      isToday && [styles.weekdayToday, { color: accent.ink }],
                    ]}
                  >
                    {d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
                  </Text>
                  <Text style={[styles.date, isPast && styles.dimmed]}>
                    {String(d.getDate()).padStart(2, '0')}
                  </Text>
                </RNView>

                {!isPast && (
                  <Pressable
                    onPress={() => setPlanning(key)}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={`Plan ${d.toLocaleDateString(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })}`}
                    testID={`plan-add-${key}`}
                  >
                    <Text style={[styles.add, { color: accent.ink }]}>+ Add</Text>
                  </Pressable>
                )}
              </RNView>

              {mine.length === 0 ? (
                <Text style={[styles.rest, isPast && styles.dimmed]}>
                  {isPast ? '—' : 'Rest'}
                </Text>
              ) : (
                mine.map((p) => {
                  const target = plannedEntryTarget(p, names);
                  // One lookup feeding the title, the label and the chevron.
                  // They were two copies agreeing by luck: both fall back when
                  // the name is empty, so they match today — but the predicate
                  // deciding to open a blank-named workout would leave the row
                  // navigating while still announcing the sport fallback. That
                  // is the same drift this fix exists to remove.
                  const name = target ? names[target] : null;
                  // N442: the class-plan-linked case, mutually exclusive with
                  // `target` on the server (see plan.go's
                  // `plans_one_template_kind`), so at most one of the two
                  // navigates. No local name to show — see
                  // `plannedClassPlanTarget`'s own comment — so this row
                  // falls back to the same "<Sport> session" text the
                  // template-less case already uses.
                  const classPlanTarget = plannedClassPlanTarget(p);
                  const opensWorkout = target !== null;
                  const opensClass = classPlanTarget !== null;
                  return (
                  <Pressable
                    key={p.id}
                    style={({ pressed }) => [styles.entry, pressed && styles.entryPressed]}
                    onPress={
                      opensWorkout
                        ? () => router.push(`/workout/${target}`)
                        : opensClass
                          ? () => router.push(`/classplans/${classPlanTarget}/run`)
                          : undefined
                    }
                    onLongPress={() => confirmRemove(p)}
                    accessibilityRole="button"
                    accessibilityLabel={`${name || labelFor(modules, p.sport)}, planned.${
                      opensWorkout ? ' Opens the workout.' : opensClass ? ' Starts the class.' : ''
                    } Long press to remove.`}
                    testID={`plan-entry-${p.id}`}
                  >
                    <RNView
                      style={[
                        styles.entryRule,
                        { backgroundColor: sportColor(p.sport) ?? accent.accent },
                      ]}
                    />
                    {sportIcon(p.sport) && (
                      <RNView
                        style={[
                          styles.entryBadge,
                          {
                            backgroundColor: sportTint(
                              sportColor(p.sport) ?? accent.accent,
                            ),
                          },
                        ]}
                      >
                        <Icon
                          name={sportIcon(p.sport)!}
                          size={15}
                          color={sportColor(p.sport) ?? accent.accent}
                        />
                      </RNView>
                    )}
                    <RNView style={styles.entryMain}>
                      <Text
                        style={[
                          styles.entrySport,
                          { color: sportColor(p.sport) ?? vola.textDim },
                        ]}
                      >
                        {labelFor(modules, p.sport).toUpperCase()}
                      </Text>
                      <Text style={styles.entryTitle} numberOfLines={1}>
                        {/* Falls back to the discipline when the plan names a
                            template the cache no longer holds — see lib/plan.ts
                            on why there is no foreign key. Same `name` the
                            chevron and the label read, so a row can never
                            announce one thing and open another. */}
                        {name || `${labelFor(modules, p.sport)} session`}
                      </Text>
                    </RNView>
                    {/* Only when there is somewhere to go. A chevron on an
                        inert row is the whole bug this fixes. */}
                    {(opensWorkout || opensClass) && (
                      <Icon name="chevron" size={13} color={vola.textDim} />
                    )}
                  </Pressable>
                  );
                })
              )}
            </RNView>
          );
        })}
      </View>
      )}

      {expanded && (
        <Text style={styles.hint}>Long-press a planned session to remove it.</Text>
      )}

      <PickSessionSheet
        visible={planning !== null}
        modules={modules}
        userId={userId}
        title={
          planning
            ? // The date, not just the weekday. "Plan Tuesday" could only mean
              // this week's Tuesday before the calendar could move; it can now
              // mean one five weeks out, and the confirmation has to match
              // what was actually tapped.
              `Plan ${new Date(`${planning}T00:00:00`).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'short',
              })}`
            : 'Plan'
        }
        onClose={() => setPlanning(null)}
        onPick={(pick) => {
          const day = planning;
          setPlanning(null);
          if (day) add(day, pick.sport, pick.workoutId);
        }}
      />

      <Modal
        visible={monthOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setMonthOpen(false)}
      >
        {/* Gated on `monthOpen`, not left to `Modal` to decide. JSX children
            are evaluated by the parent before the modal renders, so the grid
            was being built — and ~42 `toLocaleDateString` calls made for the
            cell labels — on every render of a tab the athlete keeps open. */}
        {monthOpen && (
        <View style={styles.sheet} lightColor={vola.bg} darkColor={vola.bg}>
          <RNView style={styles.sheetHead}>
            {/*
              Today lives HERE, not on the header, and it is what makes losing
              the header's Today pill an acceptable trade. `openMonth` opens on
              the *navigated* week's month, so from three months out "tap the
              label, tap today's cell" is five taps and today is not even on
              the grid. One button, in the place you already came to jump from.

              It also balances the row: `Done` is on the right, so without
              something of similar weight on the left the switcher centres
              itself ~30pt off the sheet's true middle.
            */}
            <Pressable
              onPress={() => {
                const today = new Date();
                setNow(today);
                setAnchor(today);
                setMonthOpen(false);
              }}
              hitSlop={12}
              style={styles.sheetToday}
              accessibilityRole="button"
              accessibilityLabel="Today, back to this week"
              testID="plan-month-today"
            >
              <Text style={styles.close}>Today</Text>
            </Pressable>

            {/* Same switcher, without the disclosure icon: this IS the
                calendar that icon would open. */}
            <RNView style={styles.sheetSwitcher}>
              <PeriodSwitcher
                label={monthAnchor
                  .toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
                  .toUpperCase()}
                onPrev={() => stepMonth(-1)}
                onNext={() => stepMonth(1)}
                prevLabel="Previous month"
                nextLabel="Next month"
                testID="plan-month"
              />
            </RNView>
            <Pressable
              onPress={() => setMonthOpen(false)}
              hitSlop={12}
              style={styles.sheetClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="plan-month-close"
            >
              <Text style={styles.close}>Done</Text>
            </Pressable>
          </RNView>

          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={styles.sheetHint}>Pick a day to plan that week.</Text>

            <RNView style={styles.gridHead}>
              {days.map((d) => (
                <Text key={d.toISOString()} style={styles.gridHeadCell}>
                  {d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase()}
                </Text>
              ))}
            </RNView>

            {monthGrid(monthAnchor).map((row) => (
              <RNView key={row[0].key} style={styles.gridRow}>
                {row.map((cell) => {
                  const isToday = cell.key === todayKey;
                  const planned = monthDays.has(cell.key);
                  // The week the rows are already showing, so the grid says
                  // where you are rather than only where you could go.
                  const inShownWeek = days.some((d) => dayString(d) === cell.key);
                  return (
                    <Pressable
                      key={cell.key}
                      style={[styles.gridCell, inShownWeek && styles.gridCellShown]}
                      onPress={() => {
                        setAnchor(cell.date);
                        setMonthOpen(false);
                      }}
                      accessibilityRole="button"
                      // The highlight is the only thing saying "this is the
                      // week behind the sheet", and a tint says nothing to a
                      // screen reader — the same gap `TrainingCalendar` closes
                      // with `selected` on its own cells.
                      accessibilityState={{ selected: inShownWeek }}
                      // Every state is named rather than left to the dot,
                      // matching `TrainingCalendar` — a cell that reads out as
                      // a bare number tells a screen reader nothing about the
                      // plan, which is the whole content of this grid.
                      accessibilityLabel={[
                        cell.date.toLocaleDateString(undefined, {
                          weekday: 'long',
                          day: 'numeric',
                          month: 'long',
                        }),
                        isToday ? 'today' : null,
                        planned ? 'planned' : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                      testID={`plan-month-day-${cell.key}`}
                    >
                      <Text
                        style={[
                          styles.gridDate,
                          !cell.inMonth && styles.gridSpill,
                          isToday && styles.gridToday,
                        ]}
                      >
                        {cell.date.getDate()}
                      </Text>
                      {/* Always rendered, so a dot appearing never shifts the
                          row's height — the same placeholder trick the Today
                          calendar's markers use. */}
                      <RNView style={[styles.gridDot, planned && styles.gridDotOn]} />
                    </Pressable>
                  );
                })}
              </RNView>
            ))}
          </ScrollView>
        </View>
        )}
      </Modal>
    </RNView>
  );
}

/**
 * One week's theme, as a row above the strip — N82.
 *
 * `WeekPlanner` renders this with `key={weekStartKey}`, and that key is the
 * whole mechanism: this component's own `theme`/`editing`/`draft` state is
 * thrown away and rebuilt from scratch whenever the shown week changes, so
 * there is nothing here that resets state in a `useEffect` in response to a
 * prop — which is what would otherwise trip
 * `react-hooks/set-state-in-effect` for exactly the reason its docs give
 * (derive or reset via `key`, not via an effect that mirrors a prop into
 * state). The read effect below is the one exception, and it avoids the same
 * rule the way `app/(tabs)/index.tsx`'s identical read does: the `setState`
 * call sits inside a promise `.then`, not as a bare statement in the effect
 * body, which is the shape the rule treats as "subscribe to an external
 * system, `setState` in the callback" rather than as a synchronous effect
 * side-effect.
 *
 * **Network-only, deliberately not cached**, matching Today's read of the
 * same value: a theme is one short string that changes weekly, so a stale one
 * read offline is worse than none — it would claim a block the athlete has
 * already moved past.
 *
 * Full parity with web's own `ThemeRow`, not a reduction: web edits only
 * `title` too (its own `setTheme` call always sends `notes: ""`), so there is
 * nothing narrower to build. Three states, matching `ThemeRow`: editing (a
 * text field plus Save/Cancel), set-but-not-editing (the title, tappable to
 * edit), and unset-and-not-editing (a "+ Theme" affordance, always visible
 * here — unlike web's hover-only reveal, which has no equivalent on a touch
 * screen with nothing to hover).
 *
 * keyboard-container: provided by parent — `WeekPlanner` (this row's only
 * caller) is itself rendered exactly once in production, as the
 * `ListHeaderComponent` of `app/(tabs)/workouts.tsx`'s
 * `KeyboardAwareFlatList`, which already carries this file's input above the
 * keyboard. `WeekPlanner.tsx` also contains the month-jump sheet's bare
 * `<ScrollView>`, unrelated to this input (it holds day buttons, no text
 * field) and pre-dating this component — it only entered
 * `keyboardCoverage.test.ts`'s scan the moment this file gained a
 * `<SelectAllTextInput>` to trigger it, per that file's own `INPUT_TAGS`
 * comment on `SelectAllTextInput` counting as an input in its own right.
 */
export function WeekThemeRow({
  weekStart,
  getToken,
  reloadAt,
  lastSyncAt,
  accentInk,
}: {
  weekStart: string;
  getToken: TokenGetter;
  reloadAt: number;
  lastSyncAt: number | null;
  accentInk: string;
}) {
  const [theme, setWeekTheme] = useState<Theme | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Whether a read has ever SUCCEEDED for this mounted instance — a "no theme
  // this week" answer counts, `false` (the never-loaded default) does not.
  // Ref, not state: flipping it must never itself trigger a render.
  const loadedOnce = useRef(false);

  // Reads on mount, on focus (`reloadAt`) and whenever a sync finishes
  // (`lastSyncAt`) — a theme set on web while the app was backgrounded should
  // not wait for a manual pull. `weekStart` is IN the dependency array (it
  // has to be, for the closure inside `.then`/`.catch` to read the right
  // value) but is inert in practice: this component is remounted by its
  // `key` whenever the shown week changes, so by the time this effect could
  // see a new `weekStart` the whole instance — and this ref — is already gone.
  useEffect(() => {
    let live = true;
    fetchThemes(getToken, { from: weekStart, to: weekStart })
      .then((ts) => {
        if (!live) return;
        loadedOnce.current = true;
        setWeekTheme(ts[0] ?? null);
      })
      .catch(() => {
        // Offline, or the endpoint is unreachable. On the FIRST read for this
        // week this degrades honestly to "no theme", matching Today's
        // identical read. On a background refetch (`reloadAt`/`lastSyncAt`
        // firing while a theme is already correctly on screen) it must NOT
        // stomp what is already shown — a transient failure on refocus would
        // otherwise flash "+ Theme" for a week that has one, and tapping that
        // opens a blank draft that could overwrite the real title on save.
        if (live && !loadedOnce.current) setWeekTheme(null);
      });
    return () => {
      live = false;
    };
  }, [getToken, weekStart, reloadAt, lastSyncAt]);

  async function save() {
    // A fast double-tap, or a keyboard-submit landing on top of a tap: Save's
    // own `disabled={busy}` does not gate `onSubmitEditing`, so this is the
    // one guard against two overlapping requests for the same edit.
    if (busy) return;
    const title = cleanThemeTitle(draft);
    setBusy(true);
    try {
      if (title === '') {
        // Clearing the box removes the theme, matching web: a week with an
        // empty title is not a state the model has. Skipped entirely when
        // there was nothing to remove, so an empty save on a themeless week
        // costs no request.
        if (theme) {
          await deleteTheme(getToken, weekStart);
          setWeekTheme(null);
        }
      } else {
        // `setTheme` returns the saved row, so the display updates from the
        // server's own value (its `updated_at`, in particular) rather than
        // needing a second round trip to read back what was just written.
        setWeekTheme(await setTheme(getToken, weekStart, { title }));
      }
      setEditing(false);
    } catch (err) {
      Alert.alert("Couldn't save that theme", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // A human-readable date for VoiceOver, matching how every other date-bearing
  // accessibility label in this file reads (`Plan ${weekday}, ${day} ${month}`
  // above) — the raw `YYYY-MM-DD` in `weekStart` is fine as a wire value and
  // wrong to speak aloud digit group by digit group.
  const weekLabel = new Date(`${weekStart}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  if (editing) {
    return (
      <RNView style={styles.themeEditRow} testID="plan-theme-edit">
        <SelectAllTextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          style={styles.themeInput}
          placeholder="What is this week for?"
          placeholderTextColor={vola.textMuted}
          maxLength={MAX_THEME_TITLE}
          returnKeyType="done"
          onSubmitEditing={save}
          accessibilityLabel={`Theme for the week of ${weekLabel}`}
          testID="plan-theme-input"
        />
        <Pressable
          onPress={save}
          disabled={busy}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          // Fixed, rather than left to the text child: the child reads "…"
          // while `busy`, and without this VoiceOver would announce "ellipsis,
          // button" mid-save instead of "Save, button, busy".
          accessibilityLabel="Save"
          testID="plan-theme-save"
        >
          <Text style={[styles.themeAction, { color: accentInk }, busy && styles.themeActionDisabled]}>
            {busy ? '…' : 'Save'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setEditing(false)}
          disabled={busy}
          hitSlop={10}
          accessibilityRole="button"
          testID="plan-theme-cancel"
        >
          <Text style={styles.themeCancel}>Cancel</Text>
        </Pressable>
      </RNView>
    );
  }

  return (
    <Pressable
      onPress={() => {
        setDraft(theme?.title ?? '');
        setEditing(true);
      }}
      style={styles.themeRow}
      accessibilityRole="button"
      accessibilityLabel={
        theme ? `Theme for this week: ${theme.title}. Edit.` : 'Set a theme for this week'
      }
      testID="plan-theme-open"
    >
      {theme ? (
        <Text style={styles.themeSet} numberOfLines={1}>
          {theme.title}
        </Text>
      ) : (
        <Text style={styles.themeUnset}>+ Theme</Text>
      )}
      <Icon name="pencil" size={12} color={vola.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },

  down: { transform: [{ rotate: '90deg' }] },

  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  themeSet: { fontSize: 13, fontWeight: '700', color: vola.lime, flexShrink: 1 },
  themeUnset: { fontSize: 13, color: vola.textDim },
  themeEditRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  themeInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  themeAction: { fontSize: 13, fontWeight: '700' },
  themeActionDisabled: { opacity: 0.5 },
  themeCancel: { fontSize: 13, fontWeight: '600', color: vola.textDim },

  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  day: { paddingVertical: 11, gap: 7 },
  dayDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: vola.line },
  dayHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dayName: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  weekday: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: vola.textDim },
  weekdayToday: {},
  date: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  dimmed: { color: vola.textDim, opacity: 0.55 },
  add: { fontSize: 13, fontWeight: '700' },
  rest: { fontSize: 13, color: vola.textDim },

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
  // Lime, unlike the session cards' green: this is an intention, not a result.
  // The discipline's colour, matching the session rows on Today — set at the
  // call site because it varies per entry.
  entryRule: { width: 3, alignSelf: 'stretch' },
  entryBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 9,
  },
  entryMain: { flex: 1, paddingVertical: 9, gap: 1 },
  entrySport: { fontSize: 9, fontWeight: '700', letterSpacing: 0.9, color: vola.textDim },
  entryTitle: { fontSize: 14, fontWeight: '700' },

  hint: { fontSize: 11, color: vola.textDim },

  sheet: { flex: 1 },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10 },
  toggleText: { color: vola.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  up: { transform: [{ rotate: '-90deg' }] },
  sheetSwitcher: { flex: 1 },
  sheetToday: { minWidth: 52 },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
  },
  sheetClose: { marginLeft: 'auto' },
  close: { fontSize: 14, fontWeight: '700', color: vola.lime },
  sheetBody: { padding: 14, gap: 2 },
  sheetHint: { fontSize: 12, color: vola.textDim, paddingBottom: 10 },

  gridHead: { flexDirection: 'row', paddingBottom: 6 },
  gridHeadCell: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: vola.textDim,
  },
  gridRow: { flexDirection: 'row' },
  gridCell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
  },
  gridCellShown: { backgroundColor: vola.surface },
  gridDate: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  // 0.5, matching TrainingCalendar. It matters more here: there a spill cell
  // only moves a selection, whereas this one navigates the week — and it is the
  // natural way to reach a week straddling two months.
  gridSpill: { color: vola.textDim, opacity: 0.5 },
  gridToday: { color: vola.lime, fontWeight: '800' },
  gridDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: 'transparent' },
  gridDotOn: { backgroundColor: vola.lime },
});
