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
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
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
  itemToEntry,
  photographMeal,
  savedFoodFrom,
  type EstimateQuota,
  type EstimatedItem,
  type MealEstimate,
} from '@/lib/estimateApi';
import { logFood, saveFoodLocally } from '@/lib/foodLog';
import { MEALS, slotForClock, todayString, type Macros, type Meal } from '@/lib/nutrition';
import { request as requestSync } from '@/lib/sync';
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

  const receive = useCallback((res: { estimate: MealEstimate; quota: EstimateQuota }) => {
    setEstimate(res.estimate);
    setRows(res.estimate.items.map(toDraft));
    setSingleFood(res.estimate.items.length === 1);
    setQuota(res.quota);
  }, []);

  /**
   * Busy OR saving. Both mean "an operation owns this screen", and the two
   * were tracked apart while only one of them gated the estimate buttons.
   *
   * The race that opens: tap Log, then Work it out while the loop is in
   * flight. `receive` replaces `rows` with a fresh draft while `logAll`
   * iterates its tap-time copy, `router.back()` then pops the screen out from
   * under the new estimate — a quota unit spent on nothing — and if the save
   * fails partway the error's "The items still listed were not logged" is
   * describing a draft those items were never part of. Same class as the
   * Remove-during-save race, one control further up. Raised in review.
   */
  const locked = busy || saving;

  /**
   * Ask the server. `reuse: false` is the "estimate it again" path.
   *
   * The default is left UNSENT rather than passed as `true`, so the decision
   * lives on the server and this screen cannot drift from it.
   */
  const describe = useCallback(async (reuse = true) => {
    if (!description.trim() || locked) return;
    setBusy(true);
    setError(null);
    try {
      receive(await describeMeal(getToken, { description: description.trim(), meal, reuse }));
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }, [description, locked, getToken, meal, receive]);

  const photograph = useCallback(
    async (fromCamera: boolean) => {
      if (locked) return;
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
        // exceed the endpoint's own 5MB cap.
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
        let shrunk: ImageManipulator.ImageResult;
        try {
          shrunk = await ImageManipulator.manipulateAsync(
            picked.assets[0].uri,
            [{ resize: { width: 1080 } }],
            { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
          );
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
            uri: shrunk.uri,
            mimeType: 'image/jpeg',
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
    [locked, description, getToken, meal, receive],
  );

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
    if (!userId || rows.length === 0 || saving) return;
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
        const savedId =
          estimate?.match?.food_id ?? (await saveFoodLocally(userId, savedFoodFrom(item)));
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
      router.back();
    } catch (err) {
      // Silent failure here would leave the athlete unable to tell what was
      // logged and what was not.
      setError(`${messageFor(err)} The items still listed were not logged.`);
    } finally {
      setSaving(false);
    }
  }, [userId, rows, saving, date, meal, router, params.barcode, singleFood, estimate]);

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
        style={[styles.primary, { backgroundColor: accent.accent }, busy && styles.off]}
        accessibilityRole="button"
        accessibilityLabel="Work it out"
        // Dimming is a sighted-only signal. Without the state, a screen reader
        // announces an ordinary button that then does nothing.
        disabled={locked || !description.trim()}
        accessibilityState={{ disabled: busy || !description.trim() }}
        testID="describe-submit"
      >
        <Text style={[styles.primaryText, { color: accent.on }]}>
          {busy ? 'Working it out…' : 'Work it out'}
        </Text>
      </Pressable>

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
          style={[styles.secondary, busy && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Take a photo of this meal"
          disabled={locked}
          accessibilityState={{ disabled: busy }}
          testID="describe-camera"
        >
          <Text style={styles.secondaryText}>Take a photo</Text>
        </Pressable>
        <Pressable
          onPress={() => void photograph(false)}
          style={[styles.secondary, busy && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Choose a photo from your library"
          disabled={locked}
          accessibilityState={{ disabled: busy }}
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
                disabled={locked}
                accessibilityState={{ disabled: locked }}
                testID="describe-regenerate"
              >
                <Text style={[styles.regenerate, locked && styles.off]}>
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

          <Pressable
            onPress={() => void logAll()}
            style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
            accessibilityRole="button"
            accessibilityLabel={`Log ${rows.length} items`}
            disabled={saving}
            accessibilityState={{ disabled: saving }}
            testID="describe-log"
          >
            <Text style={[styles.primaryText, { color: accent.on }]}>
              {saving ? 'Logging…' : `Log ${rows.length === 1 ? 'it' : `all ${rows.length}`}`}
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
