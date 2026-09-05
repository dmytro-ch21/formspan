import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '@clerk/clerk-expo';
import { cachedWorkouts, cacheWorkouts, createLocalWorkout } from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  useWindowDimensions,
} from 'react-native';

import {
  KeyboardAwareFlatList,
  KeyboardAwareScrollView,
} from '@/components/KeyboardAwareScroll';
import { PlanHero } from '@/components/PlanHero';
import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { Text, View } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { CurriculaStrip } from '@/components/CurriculaStrip';
import { WeekPlanner } from '@/components/WeekPlanner';
import { dayString, shortDate, weekDays } from '@/lib/calendar';
import {
  enabledSports,
  labelFor,
  moduleFor,
  moduleOffWithCatalog,
  moduleWithCatalog,
} from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import type { PlannedOffer, Source } from '@/lib/trainBoard';
import { useAuthToken } from '@/lib/useAuthToken';
import { useTrainBoard } from '@/lib/useTrainBoard';
import {
  listWorkouts,
  GOALS,
  type Goal,
  type Sport,
  type Workout,
} from '@/lib/workouts';
import { vola } from '@/constants/Colors';
import { Icon } from '@/components/ui/Icon';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { useAccent } from '@/lib/AccentProvider';

/**
 * "1 exercise", not "1 exercises".
 *
 * Reachable on the browse shelf as well as your own list — anyone can publish a
 * one-movement plan — and the tile had it wrong while the row beside it had it
 * right, which is the version of this bug that survives review.
 */
function countLabel(n: number): string {
  return `${n} ${n === 1 ? 'exercise' : 'exercises'}`;
}

/**
 * Room under the list for the floating New workout pill.
 *
 * 12pt of padding twice, the label's line box, and the 16pt the pill sits above
 * the bottom — plus air. **Derived from the font scale rather than fixed**,
 * because the label grows with the system text size and the paddings do not: a
 * constant 72 was measured to clear at default and through XXXL, and to
 * re-create the very overlap this exists to fix from Accessibility Large up.
 *
 * **Read live, not at module scope.** `PixelRatio.getFontScale()` is a snapshot
 * of `Dimensions`, so a `const` here freezes at bundle load — and iOS does not
 * restart the JS bundle when you change the text size and come back. The one
 * person this formula exists for would have kept the old clearance until the
 * next cold start. `useWindowDimensions` re-renders instead.
 *
 * The pill's label is `numberOfLines={1}`, which is what keeps this linear: at
 * the very top of the range "New workout" no longer fits the screen width, and
 * a second line would put the pill back over the list.
 */
function fabClearance(fontScale: number): number {
  return 44 + 20 * fontScale;
}

const SCOPES = [
  { key: 'mine', label: 'My workouts' },
  { key: 'public', label: 'VOLA Workouts' },
] as const;

export default function WorkoutsScreen() {
  const accent = useAccent();
  // For the sport label on each card — the registry carries the acronym, so
  // this renders "BJJ" rather than the "Bjj" that capitalising a key gives.
  const router = useRouter();
  const { modules } = useModules();
  // A technique discipline this server HAS, which this athlete has turned off.
  // Distinct from "no such discipline exists" — see the Roadmaps strip below,
  // and N61 for why the difference is the whole bug.
  const offTechniqueSport = moduleOffWithCatalog(modules, 'techniques');
  const getToken = useAuthToken();
  const { userId } = useAuth();

  const [scope, setScope] = useState<'mine' | 'public'>('mine');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [everLoaded, setEverLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // Refreshed on focus rather than ticked, and for the same reason Train's copy
  // was: a tab screen stays mounted for the life of the process, so a `Date`
  // captured at mount still says Sunday on Monday morning — and both the week
  // this screen draws and the "beyond this week" boundary below are measured
  // from it. Nothing here draws a running clock, so there is no interval.
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
    }, []),
  );
  // The same hook Train read, unchanged — `later` is the soonest planned day
  // strictly after today within `PLAN_WINDOW_DAYS`, off the same
  // `planned_sessions` table `WeekPlanner` above reads. Only `later` is
  // rendered here; see `NextPlannedBlock` for why the other three fields are
  // not this screen's business.
  //
  // **The cost is named rather than hidden**, because review counted it: this
  // adds a `listLocalSessions(userId, 30)` that only feeds `resume`/`today`/
  // `recent`, none of which this screen draws, plus a second
  // `listPlannedBetween` (a different window from the planner's) and a third
  // `cachedWorkouts`. Accepted for now on two grounds — they are local SQLite
  // reads over small tables on expo-sqlite's serial queue, and the ticket's
  // criterion is *moved, not reimplemented*, which a bespoke later-only read
  // would break. If Plan ever grows a heavier read, this is the term that
  // compounds, and a `useTrainBoard` variant taking the fields it is asked for
  // is the fix.
  const board = useTrainBoard(userId ?? null, modules, now);

  // Unconditional across scopes even though only `mine` renders the pill. One
  // constant beats a conditional here; the `public` list simply ends ~100pt
  // early, which is invisible next to the planner the header already drops.
  const { fontScale } = useWindowDimensions();
  const listPad = useMemo(
    () => ({ paddingBottom: TAB_BAR_CLEARANCE + fabClearance(fontScale) }),
    [fontScale],
  );

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // LOCAL FIRST. The plan is the thing you walk into a gym holding, and
    // until now this screen went straight to the network — so with no signal
    // it showed an error where the workouts should be, even though they were
    // already cached on the device for the offline session-start path.
    //
    // Only for `mine`: the public tab is a browse surface over other people's
    // templates, and there is no honest local answer for "what has everyone
    // published" — an empty list would read as "nobody has shared anything".
    if (scope === 'mine' && userId) {
      try {
        const cached = await cachedWorkouts(userId);
        if (!controller.signal.aborted && cached.length > 0) {
          setWorkouts(cached);
          setEverLoaded(true);
          setLoading(false);
        }
      } catch {
        // The network read below is still the real attempt.
      }
    }

    try {
      const list = await listWorkouts(getToken, scope, controller.signal);
      if (!controller.signal.aborted) {
        // Cleared on success, not at request start — an error wiped up
        // front leaves the screen looking fine throughout a retry.
        setError(null);
        // Refresh the cache for next time. `mine` only: caching other
        // people's shared templates under this athlete's cache rows would
        // make them reappear as if they were theirs.
        if (scope === 'mine' && userId) {
          // Resolved to whatever this load should render, THEN committed once
          // below — so there is exactly one abort check in front of exactly one
          // `setWorkouts`, however the cache behaves.
          let next = list;
          try {
            // Re-checked here, not just at :85. `cacheWorkouts` reconciles —
            // it DELETEs rows missing from `list` — so letting a superseded
            // response reach it lets stale data delete fresh rows, possibly
            // after the newer load has already read the cache back. The queue
            // widened this window from a microtask to however long the catalog
            // write ahead of it takes.
            if (controller.signal.aborted) return;
            await cacheWorkouts(userId, list);
            // Render the RECONCILED cache, not the raw response.
            //
            // `cacheWorkouts` already keeps rows the server hasn't heard of and
            // drops ones it has deleted; rendering `list` threw that away. A
            // workout created offline vanished from the list the moment a stale
            // `listWorkouts` response landed — reliably, not rarely, because
            // creating one fires the sync request and this reload together —
            // and came back on the next focus. Reading back through the cache
            // makes what is on screen the same thing that is on disk.
            next = await cachedWorkouts(userId);
          } catch (cacheErr) {
            // A CACHE failure is not a PLAN failure.
            //
            // By here the server has already answered, so the athlete's plan is
            // in hand. Letting a write to the offline cache reach the outer
            // catch put a red SQLite banner ("cannot rollback - no transaction
            // is active") over the week's training instead of the training —
            // the loudest possible presentation of the least important failure
            // on this screen.
            //
            // Fall back to READING the cache, not to `list`. What just failed
            // is a write; `cachedWorkouts` is a plain SELECT with no
            // transaction, so it will almost certainly still answer — and it
            // keeps the offline-created workouts that `list` structurally
            // cannot contain. Rendering `list` here would show a confident
            // "No workouts yet" to an athlete holding unpushed templates,
            // whenever the server list happened to be empty.
            let readErr: unknown;
            try {
              const fallback = await cachedWorkouts(userId);
              // Non-empty only — the same guard the cache-first read above
              // uses. On a first launch the write is what would have populated
              // the cache, so a failed write leaves it empty, and preferring it
              // would render "No workouts yet" over a list the server just
              // returned. Empty here means "no local answer", not "none exist".
              //
              // Known inversion, accepted: an athlete who deletes their ONLY
              // workout offline has a legitimately empty cache (the tombstone
              // is filtered by `deleted_at IS NULL`), so this hands the render
              // to `list` and the deleted workout reappears for one frame.
              // Telling the two apart needs a count that ignores `deleted_at`
              // — a new store export for a case that is already transient, on
              // an already-failing path, and self-corrects on the next focus.
              if (fallback.length > 0) next = fallback;
            } catch (err) {
              // Both halves of the cache are unusable. `list` is all that's
              // left, and it is still the server's current answer.
              readErr = err;
            }
            // Logged rather than shown. It is invisible to the athlete by
            // design, and a cache that fails every write would otherwise rot
            // the offline plan behind a screen that looks perfectly healthy.
            //
            // Both errors, because they are different halves: reporting only
            // the write would describe a wholly unusable cache by naming the
            // half that is merely the first to fail. In dev this raises a
            // LogBox notice (RN patches `console.warn` under `__DEV__` only);
            // release builds have no LogBox, so the athlete never sees it.
            console.warn('[plan] cache write failed; rendered without it', cacheErr, readErr);
          }
          if (controller.signal.aborted) return;
          setEverLoaded(true);
          setWorkouts(next);
        } else {
          setEverLoaded(true);
          setWorkouts(list);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      // So the empty state stops claiming the list is genuinely empty.
      setEverLoaded(true);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [getToken, scope, userId]);

  // Refetch on focus, so returning from the editor shows the edit rather
  // than a stale list.
  useFocusEffect(
    useCallback(() => {
      load();
      return () => abortRef.current?.abort();
    }, [load]),
  );

  return (
    <View style={styles.container} testID="workouts-screen">
      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="workouts-error">
          {error}
        </Text>
      )}

      <KeyboardAwareFlatList
        /*
          Keyed on scope, and that is not cosmetic: React Native throws
          "Changing numColumns on the fly is not supported" — the tab strip
          switches between one and two columns, so the list has to be a new
          list rather than the same one reconfigured.
        */
        key={scope}
        numColumns={scope === 'public' ? 2 : 1}
        columnWrapperStyle={scope === 'public' ? styles.tileRow : undefined}
        data={workouts}
        keyExtractor={(w) => w.id}
        contentContainerStyle={[styles.list, listPad]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        // Inside the list rather than pinned above it — the header AND the
        // scope strip both live here now (N498), so the planner scrolls
        // away and the templates get the full screen when you are browsing
        // them, and the screen title behaves the same as Today/Food/You's
        // instead of freezing in place while the list scrolls under it.
        // Always rendered (not gated on `scope === 'mine'` the way the
        // planner content below still is) — both the title and the tab
        // strip belong to the SCREEN, not to one scope of it, and pinning
        // that decision to `mine` would make them vanish on `public`, which
        // is where an athlete taps to get back is if they landed here from
        // a link.
        ListHeaderComponent={
          <View>
            {/* `marginHorizontal: -20` cancels `styles.list`'s own 20pt
                horizontal padding for JUST this row — `ScreenHeader`
                already carries its own 20pt (`ScreenHeader.tsx`'s `wrap`
                style), so left un-cancelled here it would sit 40pt in
                instead of 20, out of step with the tab strip and every card
                below it. See N498's history entry for the full padding
                reconciliation (this screen's content used to sit at 16pt
                against the header's 20). */}
            <View style={styles.headerInList}>
              {/* Scrolls away with the rest of the plan now, matching
                  Today/Food/You — see `ScreenHeader`'s own doc comment on
                  the three header/scroll arrangements. No bottom rule:
                  nothing is pinned above this list any more (the scope
                  strip moved in here too, just below), so there is no
                  boundary for content to pass under. */}
              <ScreenHeader title="Plan" contentScrollsUnder={false} />
            </View>
            {/*
              A tab strip with an underline, not two filled buttons.

              It used to be a pair of full-width pills whose selected half took the
              accent as a solid fill — the same weight, colour and footprint as the
              screen's primary action, sitting directly above it. Two accent slabs,
              neither reading as more important than the other. Switching between two
              views of one list is navigation, not an action, so the accent is left to
              mean "this button does something".

              **An underline rather than the raised thumb this first became.** That
              version put `accent.ink` on `surfaceRaised`, and review measured the
              blue theme at 4.37:1 — under the 4.5 the palette rule requires, on the
              one surface `validate_palette.mjs` never checks (it asserts ink against
              `surface` only, so the gate was green and blind). The label now sits on
              the page ground, where the existing assertion already covers it: blue,
              the worst case, is 5.15:1.

              The bar also fixes what the thumb never did. `surfaceRaised` on
              `surface` is a 1.09:1 step — invisible — so "which one is selected" was
              carried by hue alone, and inverted on the blue and purple themes where
              the selected label is *darker* than the unselected one. A bar that is
              present or absent is not a colour at all, and as a non-text indicator it
              clears 3:1 on every theme (purple, the worst, at 3.92).
            */}
            <View style={styles.scopeRow}>
              {SCOPES.map((s) => {
                const active = scope === s.key;
                return (
                  <Pressable
                    key={s.key}
                    onPress={() => {
                      setScope(s.key);
                      setLoading(true);
                      // `everLoaded` means "has THIS scope loaded", not "has the
                      // screen ever loaded" — so a switch resets it and you get the
                      // spinner.
                      setEverLoaded(false);
                      // Cleared here (N498), unlike before: this list no longer
                      // unmounts in favour of a sibling spinner while loading (see
                      // `ListEmptyComponent` below), so without this the OTHER
                      // scope's still-mounted rows would flash under the new
                      // scope's column layout for a frame — worse than the "VOLA
                      // Workout tiles under your own name" glitch the old comment
                      // here warned about, not better.
                      setWorkouts([]);
                    }}
                    style={[
                      styles.scopeTab,
                      active && [styles.scopeTabActive, { borderBottomColor: accent.accent }],
                    ]}
                    // `button`, not `tab`. RN maps "tab" to UIAccessibilityTraitNone
                    // on iOS — there is no per-tab trait — so VoiceOver would lose
                    // "button" and gain nothing, and outside a `tablist` Android
                    // still cannot say "1 of 2". `selected` below is what actually
                    // carries the state, on both platforms. Matches the app's other
                    // segmented control in `components/TrainingSummary.tsx`.
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    // The laid-out row is ~38.7pt (20 padding + 2 border + a 16.7pt
                    // line box at 14pt) — NOT the 34 an earlier version of this
                    // comment claimed by counting `fontSize` as the line box. With
                    // `paddingVertical: 12` it is ~42.7, and the slop above it lands
                    // in the strip's own margin, which nothing else claims. The slop
                    // BELOW would fall inside the FlatList's frame and lose the
                    // hit-test to it, so the target is bought by padding rather than
                    // by depending on sibling order.
                    hitSlop={{ top: 6, bottom: 6 }}
                    testID={`workouts-scope-${s.key}`}
                  >
                    <Text
                      style={[
                        styles.scopeText,
                        // `ink`, not `accent` — the palette defines `ink` as the
                        // accent used as TEXT, and they differ on purple precisely
                        // because the fill fails as type at 3.64:1.
                        active && [styles.scopeTextActive, { color: accent.ink }],
                      ]}
                    >
                      {s.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {/* `mine` only: the public tab is a browse surface over other
                people's templates, and your own week has no business on it. */}
            {scope === 'mine' && (
              <View style={styles.planHeader}>
                <WeekPlanner userId={userId ?? null} modules={modules} />
                {/* Directly under the week, because it is the week's
                    continuation and nothing else. See its docstring for why it
                    is conditional rather than always drawn. */}
                <NextPlannedBlock later={board.later} modules={modules} now={now} />
                {/* Between the week and the templates: a roadmap is what you
                    are working over months, which sits naturally after "this
                    week" and before "what do I run today". Gated on a
                    discipline whose catalog is TECHNIQUES rather than on
                    `key === 'bjj'` — the same predicate the web nav uses, and
                    the check this codebase avoids everywhere else. */}
                {moduleWithCatalog(modules, 'techniques') !== undefined ? (
                  <CurriculaStrip />
                ) : (
                  /* N61: this rendered NOTHING when the discipline was off, and
                     the user reported "roadmaps curricula are not there" from a
                     real phone. They exist and work.

                     Only when the discipline EXISTS and is off — a server with
                     no technique catalog at all shows nothing, because
                     promising a feature that is not there is the same lie in
                     the other direction. */
                  offTechniqueSport !== undefined && (
                    <Pressable
                      onPress={() => router.push('/profile/edit')}
                      style={({ pressed }) => [styles.curriculaOff, pressed && styles.curriculaOffPressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`${offTechniqueSport.label} is turned off. Turn it on to see the roadmaps`}
                      testID="plan-curricula-off"
                    >
                      <Text style={styles.curriculaOffTitle}>
                        {offTechniqueSport.label} is turned off
                      </Text>
                      <Text style={styles.curriculaOffNote}>
                        Turn it on to see your belt roadmaps here.
                      </Text>
                    </Pressable>
                  )
                )}
                <SectionHeader label="Templates" />
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          // The spinner used to be a sibling that replaced this whole list
          // while `loading`; now that the title and tab strip live INSIDE
          // the list (so they can scroll away like every other tab's), the
          // list has to stay mounted throughout so they stay visible during
          // the very first load too — so the spinner moves here instead.
          loading && !everLoaded ? (
            <ActivityIndicator style={styles.loader} accessibilityLabel="Loading workouts" />
          ) : error || !everLoaded ? null : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>
                {scope === 'mine' ? 'No workouts yet' : 'No VOLA Workouts yet'}
              </Text>
              <Text style={styles.muted}>
                {scope === 'mine'
                  ? 'Build a template once, then reuse it every session.'
                  : 'Ready-made plans you can copy and make your own.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) =>
          /*
            Two different cards, not one card bending.

            A VOLA Workout is something you are BROWSING — seventeen names
            you do not know — so it gets a square tile with artwork, laid out
            two to a row and scanned by picture. Your own workouts are a list
            you already know by name, so they stay a row: denser, and the
            artwork would be decoration over information you do not need.
          */
          scope === 'public' ? (
            <Link href={`/workout/${item.id}`} asChild>
              <Pressable
                style={styles.tile}
                accessibilityRole="button"
                // The sport is dropped — the tile does not show it, and the
                // label should describe what is there. The GOAL is added
                // back, because the tile does show it: as the glyph, which
                // the hero is `accessible={false}` for. Without this line a
                // screen reader is the one reader who cannot tell a
                // powerlifting plan from a conditioning one.
                accessibilityLabel={[
                  item.name,
                  GOALS.find((g) => g.key === item.goal)?.label,
                  countLabel(item.items.length),
                  item.owner_user_id === null ? undefined : 'community plan',
                ]
                  .filter(Boolean)
                  .join(', ')}
                testID={`workout-${item.id}`}
              >
                <PlanHero id={item.id} goal={item.goal} />
                <View style={styles.tileBody}>
                  <Text style={styles.tileName} numberOfLines={2}>
                    {item.name}
                  </Text>
                  {/* Who wrote it, on the tile rather than one tap in.
                      This shelf is called VOLA Workouts and most of it is
                      ours, but it also carries whatever anyone has published
                      — so an unmarked tile would put the brand's name on a
                      stranger's plan. Marking the exception rather than the
                      rule: seventeen "by VOLA" labels would be noise. */}
                  <Text style={styles.tileMeta} numberOfLines={1}>
                    {item.owner_user_id === null
                      ? countLabel(item.items.length)
                      : `Community · ${countLabel(item.items.length)}`}
                  </Text>
                </View>
              </Pressable>
            </Link>
          ) : (
          <Link href={`/workout/${item.id}`} asChild>
            <Pressable
              style={styles.card}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${item.sport}, ${countLabel(item.items.length)}`}
              testID={`workout-${item.id}`}
            >
              {/* The same two marks the Today screen's session rows use — a
                  rule down the edge and a tinted disc — so a template and the
                  session it becomes read as the same discipline. */}
              <View
                style={[
                  styles.cardRule,
                  { backgroundColor: sportColor(item.sport) ?? accent.accent },
                ]}
              />
              {sportIcon(item.sport) && (
                <View
                  style={[
                    styles.cardBadge,
                    { backgroundColor: sportTint(sportColor(item.sport) ?? accent.accent) },
                  ]}
                >
                  <Icon
                    name={sportIcon(item.sport)!}
                    size={18}
                    color={sportColor(item.sport) ?? accent.accent}
                  />
                </View>
              )}

              <View style={styles.cardBody}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{item.name}</Text>
                  {item.visibility === 'public' && (
                    <Text
                      style={[styles.badge, { color: accent.ink }]}
                      testID={`workout-${item.id}-public`}
                    >
                      Public
                    </Text>
                  )}
                </View>
                <Text style={styles.cardMeta}>
                  {labelFor(modules, item.sport)}
                  {item.goal ? ` · ${GOALS.find((g) => g.key === item.goal)?.label}` : ''}
                  {` · ${countLabel(item.items.length)}`}
                </Text>
                {/* No "VOLA template" line here any more. This card only
                    renders under `mine`, whose filter is `owner_user_id =
                    $1` — so the null-owner branch it was gated on could
                    never be true, and it named the shelf by its old name. */}
              </View>
            </Pressable>
          </Link>
          )
        }
      />

      {scope === 'mine' && (
        <Pressable
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: accent.accent },
            pressed && styles.fabPressed,
          ]}
          onPress={() => setComposing(true)}
          accessibilityRole="button"
          accessibilityLabel="New workout"
          // 41.8pt tall at default text size, 2.2 under the HIG's 44.
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          testID="workouts-new"
        >
          <Icon name="plus" size={16} color={accent.on} />
          {/* One line, always. At the largest accessibility sizes the label is
              wider than the screen, and a second line makes the pill tall
              enough to cover the list again — the bug this whole clearance
              exists to prevent. */}
          <Text numberOfLines={1} style={[styles.fabText, { color: accent.on }]}>
            New workout
          </Text>
        </Pressable>
      )}

      <NewWorkoutSheet
        visible={composing}
        onClose={() => setComposing(false)}
        onCreated={() => {
          setComposing(false);
          load();
        }}
      />
    </View>
  );
}

/**
 * The next planned day that the week above cannot show.
 *
 * ## Why this is not simply "Later, moved from Train"
 *
 * #587 was filed on the finding that Plan holds a template library and Train
 * holds the calendar. Half of that is right — Train did hold `Later` — and half
 * is not: `WeekPlanner`, directly above this, has drawn seven authoring rows
 * with template names, week arrows and a month-grid jump since long before
 * either ticket. **Plan already renders the forward schedule.** So lifting
 * Train's `Later` here unchanged would have drawn the same planned day twice on
 * one screen, a few hundred points apart — the W2/W4 duplicate shape, made
 * worse by being visible in a single glance rather than across two tabs.
 *
 * What the week genuinely cannot show is a plan **outside** it. `WeekPlanner`
 * opens on the current week and `refreshedAnchor` returns it there; `later`
 * looks {@link PLAN_WINDOW_DAYS} ahead. So an athlete with nothing this week
 * and a session booked on the 5th saw an empty planner and no hint the plan
 * existed. That gap is what this block fills, and it is the only thing it says.
 *
 * **It is the soonest plan OVERALL, not the soonest plan beyond the week**, and
 * the difference is worth knowing before reading the heading as a promise.
 * `lib/trainBoard.ts` picks the first day strictly after today; this block then
 * either shows it or defers. So an athlete with a session tomorrow *and* one on
 * the 5th sees nothing here — tomorrow is in the week above, and that is the
 * row answering "what is next". Widening it to "the soonest one outside the
 * week" would mean drawing a second forward answer beside the planner's, which
 * is the duplicate this block exists to avoid.
 *
 * The boundary is computed from `now` rather than from the planner's anchor.
 * That is deliberate: the anchor is `WeekPlanner`'s private state, and lifting
 * it out to make this pixel-perfect would couple an 827-line component to a
 * three-line one for a case the athlete has to deliberately navigate into. Both
 * directions drift, and both were raised in review: page the planner FORWARD
 * and this row may briefly name a day now visible above it; page it BACK and a
 * plan later this week is on screen nowhere. Transient duplicates and
 * transient gaps, in states the athlete navigated to on purpose, against
 * correctness in the state every visit starts in.
 *
 * ## Three states, and the fourth that is not a state
 *
 * `unread` draws nothing, because "we have not looked" is not "nothing is
 * planned" — the collapse `lib/trainBoard.ts` exists to prevent. `unavailable`
 * says so, and it is the ONLY honest signal on this screen when the plan read
 * fails: `WeekPlanner` deliberately renders an unreadable plan as an empty
 * week ("An unreadable plan is an empty week here, not an error banner"), so
 * without this the athlete is shown seven blank rows and told nothing.
 *
 * A `ready` answer that falls inside the visible week draws nothing, and that
 * is not a fourth state — it is this block deferring to the rows above, which
 * are already saying it better.
 */
function NextPlannedBlock({
  later,
  modules,
  now,
}: {
  later: Source<PlannedOffer | null>;
  modules: ReturnType<typeof useModules>['modules'];
  now: Date;
}) {
  // `unavailable` FIRST, and the two guards are deliberately not collapsed into
  // one `!== 'ready'`. Doing that is the exact regression this shape prevents:
  // it would put the failure note on screen during every cold open, asserting a
  // failed read before the read has answered.
  if (later.state === 'unavailable') {
    return (
      <View style={styles.nextSection}>
        <SectionHeader label="Beyond this week" />
        {/* #468's placeholder rule: dashed, because it stands WHERE the content
            would stand rather than beside it. */}
        <View style={styles.nextDashed} testID="plan-later-unavailable">
          <Text style={styles.nextDashedText}>
            The rest of your plan could not be read, so the week above may be
            missing days.
          </Text>
        </View>
      </View>
    );
  }

  // Not-yet-answered and answered-with-nothing draw the same thing — nothing —
  // and that is the one place they may be treated alike: neither ASSERTS
  // anything, which is what separates both from the note above.
  if (later.state !== 'ready' || later.value === null) return null;

  const p = later.value;
  // `weekDays` is the same Monday-anchored week `WeekPlanner` lays out, so this
  // boundary and the rows above cannot disagree about where the week ends.
  // String comparison, because `day` is `YYYY-MM-DD` and lexical order is date
  // order — no `Date` is constructed, so no timezone can shift it.
  if (p.day <= dayString(weekDays(now)[6])) return null;

  const title = p.workoutName ?? `${labelFor(modules, p.sport)} session`;
  const tone = sportColor(p.sport);
  const glyph = sportIcon(p.sport);

  return (
    <View style={styles.nextSection}>
      <SectionHeader label="Beyond this week" />
      {/* No button, and that is the rule rather than an omission: starting a
          session planned for next Tuesday today is how a plan stops meaning
          anything. Today's New log is one tab away for an athlete who means it.
          `text`, not `button`, so a screen reader is not told it acts. */}
      <View
        style={styles.nextRow}
        // `accessible` is what makes the two below fire at all. Without it iOS
        // does not group the row, so VoiceOver reads the title and the date as
        // separate elements and this label — the one sentence that says what
        // the row IS — is never announced, while the role is inert. Raised in
        // review; a label that does not fire is worse than no label, because it
        // reads as covered.
        accessible
        accessibilityRole="text"
        accessibilityLabel={`Next planned: ${title}, ${shortDate(p.day)}`}
        testID="plan-later"
      >
        {tone && glyph && (
          <View style={[styles.nextDisc, { backgroundColor: sportTint(tone) }]}>
            <Icon name={glyph} size={16} color={tone} />
          </View>
        )}
        <View style={styles.nextText}>
          <Text style={styles.nextTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.nextWhen}>{shortDate(p.day)}</Text>
        </View>
      </View>
    </View>
  );
}

function NewWorkoutSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (w: Workout) => void;
}) {
  const accent = useAccent();
  const [name, setName] = useState('');
  // The first sport this athlete actually trains, not a hardcoded 'strength'.
  // A strength-disabled athlete would otherwise silently create strength
  // workouts every time.
  const { modules } = useModules();
  const { userId } = useAuth();
  const startable = enabledSports(modules);
  const [sport, setSport] = useState<Sport>((startable[0]?.key ?? 'strength') as Sport);
  // Corrects itself when the registry resolves, and again if the selected
  // discipline is ever turned off.
  //
  // There was a `sportTouched` flag here to stop a late registry overwriting a
  // user's choice. It couldn't: a tap can only select a chip that is rendered,
  // and a rendered chip is by definition enabled, so the condition below is
  // already false for anything the user picked. All the flag actually did was
  // PRESERVE the one invalid state — a selection whose discipline was since
  // disabled, showing no active chip while still creating workouts in it.
  useEffect(() => {
    if (startable.length > 0 && !startable.some((m) => m.key === sport)) {
      setSport(startable[0].key as Sport);
    }
  }, [startable, sport]);
  const [goal, setGoal] = useState<Goal>('general');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Created LOCALLY, then pushed. A plan you build with no signal is a
      // plan, not a failed request — and the id is generated here, so the
      // push is idempotent and any session started from it references the
      // same workout the server eventually receives.
      const w = await createLocalWorkout(userId!, {
        name: name.trim(),
        sport,
        // Goal only applies to strength — sending one for a run would be
        // noise, and the API would rightly ignore it.
        // Capability, not a sport name: a future discipline with goals needs
        // no change here.
        goal: moduleFor(modules, sport)?.capabilities.has_goals ? goal : null,
        visibility: isPublic ? 'public' : 'private',
      });
      requestSync('workout-created');
      setName('');
      setIsPublic(false);
      onCreated(w);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={12}>
            <Text style={[styles.link, { color: accent.ink }]}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>New workout</Text>
          <Pressable
            onPress={submit}
            disabled={busy || !name.trim()}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || !name.trim(), busy }}
            hitSlop={12}
            testID="new-workout-create"
          >
            <Text
              style={[
                styles.link,
                { color: accent.ink },
                (!name.trim() || busy) && styles.linkDisabled,
              ]}
            >
              {busy ? '…' : 'Create'}
            </Text>
          </Pressable>
        </View>

        {/* The input is autofocused and the Discipline/Goal chips and the
            share toggle all render BELOW it, so with the keyboard up on a
            small phone they sat behind it with nothing to scroll — and
            `returnKeyType="done"` submits rather than dismisses, so there was
            no way past it. Same defect this branch fixed on the web version of
            this very dialog. It was missed by the migration because the
            migration converted scrollers that already existed, and this sheet
            never had one. */}
        <KeyboardAwareScrollView contentContainerStyle={styles.sheetBody}>
          <TextInput
            style={styles.input}
            placeholder="Name — e.g. Push Day A"
            placeholderTextColor="#767676"
            accessibilityLabel="Workout name"
            value={name}
            onChangeText={setName}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submit}
            maxLength={80}
            testID="new-workout-name"
          />

          <Text style={styles.label}>Discipline</Text>
          <View style={styles.chips}>
            {startable.length === 0 && (
              <Text style={styles.muted}>
                You haven&apos;t turned on any disciplines yet — choose what you train in your profile
                first.
              </Text>
            )}
            {startable.map((s) => (
              <Chip
                key={s.key}
                label={s.label}
                active={sport === s.key}
                onPress={() => {
                  setSport(s.key as Sport);
                }}
                testID={`new-workout-sport-${s.key}`}
              />
            ))}
          </View>
          <Text style={styles.hint}>
            A workout is one discipline — that&apos;s what lets the exercise picker show only what
            fits.
          </Text>

          {moduleFor(modules, sport)?.capabilities.has_goals && (
            <>
              <Text style={styles.label}>Goal</Text>
              <View style={styles.chips}>
                {GOALS.map((g) => (
                  <Chip
                    key={g.key}
                    label={g.label}
                    active={goal === g.key}
                    onPress={() => setGoal(g.key)}
                    testID={`new-workout-goal-${g.key}`}
                  />
                ))}
              </View>
            </>
          )}

          <Pressable
            style={styles.toggleRow}
            onPress={() => setIsPublic((v) => !v)}
            accessibilityRole="switch"
            accessibilityState={{ checked: isPublic }}
            accessibilityLabel="Share this workout publicly"
            testID="new-workout-public"
          >
            <View style={styles.toggleBody}>
              <Text style={styles.label}>Share publicly</Text>
              <Text style={styles.muted}>Anyone can view it. You stay the only editor.</Text>
            </View>
            <View
              style={[styles.switch, isPublic && [styles.switchOn, { backgroundColor: accent.accent }]]}
            >
              <View style={[styles.knob, isPublic && styles.knobOn]} />
            </View>
          </Pressable>

          {error && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
        </KeyboardAwareScrollView>
      </View>
    </Modal>
  );
}

export function Chip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const accent = useAccent();

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        active && [
          styles.chipActive,
          { backgroundColor: accent.accent, borderColor: accent.accent },
        ],
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={{ top: 8, bottom: 8 }}
      testID={testID}
    >
      <Text style={[styles.chipText, active && [styles.chipTextActive, { color: accent.on }]]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The Roadmaps strip's off-state. Shaped like a card rather than a bare
  // line so it reads as the thing that would be there, not as an error.
  curriculaOff: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  curriculaOffPressed: { opacity: 0.6 },
  curriculaOffTitle: { fontSize: 14, fontWeight: '600', color: vola.text },
  // textMuted, not textDim: at 12pt this is small text and textDim measures
  // 3.96:1 on the card, below AA.
  curriculaOffNote: { fontSize: 12, color: vola.textMuted, marginTop: 2 },

  // The "Beyond this week" block. No horizontal margin of its own: the plan
  // header renders inside the list's `contentContainerStyle`, which already
  // pads 16, and this block lines up with the `Templates` heading below it
  // rather than with the roadmaps card, which adds a second inset.
  nextSection: { gap: 10 },
  nextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  nextDisc: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextText: { flex: 1, gap: 1 },
  nextTitle: { fontSize: 16, fontWeight: '700' },
  // textMuted rather than textDim: at 12pt this is small text, and textDim
  // measures 3.96:1 on `bg`, below AA's 4.5:1.
  nextWhen: { fontSize: 12, color: vola.textMuted },
  nextDashed: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.lineSoft,
    borderRadius: 14,
    padding: 16,
  },
  nextDashedText: { fontSize: 13, lineHeight: 19, color: vola.textMuted },

  container: { flex: 1 },
  // N498 — cancels `list`'s own `paddingHorizontal: 20` for just the header
  // row: `ScreenHeader` already carries that same 20pt itself, so nested
  // inside the list's padding unchanged it would land at 40pt instead of the
  // 20pt every other tab's header sits at.
  headerInList: { marginHorizontal: -20 },
  // A tab strip: a hairline under the whole row, and a 2pt accent bar under
  // whichever segment is selected. No fill on either.
  //
  // No `marginHorizontal` of its own any more (N498) — it used to be the
  // strip's sole inset, back when it rendered as a sibling outside the list
  // entirely; now that it's the list's own `ListHeaderComponent`, `list`'s
  // `paddingHorizontal: 20` already places it exactly where the header and
  // every card below it sit.
  scopeRow: {
    flexDirection: 'row',
    marginTop: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
  },
  // The transparent border is load-bearing: without it the selected segment is
  // 2pt taller than the other and the labels shift when you switch.
  scopeTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  // Colour set inline, from the accent.
  scopeTabActive: {},
  scopeText: { fontSize: 14, fontWeight: '600', color: vola.textMuted },
  scopeTextActive: { fontWeight: '700' },
  loader: { marginTop: 32 },
  // `paddingBottom` is applied at the call site, from the live font scale —
  // TAB_BAR_CLEARANCE alone left the last row under the New workout pill, which
  // is what put it on top of the planner's hint line.
  //
  // `paddingHorizontal: 20` (N498, was 16) — matches `ScreenHeader`'s own
  // horizontal padding and every other tab's content inset, now that the
  // header and the scope strip both render inside this same list instead of
  // above it. See `headerInList` above for how the header itself opts back
  // out of this padding rather than sitting 40pt in.
  list: { paddingHorizontal: 20, gap: 12 },
  // The list's own `gap` doesn't apply between a header and the first row, so
  // the spacing below the planner is the header's to own.
  //
  // `marginTop: 16` (N498) restores the gap that used to come from `list`'s
  // own top padding, back when the planner was the very first thing inside
  // it — the scope strip now sits between the top of the list and this block.
  planHeader: { gap: 18, marginTop: 16, marginBottom: 4 },
  tileRow: { gap: 12 },
  tile: {
    // `flex: 1` inside a two-column wrapper, so the pair share the row evenly
    // whatever the names do. A fixed width would break at large text sizes.
    flex: 1,
    // …but capped, or the LAST row stretches when it holds one tile — and
    // `aspectRatio: 1` then doubles that tile's height, turning whichever plan
    // sorts last into a banner. The seeded catalog is seventeen, so every
    // athlete sees it on first open. (A lone tile lands 6pt wider than a
    // paired one, half the row gap it no longer shares. Imperceptible.)
    maxWidth: '50%',
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    overflow: 'hidden',
  },
  tileBody: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10, gap: 2 },
  tileName: { fontSize: 14, fontWeight: '700', lineHeight: 18 },
  tileMeta: { fontSize: 11, color: vola.textDim },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    overflow: 'hidden',
  },
  cardRule: { width: 3, alignSelf: 'stretch' },
  cardBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  cardBody: { flex: 1, padding: 14, gap: 4 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 17, fontWeight: '700', flexShrink: 1 },
  cardMeta: { fontSize: 13, color: vola.textMuted, textTransform: 'capitalize' },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: vola.surfaceRaised,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
  },
  empty: { alignItems: 'center', gap: 6, paddingTop: 48, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  error: { color: vola.danger, fontSize: 14, paddingHorizontal: 16, paddingTop: 10 },
  // A compact pill in the corner, not a full-width slab.
  //
  // It was `left: 16, right: 16` with 16pt of vertical padding — an accent bar
  // the width of the screen, which is the loudest thing an interface can do for
  // what, on a screen already full of templates, is an occasional action. It
  // also sat ON TOP of the planner's "long-press to remove" hint: the list
  // reserved only `TAB_BAR_CLEARANCE` under its content and the bar needed
  // roughly twice that. Both are fixed here — the pill is smaller, and
  // `list.paddingBottom` now accounts for it.
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 18,
    // NO GLOW (N108/N444, #741). This used to bloom the accent colour behind
    // the pill on the "flat pill can't separate from scrolling content"
    // argument — a real one, but Today's identically-shaped "New log" never
    // got that treatment (N108: "the user has said twice that they do not
    // want haze anywhere"), and the user reported the mismatch directly:
    // "New Log one has glow another doesnt - they both should be more
    // modern". N108's flat answer wins for both, so this pill now matches
    // Today's exactly — same radius, same padding, same `bottom`, and now
    // the same absence of a shadow, not just the first three.
  },
  fabPressed: { opacity: 0.85 },
  // No `color` here: the call site always sets it from `accent.on`, and a
  // default that is never used is a wrong-colour bug waiting for the first
  // caller who renders this without one.
  fabText: { fontWeight: '700', fontSize: 15 },

  // A Modal renders outside the navigator, so nothing paints behind it —
  // this is the one place a screen-level container has to set its own
  // background. Without it the sheet falls through to iOS's default
  // white and the near-white body text disappears into it.
  sheet: { flex: 1, paddingHorizontal: 20, paddingTop: 20, backgroundColor: vola.bg },
  // The gap moved here from `sheet` with the content: it belongs to the
  // scrolling body now, not to the fixed shell holding the header.
  sheetBody: { gap: 12, paddingTop: 12, paddingBottom: 24 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  link: { fontSize: 16, fontWeight: '600' },
  linkDisabled: { opacity: 0.35 },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
    marginTop: 8,
  },
  label: { fontSize: 15, fontWeight: '600', marginTop: 8 },
  hint: { fontSize: 12, color: vola.textMuted },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  chipActive: {},
  chipText: { fontSize: 14, fontWeight: '600' },
  chipTextActive: {},
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  toggleBody: { flex: 1 },
  switch: {
    width: 50,
    height: 30,
    borderRadius: 999,
    backgroundColor: vola.line,
    padding: 3,
    justifyContent: 'center',
  },
  switchOn: {},
  knob: { width: 24, height: 24, borderRadius: 999, backgroundColor: vola.surface },
  knobOn: { alignSelf: 'flex-end', backgroundColor: vola.navy },
});
