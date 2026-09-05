/**
 * Describe a meal, or photograph it, and correct what comes back.
 *
 * ## The draft is the point, not the estimate
 *
 * Nothing is logged until the athlete taps Log. The rows arrive editable and
 * the two fields that make them correctable — how sure the model is about the
 * PORTION, and the assumption it had to make — are shown next to the numbers
 * rather than hidden behind a disclosure. A confident-looking wrong number is
 * worse than an obviously uncertain one, because the athlete has no reason to
 * check it.
 *
 * ## Why confidence is about quantity only
 *
 * Naming a food is reliable; judging how much of it is on the plate is not.
 * A misnamed food is obvious the moment you read it. A portion wrong by a
 * factor of two is invisible and moves the day's remaining figure by hundreds
 * of calories. So `low` gets a visible mark and the servings field is where
 * the eye is sent.
 *
 * ## The photo disclosure is not fine print
 *
 * A photo leaves the device and goes to a third party. That is stated on the
 * button's own screen, before the camera opens, because a privacy consequence
 * discovered afterwards is not a choice the athlete made.
 */

import { useAuth } from '@clerk/clerk-expo';
import { randomUUID } from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView, useEnsureVisible } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { rememberBarcode } from '@/lib/barcodeCache';
import { parseOr } from '@/lib/draftNumber';
import {
  describeMeal,
  estimateErrorMessage,
  isQuotaExhausted,
  itemToEntry,
  photographMeal,
  quotaResetMessage,
  savedFoodFrom,
  type EstimateQuota,
  type EstimatedItem,
  type MealEstimate,
} from '@/lib/estimateApi';
import { logFood, saveFoodLocally } from '@/lib/foodLog';
import { prepareImageForUpload, type UploadableImage } from '@/lib/imageUpload';
import {
  fmtAmount,
  MEALS,
  slotForClock,
  sumMacros,
  todayString,
  type Macros,
  type Meal,
} from '@/lib/nutrition';
import { request as requestSync } from '@/lib/sync';
import { momentumOpenFoodHref } from '@/lib/todayBoard';
import { useAuthToken } from '@/lib/useAuthToken';

export default function DescribeMealScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const params = useLocalSearchParams<{
    meal?: string;
    date?: string;
    q?: string;
    /**
     * Set when the athlete arrived here from a barcode the catalog did not
     * have. It is the third rung of the scan ladder — catalog, then Open Food
     * Facts, then describe it yourself — and it is what lets a confirmed draft
     * teach this phone the packet.
     */
    barcode?: string;
    /**
     * N59: set when the athlete tapped "Photograph" on the grouped add-food
     * choice, rather than "Describe". Opens the camera immediately on arrival
     * so that choice reads as its own destination rather than as "describe,
     * then notice a photo button".
     */
    photo?: string;
  }>();

  const date = params.date ?? todayString();
  const [meal, setMeal] = useState<Meal>(
    MEALS.includes(params.meal as Meal) ? (params.meal as Meal) : slotForClock(new Date()),
  );

  // Seeded from the quick-add search box: whatever they typed there is
  // already the start of a description, and retyping it is the kind of
  // friction that sends people back to the form.
  const [description, setDescription] = useState(params.q ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<MealEstimate | null>(null);
  const [quota, setQuota] = useState<EstimateQuota | null>(null);
  // Drafted rows the athlete can edit before logging. Held separately from the
  // estimate so the original stays readable — the assumption beside a number
  // makes no sense once the number has been changed.
  const [rows, setRows] = useState<DraftRow[]>([]);
  /**
   * Whether the estimate that produced this draft named exactly ONE food.
   *
   * Held apart from `rows.length` because `rows` is TRIMMED as the save loop
   * lands each item, so by the time the barcode is written `rows.length` is
   * about this attempt rather than about the draft. The gap is reachable:
   * a two-item draft whose first item logs and second fails leaves one row, and
   * a retry then sees a single-item save and would cache that lone remainder
   * against the packet — the same "whichever item happened to be first,
   * forever" outcome the guard exists to prevent, just with the last one.
   * Raised in review.
   */
  const [singleFood, setSingleFood] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * The saved food a REGENERATE is replacing, if this draft came from one.
   *
   * "Not right? Estimate it again" is the escape hatch from a stored food whose
   * numbers are wrong. Without this, confirming the fresh draft saves a SECOND
   * food under the same name — so the athlete escapes the bad numbers by
   * growing exactly the pile of duplicate rows N114 was reported about, minus
   * the cost. Carrying the id forward makes the regenerate an overwrite, which
   * is what "estimate it again" means. Raised in review.
   *
   * Cleared whenever a draft arrives that is NOT a regenerate of that food, so
   * a later unrelated description cannot overwrite it.
   */
  const [replacing, setReplacing] = useState<string | null>(null);

  /**
   * N472: log every drafted row as ONE combined entry instead of one each.
   *
   * Only meaningful with more than one row — the option is hidden below
   * `rows.length <= 1`, and the ONE canonical place that matters is read
   * back through `compiling` (declared after `rows`), never this flag alone,
   * so a row removed down to a lone survivor cannot leave `compileMeal`
   * stuck true with no UI left to turn it off.
   */
  const [compileMeal, setCompileMeal] = useState(false);
  /**
   * The compiled meal's name — seeded from the model's own `meal_name`
   * (`estimate.meal_name`) and always editable, the same as every other
   * AI-authored value on this screen. Held apart from `estimate` so editing
   * it does not disturb the assumption/note text the original carries.
   */
  const [mealName, setMealName] = useState('');
  /**
   * The id `logCompiled` will save the combined food under, minted lazily on
   * the first attempt and REUSED by a retry — never a fresh `randomUUID()`
   * per tap.
   *
   * Without this, a retry after `logFood` fails (the food having already
   * saved fine) mints a second "Chipotle chicken bowl" under a new id: the
   * upsert in `saveFoodLocally` keys on `id`, so two different ids are two
   * different rows, not one corrected one. Reused across retries by holding
   * the SAME id and letting the second attempt's save overwrite the first
   * rather than duplicate it — the identical trick `replacing` above already
   * plays for a regenerate's saved food. Cleared on every fresh draft
   * (`receive`, below) so an unrelated later compile does not overwrite it.
   */
  const compiledFoodId = useRef<string | null>(null);

  const receive = useCallback(
    (res: { estimate: MealEstimate; quota: EstimateQuota }, replaces?: string | null) => {
      setEstimate(res.estimate);
      setRows(res.estimate.items.map(toDraft));
      setSingleFood(res.estimate.items.length === 1);
      setQuota(res.quota);
      // A fresh draft starts uncompiled — carrying the PREVIOUS draft's choice
      // forward would silently combine a description the athlete never asked
      // to combine, the moment "estimate it again" or a new description lands.
      setCompileMeal(false);
      setMealName(res.estimate.meal_name || '');
      compiledFoodId.current = null;
      // A regenerate carries the id it is replacing; anything else clears it,
      // so an unrelated description later cannot overwrite somebody's food.
      // Only meaningful for a ONE-item answer: a regenerate that comes back as
      // three components is not a replacement for one row.
      setReplacing(replaces && res.estimate.items.length === 1 ? replaces : null);
    },
    [],
  );

  /**
   * Busy OR saving. Both mean "an operation owns this screen", and the two
   * were tracked apart while only one of them gated the estimate buttons.
   *
   * The race that opens: tap Log, then Work it out while the loop is in
   * flight. `receive` replaces `rows` with a fresh draft while `logAll`
   * iterates its tap-time copy, `router.dismissTo(...)` then pops the screen
   * out from under the new estimate — a quota unit spent on nothing — and if the save
   * fails partway the error's "The items still listed were not logged" is
   * describing a draft those items were never part of. Same class as the
   * Remove-during-save race, one control further up. Raised in review.
   */
  const locked = busy || saving;

  /**
   * Whether the day's estimate quota is spent (F17, #403).
   *
   * Held apart from `locked`: `locked` also gates Log/Remove/field-editing,
   * none of which asks the server for a new estimate, so folding this in
   * would freeze an athlete's ALREADY-DRAFTED rows because a LATER request
   * would be refused — a quota unit is spent on asking, not on logging what
   * was already asked for. This only gates the three actions that spend one:
   * describing, photographing, and "estimate it again".
   */
  const quotaExhausted = isQuotaExhausted(quota);

  /**
   * Ask the server. `reuse: false` is the "estimate it again" path.
   *
   * The default is left UNSENT rather than passed as `true`, so the decision
   * lives on the server and this screen cannot drift from it.
   */
  const describe = useCallback(async (reuse = true) => {
    if (!description.trim() || locked || quotaExhausted) return;
    // Read BEFORE the await: `estimate` is replaced by `receive`, and this is
    // the food the request is being made against.
    const replaces = reuse ? null : (estimate?.match?.food_id ?? null);
    setBusy(true);
    setError(null);
    try {
      receive(
        await describeMeal(getToken, { description: description.trim(), meal, reuse }),
        replaces,
      );
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }, [description, locked, quotaExhausted, getToken, meal, receive, estimate]);

  const photograph = useCallback(
    async (fromCamera: boolean) => {
      if (locked || quotaExhausted) return;
      // Guarded, because the caller is `void photograph(...)`: a throw from
      // the permission prompt or the picker (already open, OS-level failure)
      // would otherwise be an unhandled rejection, and the observable is a
      // button that does nothing at all with no error shown.
      let picked: ImagePicker.ImagePickerResult;
      try {
        const perm = fromCamera
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          setError(
            fromCamera
              ? 'VOLA needs the camera to photograph a meal. You can turn it on in Settings.'
              : 'VOLA needs access to your photos to read one. You can turn it on in Settings.',
          );
          return;
        }
        picked = fromCamera
          ? await ImagePicker.launchCameraAsync({ quality: 1 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      } catch {
        // NOT messageFor: nothing here has been near the network. It classifies
        // an endpoint's failures, and the camera refusing to open is not one —
        // it would fall through to the "the server answered" branch and show
        // whatever the OS put in the exception.
        setError(
          fromCamera
            ? 'The camera would not open. Try again, or describe the meal instead.'
            : 'That photo could not be opened. Try another, or describe the meal instead.',
        );
        return;
      }
      if (picked.canceled || !picked.assets[0]) return;

      setBusy(true);
      setError(null);
      try {
        // Downscaled BEFORE it leaves the phone, which is a cost decision as
        // much as a bandwidth one: image tokens scale with resolution, and a
        // plate of food is legible at 1080px. A raw 4-5MB frame would also
        // exceed the endpoint's own 5MB cap. The resize/compress/mime-type
        // steps themselves live in `prepareImageForUpload` (N74, #392) —
        // this screen and `identify.tsx` both call it rather than each
        // keeping its own copy, which is what let `identify.tsx` ship
        // without them in the first place (N73, #361).
        //
        // **Caught separately from the request below**, and that separation is
        // the whole of N92's mobile half. A manipulator failure is
        // DETERMINISTIC — an unreadable file, no disk, a frame in a format the
        // encoder will not take — and without this the outer handler hands it
        // to `messageFor`, which classifies an ENDPOINT's failures. At the time
        // N92 was reported its no-message fallback read "Could not reach the
        // server. Try again when you have signal.", so a failure that never
        // touched the network was reported as a network one, on the screen an
        // athlete reaches by tapping "Photograph the label".
        //
        // **N55 (#448) rewrote that fallback and does not remove the need for
        // this**, which is the distinction to keep. N55 classifies *dead
        // requests* — it makes the transport say which kind of failure it was
        // rather than calling all of them a signal problem. A frame that could
        // not be re-encoded is not a dead request; it is not a request at all,
        // and it arrives here by falling past the network call entirely, so no
        // transport taxonomy can see it. Today it would land on N55's "the
        // server answered" branch and show whatever the encoder put in the
        // exception, or its generic fallback — better than the old copy, still
        // describing the wrong layer.
        //
        // `identify.tsx` already had this guard, added by #361 with a comment
        // saying in as many words that without it the false diagnosis is "the
        // same N73 was reported for, just moved one line up". That is exactly
        // what was still true here. Same bug, second path — which is the
        // pattern #392 (N74) exists for.
        let prepared: UploadableImage;
        try {
          prepared = await prepareImageForUpload(picked.assets[0]);
        } catch {
          // Branched on `fromCamera` for the same reason the picker's own catch
          // fifteen lines up is: "try taking another" cannot be followed by
          // somebody who chose an existing photo, and advice that cannot be
          // acted on is the smaller version of the defect this whole guard is
          // for. `identify.tsx` shares the camera wording and is camera-only,
          // so it has no second case to get wrong.
          setError(
            fromCamera
              ? 'That photo could not be read. Try taking another, or describe the meal instead.'
              : 'That photo could not be read. Try a different one, or describe the meal instead.',
          );
          return;
        }
        receive(
          await photographMeal(getToken, {
            uri: prepared.uri,
            mimeType: prepared.mimeType,
            description: description.trim() || undefined,
            meal,
          }),
        );
      } catch (err) {
        setError(messageFor(err));
      } finally {
        setBusy(false);
      }
    },
    [locked, quotaExhausted, description, getToken, meal, receive],
  );

  // Fires once, on arrival, and only for the "Photograph" choice — never for
  // a plain visit to this screen (`q`-seeded or otherwise), which must still
  // land on the typing view undisturbed. The `[params.photo]` dependency
  // already stops this from re-firing on an ordinary re-render (typing a
  // description, `busy` flipping) since that string value does not change.
  //
  // **The ref guards a narrower case the dependency array does not: React's
  // Strict Mode double-invokes an effect once in development**, mount →
  // cleanup → mount again, without actually remounting the component — so a
  // `useRef` set during the first invocation survives into the second and
  // stops the camera opening twice. `describePhoto.test.tsx`'s "fires once"
  // test does not exercise Strict Mode (this harness does not wrap renders in
  // it), so it cannot fail this specific guard — recorded here rather than
  // left to look like coverage it is not.
  const autoPhotoFired = useRef(false);
  useEffect(() => {
    if (params.photo !== '1' || autoPhotoFired.current) return;
    autoPhotoFired.current = true;
    void photograph(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.photo]);

  /**
   * Log every row, then leave.
   *
   * **Each row is dropped as it lands**, so a failure part-way through leaves
   * exactly the un-logged remainder on screen and a second tap logs only
   * those. Without that, a retry would re-log everything that already
   * succeeded — `logFood` mints a fresh id per call, so the outbox's
   * idempotency key does not protect a client-side replay. Raised in review.
   */
  const logAll = useCallback(async () => {
    // **`locked`, not `saving`** — the mirror of the race the `locked`
    // docstring above describes, which that guard did NOT close. Tap "Estimate
    // it again" and then Log while the request is in flight: this loop logs the
    // STALE reused draft from its own closure, `router.dismissTo(...)` pops the
    // screen, and the fresh estimate lands on nothing — one allowance slice spent for a
    // draft nobody ever sees. Raised in review.
    //
    // **The DEFENCE that is pinned is the button's own `disabled={locked}`**,
    // not this line: mutate the prop and `describeReuse.test.tsx`'s "cannot log
    // a stale draft" goes red; mutate this line alone and it stays green,
    // because a disabled Pressable never fires. Recorded rather than deleted,
    // because "the tests still pass without it" is a persuasive argument for
    // removing something load-bearing — this is the backstop for any future
    // caller that is not that button, and the two must not drift apart.
    if (!userId || rows.length === 0 || locked) return;
    setSaving(true);
    setError(null);
    try {
      // A copy, because `rows` is trimmed inside the loop.
      const snapshot = [...rows];
      const logged: DraftRow[] = [];
      for (const row of snapshot) {
        const item = fromDraft(row);
        /**
         * SAVE THE FOOD FIRST, THEN LOG AGAINST IT (N114).
         *
         * This write is the whole ticket. Before it, confirming a draft logged
         * an entry and stored nothing, so describing the same food tomorrow
         * re-generated it — a fresh estimate off the day's allowance, and
         * numbers that need not agree with yesterday's. *"I entered Pork
         * Shashlik 3 times and every time it would generate a new item."*
         *
         * **A REUSED draft writes nothing new**: it already came from a saved
         * row, and minting a second one under the same name would leave the
         * athlete with a duplicate per log and make the next lookup a choice
         * between rows. The stored id is reused as the provenance instead.
         *
         * **Ordered before the log**, because `source_food_id` is a foreign key
         * server-side: an entry pushed before its food exists is rejected. The
         * local write is synchronous and offline, so this costs nothing.
         *
         * Local only — `requestSync` below flushes both queues, and the food's
         * push is ordered ahead of the entry's inside it.
         */
        // A reused draft already came from a saved row, so it reuses that id
        // rather than minting a duplicate under the same name.
        //
        // **Matched on the NAME rather than trusting a single-item invariant.**
        // The server only ever sets `match` on a one-item draft today, and this
        // file treats the server's vocabulary as extensible everywhere else —
        // so if a future `match` arrives beside several items, keying on
        // presence alone would point every entry at one food and silently save
        // none of the others. Raised in review.
        const reusedId =
          estimate?.match && NORMALIZE(estimate.match.name) === NORMALIZE(item.name)
            ? estimate.match.food_id
            : null;
        const savedId =
          reusedId ??
          (await saveFoodLocally(userId, {
            ...savedFoodFrom(item),
            // Present only on a regenerate, where it makes the save an
            // OVERWRITE of the food this draft was asked to replace.
            ...(replacing ? { id: replacing } : {}),
          }));
        await logFood(userId, {
          eaten_on: date,
          meal,
          ...itemToEntry(item),
          // The saved food this came from. Provenance ONLY — nothing ever reads
          // an entry's nutrition back through it, which is what keeps
          // correcting a food from silently rewriting what you ate last month.
          // It is also what puts a drafted food into the quick-add recents,
          // which group entries by the food they name.
          source_food_id: savedId,
        });
        logged.push(row);
        setRows((rs) => rs.filter((r) => r.key !== row.key));
      }
      requestSync('meal estimated');
      // Teach this phone the packet, so the next scan of it resolves — the
      // promise the scan screen's "this barcode will find it next time" makes.
      //
      // **Only when the draft was a single row**, and the guard is not
      // fussiness: a barcode identifies ONE product, and caching a three-item
      // draft against it would resolve that packet to whichever item happened
      // to be first, forever, with no way for the athlete to tell. A photo of
      // a label ordinarily yields one item; when it does not, the meal is
      // still logged and the barcode simply stays unknown, which is the honest
      // outcome.
      //
      // Cached as `ai`, never `catalog` or `off`: these numbers were drafted
      // from a description, and N40 measured what an unlabelled estimate is
      // worth. Awaited rather than fired off, so the write cannot lose a race
      // with the screen unmounting — it is the last thing before `back()`.
      if (params.barcode && singleFood && logged.length === 1) {
        const it = fromDraft(logged[0]);
        await rememberBarcode(
          userId,
          params.barcode,
          {
            name: it.name,
            brand: '',
            serving_label: it.serving_label,
            serving_grams: null,
            // No packet serving — this food was described, not scanned from a
            // packet Open Food Facts has data on. Never invented (N117).
            packet_serving_label: null,
            packet_serving_grams: null,
            // Per SERVING, because that is what the cache stores and what the
            // scan screen scales. The draft's figures are the total for the
            // item, so they are divided back out by its own servings count.
            ...perServing(it),
          },
          'ai',
        ).catch(() => {
          // A cache write that fails costs one re-describe later. The meal is
          // already logged, and interrupting that with an error about a cache
          // would be reporting a failure the athlete cannot act on.
        });
      }
      // N500/#871 — land on the food log for `date`, not back to the search
      // screen this was pushed from. `dismissTo` pops the search/describe
      // screens along the way.
      router.dismissTo(momentumOpenFoodHref(date));
    } catch (err) {
      // Silent failure here would leave the athlete unable to tell what was
      // logged and what was not.
      setError(`${messageFor(err)} The items still listed were not logged.`);
    } finally {
      setSaving(false);
    }
  }, [userId, rows, locked, date, meal, router, params.barcode, singleFood, estimate, replacing]);

  /**
   * The live totals across whatever rows are CURRENTLY drafted (N472) — not
   * the original estimate, which would ignore edits and removals. Recomputed
   * off `rows` via `fromDraft`, which is the same parse the log path uses, so
   * the footer and what actually gets logged can never disagree about what a
   * partially-typed field means. `useMemo`d on `rows` so `logCompiled` below
   * has one stable value to close over rather than a fresh object every
   * render.
   */
  const totals = useMemo(() => sumMacros(rows.map(fromDraft)), [rows]);

  /**
   * Whether "compile into one meal" is BOTH chosen and actually offered.
   *
   * The single source of truth for every place that needs the answer,
   * rather than `compileMeal` alone — a row removed down to a lone survivor
   * hides the toggle's UI (`rows.length > 1` below) but does not itself
   * reset the flag, and reading `compileMeal` directly at the Log button
   * would then silently try to "compile" a list of one, or leave a stale
   * true sitting behind UI that no longer offers a way to turn it off.
   */
  const compiling = compileMeal && rows.length > 1;

  /**
   * Log every drafted row as ONE combined entry (N472) — summed macros,
   * logged as `1 meal` rather than carrying any one row's own serving count,
   * since a compiled meal is one whole thing eaten, not N components any
   * more.
   *
   * Deliberately NOT `logAll` with a different loop body. `logAll`'s
   * per-row save-then-log sequence exists so EACH ingredient gets its own
   * reusable saved food (N114) — describe "two eggs" again next week and it
   * is a match, not a fresh guess. Compiling asks a different question: is
   * THIS WHOLE PLATE, as named right now, worth remembering as one thing?
   * It saves and logs once, under the combined name, and — because that
   * save also goes through the ordinary `foods` table — a later description
   * that normalises to the same compiled name gets N114's reuse too, the
   * same as any other saved food. What it does NOT do is let compiling
   * retroactively change what each ORIGINAL ingredient reuses to; "brown
   * rice" on its own still matches whatever "brown rice" was saved as
   * before, never today's compiled total.
   */
  const logCompiled = useCallback(async () => {
    if (!userId || rows.length <= 1 || locked) return;
    const name = mealName.trim() || defaultMealName(rows);
    setSaving(true);
    setError(null);
    try {
      const combined: EstimatedItem = {
        name,
        serving_label: '1 meal',
        servings: 1,
        portion_confidence: 'high',
        // Not a judgement about any one component — the athlete already saw
        // and could correct each row's own assumption before compiling.
        assumption: '',
        ...totals,
      };
      // Reuse the SAME id across a retry, minted once — see compiledFoodId's
      // own doc comment for why: without this, a save that succeeds followed
      // by a log that fails would mint a SECOND food under the same name on
      // the next tap, since saveFoodLocally's upsert keys on id, not name.
      compiledFoodId.current ??= randomUUID();
      const savedId = await saveFoodLocally(userId, {
        ...savedFoodFrom(combined),
        id: compiledFoodId.current,
      });
      await logFood(userId, {
        eaten_on: date,
        meal,
        ...itemToEntry(combined),
        source_food_id: savedId,
      });
      setRows([]);
      requestSync('meal estimated');
      // N500/#871 — see the doc comment on `logAll` above; same fix, same
      // reason, for the compiled-into-one-meal path.
      router.dismissTo(momentumOpenFoodHref(date));
    } catch (err) {
      // The rows are still on screen either way (nothing was dropped, unlike
      // `logAll`'s land-as-you-go loop) — a retry re-sends the same combined
      // total rather than a partial one.
      setError(`${messageFor(err)} Nothing was logged.`);
    } finally {
      setSaving(false);
    }
  }, [userId, rows, locked, mealName, totals, date, meal, router]);

  const updateRow = (key: string, patch: Partial<DraftRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /**
   * The first row the model was unsure about, which is where the cursor goes.
   *
   * Only the FIRST: two autofocused inputs race, and the winner is whichever
   * mounts last rather than whichever matters most.
   */
  const firstUncertain = rows.findIndex((r) => r.portion_confidence === 'low');

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Describe a meal' }} />

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
              testID={`describe-slot-${m}`}
            >
              <Text style={[styles.slotText, on && { color: accent.on }]}>{mealLabel(m)}</Text>
            </Pressable>
          );
        })}
      </View>

      <TextInput
        style={styles.input}
        value={description}
        onChangeText={setDescription}
        placeholder="Two eggs, sourdough and butter"
        placeholderTextColor={vola.textDim}
        multiline
        maxLength={600}
        accessibilityLabel="Describe what you ate"
        testID="describe-input"
      />

      <Pressable
        onPress={() => void describe()}
        style={[
          styles.primary,
          { backgroundColor: accent.accent },
          (busy || quotaExhausted) && styles.off,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Work it out"
        // Dimming is a sighted-only signal. Without the state, a screen reader
        // announces an ordinary button that then does nothing.
        disabled={locked || !description.trim() || quotaExhausted}
        accessibilityState={{ disabled: busy || !description.trim() || quotaExhausted }}
        testID="describe-submit"
      >
        <Text style={[styles.primaryText, { color: accent.on }]}>
          {busy ? 'Working it out…' : 'Work it out'}
        </Text>
      </Pressable>

      {/* F17 (#403): said BEFORE a doomed request, not after. `quota` is
          fetched from the LAST response, so this is silent on a screen the
          athlete has not used yet today — it can only appear once a request
          this session has already reported the count. */}
      {quotaExhausted && quota ? (
        <Text style={styles.error} testID="describe-quota-exhausted">
          {quotaResetMessage(quota)}
        </Text>
      ) : null}

      <SectionHeader label="Or photograph it" />
      {/* Stated BEFORE the camera opens. A privacy consequence discovered
          afterwards is not a choice the athlete made.

          NAMES THE REAL RECIPIENT, so it has to track the backend's
          `nutrition.DefaultProvider`. A disclosure that names the wrong company
          is worse than a vague one: it is a specific false statement about
          where a photograph of somebody's kitchen went. If the provider
          changes, this string changes in the same PR. */}
      <Text style={styles.disclosure}>
        The photo is sent to OpenAI to be read. VOLA never stores it — not the
        picture, not a copy. Describing the meal in words works nearly as well
        and sends no picture at all.
      </Text>
      <View style={styles.photoRow}>
        <Pressable
          onPress={() => void photograph(true)}
          style={[styles.secondary, (busy || quotaExhausted) && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Take a photo of this meal"
          disabled={locked || quotaExhausted}
          accessibilityState={{ disabled: busy || quotaExhausted }}
          testID="describe-camera"
        >
          <Text style={styles.secondaryText}>Take a photo</Text>
        </Pressable>
        <Pressable
          onPress={() => void photograph(false)}
          style={[styles.secondary, (busy || quotaExhausted) && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Choose a photo from your library"
          disabled={locked || quotaExhausted}
          accessibilityState={{ disabled: busy || quotaExhausted }}
          testID="describe-library"
        >
          <Text style={styles.secondaryText}>Choose one</Text>
        </Pressable>
      </View>

      {busy ? <ActivityIndicator accessibilityLabel="Working it out" /> : null}
      {error ? (
        <Text style={styles.error} testID="describe-error">
          {error}
        </Text>
      ) : null}

      {/* An estimate that came back EMPTY still cost a quota unit, so it has to
          say something. Rendering nothing would look like a screen that
          ignored the tap. The note is where the model says what it could not
          see, which is the useful half. */}
      {estimate && rows.length === 0 ? (
        <Text style={styles.note} testID="describe-empty">
          {estimate.note || 'Nothing recognisable came back. Try describing it instead.'}
        </Text>
      ) : null}

      {estimate && rows.length > 0 ? (
        <>
          {/* THE TWO DRAFTS DO NOT LOOK ALIKE (N114).
              A reused food and an invented one are different claims, and the
              ticket's own words are that "the screen should not present them
              identically". The heading is the first thing read, so it is the
              heading that changes — a badge tucked beside a row would be the
              same screen with a decoration on it.

              "Check these" is the right instruction for a guess and the wrong
              one for numbers the athlete themselves saved and corrected. */}
          <SectionHeader
            label={estimate.match ? 'From your saved foods' : 'Check these before logging'}
          />
          {estimate.match ? (
            <>
              <Text style={styles.saved} testID="describe-reused">
                Reused “{estimate.match.name}”
                {estimate.match.food_source === 'ai' ? ', drafted by AI' : ', saved by you'}
                {savedAgo(estimate.match.saved_at)}. No estimate used.
              </Text>
              {/* The escape hatch, and it is not optional. Without it a saved
                  food with wrong numbers is one the athlete can never ask to be
                  read again — the feature would have replaced one complaint
                  with a worse one. Says what it costs, because it does cost. */}
              <Pressable
                onPress={() => void describe(false)}
                accessibilityRole="button"
                accessibilityLabel="Estimate this again instead of reusing the saved food"
                // Spends a quota unit exactly like the primary submit button
                // does, so it is gated on the same exhausted check (F17,
                // #403) — this used to stay tappable after the quota ran
                // out and fire a request that could only come back refused.
                disabled={locked || quotaExhausted}
                accessibilityState={{ disabled: locked || quotaExhausted }}
                testID="describe-regenerate"
              >
                <Text style={[styles.regenerate, (locked || quotaExhausted) && styles.off]}>
                  Not right? Estimate it again — uses one estimate
                </Text>
              </Pressable>
              {/* Correcting the STORED food, which is what makes the reuse
                  right next time rather than wrong every time. The copy says
                  what an edit does and does not touch, because "does this
                  rewrite what I already ate?" is the first question it raises
                  and the answer is no. */}
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/food/saved/[id]',
                    params: { id: estimate.match!.food_id },
                  })
                }
                accessibilityRole="button"
                accessibilityLabel={`Edit the saved food ${estimate.match.name}`}
                disabled={locked}
                accessibilityState={{ disabled: locked }}
                testID="describe-edit-saved"
              >
                <Text style={[styles.regenerate, locked && styles.off]}>
                  Fix these numbers for next time
                </Text>
              </Pressable>
            </>
          ) : null}
          {estimate.note ? <Text style={styles.note}>{estimate.note}</Text> : null}
          {/* Says the teaching out loud. The barcode came from a scan that
              found nothing, and nothing else on this screen would tell the
              athlete that confirming here is what makes the next scan of that
              packet work — or that describing something else entirely would
              attach the wrong food to it. Raised in review. */}
          {params.barcode && singleFood ? (
            <Text style={styles.note} testID="describe-barcode-note">
              Confirming this will remember it for barcode {params.barcode}, so scanning that packet
              finds it next time.
            </Text>
          ) : null}

          {rows.map((row, i) => (
            <View key={row.key} style={styles.row}>
              <Text style={styles.rowName}>{row.name}</Text>
              <Text style={styles.rowServing}>{row.serving_label}</Text>

              {/* The assumption sits WITH the number it explains, because it
                  is the thing that tells the athlete which field to fix. */}
              {row.assumption ? (
                <Text style={styles.assumption} testID={`describe-assumption-${i}`}>
                  {row.assumption}
                </Text>
              ) : null}
              {row.portion_confidence === 'low' ? (
                <Text style={styles.uncertain} testID={`describe-uncertain-${i}`}>
                  Unsure how much this was — worth checking
                </Text>
              ) : null}

              <View style={styles.fields}>
                <Field
                  label="Servings"
                  value={row.servingsText}
                  onChange={(v) => updateRow(row.key, { servingsText: v })}
                  testID={`describe-servings-${i}`}
                  autoFocus={i === firstUncertain}
                  editable={!saving}
                />
                <Field
                  label="Calories"
                  value={row.kcalText}
                  onChange={(v) => updateRow(row.key, { kcalText: v })}
                  testID={`describe-kcal-${i}`}
                  editable={!saving}
                />
                <Field
                  label="Protein (g)"
                  value={row.proteinText}
                  onChange={(v) => updateRow(row.key, { proteinText: v })}
                  testID={`describe-protein-${i}`}
                  editable={!saving}
                />
              </View>

              {/* Disabled while saving, because the loop drops rows as they
                  land: removing one from under it would let a row the athlete
                  deleted reach the log anyway, since the loop iterates a copy
                  taken at tap time. */}
              <Pressable
                onPress={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${row.name}`}
                testID={`describe-remove-${i}`}
                disabled={saving}
                accessibilityState={{ disabled: saving }}
              >
                <Text style={[styles.remove, saving && styles.off]}>Remove</Text>
              </Pressable>
            </View>
          ))}

          {/* The totals footer (N472): live across CURRENT rows, not the
              original estimate — an edited or removed row is reflected
              immediately, the same numbers `logAll`/`logCompiled` would
              actually log. Shown whenever there is more than one row; a
              single row already states its own totals in the fields above
              it, and repeating them here would be the same number twice. */}
          {rows.length > 1 ? (
            <View
              style={styles.totals}
              testID="describe-totals"
              // A single label rather than reading "Total" then a string of
              // "middle dot" separators — VoiceOver otherwise reads the
              // visual punctuation, not the figures it separates.
              accessible
              accessibilityLabel={`Total: ${fmtAmount(Math.round(totals.kcal))} calories, ${fmtAmount(Math.round(totals.protein_g))} grams protein, ${fmtAmount(Math.round(totals.carb_g))} grams carb, ${fmtAmount(Math.round(totals.fat_g))} grams fat`}
            >
              <Text style={styles.totalsLabel}>Total</Text>
              <Text style={styles.totalsText}>
                {fmtAmount(Math.round(totals.kcal))} kcal · {fmtAmount(Math.round(totals.protein_g))}g
                protein · {fmtAmount(Math.round(totals.carb_g))}g carb · {fmtAmount(Math.round(totals.fat_g))}g
                fat
              </Text>
            </View>
          ) : null}

          {/* "Combine into one meal" (N472). Hidden for a single row — there
              is nothing to combine — and unrelated to the reused-food branch
              above, which is always exactly one row by construction.
              `locked`, not `saving` alone — matches every quota-spending and
              save-owning control elsewhere on this screen, and the same
              in-flight regenerate that would silently discard this tick via
              `receive` should not be tickable in the first place. */}
          {rows.length > 1 ? (
            <>
              <Pressable
                onPress={() => setCompileMeal((c) => !c)}
                style={styles.compileRow}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: compileMeal, disabled: locked }}
                accessibilityLabel="Combine into one meal"
                disabled={locked}
                testID="describe-compile-toggle"
              >
                <View style={[styles.checkbox, compileMeal && { backgroundColor: accent.accent, borderColor: accent.accent }]}>
                  {compileMeal ? <Text style={[styles.checkboxMark, { color: accent.on }]}>✓</Text> : null}
                </View>
                <Text style={styles.compileLabel}>
                  Combine into one meal — log all {rows.length} as a single entry
                </Text>
              </Pressable>

              {/* The name is a SUGGESTION, editable exactly like every other
                  AI-authored value on this screen (see the file's own doc
                  comment) — never presented as a final answer the athlete
                  did not choose. */}
              {compiling ? <MealNameField value={mealName} onChange={setMealName} placeholder={defaultMealName(rows)} editable={!saving} /> : null}
            </>
          ) : null}

          <Pressable
            onPress={() => void (compiling ? logCompiled() : logAll())}
            style={[styles.primary, { backgroundColor: accent.accent }, locked && styles.off]}
            accessibilityRole="button"
            accessibilityLabel={compiling ? `Log ${mealName.trim() || defaultMealName(rows)}` : `Log ${rows.length} items`}
            // `locked`, matching `logAll`'s own guard — and on BOTH props, so
            // VoiceOver never announces an enabled button that ignores taps.
            disabled={locked}
            accessibilityState={{ disabled: locked }}
            testID="describe-log"
          >
            <Text style={[styles.primaryText, { color: accent.on }]}>
              {saving
                ? 'Logging…'
                : compiling
                  ? `Log “${mealName.trim() || defaultMealName(rows)}”`
                  : `Log ${rows.length === 1 ? 'it' : `all ${rows.length}`}`}
            </Text>
          </Pressable>
        </>
      ) : null}

      {quota ? (
        <Text style={styles.quota} testID="describe-quota">
          {quota.remaining} of {quota.limit} estimates left
        </Text>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  testID,
  autoFocus = false,
  editable = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testID: string;
  /**
   * Sends the cursor here as the draft mounts. This is what
   * `portion_confidence` reaching the client is FOR — the field carried a
   * `low` all the way to the screen and then only tinted some text, which is
   * one step above not sending it. `KeyboardAwareScrollView` scrolls the
   * focused input clear of the keyboard, so the row stays visible.
   */
  autoFocus?: boolean;
  editable?: boolean;
}) {
  const ensureVisible = useEnsureVisible();
  const inputRef = useRef<TextInput>(null);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, !editable && styles.fieldInputOff]}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        inputMode="decimal"
        accessibilityLabel={label}
        testID={testID}
        autoFocus={autoFocus}
        editable={editable}
        // The model's number is SELECTED, not just focused, so the first
        // keystroke replaces it. Without this the cursor lands after "2" and
        // correcting it to 0.5 means deleting first — friction on the one
        // field the screen just told the athlete to check.
        selectTextOnFocus
        ref={inputRef}
        // Lifts the field above the keyboard when the keyboard is ALREADY up
        // at the same height — moving between the decimal fields by tap. The
        // native inset adjustment covers the keyboard appearing; this is the
        // case it does not, and the case `useEnsureVisible` exists for.
        onFocus={() => ensureVisible(inputRef.current)}
      />
    </View>
  );
}

/**
 * The compiled meal's editable name field (N472).
 *
 * Not `Field` above — that component is decimal-only (`keyboardType`,
 * `inputMode`, `selectTextOnFocus` are all tuned for a number an athlete is
 * correcting) and this is free text. Deliberately still shares `Field`'s
 * `useEnsureVisible` treatment, though: this field sits at the very bottom of
 * the scroll, directly above Log, which is exactly where the keyboard is
 * most likely to already be covering it when the athlete taps in.
 */
function MealNameField({
  value,
  onChange,
  placeholder,
  editable,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  editable: boolean;
}) {
  const ensureVisible = useEnsureVisible();
  const inputRef = useRef<TextInput>(null);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Meal name</Text>
      <TextInput
        style={[styles.fieldInput, !editable && styles.fieldInputOff]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={vola.textDim}
        accessibilityLabel="Meal name"
        editable={editable}
        ref={inputRef}
        onFocus={() => ensureVisible(inputRef.current)}
        testID="describe-meal-name"
      />
    </View>
  );
}

/**
 * A drafted row, whose editable numbers are held as TEXT.
 *
 * **This is the trap the check-in form and the session logger both record, and
 * this screen fell into it anyway.** Round-tripping through `Number` on every
 * keystroke deletes the decimal point out from under the cursor: `"1."` parses
 * to `1`, redisplays as `"1"`, and the next keystroke makes `15` — so an
 * athlete correcting a portion to 1.5 servings silently logs ten times what
 * they meant. Worst in exactly the field a low-confidence warning tells them
 * to fix. Clearing a field the same way collapsed it to `0`, since `Number('')`
 * is `0` and passes a `>= 0` guard. Found by review.
 */
type DraftRow = EstimatedItem & {
  /**
   * A stable identity, minted once when the draft arrives.
   *
   * Rows used to be tracked by OBJECT IDENTITY and rendered under an
   * index-derived key, and both are wrong for a list that is edited and
   * trimmed while it is being written. Editing a field replaces the object, so
   * the save loop's `r !== row` filter stopped matching and left the row on
   * screen — a retry then logged it a second time, which is the exact
   * duplicate the drop-as-it-lands design exists to prevent. And an
   * index-derived key re-keys every row after a removal, remounting their
   * inputs and dismissing the keyboard mid-edit. One id fixes both.
   */
  key: string;
  servingsText: string;
  kcalText: string;
  proteinText: string;
};

/**
 * Case- and whitespace-insensitive name identity, for comparing a `match.name`
 * with a draft item's name.
 *
 * **Not a reimplementation of the server's matching rule**, and it must not
 * grow into one — the whole point of doing the lookup server-side is that there
 * is one rule in one place. Both strings here came from the SAME response, so
 * this is an identity check between two server-produced values, not a decision
 * about whether an athlete's typing matches a stored food.
 */
function NORMALIZE(s: string): string {
  return s.trim().toLowerCase().split(/\s+/).join(' ');
}

let draftKeySeq = 0;

function toDraft(it: EstimatedItem): DraftRow {
  draftKeySeq += 1;
  return {
    ...it,
    key: `draft-${draftKeySeq}`,
    servingsText: String(it.servings),
    kcalText: String(Math.round(it.kcal)),
    proteinText: String(Math.round(it.protein_g)),
  };
}

/**
 * Parse the text back, ONCE, at log time.
 *
 * An unparseable or empty field keeps the model's own number rather than
 * becoming zero — a blank calorie box means "I did not change this", not "this
 * meal had no calories".
 */
function fromDraft(row: DraftRow): EstimatedItem {
  return {
    ...row,
    servings: parseOr(row.servingsText, row.servings),
    kcal: parseOr(row.kcalText, row.kcal),
    protein_g: parseOr(row.proteinText, row.protein_g),
  };
}

/**
 * A fallback name for a compiled meal (N472), for the rare case
 * `estimate.meal_name` came back empty — the prompt asks for this only when
 * there is "nothing coherent to name", so it is not the common path, but an
 * empty Log button is not an acceptable answer to it either.
 *
 * Joins the first two row names rather than inventing a dish name this file
 * has no business guessing at — "Pollo Asado, Brown rice + 6 more" is an
 * honest description of what is about to be logged, which is the same bar
 * `assumption` text on each row is already held to.
 */
function defaultMealName(rows: DraftRow[]): string {
  const names = rows.map((r) => r.name.trim()).filter(Boolean);
  if (names.length === 0) return 'Meal';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
}

/**
 * A drafted item's figures restated PER SERVING.
 *
 * The draft carries the total for the item alongside how many servings that
 * was, which is the right shape for a log entry and the wrong one for a cache
 * — the scan screen multiplies a per-serving figure by whatever the athlete
 * ate next time. Dividing here rather than there keeps that conversion in the
 * one place that knows the draft's units.
 *
 * A zero or negative `servings` cannot be divided by, so it falls back to the
 * figures as given rather than producing an Infinity that would reach the
 * cache and then a log entry.
 */
function perServing(it: EstimatedItem): Macros {
  const n = it.servings > 0 ? it.servings : 1;
  return {
    kcal: it.kcal / n,
    protein_g: it.protein_g / n,
    carb_g: it.carb_g / n,
    fat_g: it.fat_g / n,
    fibre_g: it.fibre_g == null ? null : it.fibre_g / n,
    saturated_fat_g: it.saturated_fat_g == null ? null : it.saturated_fat_g / n,
    sugar_g: it.sugar_g == null ? null : it.sugar_g / n,
    added_sugar_g: it.added_sugar_g == null ? null : it.added_sugar_g / n,
    sodium_mg: it.sodium_mg == null ? null : it.sodium_mg / n,
    cholesterol_mg: it.cholesterol_mg == null ? null : it.cholesterol_mg / n,
  };
}

/**
 * How long ago a saved food was last changed, as a phrase to append.
 *
 * Coarse on purpose. The athlete is deciding whether numbers are stale enough
 * to re-check, and that is a "recently / a while back" judgement — minutes on a
 * figure that changes when they edit it would be false precision.
 *
 * Returns the EMPTY STRING for anything it cannot read, rather than "unknown"
 * or a fallback date. A missing or unparseable timestamp is a fact about the
 * response, not about the food, and the surrounding sentence reads correctly
 * without the clause. Guarded because `saved_at` crosses the wire: a stale
 * server, a proxy, or a future field change can all put something here that
 * `Date.parse` returns NaN for, and `new Date(NaN).toISOString()` throws.
 */
export function savedAgo(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  // A negative reading means the device clock is behind the server's, which is
  // ordinary and is not something to report as the future.
  if (days <= 0) return ', saved today';
  if (days === 1) return ', saved yesterday';
  if (days < 30) return `, saved ${days} days ago`;
  if (days < 365) return `, saved ${Math.floor(days / 30)} months ago`;
  return ', saved over a year ago';
}

/**
 * The copy for a failed estimate.
 *
 * **This used to live here**, as `messageFor`: the server's message when there
 * was one, and *"Could not reach the server. Try again when you have signal."*
 * when there was not. It moved to `estimateApi.ts` with N55, for two reasons —
 * a dead request now carries its own diagnosis from the transport instead of
 * every one of them being called a signal problem, and the 503 that means
 * "this deploy has no provider key" needed to stop reading as an outage. Both
 * are properties of the endpoint, not of this screen, so they are testable
 * without rendering it.
 */
const messageFor = estimateErrorMessage;

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
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: vola.text,
    fontSize: 15,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  disclosure: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  photoRow: { flexDirection: 'row', gap: 10 },
  error: { fontSize: 13, color: vola.danger, lineHeight: 18 },
  note: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  // Deliberately NOT `note`'s muted grey. A reuse is the good outcome and the
  // athlete should read it, whereas `note` is the model apologising for what it
  // could not see.
  saved: { fontSize: 13, color: vola.text, lineHeight: 18 },
  regenerate: { fontSize: 12, color: vola.textMuted, lineHeight: 17, paddingVertical: 6 },
  row: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 12,
    padding: 12,
    gap: 4,
    backgroundColor: vola.surface,
  },
  rowName: { fontSize: 15, fontWeight: '700' },
  rowServing: { fontSize: 12, color: vola.textDim },
  assumption: { fontSize: 12, color: vola.textMuted, fontStyle: 'italic' },
  // `warn`, not `textMuted` and not `danger`: it sat in the same grey as the
  // assumption text directly above it, which made the one line asking for
  // attention indistinguishable from the line that does not. Not `danger`
  // either — an uncertain portion is not a failure, it is a request to look.
  uncertain: { fontSize: 12, color: vola.warn, fontWeight: '600' },
  fields: { flexDirection: 'row', gap: 10, marginTop: 6 },
  field: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 11, color: vola.textDim, fontWeight: '600' },
  fieldInputOff: { opacity: 0.5 },
  fieldInput: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: vola.text,
    fontSize: 14,
  },
  remove: { fontSize: 12, color: vola.textDim, marginTop: 6 },
  // textMuted, not textDim: at 11pt this is small text, and textDim measures
  // 3.96:1 on `bg` — below AA's 4.5:1. `bjj/dictate.tsx`'s quota line already
  // uses the muted token for the same reason. Raised in review.
  quota: { fontSize: 11, color: vola.textMuted },
  totals: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 12,
    padding: 12,
    backgroundColor: vola.surface,
    gap: 2,
  },
  totalsLabel: { fontSize: 11, color: vola.textDim, fontWeight: '600' },
  totalsText: { fontSize: 14, fontWeight: '700', color: vola.text },
  compileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxMark: { fontSize: 13, fontWeight: '700' },
  compileLabel: { fontSize: 13, color: vola.text, flex: 1, lineHeight: 18 },
  primary: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  secondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 13, color: vola.textMuted, fontWeight: '600' },
  off: { opacity: 0.5 },
});
