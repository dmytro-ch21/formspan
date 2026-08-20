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
import {
  enabledSports,
  labelFor,
  moduleFor,
  moduleOffWithCatalog,
  moduleWithCatalog,
} from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';
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
import { accentGlow } from '@/lib/palette';

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
      {/* "Plan", not "Workouts": this screen is now the week's plan *and* the
          templates it draws from, and the tab bar has always called it Plan. */}
      {/* No bottom rule: the scope strip below owns this boundary and already
          draws one (`scopeRow`, `borderBottomColor: vola.line`). Content scrolls
          under THAT, not under the header — a rule here would be a second seam
          ~40pt above the first, which is the stacked-seams pattern this header
          exists to have removed. Raised in review on the W10 PR. */}
      <ScreenHeader title="Plan" contentScrollsUnder={false} />
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
                // spinner. Left true, the spinner is skipped and the OTHER
                // scope's workouts render in the new scope's layout until the
                // fetch lands: your own templates appear for a beat as VOLA
                // Workout tiles, which reads as a data bug rather than a
                // pending request. Clearing `workouts` instead would swap that
                // for a false "No VOLA Workouts yet".
                setEverLoaded(false);
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

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="workouts-error">
          {error}
        </Text>
      )}

      {loading && !everLoaded ? (
        <ActivityIndicator style={styles.loader} accessibilityLabel="Loading workouts" />
      ) : (
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
          // Inside the list rather than pinned above it, so the planner
          // scrolls away and the templates get the full screen when you are
          // browsing them. The Library's permanently-pinned ~300pt header is
          // the counter-example this avoids.
          //
          // `mine` only: the public tab is a browse surface over other
          // people's templates, and your own week has no business on it.
          ListHeaderComponent={
            scope === 'mine' ? (
              <View style={styles.planHeader}>
                <WeekPlanner userId={userId ?? null} modules={modules} />
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
            ) : null
          }
          ListEmptyComponent={
            error || !everLoaded ? null : (
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
      )}

      {scope === 'mine' && (
        <Pressable
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: accent.accent }, accentGlow(accent.accent),
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
  container: { flex: 1 },
  // A tab strip: a hairline under the whole row, and a 2pt accent bar under
  // whichever segment is selected. No fill on either.
  scopeRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
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
  list: { padding: 16, gap: 12 },
  // The list's own `gap` doesn't apply between a header and the first row, so
  // the spacing below the planner is the header's to own.
  planHeader: { gap: 18, marginBottom: 4 },
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
    // A flat pill on a dark ground cannot separate itself from a list that
    // scrolls underneath it. `shadowColor` is set INLINE to the accent, not to
    // black: 35% black over this bg is a 1.02:1 step — literally invisible —
    // and the accent instead reads as light coming off the pill. Same trick as
    // the one shadow in `TrainingCalendar` — including its `height: 0`, whose
    // comment is explicit that an offset makes it "read as a drop shadow rather
    // than light". Keeping 4 while taking the accent was the worst of both.
    //
    // On Android this is no longer elevation-only: RN 0.86 forwards
    // `shadowColor` to `setOutlineSpotShadowColor` on API 28+, so the tint
    // lands there too.
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
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
