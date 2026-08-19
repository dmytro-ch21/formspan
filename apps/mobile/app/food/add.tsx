/**
 * Log something.
 *
 * ## The two-tap repeat
 *
 * The sheet opens with the KEYBOARD DOWN and NOTHING FOCUSED, showing recents
 * ranked for this slot and read straight from SQLite. Tap a row, it is logged.
 * That is the whole interaction for the common case, and it is why the ranking
 * lives in `rankRecents` rather than being "most recent first" — porridge
 * should top breakfast and not appear at dinner.
 *
 * Auto-focusing the search field would replace two taps with a keyboard, a
 * scroll and a decision, on a screen an athlete opens six times a day.
 *
 * ## The escape row
 *
 * Typing something with no match offers `Add "chicken thigh"` as the last row,
 * prefilled.
 *
 * ## Two sources, kept apart on purpose
 *
 * The box searches the athlete's own saved foods AND the shared catalog N42
 * shipped. Until N51 it searched only the first, so a fresh account got nothing
 * from every query and the screen read as broken — reported from a real phone,
 * which is the only place it could be found, since nobody with a populated
 * saved list ever sees it.
 *
 * They render as two sections rather than one list. A saved food is the
 * athlete's own, carries their serving size, and records provenance when
 * logged; a catalog row is reference data whose id belongs to a different id
 * space and must NOT be written to `source_food_id`. Merging them would hide
 * which of the two a tap is about to log.
 *
 * ## An empty result says which kind of empty it is
 *
 * "Nothing saved by that name" is a claim about the athlete's list. "We do not
 * have that food" is a claim about the catalog, and only the server's
 * `no_match` outcome licenses it — not `query_unusable`, not `catalog_empty`
 * (which is a deploy that never seeded, i.e. our failure), not
 * `market_not_covered`, and emphatically not a failed request. See
 * `emptySearchMessage`.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  emptySearchMessage,
  searchCatalog,
  type CatalogFood,
  type CatalogSearch,
} from '@/lib/catalogApi';
import { localFoods, logFood, recentsFor, saveFoodLocally } from '@/lib/foodLog';
import {
  MEALS,
  atwater,
  kcalLooksOff,
  rankRecents,
  scale,
  slotForClock,
  todayString,
  type Food,
  type Meal,
} from '@/lib/nutrition';
import { request } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * A catalog answer, tied to the query it answers.
 *
 * The pairing is the point: a response that arrives after the athlete has kept
 * typing is an answer to a question they are no longer asking, and rendering it
 * is how a search appears to change its mind.
 */
type CatalogState = { forQuery: string; result: CatalogSearch | 'unreachable' };

/**
 * The key two food lists are compared on.
 *
 * Brand AND name, lowercased and trimmed. Name alone is not identifying — a
 * brandless saved "Greek Yogurt" would suppress every branded one in the
 * catalog — and id is useless here because the two lists do not share an id
 * space.
 */
function foodKey(f: { name: string; brand: string }): string {
  return `${f.brand.trim().toLowerCase()}|${f.name.trim().toLowerCase()}`;
}

/**
 * What a catalog row is called — used for the ROW and for the logged entry,
 * from one place.
 *
 * They were computed separately and disagreed: the row showed the bare name
 * while the log recorded brand-plus-name, so an athlete tapped a row saying one
 * thing and found another in their diary. Raised in review.
 */
function catalogName(food: CatalogFood): string {
  if (!food.brand) return food.name;
  return food.name.toLowerCase().includes(food.brand.toLowerCase())
    ? food.name
    : `${food.brand} ${food.name}`;
}

export default function AddFoodScreen() {
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();

  const date = params.date ?? todayString();
  const [meal, setMeal] = useState<Meal>(
    MEALS.includes(params.meal as Meal) ? (params.meal as Meal) : slotForClock(new Date()),
  );
  const [q, setQ] = useState('');
  const [recents, setRecents] = useState<Food[]>([]);
  const [matches, setMatches] = useState<Food[]>([]);
  const [creating, setCreating] = useState(false);

  /**
   * The catalog half of the search.
   *
   * `null` while nothing has been asked; a `CatalogSearch` once an answer has
   * arrived; `'unreachable'` when the request failed. Three states rather than
   * an array, because an empty array cannot say WHY it is empty and that is the
   * whole question an athlete has when a search finds nothing.
   */
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(() => {
    if (!userId) return;
    let live = true;
    recentsFor(userId, meal)
      .then((rs) => {
        if (live) setRecents(rankRecents(rs, date));
      })
      .catch(() => {});
    localFoods(userId, q)
      .then((fs) => {
        if (live) setMatches(fs);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, meal, q, date]);

  useEffect(() => load(), [load]);

  /**
   * The catalog search, debounced and network-bound.
   *
   * Kept in its own effect rather than folded into `load` because the two are
   * not alike: `load` is a local SQLite read that should feel instant on every
   * keystroke, and this is a request. Debounced so typing "chicken breast" is
   * one search rather than fourteen, and `live` guards the response so a slow
   * answer to "chick" cannot land after a fast answer to "chicken" — the
   * out-of-order render that makes a search feel haunted.
   */
  useEffect(() => {
    const query = q.trim();
    let live = true;
    // Everything happens inside the timer, including the empty-query reset —
    // a synchronous setState in an effect body cascades renders, and the rule
    // that says so is a warning this app's ratchet will not absorb.
    const t = setTimeout(() => {
      if (!query) {
        setCatalog(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      searchCatalog(getToken, { q: query, limit: 20 })
        .then((r) => {
          if (live) setCatalog({ forQuery: query, result: r });
        })
        .catch(() => {
          // A failed request is NOT an empty catalog. Rendering it as one
          // would tell the athlete their food is missing because their signal
          // was bad — the absence-reads-as-answer failure this repo keeps
          // meeting, and the one the barcode screen is shaped around.
          if (live) setCatalog({ forQuery: query, result: 'unreachable' });
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, getToken]);

  const searched = q.trim();
  /**
   * The answer, ONLY if it is an answer to what is currently typed.
   *
   * Without the `forQuery` check a result for "chick" renders under "chicken"
   * for as long as the next request takes — so an athlete who kept typing sees
   * a stale empty state claiming their food is missing, then watches it change
   * its mind. Tying the answer to its own question is cheaper than trying to
   * cancel the request.
   */
  const answer = catalog && catalog.forQuery === searched ? catalog.result : null;
  /**
   * Catalog rows the athlete has not already saved.
   *
   * Deduplicated on BRAND AND NAME rather than id, because the two lists have
   * different id spaces — a saved food's id is client-generated and a catalog
   * id is not, so nothing would ever collide and every saved food would appear
   * twice. Brand is part of the key because name alone is not identifying: a
   * brandless saved "Greek Yogurt" would otherwise suppress every branded
   * Greek yogurt in the catalog.
   */
  const savedNames = useMemo(
    () => new Set(matches.map(foodKey)),
    [matches],
  );
  const catalogOnly = useMemo(() => {
    if (!answer || answer === 'unreachable') return [];
    return answer.foods.filter((f) => !savedNames.has(foodKey(f)));
  }, [answer, savedNames]);

  const shown = searched ? matches : recents;
  const exact = useMemo(
    () => matches.some((f) => f.name.toLowerCase() === q.trim().toLowerCase()),
    [matches, q],
  );

  const log = useCallback(
    async (food: Food, servings = 1) => {
      if (!userId) return;
      const m = scale(food, servings);
      await logFood(userId, {
        eaten_on: date,
        meal,
        name: food.name,
        servings,
        serving_label: food.serving_label,
        ...m,
        source_food_id: food.id,
      });
      // Fire-and-forget: the row is already local and the screen behind this
      // one reads it locally. Awaiting a push would put the network back
      // between the tap and the number moving.
      request('food logged');
      router.back();
    },
    [userId, date, meal, router],
  );

  /**
   * Log a catalog row.
   *
   * Separate from `log` because of the last argument. `source_food_id` is a
   * foreign key into the athlete's OWN saved foods, and a catalog id is not one
   * — pointing it there would be a dangling reference the database would refuse
   * or silently null. Same reasoning as the barcode draft, which is the other
   * place a food arrives from outside the athlete's list.
   *
   * It is also why this does not quietly save the row first: the athlete asked
   * to log a food, not to add one to their list, and a saved-foods list that
   * fills up with everything ever tapped stops being the two-tap shortlist it
   * exists to be.
   */
  const logCatalog = useCallback(
    async (food: CatalogFood) => {
      if (!userId) return;
      await logFood(userId, {
        eaten_on: date,
        meal,
        name: catalogName(food),
        servings: 1,
        serving_label: food.serving_label,
        kcal: food.kcal,
        protein_g: food.protein_g,
        carb_g: food.carb_g,
        fat_g: food.fat_g,
        fibre_g: food.fibre_g,
        source_food_id: null,
      });
      request('catalog food logged');
      router.back();
    },
    [userId, date, meal, router],
  );

  if (creating) {
    return (
      <NewFood
        initialName={q.trim()}
        onCancel={() => setCreating(false)}
        onSave={async (draft) => {
          if (!userId) return;
          const id = await saveFoodLocally(userId, draft);
          await log({ ...draft, id }, 1);
        }}
      />
    );
  }

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Add food' }} />

      <View style={styles.slots}>
        {MEALS.map((m) => {
          const on = m === meal;
          return (
            <Pressable
              key={m}
              onPress={() => setMeal(m)}
              style={[styles.slotPill, on && { backgroundColor: accent.accent }]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={mealLabel(m)}
              testID={`add-slot-${m}`}
            >
              <Text style={[styles.slotText, on && { color: accent.on }]}>{mealLabel(m)}</Text>
            </Pressable>
          );
        })}
      </View>

      <TextInput
        style={styles.search}
        value={q}
        onChangeText={setQ}
        placeholder="Search your foods and the catalog"
        placeholderTextColor={vola.textDim}
        autoCorrect={false}
        accessibilityLabel="Search your foods and the catalog"
        testID="add-search"
      />

      <SectionHeader label={q.trim() ? 'Matches' : 'Recent'} />

      {shown.map((f) => (
        <Pressable
          key={f.id}
          style={styles.row}
          onPress={() => void log(f)}
          accessibilityRole="button"
          accessibilityLabel={`Log ${f.name}`}
          testID={`add-food-${f.id}`}
        >
          <View style={styles.rowMain}>
            <Text style={styles.rowName} numberOfLines={1}>
              {f.name}
            </Text>
            <Text style={styles.rowServing}>{f.serving_label}</Text>
          </View>
          <Text style={styles.rowKcal}>{Math.round(f.kcal)}</Text>
        </Pressable>
      ))}

      {shown.length === 0 && (
        <Text style={styles.empty}>
          {searched
            ? 'Nothing saved by that name.'
            : 'Log something once and it will be here next time.'}
        </Text>
      )}

      {/* The catalog, as a SECOND section rather than merged into the first.
          The athlete's own foods are theirs and carry their own serving sizes;
          a catalog row is reference data. Merging them would also hide which
          of the two a tap is about to log, and they behave differently — a
          saved food records provenance and a catalog row cannot. */}
      {searched && catalogOnly.length > 0 ? (
        <>
          <SectionHeader label="From the food catalog" />
          {catalogOnly.map((f) => (
            <Pressable
              key={f.id}
              style={styles.row}
              onPress={() => void logCatalog(f)}
              accessibilityRole="button"
              accessibilityLabel={`Log ${catalogName(f)} from the food catalog`}
              testID={`add-catalog-${f.id}`}
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {catalogName(f)}
                </Text>
                <Text style={styles.rowServing}>{f.serving_label}</Text>
              </View>
              <Text style={styles.rowKcal}>{Math.round(f.kcal)}</Text>
            </Pressable>
          ))}
          {/* Honest about the cap. "20 of 63" beats a list that silently
              stops and implies it is everything. */}
          {/* Counts what is ACTUALLY on screen. `answer.foods.length` is the
              pre-dedupe figure, so with two rows suppressed it claimed to be
              showing twenty above eighteen. */}
          {answer && answer !== 'unreachable' && answer.total > catalogOnly.length ? (
            <Text style={styles.empty} testID="add-catalog-more">
              Showing {catalogOnly.length} of {answer.total}. Keep typing to narrow it.
            </Text>
          ) : null}
        </>
      ) : null}

      {/* Says WHICH kind of nothing. Only `no_match` is a statement about the
          food; the rest are about the query, the deploy, the region, or the
          network, and reporting any of them as "we do not have that food"
          sends the athlete off to type it in by hand forever. */}
      {/* Gated on the ANSWER being empty, not on `catalogOnly` being empty.
          Those differ, and the difference was a live bug: when every catalog
          row was deduped away against the athlete's saved foods — the MAINLINE
          case for anyone who has saved a common food — an `ok` answer fell
          through to the failure copy, so "The catalog could not answer that
          one" rendered directly beneath the saved row that had just answered
          it. The catalog answered perfectly. Found in review, reproduced.

          `answer &&` also matters on its own: without it the block renders an
          empty `Text` between the keystroke and the debounce — a stray node
          saying nothing that a test can find and mistake for a message. */}
      {searched && answer && !searching && (answer === 'unreachable' || answer.foods.length === 0) ? (
        <Text style={styles.empty} testID="add-catalog-empty">
          {answer === 'unreachable'
            ? 'Could not reach the food catalog. Your own saved foods are still searched.'
            : emptySearchMessage(answer, searched)}
        </Text>
      ) : null}

      {/* Above the describe row, because a packet with a barcode should never
          be described: a scan gives the numbers printed on it, and describing
          it hands the same job to an estimator that N40 measured doubling a
          quantity without flagging it. Below the recents, because the two-tap
          repeat still beats both. */}
      <Pressable
        style={styles.newRow}
        onPress={() => router.push(`/food/scan?meal=${meal}&date=${date}`)}
        accessibilityRole="button"
        accessibilityLabel="Scan a barcode"
        testID="add-scan"
      >
        <Icon name="plus" size={14} color={accent.ink} />
        <Text style={[styles.newText, { color: accent.ink }]}>Scan a barcode</Text>
      </Pressable>

      {/* The escape hatch BELOW the list rather than above it: recents are the
          two-tap path and this is for the meal that is not in them. Offered
          whether or not anything was typed, because "I cannot describe this in
          a search box" is exactly when it is wanted. */}
      <Pressable
        style={styles.newRow}
        onPress={() =>
          router.push(
            `/food/describe?meal=${meal}&date=${date}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`,
          )
        }
        accessibilityRole="button"
        accessibilityLabel="Describe a meal or photograph it"
        testID="add-describe"
      >
        <Icon name="plus" size={14} color={accent.ink} />
        <Text style={[styles.newText, { color: accent.ink }]}>Describe a meal, or photograph it</Text>
      </Pressable>

      {q.trim().length > 0 && !exact && (
        <Pressable
          style={styles.newRow}
          onPress={() => setCreating(true)}
          accessibilityRole="button"
          accessibilityLabel={`Add ${q.trim()}`}
          testID="add-new-food"
        >
          <Icon name="plus" size={14} color={accent.ink} />
          <Text style={[styles.newText, { color: accent.ink }]}>Add “{q.trim()}”</Text>
        </Pressable>
      )}
    </KeyboardAwareScrollView>
  );
}

/**
 * A new food, in one screen.
 *
 * Draft state is TEXT, never numbers: a half-typed `81.` is not a number, and
 * round-tripping through `Number` on every keystroke deletes the decimal point
 * out from under the cursor — the same reason the check-in form and the session
 * logger keep their fields as strings.
 */
function NewFood({
  initialName,
  onCancel,
  onSave,
}: {
  initialName: string;
  onCancel: () => void;
  onSave: (draft: Omit<Food, 'id'>) => Promise<void>;
}) {
  const accent = useAccent();
  const [name, setName] = useState(initialName);
  const [servingLabel, setServingLabel] = useState('100 g');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openFibre, setOpenFibre] = useState(false);
  const [saving, setSaving] = useState(false);

  const num = (k: string): number => {
    const raw = draft[k]?.trim().replace(',', '.');
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const macros = { protein_g: num('protein_g'), carb_g: num('carb_g'), fat_g: num('fat_g') };
  const suggested = atwater(macros);
  const kcal = draft.kcal?.trim() ? num('kcal') : suggested;
  const odd = draft.kcal?.trim() ? kcalLooksOff(num('kcal'), macros) : false;

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'New food' }} />

      <Field label="Name" value={name} onChange={setName} testID="new-name" />
      <Field
        label="One serving is"
        value={servingLabel}
        onChange={setServingLabel}
        hint="How you would say it — “100 g”, “1 scoop (30 g)”, “1 egg”."
        testID="new-serving"
      />

      <View style={styles.macros}>
        {(
          [
            ['kcal', 'Calories'],
            ['protein_g', 'Protein (g)'],
            ['carb_g', 'Carbs (g)'],
            ['fat_g', 'Fat (g)'],
          ] as const
        ).map(([key, fieldLabel]) => (
          <View key={key} style={styles.macroField}>
            <Text style={styles.fieldLabel}>{fieldLabel}</Text>
            <TextInput
              style={styles.input}
              value={draft[key] ?? ''}
              onChangeText={(t) => setDraft((d) => ({ ...d, [key]: t }))}
              keyboardType="decimal-pad"
              inputMode="decimal"
              // The Atwater sum fills the calorie field in when the packet does
              // not state one. A PLACEHOLDER, never a value: a stated kcal
              // always wins, because real labels do not reconcile against
              // 4/4/9.
              placeholder={key === 'kcal' && suggested > 0 ? String(Math.round(suggested)) : '—'}
              placeholderTextColor={vola.textDim}
              accessibilityLabel={fieldLabel}
              testID={`new-${key}`}
            />
          </View>
        ))}
      </View>

      {odd && (
        <Text style={styles.nudge}>
          The macros add to {Math.round(suggested)} kcal — worth checking one of these.
        </Text>
      )}

      <Pressable
        onPress={() => setOpenFibre((v) => !v)}
        style={styles.disclose}
        accessibilityRole="button"
        accessibilityState={{ expanded: openFibre }}
        accessibilityLabel="Fibre"
      >
        <Text style={styles.fieldLabel}>Fibre</Text>
        <Icon name={openFibre ? 'chevron-down' : 'chevron'} size={16} color={vola.textMuted} />
      </Pressable>
      {openFibre && (
        <TextInput
          style={styles.input}
          value={draft.fibre_g ?? ''}
          onChangeText={(t) => setDraft((d) => ({ ...d, fibre_g: t }))}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="—"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Fibre in grams"
          testID="new-fibre_g"
        />
      )}

      <View style={styles.actions}>
        <Pressable
          onPress={async () => {
            if (!name.trim() || saving) return;
            setSaving(true);
            try {
              await onSave({
                kind: 'food',
                name: name.trim(),
                brand: '',
                serving_label: servingLabel.trim() || '1 serving',
                serving_grams: null,
                kcal,
                ...macros,
                // Absent, not zero: a food nobody stated fibre for is not
                // claiming there is none.
                fibre_g: draft.fibre_g?.trim() ? num('fibre_g') : null,
              });
            } finally {
              setSaving(false);
            }
          }}
          style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Save and log"
          testID="new-save"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>
            {saving ? 'Saving…' : 'Save and log'}
          </Text>
        </Pressable>
        <Pressable onPress={onCancel} style={styles.secondary} accessibilityRole="button">
          <Text style={styles.secondaryText}>Back</Text>
        </Pressable>
      </View>
    </KeyboardAwareScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        accessibilityLabel={label}
        testID={testID}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function mealLabel(m: Meal): string {
  return m === 'snack' ? 'Snacks' : m[0].toUpperCase() + m.slice(1);
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
  slots: { flexDirection: 'row', gap: 8 },
  slotPill: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
  },
  slotText: { fontSize: 12, fontWeight: '600', color: vola.textMuted },
  search: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: vola.text,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowServing: { fontSize: 12, color: vola.textDim },
  rowKcal: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  empty: { fontSize: 13, color: vola.textMuted, paddingVertical: 8 },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  newText: { fontSize: 14, fontWeight: '600' },
  field: { gap: 6 },
  fieldLabel: { fontSize: 12, color: vola.textDim, fontWeight: '600' },
  hint: { fontSize: 11, color: vola.textDim },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: vola.text,
    fontSize: 15,
  },
  macros: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  macroField: { flexBasis: '47%', flexGrow: 1, gap: 6 },
  nudge: { fontSize: 12, color: vola.textMuted },
  disclose: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  primary: {
    minHeight: 46,
    paddingHorizontal: 22,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
  secondary: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
  },
  secondaryText: { fontSize: 13, color: vola.textMuted, fontWeight: '600' },
});
