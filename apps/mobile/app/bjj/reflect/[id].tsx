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

import { LibraryTile, categoryBadge } from '@/components/LibraryTile';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
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
import { fetchTechniques, searchTechniques, type TechniqueSummary } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

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
    <View style={styles.container} testID="bjj-reflect-screen">
      <Stack.Screen
        options={{
          title: `Step ${step + 1} of ${STEPS.length}`,
          headerRight: () => (
            <Pressable onPress={finish} hitSlop={12} accessibilityRole="button" testID="bjj-reflect-done">
              <Text style={styles.headerAction}>Done</Text>
            </Pressable>
          ),
        }}
      />

      {/* Progress. Three segments rather than a percentage: the athlete needs
          to know how much is left, and "60%" of an optional flow means
          nothing. */}
      <RNView style={styles.progress} accessible accessibilityLabel={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <RNView key={s.key} style={[styles.progressBar, i <= step && styles.progressBarOn]} />
        ))}
      </RNView>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}

        <Text style={styles.stepTitle}>{current.title}</Text>
        <Text style={styles.stepBlurb}>{current.blurb}</Text>

        {current.key === 'drilled' && (
          <DrilledStep detail={detail} onChange={persist} getToken={getToken} />
        )}
        {current.key === 'live' && <LiveStep detail={detail} onChange={persist} getToken={getToken} />}
        {current.key === 'note' && <NoteStep detail={detail} onChange={persistSoon} />}
      </ScrollView>

      <RNView style={styles.footer}>
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
          style={styles.next}
          accessibilityRole="button"
          testID="bjj-reflect-next"
        >
          <Text style={styles.nextText}>{last ? 'Save it' : 'Next'}</Text>
        </Pressable>
      </RNView>
    </View>
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
}: {
  detail: SessionDetail;
  onChange: (d: SessionDetail) => void;
  getToken: ReturnType<typeof useAuthToken>;
}) {
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

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return searchTechniques(all, query).slice(0, 8);
  }, [all, query]);

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

  return (
    <RNView style={styles.stepBody}>
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
          The technique library isn&apos;t loaded on this device yet. Open the Library tab once with
          a connection, or skip this step — everything else still saves.
        </Text>
      )}

      {/*
        A query that matches nothing rendered a blank space, indistinguishable
        from an empty box — and this is the screen where that reads as "the
        technique isn't in the library", which is how a lookup bug became a
        plan to author a duplicate. Say it outright instead.
      */}
      {!failed && query.trim().length > 0 && results.length === 0 && (
        <Text style={styles.muted} testID="bjj-drilled-empty">
          No technique matches “{query.trim()}”. Try a shorter search or another spelling — or skip
          this step, everything else still saves.
        </Text>
      )}

      {results.map((t) => {
        const [code, accent] = categoryBadge(t.category);
        return (
          <Pressable
            key={t.id}
            onPress={() => add(t)}
            style={styles.result}
            accessibilityRole="button"
            accessibilityLabel={`Add ${t.name}`}
            testID={`bjj-drilled-add-${t.id}`}
          >
            <LibraryTile code={code} accent={accent} />
            <RNView style={styles.resultBody}>
              <Text style={styles.resultName}>{t.name}</Text>
              <Text style={styles.muted} numberOfLines={1}>
                {t.position}
              </Text>
            </RNView>
            <Text style={styles.plus}>＋</Text>
          </Pressable>
        );
      })}

      {drilled.length > 0 && (
        <>
          <Text style={styles.label}>Drilled today</Text>
          {drilled.map((t) => {
            const name = nameFor(all, t.technique_id);
            return (
              <RNView key={t.technique_id ?? `${t.category}-${t.position}`} style={styles.drilledRow}>
                <RNView style={styles.drilledHead}>
                  <Text style={styles.drilledName} numberOfLines={2}>
                    {name}
                  </Text>
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
}: {
  detail: SessionDetail;
  onChange: (d: SessionDetail) => void;
  getToken: ReturnType<typeof useAuthToken>;
}) {
  const [position, setPosition] = useState('');
  const [focus, setFocus] = useState<Focus[]>([]);

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
  const rows = useMemo(() => focusRows(focus, detail.tags), [focus, detail.tags]);

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
          <Text style={styles.label} accessibilityRole="header">
            Working on
          </Text>
          <RNView
            style={styles.gridHead}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={[styles.gridHeadCell, styles.gridHeadSpacer]} />
            <Text style={styles.gridHeadCell}>Tried</Text>
            <Text style={styles.gridHeadCell}>Landed</Text>
          </RNView>
          {rows.map((f) => (
            <RNView key={f.technique_id} style={styles.gridRow}>
              <Text style={styles.gridLabel} numberOfLines={2}>
                {f.name}
              </Text>
              {FUNNEL_OUTCOMES.map((o) => (
                <Counter
                  key={o.event}
                  value={techniqueOutcomeCount(detail.tags, f.technique_id, o.event)}
                  label={o.label}
                  context={f.name}
                  // Tried is neither a win nor something done to you — it is
                  // the attempt, which is the behaviour being encouraged.
                  tone={o.event === 'scored' ? 'scored' : 'neutral'}
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
          ))}
          <Text style={styles.footnote}>
            The techniques you&apos;re working on. “Tried” means you went for it and it didn&apos;t
            land, so tried plus landed is how often you went for it. Record it here rather than in the
            grid below — one row per thing that happened.
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
          <Text style={styles.gridLabel}>{r.label}</Text>
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
   *  adjacency is a VISUAL property — VoiceOver reads a run of "Tried: 0 /
   *  Landed: 0" with nothing binding a pair to a technique. The category grid
   *  below omits it because its row label ("Submissions") is already part of
   *  the same announced row. */
  context?: string;
  tone: 'scored' | 'conceded' | 'neutral';
  onAdd: () => void;
  onRemove: () => void;
  testID: string;
}) {
  const on = value > 0;
  return (
    <Pressable
      onPress={onAdd}
      onLongPress={onRemove}
      style={[
        styles.counter,
        on &&
          (tone === 'scored'
            ? styles.counterScored
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
  // counters' accessibility context into "Technique, Tried: 0" repeated down
  // the list, which is exactly the ambiguity that context prop was added to
  // remove. The ids are readable slugs (`armbar-from-guard`), so they are a
  // genuinely useful last resort. Matches the read-back screen's `nameOf`.
  return all.find((t) => t.id === id)?.name ?? id;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 20, gap: 8, paddingBottom: 32 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  centreTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  centreMuted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },

  headerAction: { color: vola.lime, fontWeight: '700', fontSize: 16 },

  progress: { flexDirection: 'row', gap: 4, paddingHorizontal: 20, paddingTop: 4 },
  progressBar: { flex: 1, height: 3, borderRadius: 999, backgroundColor: vola.line },
  progressBarOn: { backgroundColor: vola.lime },

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
  plus: { color: vola.lime, fontSize: 20, fontWeight: '700' },

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
  drilledName: { flex: 1, fontWeight: '600', fontSize: 14 },
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
  gridLabel: { flex: 1.1, fontSize: 14, fontWeight: '600' },

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
  counterScored: { borderColor: vola.lime, backgroundColor: vola.setDone },
  counterConceded: { borderColor: vola.warn, backgroundColor: vola.surfaceRaised },
  // "Tried" is neither a win nor something that happened to you — it is the
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
    backgroundColor: vola.lime,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  nextText: { color: vola.navy, fontWeight: '700', fontSize: 16 },
});
