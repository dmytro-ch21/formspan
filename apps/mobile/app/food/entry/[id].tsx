/**
 * Correct one logged entry.
 *
 * ## What this screen may change, and what it may not
 *
 * Servings, meal slot and the numbers themselves. It does NOT reach back into
 * the saved food the entry came from: `source_food_id` is provenance, and a
 * correction here is a correction to what was eaten, not to the athlete's
 * catalog. Editing the food instead would silently rewrite every day it has
 * ever appeared on — the one rule the whole module is built around.
 *
 * ## Servings drive the numbers, until you touch a number
 *
 * The common correction is "that was one and a half, not one", so changing
 * servings rescales the macros from the per-serving figures the entry already
 * carries. Type into a macro field and that link is cut for the rest of the
 * edit: an explicit number always beats a derived one, and re-deriving under
 * the cursor is how a form fights its user.
 *
 * ## Quantity in grams, when the entry can honestly say so (N90)
 *
 * `nutrition_entries` has no gram column — `servings` is a multiplier against
 * whatever `serving_label` says one serving is, and that label is free text.
 * `gramsBasisFromLabel` reads a genuine weight back out of it ("100 g", which
 * is what almost every catalog-logged entry carries) and refuses everything
 * else ("1 scoop (30 g)", "1 egg") rather than inventing a basis. When it
 * returns a number this screen shows a grams/oz control, converting to and
 * from `servings` under the hood — `setServingCount` below is still what
 * actually rescales the macros, so typing a gram quantity and picking a
 * servings chip go through the exact same path. When it returns null (a food
 * with no honest gram weight) this screen is unchanged from before N90: a
 * plain servings stepper.
 *
 * ## "Made of" and "Split into separate entries" (N115)
 *
 * When this entry was logged from a recipe — `source_food_id` names one, and
 * that includes a meal built by `food/combine.tsx` a minute ago, which is a
 * recipe like any other — its items are shown read-only under "Made of". That
 * is `Food`'s own storage doing the work: a recipe already keeps a permanent
 * record of what it is made from, so viewing it back is not a feature this
 * screen has to build, only a query it has to make.
 *
 * "Split into separate entries" (rebuilding those items as their own logged
 * rows and removing this one) is offered **only when `eaten_on` is today**.
 * Not a technical limit — {@link entriesFromRecipeItems} works on any day —
 * but a considered one: splitting a day OTHER than today changes a log that
 * was already used to judge a day gone by, the exact thing this module's own
 * package doc spends a paragraph refusing to let an edit do. Today's log is
 * still being written, so replacing one row with several is still within the
 * same "what did I eat today" answer rather than a rewrite of a settled one.
 * A past day shows why the control is missing rather than just omitting it —
 * "the copy says plainly that it is not [reversible]" is the ticket's own
 * fallback for exactly this case.
 *
 * **Both are gated on `recipeFood.yield_servings === 1 && entry.servings ===
 * 1` — found in review, and not a stylistic choice.** A recipe's `items` are
 * the FULL BATCH, at whatever quantities were entered; a portion of it is
 * `items summed / yield_servings`, and this entry's own `kcal` is that portion
 * times however many servings were logged. The two agree — "Made of" sums to
 * exactly this entry's own total — ONLY when `yield_servings === servings`,
 * and the simplest, always-true case of that is both equal to 1: a
 * `food/combine.tsx` meal, never edited since (it fixes `yield_servings: 1`
 * and logs `servings: 1`, but the servings stepper on THIS screen can still
 * move an already-logged one away from 1 later). Widening the gate to "any
 * `yield_servings === servings`" would also be sound and would additionally
 * cover "logged the whole batch of an ordinary N87 recipe" — narrowed to
 * exactly-one here because that is the only case this ticket asks for, and a
 * wider gate is a decision for whoever asks for the wider case, not a default
 * this ticket should reach for. Get the condition wrong in either direction
 * and "Made of"/Split would show, or split into, a total that does not match
 * what this entry itself says was eaten — the identical failure the AC names
 * ("a total that cannot be checked against its components").
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { ShareToFriend } from '@/components/ShareToFriend';
import { editEntry, entrySyncState, localEntry, localFood, removeEntry, splitEntry } from '@/lib/foodLog';
import { gramsBasisFromLabel, parseQuantity, servingsForLabelGrams } from '@/lib/foodQuantity';
import { fmtAmount, MEALS, rescale, todayString, type Entry, type Food, type Meal } from '@/lib/nutrition';
import { entriesFromRecipeItems } from '@/lib/recipe';
import { shareBlockedReason } from '@/lib/shares';
import { request, useSyncState } from '@/lib/sync';
import { useUnits } from '@/lib/UnitsProvider';
import { foodUnitLabel, fromDisplayGrams, toDisplayGrams, type FoodUnit } from '@/lib/units';

const FOOD_UNITS: FoodUnit[] = ['g', 'oz'];

/** The four editable numbers, in the order a packet prints them. */
const FIELDS = [
  ['kcal', 'Calories'],
  ['protein_g', 'Protein (g)'],
  ['carb_g', 'Carbs (g)'],
  ['fat_g', 'Fat (g)'],
] as const;

type Key = (typeof FIELDS)[number][0];

export default function EditEntryScreen() {
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [entry, setEntry] = useState<Entry | null>(null);
  const [missing, setMissing] = useState(false);
  const [meal, setMeal] = useState<Meal>('lunch');
  const [servings, setServings] = useState('1');
  const [draft, setDraft] = useState<Record<string, string>>({});
  // Once a macro is typed, servings stop rescaling. See the docstring.
  const [manual, setManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [gone, setGone] = useState(false);

  // N115 — the recipe this entry was logged from, if `source_food_id` names
  // one that is still a recipe with items on this device. Null covers "not
  // looked up yet", "this entry has no source", "the source is a plain food"
  // and "the source is gone" alike — none of them render a "Made of" section,
  // so there is nothing here that needs telling apart.
  const [recipeFood, setRecipeFood] = useState<Food | null>(null);
  const [splitting, setSplitting] = useState(false);

  const { foodUnit, setFoodUnit } = useUnits();
  // A VIEW of `servings * basis`, in `foodUnit` — servings stays the source of
  // truth (same reason `FoodQuantity` keeps grams, not the text field, as its
  // state) so this and the servings chips can share one rescale path.
  const [gramsText, setGramsText] = useState('');

  // N116/#505 — whether this entry is safe to hand to `ShareToFriend`. Read
  // alongside the entry itself, from the same two flags `removeEntry` reads.
  const [shareSync, setShareSync] = useState<{ unsynced: boolean; owed: boolean } | null>(null);

  useEffect(() => {
    if (!userId || !id) return;
    let live = true;
    localEntry(userId, id)
      .then((e) => {
        if (!live) return;
        if (!e) {
          setMissing(true);
          return;
        }
        setEntry(e);
        setMeal(e.meal);
        setServings(String(e.servings));
        setDraft({
          kcal: String(round(e.kcal)),
          protein_g: String(round(e.protein_g)),
          carb_g: String(round(e.carb_g)),
          fat_g: String(round(e.fat_g)),
          fibre_g: e.fibre_g == null ? '' : String(round(e.fibre_g)),
        });
        const basis = gramsBasisFromLabel(e.serving_label);
        if (basis != null) {
          // `foodUnit` is read at the unit the athlete already had set when
          // this screen opened — the effect below handles it changing under
          // the sheet afterwards, so this initial seed does not need it in
          // this callback's own dependency list.
          setGramsText(String(toDisplayGrams(e.servings * basis, foodUnit)));
        }
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, id]);

  // N116/#505 — a separate read, same reasoning workoutDetailScreen's own
  // `blockedFromSharing` effect gives: sync flags can change without the
  // entry's own fields changing (a background push finishing), so this is
  // not derivable from `entry` alone.
  //
  // `lastSyncAt` IN THE DEPS, not just `[userId, id]` — `workout/[id].tsx`'s
  // own copy of this effect documents why: `request()` returns immediately
  // and pushes in the background, so at the moment this screen first reads
  // the flags a freshly-logged entry is still `unsynced` in SQLite. Without
  // `lastSyncAt`, Share would stay stuck saying "Not synced yet" long after
  // the push actually landed, until the screen was left and reopened.
  const { lastSyncAt } = useSyncState();
  useEffect(() => {
    if (!userId || !id) return;
    let live = true;
    entrySyncState(userId, id).then((s) => {
      if (live) setShareSync(s);
    });
    return () => {
      live = false;
    };
  }, [userId, id, lastSyncAt]);

  // N115 — a second, separate read rather than folded into the one above: it
  // depends on `entry.source_food_id`, which is not known until the first
  // read resolves, and a food with no items (a plain saved food, not a
  // recipe) is deliberately left as `null` here rather than stored — the
  // render side only ever asks "do I have a recipe with items", never "what
  // kind of food was this".
  useEffect(() => {
    // Nothing to reset TO here: the state already starts at `null`, and this
    // screen never sees the same `entry` swap a `source_food_id` in for
    // another mid-mount — a fresh `id` param is a fresh screen instance. So
    // the only real work this effect ever does is the fetch below, and it
    // does it only when there is one to make.
    if (!userId || !entry?.source_food_id) return;
    let live = true;
    localFood(userId, entry.source_food_id)
      .then((f) => {
        if (!live) return;
        // The gate this file's own docstring explains at length: a recipe's
        // items are the FULL BATCH, and they sum to exactly this entry's own
        // total only when the recipe makes one serving AND one serving was
        // logged. Reviewed and found missing before merge — the first version
        // showed "Made of" for ANY recipe-sourced entry, which overstated an
        // ordinary multi-portion recipe's contents by its yield factor.
        setRecipeFood(
          f && f.kind === 'recipe' && f.items.length > 0
            && f.yield_servings === 1 && entry.servings === 1
            ? f
            : null,
        );
      })
      .catch(() => {
        // "Made of" is supplementary, not the entry itself — a failed lookup
        // must not surface as an unhandled rejection. `recipeFood` stays at
        // its default `null`, the same as "no source food at all".
        if (live) setRecipeFood(null);
      });
    return () => {
      live = false;
    };
  }, [userId, entry?.source_food_id, entry?.servings]);

  /**
   * Rebuild the recipe's items as their own logged entries, and remove this
   * one — see the docstring for why this is offered only for TODAY.
   *
   * `splitEntry` does both writes in ONE transaction — see its own doc
   * comment in `foodLog.ts` for why a thrown `removeEntry` after the items
   * were already logged (or a retry after that) is a correctness gap, not
   * just an inconvenience, once this is more than one item.
   */
  const split = useCallback(async () => {
    if (!userId || !entry || !recipeFood || splitting) return;
    setSplitting(true);
    try {
      await splitEntry(userId, {
        entries: entriesFromRecipeItems(recipeFood, entry.meal, entry.eaten_on),
        removeId: entry.id,
      });
      request('meal split');
      router.back();
    } finally {
      setSplitting(false);
    }
  }, [userId, entry, recipeFood, splitting, router]);

  /**
   * Rescale from the entry's own PER-SERVING figures rather than from what is
   * currently in the fields. Scaling the displayed numbers would compound the
   * rounding every time the stepper moved.
   */
  const setServingCount = useCallback(
    (next: string) => {
      setServings(next);
      if (manual || !entry) return;
      const n = parse(next);
      if (!(n > 0)) return;
      const m = rescale(entry, n);
      setDraft((d) => ({
        ...d,
        kcal: String(m.kcal),
        protein_g: String(m.protein_g),
        carb_g: String(m.carb_g),
        fat_g: String(m.fat_g),
        fibre_g: m.fibre_g == null ? (d.fibre_g ?? '') : String(m.fibre_g),
      }));
    },
    [entry, manual],
  );

  /**
   * Grams typed or picked -> servings, through the SAME rescale path the
   * servings chips already use — a gram quantity and a servings chip are two
   * views of one number, never two competing ones.
   */
  const commitGrams = useCallback(
    (text: string) => {
      setGramsText(text);
      if (!entry) return;
      const typed = parseQuantity(text);
      if (typed == null) return;
      const grams = fromDisplayGrams(typed, foodUnit);
      const next = servingsForLabelGrams(entry.serving_label, grams);
      if (next != null) setServingCount(String(next));
    },
    [entry, foodUnit, setServingCount],
  );

  const pickGrams = useCallback(
    (grams: number) => {
      if (!entry) return;
      const next = servingsForLabelGrams(entry.serving_label, grams);
      if (next == null) return;
      setServingCount(String(next));
      setGramsText(String(toDisplayGrams(grams, foodUnit)));
    },
    [entry, foodUnit, setServingCount],
  );

  /**
   * The g/oz toggle CONVERTS the field rather than relabelling it — same rule
   * and same ordering as `FoodQuantity`'s `switchUnit`: read the current
   * quantity out under the OLD unit, redisplay it under the new one, and only
   * then persist the choice.
   */
  const switchUnit = useCallback(
    async (u: FoodUnit) => {
      if (u === foodUnit || !entry) return;
      const basis = gramsBasisFromLabel(entry.serving_label);
      if (basis != null) {
        const n = parse(servings);
        setGramsText(String(toDisplayGrams(n * basis, u)));
      }
      await setFoodUnit(u);
    },
    [foodUnit, entry, servings, setFoodUnit],
  );

  // Re-renders the field when the unit changes from OUTSIDE this screen (the
  // athlete flips it in Settings, say, while this sheet is open) — same
  // mechanism and same reasoning as `FoodQuantity`'s own `lastUnit` effect.
  // Keyed on the unit alone, never on `servings`, or it would fight the
  // athlete's own typing.
  const lastUnit = useRef(foodUnit);
  useEffect(() => {
    // `entry` checked BEFORE the ref write, not after: in the narrow window
    // between mount and `localEntry` resolving, a unit change arriving while
    // `entry` is still null must not be consumed here — advancing
    // `lastUnit.current` past it would mean the seed effect above (whose
    // `foodUnit` closure is frozen at mount) applies the STALE unit once the
    // entry loads, leaving the field showing the old unit's number beside a
    // toggle already lit for the new one. `entry` is now in the deps below so
    // this effect gets another chance to run once loading finishes and pick
    // the missed change back up — the ref guard still stops it firing on
    // every keystroke, since `foodUnit` itself hasn't changed between those.
    if (!entry) return;
    if (lastUnit.current === foodUnit) return;
    lastUnit.current = foodUnit;
    const basis = gramsBasisFromLabel(entry.serving_label);
    if (basis == null) return;
    const n = parse(servings);
    // This is the sanctioned "re-render because an external value changed"
    // effect the ref guard above exists for — `FoodQuantity`'s identically
    // shaped `lastUnit` effect is the same pattern. `servings` is read fresh
    // via closure rather than added to the deps, which would fire this on
    // every keystroke instead of only on an outside unit change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGramsText(String(toDisplayGrams(n * basis, foodUnit)));
    // `servings` deliberately still absent — see above; `entry` is now
    // included so the effect gets a second chance once loading finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foodUnit, entry]);

  if (missing) {
    return (
      <View style={styles.gone}>
        <Stack.Screen options={{ title: 'Entry' }} />
        <Text style={styles.goneText}>This entry is no longer here.</Text>
      </View>
    );
  }
  if (!entry) {
    return (
      <View style={styles.gone}>
        <Stack.Screen options={{ title: 'Entry' }} />
        <Text style={styles.goneText}>Loading…</Text>
      </View>
    );
  }

  // Recomputed every render rather than memoised: it is one cheap regex
  // against a string that only ever changes when a fresh `entry` loads.
  const quantityBasis = gramsBasisFromLabel(entry.serving_label);

  // N116/#505. `shareSync === null` (still loading, or this device somehow
  // has no local row for an entry it just displayed) reads as blocked rather
  // than as permitted — the safe default while the answer is unknown.
  const blockedFromSharing = shareSync
    ? shareBlockedReason({ ...shareSync, unsavedOnScreen: false })
    : 'Loading…';

  const save = async () => {
    if (!userId || saving) return;
    const n = parse(servings);
    const effectiveServings = n > 0 ? n : entry.servings;
    // This screen has no fields for the N52 label macros — it corrects the
    // four figures the athlete can see, not the whole label. They are
    // therefore never taken from `draft` (there is nothing there to take),
    // but they must NOT be carried through UNSCALED from the original entry
    // either: the common correction on this screen is changing `servings`,
    // and `entry`'s own fields are its ORIGINAL per-log absolutes — sending
    // them back untouched while `kcal`/`protein_g`/etc are rescaled to the
    // new serving count would store an entry whose visible and hidden
    // macros disagree about how much was eaten. `rescale` already scales
    // all ten `Macros` fields from the entry's per-serving figures, null-
    // preserving exactly as `fibre_g` is, so reading the hidden five off
    // its result keeps them in step with the visible four without a second,
    // parallel scaling rule to keep in sync by hand.
    const rescaled = rescale(entry, effectiveServings);
    setSaving(true);
    try {
      await editEntry(userId, entry.id, {
        eaten_on: entry.eaten_on,
        meal,
        name: entry.name,
        servings: effectiveServings,
        serving_label: entry.serving_label,
        kcal: parse(draft.kcal),
        protein_g: parse(draft.protein_g),
        carb_g: parse(draft.carb_g),
        fat_g: parse(draft.fat_g),
        // Blank stays absent. Clearing the field is "I never recorded this",
        // which is not the same claim as zero grams of fibre.
        fibre_g: draft.fibre_g?.trim() ? parse(draft.fibre_g) : null,
        saturated_fat_g: rescaled.saturated_fat_g,
        sugar_g: rescaled.sugar_g,
        added_sugar_g: rescaled.added_sugar_g,
        sodium_mg: rescaled.sodium_mg,
        cholesterol_mg: rescaled.cholesterol_mg,
        source_food_id: entry.source_food_id,
        // Carried through unchanged, like `source_food_id` above: an edit to
        // the amount or macros says nothing about what food this was, so the
        // glyph it draws must not change underneath the athlete.
        category: entry.category,
        notes: entry.notes,
      });
      request('food edited');
      router.back();
    } catch {
      // `editEntry` throws when the row has gone — deleted from the day screen
      // while this editor sat open. Without this the button simply un-dimmed,
      // which is the same silent-failure shape the target screen's `accept()`
      // had.
      setGone(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: entry.name }} />

      <Text style={styles.serving}>
        {entry.serving_label} · logged {entry.eaten_on}
      </Text>

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
              testID={`edit-slot-${m}`}
            >
              <Text style={[styles.slotText, on && { color: accent.on }]}>{mealLabel(m)}</Text>
            </Pressable>
          );
        })}
      </View>

      {quantityBasis != null ? (
        // N90: `serving_label` honestly states a gram weight, so quantity is
        // edited in grams (or oz) rather than as an abstract multiplier — the
        // same control `FoodQuantity` offers on the way IN, offered again on
        // the way back OUT.
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Quantity</Text>
          <View style={styles.stepRow}>
            {[0.5, 1, 1.5, 2].map((f) => {
              const g = quantityBasis * f;
              const on = Math.abs(parse(servings) - f) < 0.001;
              return (
                <Pressable
                  key={f}
                  onPress={() => pickGrams(g)}
                  style={[styles.chip, on && { borderColor: accent.accent }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${toDisplayGrams(g, foodUnit)}${foodUnitLabel(foodUnit)}`}
                  testID={`edit-quantity-${g}`}
                >
                  <Text style={styles.chipText}>
                    {toDisplayGrams(g, foodUnit)}
                    {foodUnitLabel(foodUnit)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.quantityRow}>
            <TextInput
              style={[styles.input, styles.stepInput]}
              value={gramsText}
              onChangeText={commitGrams}
              keyboardType="decimal-pad"
              inputMode="decimal"
              accessibilityLabel={`Quantity in ${foodUnit === 'oz' ? 'ounces' : 'grams'}`}
              testID="edit-quantity"
            />
            <View style={styles.toggle}>
              {FOOD_UNITS.map((u) => (
                <Pressable
                  key={u}
                  onPress={() => void switchUnit(u)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: u === foodUnit }}
                  accessibilityLabel={u === 'oz' ? 'Ounces' : 'Grams'}
                  testID={`edit-quantity-unit-${u}`}
                  style={[styles.unit, u === foodUnit && { backgroundColor: accent.accent }]}
                >
                  <Text style={[styles.unitText, u === foodUnit && { color: accent.on }]}>
                    {foodUnitLabel(u)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Servings</Text>
          <View style={styles.stepRow}>
            {['0.5', '1', '1.5', '2'].map((s) => (
              <Pressable
                key={s}
                onPress={() => setServingCount(s)}
                style={[styles.chip, servings === s && { borderColor: accent.accent }]}
                accessibilityRole="button"
                accessibilityState={{ selected: servings === s }}
                accessibilityLabel={`${s} servings`}
                testID={`edit-servings-${s}`}
              >
                <Text style={styles.chipText}>{s}</Text>
              </Pressable>
            ))}
            <TextInput
              style={[styles.input, styles.stepInput]}
              value={servings}
              onChangeText={setServingCount}
              keyboardType="decimal-pad"
              inputMode="decimal"
              accessibilityLabel="Servings"
              testID="edit-servings"
            />
          </View>
        </View>
      )}

      <View style={styles.macros}>
        {FIELDS.map(([key, label]) => (
          <View key={key} style={styles.macroField}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
              style={styles.input}
              value={draft[key] ?? ''}
              onChangeText={(t) => {
                setManual(true);
                setDraft((d) => ({ ...d, [key as Key]: t }));
              }}
              keyboardType="decimal-pad"
              inputMode="decimal"
              placeholder="—"
              placeholderTextColor={vola.textDim}
              accessibilityLabel={label}
              testID={`edit-${key}`}
            />
          </View>
        ))}
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Fibre (g) — blank if you never recorded it</Text>
        <TextInput
          style={styles.input}
          value={draft.fibre_g ?? ''}
          onChangeText={(t) => {
            setManual(true);
            setDraft((d) => ({ ...d, fibre_g: t }));
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="—"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Fibre in grams"
          testID="edit-fibre_g"
        />
      </View>

      {recipeFood ? (
        <View style={styles.field} testID="entry-made-of">
          <SectionHeader label="Made of" />
          {recipeFood.items.map((it, i) => (
            <View key={`${it.name}-${i}`} style={styles.madeOfRow} testID={`entry-made-of-${i}`}>
              <View style={styles.madeOfMain}>
                <Text style={styles.madeOfName} numberOfLines={1}>
                  {it.name}
                </Text>
                <Text style={styles.madeOfMacros}>
                  {fmtAmount(it.protein_g * it.quantity)}P · {fmtAmount(it.carb_g * it.quantity)}C ·{' '}
                  {fmtAmount(it.fat_g * it.quantity)}F
                </Text>
              </View>
              <Text style={styles.madeOfKcal}>{fmtAmount(it.kcal * it.quantity)} kcal</Text>
            </View>
          ))}

          {entry.eaten_on === todayString() ? (
            <Pressable
              onPress={() => void split()}
              disabled={splitting}
              style={[styles.split, splitting && styles.off]}
              accessibilityRole="button"
              accessibilityLabel="Split into separate entries"
              testID="entry-split"
            >
              <Text style={styles.splitText}>
                {splitting ? 'Splitting…' : 'Split into separate entries'}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.splitNote} testID="entry-split-unavailable">
              This can’t be split back into separate entries — that would change
              a past day’s log.
            </Text>
          )}
        </View>
      ) : null}

      {gone ? (
        <Text style={styles.problem}>
          This entry has been deleted, so there is nothing left to correct.
        </Text>
      ) : null}

      {/* N116/#505. Sends WHAT THE SERVER HOLDS for this entry — not this
          screen's own draft state, hence `blockedFromSharing` covering the
          two sync flags. Landing shape: the receiver gets a new saved food,
          scaled to one serving of it — never a dated row in their own log,
          see nutrition/share.go's EntryCopier doc comment for why. */}
      <ShareToFriend
        resourceType="nutrition_entry"
        resourceId={entry.id}
        disabled={blockedFromSharing !== null}
        disabledReason={blockedFromSharing ?? undefined}
        testID="entry-share-open"
      />

      <View style={styles.actions}>
        <Pressable
          onPress={() => void save()}
          style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Save"
          testID="edit-save"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>
            {saving ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            if (!userId) return;
            await removeEntry(userId, entry.id);
            request('food deleted');
            router.back();
          }}
          style={styles.secondary}
          accessibilityRole="button"
          accessibilityLabel="Delete this entry"
          testID="edit-delete"
        >
          <Text style={styles.secondaryText}>Delete</Text>
        </Pressable>
      </View>
    </KeyboardAwareScrollView>
  );
}

/** Blank, a stray comma, or nonsense reads as 0 rather than NaN. */
function parse(raw: string | undefined): number {
  const n = Number(raw?.trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** One decimal at most: nobody corrects a lunch to a tenth of a gram. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function mealLabel(m: Meal): string {
  return m === 'snack' ? 'Snacks' : m[0].toUpperCase() + m.slice(1);
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
  gone: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  goneText: { fontSize: 14, color: vola.textMuted },
  problem: { fontSize: 13, color: vola.danger, lineHeight: 18 },
  serving: { fontSize: 12, color: vola.textDim },
  madeOfRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.lineSoft,
    backgroundColor: vola.surface,
    marginBottom: 6,
  },
  madeOfMain: { flex: 1, gap: 2 },
  madeOfName: { fontSize: 14, fontWeight: '600' },
  madeOfMacros: { fontSize: 12, color: vola.textDim },
  madeOfKcal: { fontSize: 13, color: vola.textMuted },
  split: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: vola.line,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 4,
  },
  splitText: { fontSize: 13, fontWeight: '700', color: vola.text },
  splitNote: { fontSize: 12, color: vola.textDim, lineHeight: 17, marginTop: 4 },
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
  field: { gap: 6 },
  fieldLabel: { fontSize: 12, color: vola.textDim, fontWeight: '600' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
  },
  chipText: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
  stepInput: { flex: 1, minWidth: 70 },
  quantityRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  toggle: {
    flexDirection: 'row',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: vola.surface,
  },
  unit: { paddingVertical: 12, paddingHorizontal: 16 },
  unitText: { fontSize: 14, fontWeight: '600', color: vola.textMuted },
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
