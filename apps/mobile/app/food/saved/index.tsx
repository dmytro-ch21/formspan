/**
 * "Saved foods" — the phone half of N79, made findable by N532.
 *
 * ## The gap N79 closed
 *
 * `apps/web`'s `nutrition/recipes` page could list, edit and delete an
 * athlete's own saved things; the phone could create them (`food/add.tsx`,
 * `food/describe.tsx`, the barcode flow — collectively N78) and, since N114,
 * correct one it already knew the id of (`food/saved/[id].tsx`,
 * `food/recipe/[id].tsx`) — but nothing let an athlete BROWSE the whole list
 * or remove one. `removeFood` in `lib/foodLog.ts` is the caller `deleteFood`
 * had been waiting for, through the same outbox every other mutation uses.
 *
 * ## What N532 (#963) changed, and why
 *
 * The user's two complaints, verbatim: *"we should have an option to
 * distinguish shared food items, its hard to find them so we could have
 * recently shared with it"* and *"the list gets large in saved food - lets
 * make rows more compact and sortable."*
 *
 * - **"Recently shared"** sits above the list: foods a friend sent in the
 *   last {@link RECENTLY_SHARED_DAYS} days, newest first. It renders ONLY
 *   when there is something in it — an empty "Recently shared" heading would
 *   be a section that can never be non-empty in a test, and a screen that
 *   announces an absence. Shown only while the search box is empty: a search
 *   is one question, and a spotlight on top of its answer is noise.
 * - **"from @handle · 3 Sep"** on any row with provenance, wherever it
 *   appears — the spotlight, the full list, a search result. The handle is
 *   the server's LIVE resolution (`lib/nutrition.ts`'s `Food.shared_by`), so
 *   a rename shows up on the next pull; this screen never derives one.
 * - **Compact rows.** One line — name, the recipe mark, kcal · P/C/F — and a
 *   second only when there is something to say (provenance, brand). The old
 *   card was ≈134pt plus a 12pt gap (padding 28, three text lines, a 36pt
 *   hold-to-delete button); this row is 41pt, or 59pt with its second line —
 *   computed from the styles below, not measured on a device. Roughly a
 *   third of the old height, against the ticket's "roughly half".
 * - **Sort chips — Recent / Name / Most used**, default Recent, remembered
 *   per athlete (`PREF_SAVED_FOODS_SORT`, the Library sport filter's
 *   precedent). Search filters WITHIN the chosen sort: both go to the same
 *   `localFoods` read, so there is no in-memory re-sort to drift from it.
 *
 * ## Editing is not duplicated here
 *
 * A row's tap pushes straight to the screens that already do this correctly
 * — `food/saved/[id]` for a plain food, `food/recipe/[id]` for a recipe,
 * exactly the split `food/add.tsx`'s own Edit button uses and for the
 * identical reason (N87): a recipe edited through the plain-food form loses
 * its ingredient list.
 *
 * ## Deleting: off the row, behind a gesture, always confirmed
 *
 * The per-row `HoldToConfirm` was the tallest thing on the old card and the
 * one thing a compact row cannot carry. Delete now lives behind THREE
 * gestures, all ending in the same platform confirm dialog:
 *
 *   - **swipe left** reveals Delete (`SwipeToDelete`, the session screen's
 *     own reveal-then-tap component — never a full-swipe delete);
 *   - **long-press** the row, for anyone who does not discover the swipe;
 *   - the **`delete` accessibility action**, because a screen-reader user
 *     can do neither, and `SwipeToDelete` deliberately hides its button from
 *     assistive tech while closed. VoiceOver/TalkBack expose it in the
 *     actions rotor.
 *
 * `Alert.alert` rather than the hold, because the hold's whole point was
 * "no dialog for sighted users", and a dialog is the honest cost of taking a
 * destructive control off the row. Its body says what survives: a day
 * already logged keeps its own copied numbers, because `source_food_id` is
 * `ON DELETE SET NULL` and an entry never reads nutrition back through it.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { SwipeToDelete } from '@/components/SwipeToDelete';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { foodSyncProblems, localFoods, recentlySharedFoods, removeFood } from '@/lib/foodLog';
import { savedFoodProblemCopy, type Food } from '@/lib/nutrition';
import { PREF_SAVED_FOODS_SORT, readPref, writePref } from '@/lib/prefs';
import {
  DEFAULT_SAVED_FOODS_SORT,
  RECENTLY_SHARED_DAYS,
  SAVED_FOODS_SORTS,
  SAVED_FOODS_SORT_LABELS,
  parseSavedFoodsSort,
  sharedFromLine,
  type SavedFoodsSort,
} from '@/lib/savedFoodsSort';
import { request as requestSync } from '@/lib/sync';
import { PressableScale } from '@/components/ui/PressableScale';

const DELETE_ACTIONS = [{ name: 'delete', label: 'Delete' }] as const;

export default function SavedFoodsScreen() {
  const { userId } = useAuth();
  const router = useRouter();
  const accent = useAccent();

  const [q, setQ] = useState('');
  const [sort, setSortState] = useState<SavedFoodsSort>(DEFAULT_SAVED_FOODS_SORT);
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [recent, setRecent] = useState<Food[]>([]);
  /**
   * N533/#964 — the foods the server refused, by id, with its reason. Read
   * beside the list rather than folded into `localFoods`, because that read
   * feeds the quick-add picker too and a ghost there is still a food the
   * athlete can log (an entry owns its own numbers). Here, where the list is
   * the athlete's picture of what is saved, a row that is NOT saved anywhere
   * but this phone has to say so.
   */
  const [problems, setProblems] = useState<Map<string, { reason: string; onServer: boolean }>>(
    () => new Map(),
  );
  const [error, setError] = useState<string | null>(null);

  /**
   * A generation counter, so a SLOWER EARLIER load can never overwrite a
   * faster later one.
   *
   * Two loads are in flight on almost every mount: the focus effect fires
   * immediately with the default sort, and the stored-preference effect
   * fires again with the remembered one as soon as `readPref` answers.
   * Nothing orders their two `localFoods` promises, so without this the
   * chips could settle on "Name" while the rows on screen were still the
   * "Recent" answer — the sort control silently lying about the list under
   * it, which is the one thing this ticket exists to get right. Measured,
   * not theorised: resolving the two out of order reproduces it.
   *
   * `food/add.tsx` guards its own two concurrent reads the same way and for
   * the same reason; this is that pattern, not a new one. It also covers
   * the search box for free — a fast typist's earlier keystroke can no
   * longer land after a later one.
   */
  const loadSeq = useRef(0);

  const load = useCallback(
    async (query: string, order: SavedFoodsSort) => {
      if (!userId) return;
      const seq = ++loadSeq.current;
      try {
        // The spotlight is read only while there is no search — see the doc
        // comment. `[]` rather than a stale list, so a search typed after a
        // load can never leave last time's spotlight sitting above it.
        const [rows, shared] = await Promise.all([
          localFoods(userId, query, order),
          query.trim() ? Promise.resolve([]) : recentlySharedFoods(userId),
        ]);
        // A newer load started while this one was reading; its answer is
        // the current one, and this is last time's.
        if (seq !== loadSeq.current) return;
        setFoods(rows);
        setRecent(shared);
        setError(null);
      } catch (err) {
        if (seq !== loadSeq.current) return;
        setError(err instanceof Error ? err.message : 'Could not read your saved foods.');
        return;
      }
      // **Read SECOND and swallowed, not folded into the read above.** Found in
      // review: a `Promise.all` of the two makes a failure of THIS read blank
      // the entire saved-foods list, which is a strictly worse screen than the
      // one that existed before this ticket — the list is the athlete's picture
      // of what they have saved, and the refusal notice is an annotation on it.
      // Losing the annotation costs a warning; losing the list costs the
      // screen. Same "an accelerator, not a requirement" posture `foodLog.ts`
      // gives its caffeine sync.
      try {
        const refused = await foodSyncProblems(userId);
        if (seq !== loadSeq.current) return;
        setProblems(refused);
      } catch {
        if (seq === loadSeq.current) setProblems(new Map());
      }
    },
    [userId],
  );

  /**
   * The CURRENT query and sort, read by the focus effect below without being
   * dependencies of it.
   *
   * `useFocusEffect` needs a memoised callback — an unmemoised one would give
   * it a new identity on every render, and its own effect re-runs whenever
   * that identity changes, which turns "reload on focus" into "reload after
   * every keystroke sets state and re-renders": a loop. So the callback can
   * only depend on `load` (stable unless `userId` changes) — and reading the
   * two values from refs is what keeps them current without needing either
   * back in the dependency array to get there.
   */
  const qRef = useRef('');
  const sortRef = useRef<SavedFoodsSort>(DEFAULT_SAVED_FOODS_SORT);
  useEffect(() => {
    qRef.current = q;
  }, [q]);

  // On focus, not on mount — deleting one and coming straight back here has to
  // show the list without it, the same reason `curriculum/index.tsx` reloads
  // on focus rather than once. Reads the refs so a search typed before leaving
  // (to edit a row, say) is still the search in effect on the way back.
  useFocusEffect(
    useCallback(() => {
      void load(qRef.current, sortRef.current);
    }, [load]),
  );

  /**
   * The sort is remembered; the search box is not — the Library's split, for
   * the Library's reason: "I like newest first" is a standing preference,
   * "rice" is a question you asked once and already got the answer to.
   *
   * Only reloads when the stored value DIFFERS from what the focus effect
   * already loaded with, so the common case (default, or no row) costs one
   * read and no second render.
   */
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    readPref(userId, PREF_SAVED_FOODS_SORT)
      .then((stored) => {
        if (cancelled) return;
        const parsed = parseSavedFoodsSort(stored);
        if (parsed === sortRef.current) return;
        sortRef.current = parsed;
        setSortState(parsed);
        void load(qRef.current, parsed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId, load]);

  function setSort(next: SavedFoodsSort) {
    if (next === sortRef.current) return;
    sortRef.current = next;
    setSortState(next);
    if (userId) writePref(userId, PREF_SAVED_FOODS_SORT, next).catch(() => {});
    void load(qRef.current, next);
  }

  async function onSearch(text: string) {
    setQ(text);
    await load(text, sortRef.current);
  }

  async function onDelete(f: Food) {
    if (!userId) return;
    try {
      await removeFood(userId, f.id);
      requestSync('saved food deleted');
      setError(null);
      await load(qRef.current, sortRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be deleted.');
    }
  }

  function confirmDelete(f: Food) {
    Alert.alert(
      `Delete ${f.name}?`,
      'This removes it from your saved list. Days you have already logged it on keep the numbers they were logged with — a logged entry owns its own numbers.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void onDelete(f) },
      ],
    );
  }

  function edit(f: Food) {
    // **A recipe must not open the plain-food editor (N87).** Identical guard
    // to `food/add.tsx`'s own Edit button — see that screen's comment for the
    // failure this prevents.
    if (f.kind === 'recipe') {
      router.push({ pathname: '/food/recipe/[id]', params: { id: f.id } });
    } else {
      router.push({ pathname: '/food/saved/[id]', params: { id: f.id } });
    }
  }

  function row(f: Food, keyPrefix: string) {
    const from = sharedFromLine(f);
    // Provenance first, brand second: who sent it is the fact this ticket
    // exists for, and the brand was already searchable.
    const second = [from, f.brand || null].filter(Boolean).join(' · ');
    return (
      <SwipeToDelete
        key={`${keyPrefix}${f.id}`}
        accessibilityLabel={f.name}
        onDelete={() => confirmDelete(f)}
        testID={`${keyPrefix}saved-foods-row-${f.id}`}
      >
        <PressableScale
          onPress={() => edit(f)}
          onLongPress={() => confirmDelete(f)}
          style={styles.row}
          accessibilityRole="button"
          // **The refusal has to be IN the label, not merely under it.** A
          // container with an `accessibilityLabel` replaces everything nested
          // inside it for a screen reader, so the red line this ticket added to
          // the row is text a VoiceOver user never reaches — the one athlete
          // for whom "it looks saved but is not" is hardest to notice
          // otherwise. Appended rather than made its own focusable element so
          // the row is still one swipe.
          accessibilityLabel={`Edit ${f.name}${from ? `, ${from}` : ''}${
            problems.has(f.id) ? `. ${savedFoodProblemCopy(problems.get(f.id)!)}` : ''
          }`}
          accessibilityHint="Long press, or swipe left, to delete"
          accessibilityActions={DELETE_ACTIONS}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'delete') confirmDelete(f);
          }}
          testID={`${keyPrefix}saved-foods-edit-${f.id}`}
        >
          <RNView style={styles.rowMain}>
            <Text style={styles.name} numberOfLines={1}>
              {f.name}
            </Text>
            {f.kind === 'recipe' ? <Text style={styles.mark}>Recipe</Text> : null}
            <Text style={styles.macros} numberOfLines={1}>
              {Math.round(f.kcal)} kcal · {Math.round(f.protein_g)}P/{Math.round(f.carb_g)}C/
              {Math.round(f.fat_g)}F
            </Text>
          </RNView>
          {second ? (
            <Text
              style={[styles.second, from ? styles.from : null]}
              numberOfLines={1}
              testID={from ? `${keyPrefix}saved-foods-from-${f.id}` : undefined}
            >
              {second}
            </Text>
          ) : null}
          {problems.has(f.id) ? (
            <Text style={styles.problem} testID={`${keyPrefix}saved-foods-problem-${f.id}`}>
              {savedFoodProblemCopy(problems.get(f.id)!)}
            </Text>
          ) : null}
        </PressableScale>
      </SwipeToDelete>
    );
  }

  const showRecent = recent.length > 0 && !q.trim();

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Saved foods' }} />
      <KeyboardAwareScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          Everything you have saved or been sent. Tap a row to edit it; swipe
          left or long-press to delete. Days you have already logged keep the
          numbers they were logged with.
        </Text>

        <TextInput
          style={styles.search}
          value={q}
          onChangeText={(t) => void onSearch(t)}
          placeholder="Search your saved foods"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Search your saved foods"
          testID="saved-foods-search"
          autoCorrect={false}
          autoCapitalize="none"
        />

        {error ? (
          <Text style={styles.error} accessibilityLiveRegion="polite" testID="saved-foods-error">
            {error}
          </Text>
        ) : null}

        {showRecent ? (
          <RNView style={styles.section} testID="saved-foods-recently-shared">
            <RNView style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Recently shared</Text>
              <Text style={styles.sectionMeta}>Last {RECENTLY_SHARED_DAYS} days</Text>
            </RNView>
            {recent.map((f) => row(f, 'recent-'))}
          </RNView>
        ) : null}

        {/* The sort chips double as the full list's heading. `accessibilityRole`
            "button" with `selected`, not "tab": these reorder one list, they
            do not switch between views. */}
        <RNView style={styles.chipRow} accessibilityRole="radiogroup" accessibilityLabel="Sort saved foods">
          <Text style={styles.chipRowLabel}>Sort</Text>
          {SAVED_FOODS_SORTS.map((s) => {
            const active = s === sort;
            return (
              <PressableScale
                key={s}
                onPress={() => setSort(s)}
                style={[styles.chip, active && { backgroundColor: accent.accent, borderColor: accent.accent }]}
                hitSlop={8}
                accessibilityRole="radio"
                accessibilityLabel={`Sort by ${SAVED_FOODS_SORT_LABELS[s]}`}
                accessibilityState={{ selected: active, checked: active }}
                testID={`saved-foods-sort-${s}`}
              >
                <Text style={[styles.chipText, active && { color: accent.on }]}>
                  {SAVED_FOODS_SORT_LABELS[s]}
                </Text>
              </PressableScale>
            );
          })}
        </RNView>

        {foods === null && !error ? (
          <ActivityIndicator style={styles.loading} accessibilityLabel="Loading your saved foods" />
        ) : null}

        {foods !== null && foods.length === 0 ? (
          <Text style={styles.empty} testID="saved-foods-empty">
            {q.trim()
              ? 'Nothing saved by that name.'
              : 'Nothing saved yet. Log something once, describe a plate, or scan a barcode, and it will be here to reuse and correct.'}
          </Text>
        ) : null}

        {foods && foods.length > 0 ? (
          <RNView style={styles.list}>{foods.map((f) => row(f, ''))}</RNView>
        ) : null}
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  container: { padding: 16, gap: 12, paddingBottom: 60 },
  intro: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  search: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: vola.text,
    fontSize: 15,
  },
  error: { color: vola.danger, fontSize: 13 },
  loading: { marginTop: 24 },
  empty: { fontSize: 13, color: vola.textMuted, lineHeight: 19, paddingVertical: 16 },

  section: { gap: 0 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingBottom: 6,
  },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: vola.text, letterSpacing: 0.3 },
  sectionMeta: { fontSize: 11, color: vola.textDim },

  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chipRowLabel: { fontSize: 12, color: vola.textDim, marginRight: 2 },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  chipText: { color: vola.textMuted, fontSize: 12, fontWeight: '600' },

  list: { gap: 0 },
  // 41pt for a one-line row: 10 + 20 (name lineHeight) + 10 + a hairline.
  // 59pt with the second line: + 2 margin + 16 lineHeight.
  row: {
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
    // Opaque: SwipeToDelete's Delete button sits BEHIND the row and slides
    // into view; a transparent row would show it through at rest.
    backgroundColor: vola.bg,
  },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600', color: vola.text },
  mark: {
    fontSize: 10,
    fontWeight: '700',
    color: vola.textMuted,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: vola.line,
    overflow: 'hidden',
  },
  macros: { fontSize: 12, lineHeight: 20, color: vola.textMuted, flexShrink: 0 },
  second: { fontSize: 12, lineHeight: 16, marginTop: 2, color: vola.textDim },
  from: { color: vola.textMuted },
  problem: { fontSize: 12, lineHeight: 16, marginTop: 2, color: vola.warn },
});
