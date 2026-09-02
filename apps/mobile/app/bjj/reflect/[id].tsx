import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import {
  KeyboardAwareFooter,
  KeyboardAwareScreen,
  KeyboardAwareScrollView,
} from '@/components/KeyboardAwareScroll';
import { LibraryTile, categoryBadge } from '@/components/LibraryTile';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  FUNNEL_OUTCOMES,
  LIVE_ROWS,
  POSITIONS,
  bumpTechniqueOutcome,
  removeDrilledTechnique,
  tagCount,
  techniqueOutcomeCount,
  familyOf,
  toCategory,
  type Category,
  type Event,
  type SessionDetail,
} from '@/lib/bjjSession';
import { readLocalBjjDetail, saveLocalBjjDetail } from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { fetchFocus, focusRows, type Focus } from '@/lib/bjjFocus';
import { fetchTechniques, rankTechniques, type TechniqueSummary } from '@/lib/techniques';
import {
  MAX_SEQUENCE_NAME,
  MAX_SEQUENCE_STEPS,
  captureSequence,
  getSequence,
  listSequences,
  pendingSequences,
  type Sequence,
} from '@/lib/sequences';
import { useAuthToken } from '@/lib/useAuthToken';
import { fetchProficiency, type Proficiency } from '@/lib/proficiency';
import { LEARNING_STATE_LABEL, displayLearningState } from '@/lib/learningState';
import { LearningStateBadge } from '@/components/LearningStateBadge';
import { listWorkingCurricula, type Curriculum } from '@/lib/curriculum';
import { RoadmapLine } from '@/components/RoadmapLine';

/**
 * The reflection wizard — everything past the three-tap floor.
 *
 * **Entirely optional, and it has to stay that way.** The session was already
 * saved before this screen opened; nothing here is required for the log to
 * count. `docs/decisions/bjj-tracking-design.md` is explicit that a mandatory
 * two-minute wizard kills the habit, so every step skips, the header offers
 * Done at all times, and leaving early loses nothing.
 *
 * **Why it is worth asking at all.** Memory of individual rolls decays
 * absurdly fast — by the drive home "I got swept a lot" is all that survives
 * of what was, mat-side, "he kept getting the underhook in half guard because
 * I was lazy with my frames." Everything downstream (the technique funnel,
 * the position heatmap, gap detection, eventually the gameplan) is a read
 * over what gets captured in this window, which is why the schema records
 * position and outcome direction from the first migration rather than
 * retrofitting them onto months of history that lacks them.
 *
 * **Evidence, never self-assessment.** No step asks the athlete to rate
 * anything. Each one records what happened — drilled this, hit that, got
 * caught by the other — because a fact stays true and a rating goes stale.
 */

type Step = 'drilled' | 'live' | 'note';

const STEPS: { key: Step; title: string; blurb: string }[] = [
  { key: 'drilled', title: 'What did you drill?', blurb: 'Techniques you worked, live or not' },
  { key: 'live', title: 'What happened live?', blurb: 'Both directions — this is the useful part' },
  { key: 'note', title: 'Anything worth remembering?', blurb: 'What the chips above can’t hold' },
];

export default function ReflectScreen() {
  const accent = useAccent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { userId } = useAuth();
  const getToken = useAuthToken();

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!userId || !id) return;
    let cancelled = false;
    readLocalBjjDetail(userId, id)
      .then((d) => {
        if (cancelled) return;
        // No local reflection means this screen was reached for a session
        // that isn't a BJJ log — a stale link, or a session created on
        // another device and not yet pulled. Withhold the form rather than
        // start an empty one that would save over nothing.
        if (!d) setMissing(true);
        else setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, id]);

  /**
   * Persist after every change, not on a Save button.
   *
   * The reflection is worth more the earlier it is captured, and a wizard
   * that loses two steps because the phone rang is a wizard people stop
   * trusting. Local write first; the outbox carries it whenever it can.
   */
  const persist = useCallback(
    async (next: SessionDetail) => {
      setDetail(next);
      if (!userId || !id) return;
      try {
        await saveLocalBjjDetail(userId, id, next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [userId, id],
  );

  /**
   * Debounced persist, for the free-text fields.
   *
   * Every write re-serialises the whole reflection and runs an UPDATE, so
   * calling `persist` per keystroke means one full JSON write per character
   * on the JS thread — and, because nothing serialises those writes, two in
   * flight can land out of order and store a stale note.
   *
   * The counters and chips deliberately keep writing immediately: they are
   * discrete, infrequent, and each one is a fact worth not losing. Only
   * typing is debounced. Same split as the session screen's `persistSoon`
   * (app/session/[id].tsx), including the flush on unmount — otherwise the
   * last few characters die with the screen.
   */
  const pending = useRef<SessionDetail | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistSoon = useCallback(
    (next: SessionDetail) => {
      setDetail(next);
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const p = pending.current;
        pending.current = null;
        if (p) void persist(p);
      }, 700);
    },
    [persist],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void persist(pending.current);
    },
    [persist],
  );

  /**
   * The cross-session technique funnel, fetched once — what lets a drilled or
   * focus row say "Reliable" instead of just "Drilled".
   *
   * Fetched here rather than inside `DrilledStep`/`LiveStep` so both steps
   * read the same snapshot from one request, matching the pattern `names`
   * already sets for technique names in `LiveStep` below. Silent on failure —
   * an accelerator, not a requirement: a learning-state badge that cannot be
   * shown just does not render, the wizard's actual capture surface (chips,
   * counters) is unaffected either way.
   */
  const [proficiency, setProficiency] = useState<ReadonlyMap<string, Proficiency>>(new Map());
  useEffect(() => {
    const c = new AbortController();
    fetchProficiency(getToken, c.signal)
      .then((rows) => setProficiency(new Map(rows.map((r) => [r.technique_id, r]))))
      .catch(() => {});
    return () => c.abort();
  }, [getToken]);

  /**
   * The roadmaps this athlete is actively on — reference only. `RoadmapLine`
   * is the SAME component Today renders; nothing about the roadmap itself is
   * re-derived here, per the ticket's own rule not to rebuild it. Shown on
   * the drilled step because that is where "what to work on" is being
   * decided; an athlete on no roadmap sees nothing, which is the existing
   * component's own behaviour on Today.
   */
  const [roadmaps, setRoadmaps] = useState<Curriculum[]>([]);
  useEffect(() => {
    const c = new AbortController();
    listWorkingCurricula(getToken, c.signal)
      .then(setRoadmaps)
      .catch(() => {});
    return () => c.abort();
  }, [getToken]);

  function finish() {
    // Anything still waiting on the debounce goes now, before the screen
    // and its timer are gone.
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current) {
      void persist(pending.current);
      pending.current = null;
    }
    requestSync('bjj-reflection-saved');
    // Back past the log screen to wherever the log was started from — the
    // floor screen used `replace` to get here, so there is nothing to return
    // to and `back()` lands on Today.
    router.back();
  }

  if (missing) {
    return (
      <View style={styles.centre} testID="bjj-reflect-missing">
        <Stack.Screen options={{ title: 'Reflection' }} />
        <Text style={styles.centreTitle}>This session has no reflection to edit</Text>
        <Text style={styles.centreMuted}>
          It may have been logged on another device and not synced here yet.
        </Text>
      </View>
    );
  }

  if (!detail) {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Reflection' }} />
        <ActivityIndicator accessibilityLabel="Loading your session" />
      </View>
    );
  }

  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    /* The scroll view and the footer below it are siblings compensating for
       the same keyboard. `KeyboardAwareScreen` is how they find that out —
       without it both do, and the surplus inset shows up as a band of blank
       between the last line of content and the footer. */
    <KeyboardAwareScreen>
      <View style={styles.container} testID="bjj-reflect-screen">
        <Stack.Screen
          options={{
            title: `Step ${step + 1} of ${STEPS.length}`,
            headerRight: () => (
              <Pressable onPress={finish} hitSlop={12} accessibilityRole="button" testID="bjj-reflect-done">
                <Text style={[styles.headerAction, { color: accent.ink }]}>Done</Text>
              </Pressable>
            ),
          }}
        />

        {/* Progress. Three segments rather than a percentage: the athlete needs
            to know how much is left, and "60%" of an optional flow means
            nothing. */}
        <RNView style={styles.progress} accessible accessibilityLabel={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <RNView
              key={s.key}
              style={[
                styles.progressBar,
                i <= step && [styles.progressBarOn, { backgroundColor: accent.accent }],
              ]}
            />
          ))}
        </RNView>

        <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
          {error && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}

          <Text style={styles.stepTitle}>{current.title}</Text>
          <Text style={styles.stepBlurb}>{current.blurb}</Text>

          {/* Reference only — the SAME component Today renders, not a second
              copy of the roadmap. An athlete on no roadmap sees nothing here,
              matching that component's own behaviour. */}
          {current.key === 'drilled' &&
            roadmaps.map((c) => <RoadmapLine key={c.id} curriculum={c} />)}

          {current.key === 'drilled' && (
            <DrilledStep
              userID={userId ?? ''}
              detail={detail}
              onChange={persist}
              getToken={getToken}
              proficiency={proficiency}
            />
          )}
          {current.key === 'live' && (
            <LiveStep detail={detail} onChange={persist} getToken={getToken} proficiency={proficiency} />
          )}
          {current.key === 'note' && <NoteStep detail={detail} onChange={persistSoon} />}
        </KeyboardAwareScrollView>

        {/* A footer, not an RNView: it is a SIBLING of the scroll view, so the
            keyboard inset that rescues the list above cannot reach it. On the
            note step — the one step whose whole content is a text field — the
            keyboard sat straight over the only control that finishes the
            wizard. */}
        <KeyboardAwareFooter style={styles.footer}>
          <Pressable
            onPress={() => (last ? finish() : setStep((s) => s + 1))}
            style={styles.skip}
            accessibilityRole="button"
            testID="bjj-reflect-skip"
          >
            <Text style={styles.skipText}>{last ? 'Skip' : 'Skip this'}</Text>
          </Pressable>
          <Pressable
            onPress={() => (last ? finish() : setStep((s) => s + 1))}
            style={[styles.next, { backgroundColor: accent.accent }]}
            accessibilityRole="button"
            testID="bjj-reflect-next"
          >
            <Text style={[styles.nextText, { color: accent.on }]}>{last ? 'Save it' : 'Next'}</Text>
          </Pressable>
        </KeyboardAwareFooter>
      </View>
    </KeyboardAwareScreen>
  );
}

/* ── step 1: what was drilled ─────────────────────────────────────────── */

/**
 * The technique picker.
 *
 * Search-first over the whole library rather than a position drill-down: the
 * athlete already knows the name of what they just did fifty times, and
 * making them navigate a taxonomy to confirm it is slower than typing four
 * letters. Position filtering is what the Library tab is for.
 *
 * Tags land as `drilled`, which is the first stage of the funnel — the whole
 * point of recording it is that "drilled 12 times, attempted 0 in rolling" is
 * a finding, and it needs the left-hand number to exist.
 */
function DrilledStep({
  detail,
  onChange,
  getToken,
  userID,
  proficiency,
}: {
  detail: SessionDetail;
  onChange: (d: SessionDetail) => void;
  getToken: ReturnType<typeof useAuthToken>;
  userID: string;
  /** The cross-session funnel, keyed by technique id — see `ReflectScreen`. */
  proficiency: ReadonlyMap<string, Proficiency>;
}) {
  // `accent` is taken below for the technique badge's own colour.
  const ui = useAccent();
  const [all, setAll] = useState<TechniqueSummary[]>([]);
  const [query, setQuery] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    fetchTechniques(getToken, c.signal)
      .then((list) => setAll(list))
      .catch(() => {
        if (!c.signal.aborted) setFailed(true);
      });
    return () => c.abort();
  }, [getToken]);

  const drilled = detail.tags.filter((t) => t.event === 'drilled');

  // Ranked, not filtered. The cap only works if the ones it keeps are the best
  // ones: "side control" matches 50 techniques, and taking the first 8 in seed
  // order put three closed-guard armbars above every side-control one for an
  // athlete who had just drilled side control. 20 rather than 8 because the
  // shortlist is now worth scrolling.
  const matches = useMemo(() => (query.trim() ? rankTechniques(all, query) : []), [all, query]);
  const results = useMemo(() => matches.slice(0, 20), [matches]);

  // Sequences the athlete already has. `null` is still loading and `[]` is
  // genuinely none — collapsing them shows "no sequences" for a moment on
  // every open, which reads as "you have none" to someone who has plenty.
  const [sequences, setSequences] = useState<Sequence[] | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [chainName, setChainName] = useState('');
  const [savingChain, setSavingChain] = useState(false);
  const [chainSaved, setChainSaved] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const [chainBusy, setChainBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listSequences(userID, getToken)
      .then((list) => {
        if (!cancelled) setSequences(list);
      })
      // A server fault must not hide the chains this phone is still holding.
      // `listSequences` rejects the WHOLE promise on a 500 — including the
      // local half it had already read — so degrading to `[]` meant an outage
      // hid your own captures, while being offline showed them. Inconsistent,
      // and the wrong way round.
      .catch(async () => {
        if (cancelled) return;
        try {
          setSequences(await pendingSequences(userID));
        } catch {
          setSequences([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userID, getToken]);

  function add(t: TechniqueSummary) {
    if (drilled.some((d) => d.technique_id === t.id)) return;
    onChange({
      ...detail,
      tags: [
        ...detail.tags,
        {
          // The library's own category, lowercased to the tag vocabulary.
          // Anything outside the six symmetric ones lands as `control`,
          // which is the honest bucket for "worked on, no clean opposite".
          category: toCategory(t.category),
          event: 'drilled',
          position: familyOf(t.position),
          technique_id: t.id,
          count: 1,
        },
      ],
    });
    setQuery('');
  }

  function remove(techniqueID: string | null | undefined) {
    onChange({ ...detail, tags: removeDrilledTechnique(detail.tags, techniqueID) });
  }

  /**
   * Add every technique in a chain at once.
   *
   * Expands to ORDINARY drilled tags rather than recording "this sequence was
   * drilled". That is deliberate: the funnel, mastery, curricula progress and
   * every other read are built on technique tags, so a sequence-shaped tag
   * would be invisible to all of them. The chain is how you entered it, not a
   * different kind of evidence.
   *
   * The library lookup is the source of truth for category and position, with
   * the server's own step fields as the fallback — on a cold launch with no
   * signal `all` is empty, and a tag with a wrong category is worse than a
   * slightly generic one.
   */
  async function addChain(seq: Sequence) {
    setChainBusy(seq.id);
    setChainError(null);
    try {
      // Steps are fetched here rather than read off the list row: the list
      // omits them. Locally-captured chains short-circuit inside
      // `getSequence` from the outbox, so this costs no request offline for
      // the chains you just made — but a SYNCED chain genuinely needs the
      // network, and there is no local cache of one. Says so rather than
      // silently adding nothing.
      const full = seq.steps?.length ? seq : await getSequence(userID, seq.id, getToken);
      const steps = full?.steps ?? [];
      if (steps.length === 0) {
        setChainError(
          full === null
            ? 'Needs signal to open a synced sequence. What you captured on this phone still works offline.'
            : 'That sequence has no steps yet.',
        );
        return;
      }

      // The Set GROWS as we go. A snapshot let a chain that repeats a
      // technique — which the API explicitly allows, because sweep/get
      // passed/sweep again is ordinary grappling — add the same tag twice:
      // a double-counted `drilled` stage in the funnel, and two React rows
      // with the same key.
      const seen = new Set(drilled.map((d) => d.technique_id));
      const added = [];
      for (const st of steps) {
        if (!st.technique_id || seen.has(st.technique_id)) continue;
        seen.add(st.technique_id);
        const lib = all.find((t) => t.id === st.technique_id);
        added.push({
          category: toCategory(lib?.category ?? st.category ?? ''),
          event: 'drilled' as const,
          position: familyOf(lib?.position ?? st.position ?? ''),
          technique_id: st.technique_id,
          count: 1,
        });
      }
      if (added.length === 0) return;
      onChange({ ...detail, tags: [...detail.tags, ...added] });
    } catch (err) {
      setChainError(err instanceof Error ? err.message : String(err));
    } finally {
      setChainBusy(null);
    }
  }

  /**
   * Capture what was just drilled as a new chain.
   *
   * Local write first — the changing room is a dead-spot more often than not,
   * and this is the one moment the chain is still in the athlete's head. The
   * outbox owes it to the server; the id is generated on device so the retry
   * is idempotent.
   *
   * Steps carry no destinations. Naming where each move leaves you is the
   * refining half and belongs at a desk, per the platform rule — this records
   * the ORDER, which is the part that is lost by tomorrow.
   */
  async function saveChain() {
    const name = chainName.trim();
    if (!name || drilled.length < 2) return;
    // Guarded, because a capture written under an empty user id is selected by
    // NO query afterwards — not the list, not the count, not the push. It
    // would be permanently invisible and silently never sync. Narrow window
    // (Clerk going null with this screen mounted), permanent consequence.
    if (!userID) {
      setChainError('Sign-in state was lost. Reopen this step and try again.');
      return;
    }
    // The server caps these; a violation comes back 4xx, which the outbox
    // classifies permanent and retires — after the copy already said "Saved
    // to this phone". Keeping the permanent path rare is the premise the
    // whole outbox design rests on.
    if (name.length > MAX_SEQUENCE_NAME) {
      setChainError(`Keep the name under ${MAX_SEQUENCE_NAME} characters.`);
      return;
    }
    const steps = drilled.filter((d) => d.technique_id);
    if (steps.length > MAX_SEQUENCE_STEPS) {
      setChainError(
        `A sequence holds ${MAX_SEQUENCE_STEPS} steps. Remove a few, or save this as two chains.`,
      );
      return;
    }
    setSavingChain(true);
    try {
      await captureSequence(userID, {
        name,
        steps: steps.map((d) => ({ technique_id: d.technique_id as string })),
      });
      requestSync('bjj-sequence-captured');
      setChainName('');
      setCapturing(false);
      setChainSaved(true);
    } catch (err) {
      setChainError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingChain(false);
    }
  }

  // `step_count`, NOT `steps.length`. The list endpoint OMITS steps by design
  // — it is a list of fifty chains and shipping every step of every one is the
  // N+1 in its lazy form — so filtering on `steps` dropped every server-side
  // chain and, worse, made a captured chain VANISH from this bar the moment it
  // synced: it leaves the outbox, and the server copy carries no steps. That
  // looked exactly like data loss. `step_count` is on both list and detail.
  const usable = (sequences ?? []).filter((sq) => sq.step_count > 0);

  return (
    <RNView style={styles.stepBody}>
      {usable.length > 0 && (
        <RNView style={styles.chainBar}>
          <Text style={styles.label}>Drilled a sequence?</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {usable.map((sq) => (
              <Pressable
                key={sq.id}
                onPress={() => void addChain(sq)}
                disabled={chainBusy !== null}
                style={[styles.chainChip, chainBusy === sq.id && styles.chainChipBusy]}
                accessibilityRole="button"
                accessibilityLabel={`Add all ${sq.step_count} techniques from ${sq.name}`}
                testID={`bjj-chain-add-${sq.id}`}
              >
                <Text style={styles.chainChipName} numberOfLines={1}>
                  {sq.name}
                </Text>
                <Text style={styles.chainChipMeta}>
                  {chainBusy === sq.id
                    ? 'Opening…'
                    : `${sq.step_count} steps${sq.pending ? ' · not synced' : ''}`}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          {chainError && (
            <Text style={styles.muted} testID="bjj-chain-add-error">
              {chainError}
            </Text>
          )}
        </RNView>
      )}

      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Search techniques"
        placeholderTextColor={vola.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search techniques"
        testID="bjj-drilled-search"
      />

      {failed && all.length === 0 && (
        <Text style={styles.muted}>
          The technique library isn&apos;t loaded on this device yet. Open it once with a
          connection — You → Library — or skip this step; everything else still saves.
        </Text>
      )}

      {/*
        A query that matches nothing rendered a blank space, indistinguishable
        from an empty box — and this is the screen where that reads as "the
        technique isn't in the library", which is how a lookup bug became a
        plan to author a duplicate. Say it outright instead.

        Gated on `all.length` too: `all` starts empty and `failed` starts false,
        so without it a cold session claims "no match" for whatever is typed
        while the library is still downloading — the same false negative, on
        the same screen, arrived at from the other direction.
      */}
      {!failed && all.length > 0 && query.trim().length > 0 && results.length === 0 && (
        <Text style={styles.muted} testID="bjj-drilled-empty">
          No technique matches “{query.trim()}”. Try a shorter search or another spelling — or skip
          this step, everything else still saves.
        </Text>
      )}

      {results.map((t) => {
        const [code, accent] = categoryBadge(t.category);
        // What the search result already carries — showing it here, before
        // it is even added, is what lets an athlete recognise a technique
        // they already have reliable rather than finding out only after
        // drilling it a fourth time.
        const state = displayLearningState(proficiency, detail.tags, t.id);
        return (
          <Pressable
            key={t.id}
            onPress={() => add(t)}
            style={styles.result}
            accessibilityRole="button"
            accessibilityLabel={`Add ${t.name}, ${LEARNING_STATE_LABEL[state]}`}
            testID={`bjj-drilled-add-${t.id}`}
          >
            <LibraryTile code={code} accent={accent} />
            <RNView style={styles.resultBody}>
              <Text style={styles.resultName}>{t.name}</Text>
              <Text style={styles.muted} numberOfLines={1}>
                {t.position}
              </Text>
            </RNView>
            {state !== 'seen' && (
              <LearningStateBadge state={state} testID={`bjj-drilled-add-${t.id}-state`} />
            )}
            <Text style={[styles.plus, { color: ui.ink }]}>＋</Text>
          </Pressable>
        );
      })}

      {/*
        Say when the list is cut off. "side control" matches 62 and shows 20;
        without this the twentieth row is indistinguishable from the last one
        that exists, which on THIS screen reads as "the library doesn't have
        it" — the same false negative the empty-state copy above exists to
        prevent, arrived at from a third direction.
      */}
      {matches.length > results.length && (
        <Text style={styles.muted} testID="bjj-drilled-truncated">
          Showing the {results.length} best matches of {matches.length}. Keep typing to narrow it.
        </Text>
      )}

      {drilled.length > 0 && (
        <>
          <Text style={styles.label}>Drilled today</Text>
          {drilled.map((t) => {
            const name = nameFor(all, t.technique_id);
            // The state THIS row justifies right now, including the drilled
            // tag just added — so tapping "add" and landing here never shows
            // a stale "Seen" for a technique the athlete just drilled.
            //
            // Gated on `!== 'seen'` — the SAME condition the search results
            // and the live step's focus rows use, and it has to be, for a
            // real reason: `t.technique_id` is nullable (`ON DELETE SET NULL`
            // when a technique is retired, `bjjSession.ts`'s own comment on
            // `removeDrilledTechnique`), and `displayLearningState` reads
            // "seen" off a null id. An UNCONDITIONAL badge here showed "Seen"
            // on a row the session itself had just recorded as drilled — a
            // direct contradiction on the same line. Caught in review.
            const state = displayLearningState(proficiency, detail.tags, t.technique_id);
            return (
              <RNView key={t.technique_id ?? `${t.category}-${t.position}`} style={styles.drilledRow}>
                <RNView style={styles.drilledHead}>
                  <RNView style={styles.drilledNameCol}>
                    <Text style={styles.drilledName} numberOfLines={2}>
                      {name}
                    </Text>
                    {state !== 'seen' && (
                      <LearningStateBadge
                        state={state}
                        testID={`bjj-drilled-chip-${t.technique_id}-state`}
                      />
                    )}
                  </RNView>
                  <Pressable
                    onPress={() => remove(t.technique_id)}
                    style={styles.drilledRemove}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${name}`}
                    testID={`bjj-drilled-chip-${t.technique_id}`}
                  >
                    <Text style={styles.tagChipX}>×</Text>
                  </Pressable>
                </RNView>
              </RNView>
            );
          })}
          {/* Capture, and only once there is a CHAIN to capture. One technique
              is not a sequence, so the affordance stays hidden rather than
              appearing disabled — an offer you cannot take is noise on a step
              that is already optional. */}
          {drilled.length >= 2 && !chainSaved && (
            <RNView style={styles.captureBox}>
              {!capturing ? (
                <Pressable
                  onPress={() => setCapturing(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Save these techniques as a sequence"
                  testID="bjj-chain-capture-open"
                >
                  <Text style={[styles.captureCta, { color: ui.ink }]}>
                    Save these {drilled.length} as a sequence
                  </Text>
                </Pressable>
              ) : (
                <>
                  <TextInput
                    style={styles.search}
                    value={chainName}
                    onChangeText={setChainName}
                    placeholder="Closed guard to side control"
                    placeholderTextColor={vola.textDim}
                    accessibilityLabel="Name this sequence"
                    maxLength={MAX_SEQUENCE_NAME}
                    autoFocus
                    testID="bjj-chain-name"
                  />
                  <Text style={styles.footnote}>
                    Saved in the order above. Where each move leaves you is added later on the
                    web app — this is the part that is gone by tomorrow.
                  </Text>
                  <RNView style={styles.captureRow}>
                    <Pressable
                      onPress={saveChain}
                      disabled={savingChain || chainName.trim() === ''}
                      accessibilityRole="button"
                      testID="bjj-chain-save"
                    >
                      <Text
                        style={[
                          styles.captureCta,
                          { color: ui.ink },
                          (savingChain || chainName.trim() === '') && styles.captureDisabled,
                        ]}
                      >
                        {savingChain ? 'Saving…' : 'Save'}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setCapturing(false);
                        setChainName('');
                      }}
                      accessibilityRole="button"
                      testID="bjj-chain-cancel"
                    >
                      <Text style={styles.captureCancel}>Cancel</Text>
                    </Pressable>
                  </RNView>
                </>
              )}
              {chainError && (
                <Text style={styles.footnote} testID="bjj-chain-error">
                  {chainError}
                </Text>
              )}
            </RNView>
          )}

          {/* Says "saved", never "synced". The row is in the outbox and may sit
              there until the phone has signal, and claiming otherwise is the
              reassurance that must not be false. */}
          {chainSaved && (
            <Text style={styles.footnote} testID="bjj-chain-saved">
              Saved to this phone. It uploads with everything else when you have signal, and you
              can tidy it up on the web app.
            </Text>
          )}

          <Text style={styles.footnote}>
            Just what was covered. Whether any of it worked live is recorded on the next step,
            beside everything else that happened — so nothing gets logged twice.
          </Text>
        </>
      )}
    </RNView>
  );
}

/* ── step 2: what happened live ───────────────────────────────────────── */

/**
 * The symmetric grid — the highest-value screen in the flow.
 *
 * One row per category, a column for what you did and a column for what was
 * done to you. The symmetry is the design: recording only successes produces
 * a highlight reel, and "where do I keep getting stuck" — the question every
 * serious grappler is actually trying to answer — needs the right-hand
 * column to exist.
 *
 * Tap to increment, long-press to decrement. Counters rather than a list
 * because reflection is recalled in counts ("got swept about three times"),
 * and because a five-by-two grid of taps is the fastest structured input
 * that still produces queryable data.
 */
function LiveStep({
  detail,
  onChange,
  getToken,
  proficiency,
}: {
  detail: SessionDetail;
  onChange: (d: SessionDetail) => void;
  getToken: ReturnType<typeof useAuthToken>;
  /** The cross-session funnel, keyed by technique id — see `ReflectScreen`. */
  proficiency: ReadonlyMap<string, Proficiency>;
}) {
  const accent = useAccent();
  const [position, setPosition] = useState('');
  const [focus, setFocus] = useState<Focus[]>([]);
  /*
    Library names for the rows that come from a tag rather than from focus.

    Needed since a technique DRILLED today gets a row (N31): the athlete picked
    it by name on the previous screen, and handing back `armbar-closed-guard`
    would read as something else. `fetchTechniques` is module-cached, so on the
    ordinary path — step 1, then step 2 — this resolves without a request.

    Silent on failure, and the same accelerator argument the focus fetch makes:
    the fallback is the id, the counters work either way, and an error banner
    about the library would be noise on the fastest screen in the flow.
  */
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  // The full catalog, alongside `names` above — needed for N119/#508's
  // "Match in library" action on a tag kept unmatched (see `unmatched`
  // below), which ranks against the whole library the same way the
  // dictation screen's picker does. Same fetch as `names` is built from
  // (`fetchTechniques` is module-cached, so this is not a second request),
  // kept separate because `names` is what most of this file already reads.
  const [library, setLibrary] = useState<TechniqueSummary[]>([]);
  useEffect(() => {
    const c = new AbortController();
    fetchTechniques(getToken, c.signal)
      .then((all) => {
        setNames(new Map(all.map((t) => [t.id, t.name])));
        setLibrary(all);
      })
      .catch(() => {});
    return () => c.abort();
  }, [getToken]);

  useEffect(() => {
    const c = new AbortController();
    fetchFocus(getToken, c.signal)
      .then(setFocus)
      // Silent, and deliberately. The focus rows are an accelerator, not a
      // requirement — the category grid below is the whole capture surface on
      // its own, and an error banner about a list the athlete may not even
      // have set would be noise on the fastest screen in the flow.
      .catch(() => {});
    return () => c.abort();
  }, [getToken]);

  // Every technique with live evidence in THIS session, focused or not.
  //
  // Focus alone is not enough: drop a technique from the list on web after
  // logging against it, and its rows would still be in the session with no
  // control able to edit them — stranded exactly the way the old drilled-step
  // counters stranded rows when a chip was removed. The union is what keeps
  // "what is displayed" and "what is stored" the same set.
  const rows = useMemo(() => focusRows(focus, detail.tags, names), [focus, detail.tags, names]);

  // Live tags recorded under some position other than the one on screen.
  //
  // Same predicate the counters use, minus the position match — so the two
  // always agree about what this grid owns. `drilled` is excluded because
  // the grid only shows scored/conceded; technique-tagged rows because they
  // belong to the drilled step.
  const elsewhere = detail.tags
    .filter(
      (t) =>
        !t.technique_id &&
        (t.event === 'scored' || t.event === 'conceded') &&
        t.position !== position,
    )
    .reduce((n, t) => n + t.count, 0);

  /**
   * N119/#508: tags kept unmatched from dictation — `technique_id` null,
   * `label` the athlete's own phrase. The "correct it" half of this ticket:
   * `dictate.tsx` is not the only chance to resolve one, because that
   * screen's own header says there is "no separate 'review a dictated
   * session' surface, deliberately" — this wizard IS that surface.
   *
   * Distinct from `elsewhere`/the coarse counters above on purpose: those
   * stay a pure aggregate — a plain +/- tap can land on the same
   * category/event/position as one of these and simply add to its count,
   * which is accepted rather than guarded against, because the grid was
   * already lossy about which specific submission before labels existed.
   * This list is the one place a SPECIFIC phrase, and the ability to match
   * or drop it, is visible.
   */
  const unmatched = detail.tags
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !t.technique_id && !!t.label);

  const [matchingIndex, setMatchingIndex] = useState<number | null>(null);
  const matchQuery = matchingIndex === null ? '' : (detail.tags[matchingIndex]?.label ?? '');
  const matches = useMemo(
    () => (matchQuery ? rankTechniques(library, matchQuery).slice(0, 6) : []),
    [library, matchQuery],
  );

  /**
   * Mirrors `resolvePhrase` in `dictate.tsx`: category, event and count all
   * stay exactly as already confirmed. Only `technique_id` is set and
   * `label` cleared — the server rejects a tag carrying both.
   */
  function resolveUnmatched(i: number, picked: TechniqueSummary) {
    onChange({
      ...detail,
      tags: detail.tags.map((tag, n) =>
        n === i ? { ...tag, technique_id: picked.id, label: undefined } : tag,
      ),
    });
    setMatchingIndex(null);
  }

  function removeUnmatched(i: number) {
    onChange({ ...detail, tags: detail.tags.filter((_, n) => n !== i) });
    setMatchingIndex((cur) => (cur === i ? null : cur));
  }

  function bump(category: Category, event: Event, delta: number) {
    const tags = [...detail.tags];
    // Match on the position too: "swept from half guard" and "swept from
    // guard" are different evidence and must not merge into one counter.
    const i = tags.findIndex(
      (t) => t.category === category && t.event === event && t.position === position && !t.technique_id,
    );
    if (i === -1) {
      if (delta < 0) return;
      tags.push({ category, event, position, count: 1 });
    } else {
      const next = tags[i].count + delta;
      if (next <= 0) tags.splice(i, 1);
      else tags[i] = { ...tags[i], count: next };
    }
    onChange({ ...detail, tags });
  }

  return (
    <RNView style={styles.stepBody}>
      {/* Optional position context, applied to whatever is tapped next.
          A filter-shaped control rather than a per-tap prompt: asking where
          it happened after every tap would triple the interaction cost of
          the fastest screen in the flow.

          The first chip reads "Not saying", matching the gi tri-state on
          the log screen, and NOT "Anywhere" — which would imply it shows
          everything. It is one bucket among the rest: the entries with no
          position recorded. Calling it "Anywhere" made switching back to
          it look like data had vanished. */}
      <Text style={styles.label}>From where? (optional)</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {['', ...POSITIONS].map((p) => {
          const active = position === p;
          return (
            <Pressable
              key={p || 'any'}
              onPress={() => setPosition(p)}
              style={[styles.pill, active && styles.pillActive]}
              // The control every counter above is scoped by, at ~32pt tall.
              // The log screen's equivalent pills carry minHeight 44; this
              // copy of the style did not get it.
              hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              testID={`bjj-live-position-${p || 'any'}`}
            >
              <Text style={[styles.pillText, active && styles.pillTextActive]}>
                {p || 'Not saying'}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {rows.length > 0 && (
        <>
          {/* NOT "Working on" alone any more. Rows can now be something
              drilled once today, and for an athlete with no focus list the
              section contains ONLY today's drills — so the old header named
              a list they had never made. The footnote covers it, but a
              footnote is read once and a header is read every time. */}
          <Text style={styles.label} accessibilityRole="header">
            Working on & drilled today
          </Text>
          <RNView
            style={styles.gridHead}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={[styles.gridHeadCell, styles.gridHeadSpacer]} />
            {/* Derived, not spelled out. Hardcoded as two cells for what
                became three counters, the "Landed" header sat over the
                "Stopped theirs" column and actively mislabelled it. A header
                that cannot disagree with its own row is worth more than one
                that reads more plainly in the source. */}
            {FUNNEL_OUTCOMES.map((o) => (
              <Text key={o.event} style={styles.gridHeadCell}>
                {o.label}
              </Text>
            ))}
          </RNView>
          {rows.map((f) => {
            const state = displayLearningState(proficiency, detail.tags, f.technique_id);
            return (
            <RNView key={f.technique_id} style={styles.gridRow}>
              <RNView style={styles.gridLabelCol}>
                <Text style={styles.gridLabel} numberOfLines={2}>
                  {f.name}
                </Text>
                {state !== 'seen' && (
                  <LearningStateBadge state={state} testID={`bjj-focus-${f.technique_id}-state`} />
                )}
              </RNView>
              {FUNNEL_OUTCOMES.map((o) => (
                <Counter
                  key={o.event}
                  value={techniqueOutcomeCount(detail.tags, f.technique_id, o.event)}
                  label={o.label}
                  context={f.name}
                  // Landed and Stopped are both wins — one offensive, one
                  // defensive — and colouring only the first would say the
                  // quiet part out loud about which half the app values.
                  // Missed is neither a win nor something done to you; it is
                  // the attempt that did not land, and going for it is still
                  // the behaviour being encouraged -- hence neutral rather
                  // than the conceded tone.
                  tone={o.event === 'attempted' ? 'neutral' : 'scored'}
                  onAdd={() =>
                    onChange({ ...detail, tags: bumpTechniqueOutcome(detail.tags, f, o.event, 1) })
                  }
                  onRemove={() =>
                    onChange({ ...detail, tags: bumpTechniqueOutcome(detail.tags, f, o.event, -1) })
                  }
                  testID={`bjj-focus-${f.technique_id}-${o.event}`}
                />
              ))}
            </RNView>
            );
          })}
          <Text style={styles.footnote}>
            The techniques you&apos;re working on, and what you drilled today. “Missed” means you went for it and it
            didn&apos;t land, so missed plus landed is how often you went for it — and landed out of
            that is your hit rate, which is what a roadmap reads. “Stopped theirs” is the other
            direction — they went for it and you shut it down. Record it here rather than in the grid
            below — one row per thing that happened.
          </Text>
        </>
      )}

      {rows.length > 0 && (
        <Text style={styles.label} accessibilityRole="header">
          Everything else
        </Text>
      )}
      <RNView
        style={styles.gridHead}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={[styles.gridHeadCell, styles.gridHeadSpacer]} />
        <Text style={styles.gridHeadCell}>You</Text>
        <Text style={styles.gridHeadCell}>Them</Text>
      </RNView>

      {LIVE_ROWS.map((r) => (
        <RNView key={r.category} style={styles.gridRow}>
          {/*
            Same `gridLabelCol` (flex: 1.1) the "Working on & drilled today"
            grid above uses, and the same column the `gridHeadSpacer` header
            row reserves — a bare, unflexed label here sized to its own text
            ("Submissions" vs "Passes"), leaving a different amount of room for
            the two counters on every row, so the columns drifted row to row.
            (N206)
          */}
          <RNView style={styles.gridLabelCol}>
            <Text style={styles.gridLabel} numberOfLines={2}>
              {r.label}
            </Text>
          </RNView>
          <Counter
            value={tagCount(detail.tags, r.category, 'scored', position)}
            label={r.scored}
            tone="scored"
            onAdd={() => bump(r.category, 'scored', 1)}
            onRemove={() => bump(r.category, 'scored', -1)}
            testID={`bjj-live-${r.category}-scored`}
          />
          <Counter
            value={tagCount(detail.tags, r.category, 'conceded', position)}
            label={r.conceded}
            tone="conceded"
            onAdd={() => bump(r.category, 'conceded', 1)}
            onRemove={() => bump(r.category, 'conceded', -1)}
            testID={`bjj-live-${r.category}-conceded`}
          />
        </RNView>
      ))}

      {/* The counters show only the selected chip, because that is all the
          +/- buttons edit. Without this line, switching chips blanks every
          counter and reads as though the earlier taps were lost.

          Deliberately NOT gated on a named position being selected. The
          first chip is the *unspecified* bucket, not "all" — so returning
          to it hides everything recorded under a named position, which is
          the same "did I lose that?" moment one step along. Both cases get
          the line; only the wording differs. */}
      {elsewhere > 0 && (
        <Text style={styles.footnote}>
          Showing {position === '' ? 'unlabelled entries' : position} only. {elsewhere} more
          recorded {position === '' ? 'against a position' : 'elsewhere'} — still saved.
        </Text>
      )}

      <Text style={styles.footnote}>
        Tap to add, press and hold to take one back. The right-hand column is the half most people
        never record — and the half that tells you what to work on.
      </Text>

      {/* N119/#508. Only present when dictation kept something the library
          never matched — an ordinary session with no unresolved phrase
          renders exactly as before this existed. */}
      {unmatched.length > 0 && (
        <>
          <Text style={styles.label} accessibilityRole="header">
            Said, not matched to the library
          </Text>
          {unmatched.map(({ t, i }) => (
            <RNView key={i} style={styles.unmatchedRow}>
              <RNView style={styles.unmatchedHead}>
                <Text style={[styles.gridLabel, styles.unmatchedLabel]} numberOfLines={2}>
                  “{t.label}”{t.count > 1 ? ` ×${t.count}` : ''}
                </Text>
                <Pressable
                  onPress={() => setMatchingIndex((cur) => (cur === i ? null : i))}
                  accessibilityRole="button"
                  accessibilityLabel={
                    matchingIndex === i
                      ? `Hide matches for “${t.label}”`
                      : `Match “${t.label}” to a technique`
                  }
                >
                  <Text style={[styles.footnote, { color: accent.ink, fontWeight: '700' }]}>
                    {matchingIndex === i ? 'Hide' : 'Match'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => removeUnmatched(i)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove “${t.label}”`}
                >
                  <Text style={[styles.footnote, { color: vola.textDim, fontWeight: '700' }]}>
                    Remove
                  </Text>
                </Pressable>
              </RNView>
              {matchingIndex === i && (
                <RNView style={styles.unmatchedMatches}>
                  {matches.length === 0 ? (
                    <Text style={styles.footnote}>
                      Nothing in the library matches that yet.
                    </Text>
                  ) : (
                    matches.map((m) => (
                      <Pressable
                        key={m.id}
                        onPress={() => resolveUnmatched(i, m)}
                        style={styles.pill}
                        accessibilityRole="button"
                        accessibilityLabel={`${m.name}, for “${t.label}”`}
                      >
                        <Text style={styles.pillText}>{m.name}</Text>
                      </Pressable>
                    ))
                  )}
                </RNView>
              )}
            </RNView>
          ))}
          <Text style={styles.footnote}>
            Said during dictation, no catalog entry pinned it down. Match it here if the library
            has grown since, or leave it — it still counts as evidence above.
          </Text>
        </>
      )}
    </RNView>
  );
}

function Counter({
  value,
  label,
  context,
  tone,
  onAdd,
  onRemove,
  testID,
}: {
  value: number;
  label: string;
  /** Prefixed to the accessibility label. The focus rows use it because
   *  adjacency is a VISUAL property — VoiceOver reads a run of "Missed: 0 /
   *  Landed: 0" with nothing binding a pair to a technique. The category grid
   *  below omits it because its row label ("Submissions") is already part of
   *  the same announced row. */
  context?: string;
  tone: 'scored' | 'conceded' | 'neutral';
  onAdd: () => void;
  onRemove: () => void;
  testID: string;
}) {
  const accent = useAccent();
  const on = value > 0;
  return (
    <Pressable
      onPress={onAdd}
      onLongPress={onRemove}
      style={[
        styles.counter,
        on &&
          (tone === 'scored'
            ? [styles.counterScored, { borderColor: accent.accent }]
            : tone === 'conceded'
              ? styles.counterConceded
              : styles.counterNeutral),
      ]}
      accessibilityRole="button"
      accessibilityLabel={context ? `${context}, ${label}: ${value}` : `${label}: ${value}`}
      accessibilityHint="Tap to add one, press and hold to remove one"
      testID={testID}
    >
      <Text style={[styles.counterValue, on && styles.counterValueOn]}>{value || '–'}</Text>
      <Text style={[styles.counterLabel, on && styles.counterLabelOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/* ── step 3: the note ─────────────────────────────────────────────────── */

function NoteStep({
  detail,
  onChange,
}: {
  detail: SessionDetail;
  onChange: (d: SessionDetail) => void;
}) {
  return (
    <RNView style={styles.stepBody}>
      <TextInput
        style={[styles.search, styles.multiline]}
        value={detail.note}
        onChangeText={(note) => onChange({ ...detail, note })}
        placeholder="His grip broke my posture before I could frame…"
        placeholderTextColor={vola.textDim}
        multiline
        accessibilityLabel="Session note"
        testID="bjj-note"
      />
      <Text style={styles.label}>Anything hurt?</Text>
      <TextInput
        style={styles.search}
        value={detail.body_note}
        onChangeText={(body_note) => onChange({ ...detail, body_note })}
        placeholder="Left knee tweaked in a scramble"
        placeholderTextColor={vola.textDim}
        accessibilityLabel="Body or injury note"
        testID="bjj-body-note"
      />
      <Text style={styles.footnote}>
        The chips make a session searchable. This is for what they can&apos;t hold.
      </Text>
    </RNView>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function nameFor(all: TechniqueSummary[], id: string | null | undefined): string {
  if (!id) return 'Technique';
  // Fall back to the ID before the placeholder. `fetchTechniques` caches only
  // in module memory, so on a COLD OFFLINE launch — reopening a reflection at
  // the gym, which is the flow this app exists for — `all` is empty and every
  // row rendered as the same word "Technique". That makes the counters
  // unbindable to a technique for a sighted user and turns the funnel
  // counters' accessibility context into "Technique, Missed: 0" repeated down
  // the list, which is exactly the ambiguity that context prop was added to
  // remove. The ids are readable slugs (`armbar-from-guard`), so they are a
  // genuinely useful last resort. Matches the read-back screen's `nameOf`.
  return all.find((t) => t.id === id)?.name ?? id;
}

const styles = StyleSheet.create({
  chainBar: { marginBottom: 12, gap: 6 },
  chainChip: {
    marginRight: 8,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    maxWidth: 200,
  },
  chainChipBusy: { opacity: 0.5 },
  chainChipName: { fontWeight: '600', fontSize: 14 },
  chainChipMeta: { fontSize: 11, color: vola.textMuted, marginTop: 2 },
  captureBox: { marginTop: 12, gap: 8 },
  // minHeight/padding so Save and Cancel clear the 44pt target the sibling
  // pills in this file already enforce. Bare text at 15pt did not.
  captureCta: { fontWeight: '700', fontSize: 15, minHeight: 44, paddingVertical: 12 },
  captureDisabled: { opacity: 0.4 },
  captureRow: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  captureCancel: { color: vola.textMuted, fontSize: 15, minHeight: 44, paddingVertical: 12 },

  container: { flex: 1 },
  scroll: { padding: 20, gap: 8, paddingBottom: 32 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  centreTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  centreMuted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },

  headerAction: { fontWeight: '700', fontSize: 16 },

  progress: { flexDirection: 'row', gap: 4, paddingHorizontal: 20, paddingTop: 4 },
  progressBar: { flex: 1, height: 3, borderRadius: 999, backgroundColor: vola.line },
  progressBarOn: {},

  stepTitle: { fontSize: 22, fontWeight: '800', marginTop: 8 },
  stepBlurb: { color: vola.textMuted, fontSize: 13, marginBottom: 6 },
  stepBody: { gap: 8 },

  label: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
  },
  muted: { color: vola.textMuted, fontSize: 13 },
  footnote: { color: vola.textDim, fontSize: 12, marginTop: 12 },
  error: { color: vola.danger, fontSize: 14 },

  search: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  multiline: { minHeight: 110, textAlignVertical: 'top' },

  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
  },
  resultBody: { flex: 1, gap: 2 },
  resultName: { fontSize: 15, fontWeight: '600' },
  plus: { fontSize: 20, fontWeight: '700' },

  // One drilled technique: its name and a remove control. The funnel counters
  // that used to sit under it moved to the live step, so this is now a plain
  // row — kept bordered rather than made a pill because a full technique name
  // wraps, and "Berimbolo to back take" truncated to "Berim…" is not something
  // anyone can confirm they drilled.
  drilledRow: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
    gap: 8,
  },
  drilledHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  drilledNameCol: { flex: 1, gap: 4 },
  drilledName: { fontWeight: '600', fontSize: 14 },
  drilledRemove: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagChipX: { color: vola.textMuted, fontSize: 15, fontWeight: '700' },

  row: { gap: 8, paddingRight: 20 },
  pill: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pillActive: { borderColor: vola.textMuted, backgroundColor: vola.surfaceRaised },
  pillText: { color: vola.textDim, fontSize: 12, fontWeight: '600' },
  pillTextActive: { color: vola.text },

  gridHead: { flexDirection: 'row', gap: 8, marginTop: 16, alignItems: 'flex-end' },
  gridHeadCell: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: vola.textDim,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  gridHeadSpacer: { flex: 1.1, textAlign: 'left' },
  gridRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
  gridLabelCol: { flex: 1.1, gap: 4 },
  gridLabel: { fontSize: 14, fontWeight: '600' },

  // N119/#508's "Said, not matched to the library" list.
  unmatchedRow: { marginTop: 10, gap: 8 },
  unmatchedHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  unmatchedLabel: { flex: 1, flexShrink: 1 },
  unmatchedMatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  counter: {
    flex: 1,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 1,
    minHeight: 56,
    justifyContent: 'center',
  },
  // Scored reads as the app's "this is yours / act here" accent; conceded is
  // warn rather than danger — getting swept is information, not a failure,
  // and the tone should not scold. See the no-shame-messaging stance.
  counterScored: { backgroundColor: vola.setDone },
  counterConceded: { borderColor: vola.warn, backgroundColor: vola.surfaceRaised },
  // "Missed" is neither a win nor something that happened to you — it is the
  // attempt, which is the thing being encouraged. Raised surface, no accent.
  counterNeutral: { borderColor: vola.textMuted, backgroundColor: vola.surfaceRaised },
  counterValue: { fontSize: 20, fontWeight: '800', color: vola.textDim },
  counterValueOn: { color: vola.text },
  counterLabel: { fontSize: 10, color: vola.textDim },
  counterLabelOn: { color: vola.textMuted },

  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.lineSoft,
  },
  skip: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipText: { color: vola.textMuted, fontWeight: '700', fontSize: 15 },
  next: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  nextText: { fontWeight: '700', fontSize: 16 },
});
