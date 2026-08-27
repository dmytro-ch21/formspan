/**
 * Scan a barcode, get the exact food.
 *
 * ## Why this exists next to the describe screen rather than inside it
 *
 * N26 shipped "describe a meal and let a model work it out", and N40 put the
 * first real photograph through it. Four items were named correctly, one was
 * INVENTED, and one quantity was DOUBLED — two fried eggs where there was one,
 * about 29% over on the day. The asymmetry is the part that matters: the
 * invention came back flagged three separate ways (`portion_confidence: low`,
 * a hedged assumption, a note calling it unclear), and the miscount came back
 * `medium` and stated flatly. The estimator can tell you it might have made a
 * food up. It cannot tell you it counted wrong.
 *
 * A barcode is the one input where quantity and macros are FACTS rather than
 * estimates — they are printed on the packet — so it covers precisely the
 * failure the AI path has no way to signal, on precisely the foods (packaged)
 * where estimation is worst.
 *
 * ## A scan proposes an entry. It never logs one.
 *
 * That is N26's rule and it is inherited whole. The difference is what the
 * athlete is being asked to check: on the describe screen it is "is this
 * number right?", here it is "is this the right packet, and how much of it did
 * you have?". So this screen shows **no confidence badge and no assumption
 * line**, and that is a deliberate omission rather than an unfinished one.
 * Those two fields exist on an estimate because a model guessed. Painting them
 * onto a figure read off a label would be manufacturing doubt about the one
 * source in this app that does not need any.
 *
 * ## Three ways this can end, and all three say which one happened
 *
 * - **Resolved** — a draft to confirm.
 * - **Not in the catalog** — says so, names the digits it read, and offers the
 *   describe path. It must never be an empty screen: absence reading as an
 *   answer is a failure this repo has hit repeatedly.
 * - **Could not ask** — says THAT instead, because "we do not have this one"
 *   is a false statement about the catalog when the real problem is a basement
 *   with no signal. A barcode already scanned on this phone still resolves
 *   offline, from the local cache; a new one cannot, and the screen says so
 *   rather than spinning.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { FoodQuantity } from '@/components/FoodQuantity';
import { AmountSheet } from '@/components/food/AmountSheet';
import { NutritionPanel } from '@/components/food/NutritionPanel';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { FOOD_BARCODE_TYPES, normaliseBarcode } from '@/lib/barcode';
import { lookupBarcode, type CachedSource, type ScannedFood } from '@/lib/barcodeApi';
import { cachedBarcode, rememberBarcode } from '@/lib/barcodeCache';
import { ApiError, transportDiagnosis } from '@/lib/apiError';
// Never `expo-camera` directly — it throws at module scope. See there (N91).
import { CameraView, useCameraPermissions } from '@/lib/cameraModule';
import { logFood } from '@/lib/foodLog';
import {
  canLogByWeight,
  displayName,
  FALLBACK_SERVING_GRAMS,
  macrosForGrams,
  macrosForServings,
  parseQuantity,
  quantityOptions,
  servingBasisGrams,
  servingsForGrams,
  type QuantifiableFood,
} from '@/lib/foodQuantity';
import { MEALS, slotForClock, todayString, type Macros, type Meal } from '@/lib/nutrition';
import { request as requestSync } from '@/lib/sync';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * What the screen is currently doing.
 *
 * A tagged union rather than a handful of booleans, for the reason
 * `nutrition.ts`'s `TargetView` gives about the same choice: the states that
 * matter here are the ones that must not collapse into each other. `unknown`
 * ("the server has nothing") and `unreachable` ("I could not ask") rendering
 * as one state IS the bug this screen is written to avoid, and two booleans
 * let that happen silently.
 */
type Phase =
  | { kind: 'scanning' }
  | { kind: 'looking-up'; code: string }
  /**
   * `source` is PROVENANCE (where the numbers came from) and `cached` is
   * AVAILABILITY (whether this phone already had them). They are deliberately
   * two fields rather than one enum with a `cache` member: a cached row still
   * has the provenance it was cached with, and collapsing them would let an
   * AI-drafted food resolve from SQLite and report itself as merely "cached",
   * losing the one label that says its numbers were guessed.
   */
  | { kind: 'draft'; code: string; food: ScannedFood; source: CachedSource; cached: boolean }
  | { kind: 'unknown'; code: string }
  | { kind: 'unreachable'; code: string; message: string };

export default function ScanBarcodeScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();
  const { userId } = useAuth();
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();
  const [permission, requestPermission] = useCameraPermissions();

  const date = params.date ?? todayString();
  const [meal, setMeal] = useState<Meal>(
    MEALS.includes(params.meal as Meal) ? (params.meal as Meal) : slotForClock(new Date()),
  );

  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' });
  const [misread, setMisread] = useState(false);
  /**
   * The amount currently entered, reported up by whichever amount control is
   * mounted (N117) — `FoodQuantity` when the food has an honest gram basis,
   * `ServingsFallback` below when it does not.
   *
   * Resolved to ONE common shape — a `servings` count and the macros for it
   * — regardless of which control produced it, so `confirm` and the summary
   * line below read from a single place rather than branching on which
   * control is active. Null only for the instant before that control's own
   * mount effect reports in — `add.tsx`'s `picking` screen carries the same
   * null window for the same reason.
   */
  const [quantity, setQuantity] = useState<{ servings: number; valid: boolean; macros: Macros } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** N426: the amount editor is a sheet, not an always-visible field. */
  const [amountSheetOpen, setAmountSheetOpen] = useState(false);

  /**
   * Speak the two messages that change in place.
   *
   * **`accessibilityLiveRegion` is Android-only** — recorded in `sign-up.tsx`
   * and `forgot-password.tsx` and forgotten here. The attribute below announces
   * nothing on iOS, so the misread hint this screen relies on to say "aim
   * again" was silent on the platform the app ships on, for exactly the
   * eyes-free case it was added for. Kept for Android, paired with this.
   *
   * Introduced in N41 and corrected in N47, where review found the identical
   * claim on the identify screen.
   */
  useEffect(() => {
    if (saveError) AccessibilityInfo.announceForAccessibility(saveError);
  }, [saveError]);

  useEffect(() => {
    if (misread) AccessibilityInfo.announceForAccessibility("That didn't read cleanly — try again.");
  }, [misread]);

  /**
   * Whether a code is already being handled.
   *
   * A ref, not state, and this is load-bearing rather than an optimisation.
   * `onBarcodeScanned` fires on every frame the camera can decode — tens of
   * times a second — and a state flag does not update until the next render,
   * so the first dozen frames all read the stale `false` and all start a
   * lookup. A ref is written synchronously, so the second frame sees the first
   * frame's decision.
   */
  const handling = useRef(false);

  /**
   * Whether a confirm is already in flight.
   *
   * A ref for the same reason `handling` is one, and the file already argues
   * it: a state flag does not update until the next render, so two taps
   * landing before React commits both read `saving === false` and both log.
   * The window is narrow — a local SQLite write — but it is the identical
   * pattern this screen names twenty lines up, and a duplicated meal is
   * exactly the damage the draft-then-confirm rule exists to avoid. Raised in
   * review.
   */
  const confirming = useRef(false);

  /**
   * Show the drafted product and let the athlete correct it.
   *
   * Declared BEFORE `resolve`, which calls it. That ordering is enforced —
   * `react-hooks/immutability` rejects reading a `useCallback` binding above
   * its declaration, and it is right to: the earlier reference would capture
   * the binding before initialisation rather than tracking it. This was
   * written the other way round first and the rule caught it.
   */
  const openDraft = useCallback(
    (code: string, food: ScannedFood, source: CachedSource, cached: boolean) => {
      // Reset, not left stale — `defaultQuantity` below is re-derived for the
      // new food within the same tick, but between this
      // line and that report the screen must not show the PREVIOUS packet's
      // numbers under the new one's name (a scan-a-different-packet loop).
      setQuantity(null);
      setPhase({ kind: 'draft', code, food, source, cached });
    },
    [],
  );

  const resolve = useCallback(
    async (code: string) => {
      if (!userId) {
        // Release the frame guard. Latched with a live camera and no phase
        // change, every subsequent frame is silently swallowed and the screen
        // looks broken rather than signed out. Raised in review.
        handling.current = false;
        return;
      }
      setPhase({ kind: 'looking-up', code });

      // The local cache first, and BEFORE the network rather than as a
      // fallback after it fails. A product already scanned on this phone
      // should resolve in a shop with no signal at all, and asking the network
      // first would make that case wait for a timeout it does not need.
      try {
        const hit = await cachedBarcode(userId, code);
        if (hit) {
          // The row's OWN provenance, plus the fact that it came from the
          // cache. An AI-drafted food resolving offline must still say its
          // numbers were drafted.
          openDraft(code, hit.food, hit.source, true);
          return;
        }
      } catch {
        // A cache read that fails is not worth telling the athlete about — the
        // network path below answers the same question. Swallowing it here is
        // the one place in this screen where silence is right.
      }

      try {
        const res = await lookupBarcode(getToken, code);
        if (res.status === 'unknown') {
          setPhase({ kind: 'unknown', code });
          return;
        }
        openDraft(code, res.food, res.source, false);
        // Cached AFTER the draft opens, so a slow write never sits between the
        // scan and the numbers appearing. A failure here costs a re-fetch next
        // time and nothing else, which is why it is not surfaced.
        void rememberBarcode(userId, code, res.food, res.source).catch(() => {});
      } catch (err) {
        setPhase({
          kind: 'unreachable',
          code,
          message: messageForLookupFailure(err),
        });
      }
    },
    [userId, getToken, openDraft],
  );

  const onScanned = useCallback(
    // `type` is the SYMBOLOGY the camera decoded, and it is passed on rather
    // than dropped: eight digits is EAN-8 or UPC-E and the string alone cannot
    // say which. Guessing there is what let a misread through once already.
    ({ data, type }: { data: string; type: string }) => {
      if (handling.current) return;
      const code = normaliseBarcode(data, type);
      if (!code) {
        // Keep scanning. A creased or curved packet fails its own check digit
        // routinely, and the honest reading of that is "aim again", not "we do
        // not have this food" — which is what a lookup on a misread would have
        // ended up saying.
        setMisread(true);
        return;
      }
      handling.current = true;
      setMisread(false);
      void resolve(code);
    },
    [resolve],
  );

  const scanAgain = useCallback(() => {
    handling.current = false;
    setMisread(false);
    setSaveError(null);
    setPhase({ kind: 'scanning' });
  }, []);

  /**
   * `phase.food` adapted for `FoodQuantity` (N117) — MEMOISED, and that is
   * load-bearing rather than tidiness. A fresh object literal every render
   * would give `FoodQuantity`'s internal `[grams, valid, food]` effect a new
   * `food` reference every time, which fires `onQuantityChange`, which calls
   * `setQuantity`, which re-renders this component, which built a new
   * `quantifiable`, which fires the effect again — an infinite loop with
   * nothing on screen to show for it. Measured: this exact shape OOM'd the
   * test runner before `useMemo` was added here.
   *
   * `serving_grams` stays `phase.food.serving_grams` (always 100) — the
   * ARITHMETIC basis `FoodQuantity` scales every amount against. The
   * packet's own serving becomes a single PORTION CHIP instead:
   * `quantityOptions` treats the first portion as the default amount, so a
   * Kinder bar opens to "2 Pieces (25 g)" rather than "100 g", while the
   * math underneath is still `perHundredG * (grams/100)` either way.
   *
   * Declared with the other hooks, above every conditional return — a hook
   * below one is what made every BJJ session a black screen once already.
   *
   * Only consulted when `canWeigh` (below) is true — a food with no honest
   * gram basis renders `ServingsFallback` instead and never reads this.
   */
  const quantifiable: QuantifiableFood | null = useMemo(() => {
    if (phase.kind !== 'draft') return null;
    return adaptForQuantity(phase.food);
  }, [phase]);

  /**
   * The default `quantity` for the current draft, computed directly rather
   * than seeded by an effect (N426, found in review — an effect calling
   * `setQuantity` here trips `react-hooks/set-state-in-effect`, and this
   * app's lint gate is a warning RATCHET with zero headroom; a derived
   * value has no such cost, and is simpler besides). `quantity` itself
   * (the state below) holds only what an amount control has actually
   * REPORTED; `effectiveQuantity` is what the screen shows and logs before
   * that ever happens — the packet's own serving on first look, matching
   * the reference screenshot, not a "—" until the sheet is opened once.
   */
  const defaultQuantity = useMemo(() => {
    if (phase.kind !== 'draft' || !quantifiable) return null;
    return defaultQuantityFor(phase.food, quantifiable);
  }, [phase, quantifiable]);
  const effectiveQuantity = quantity ?? defaultQuantity;

  /**
   * Confirm the draft.
   *
   * `effectiveQuantity` is already resolved to a `servings` count and the
   * macros for it — either reported by an amount control, or (if the
   * athlete never opened the sheet) the same default `defaultQuantityFor`
   * computed above. Nothing is re-derived here; the numbers on screen are
   * the numbers logged.
   *
   * The two amount controls arrive at `servings` differently, and that
   * difference is the fix for a real bug (found in review): `FoodQuantity`
   * (grams-based) reports grams, converted via `servingsForGrams` — the SAME
   * helper `add.tsx`'s `logCatalog` uses for a catalog food, NOT a hardcoded
   * `grams / 100`, because `phase.food.serving_grams` is 100 for a barcode
   * this build resolved fresh but is not guaranteed 100 for every
   * `ScannedFood`. `ServingsFallback` reports a servings count directly, for
   * a food with NO gram basis at all (`serving_grams: null` — the
   * AI-cached-as-barcode path in `describe.tsx`, e.g. "1 egg"). Routing that
   * food through the grams control instead would silently invent a 100 g
   * basis it never stated — exactly what N117's own acceptance criteria
   * forbid ("a serving whose gram weight is unknown does not silently
   * become 100 g"), and a regression against this screen's own pre-N117
   * behaviour, which was basis-agnostic (a bare "servings" count) precisely
   * because it never assumed a gram weight either.
   */
  const confirm = useCallback(async () => {
    if (phase.kind !== 'draft' || !userId || confirming.current || !effectiveQuantity?.valid) return;
    confirming.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await logFood(userId, {
        eaten_on: date,
        meal,
        name: displayName(phase.food),
        servings: effectiveQuantity.servings,
        serving_label: phase.food.serving_label,
        ...effectiveQuantity.macros,
        // No `source_food_id`: that column is a foreign key into the athlete's
        // OWN saved foods, and a scanned product is not one of those. Pointing
        // it at a cache row would be a dangling reference the moment the cache
        // is cleared.
        source_food_id: null,
      });
      requestSync('barcode scanned');
      router.back();
    } catch (err) {
      setSaveError(
        `${err instanceof Error && err.message ? err.message : 'That could not be saved.'} Nothing was logged.`,
      );
    } finally {
      confirming.current = false;
      setSaving(false);
    }
  }, [phase, userId, effectiveQuantity, date, meal, router]);

  // ---- render ------------------------------------------------------------
  // Every hook is above this line. Nothing below may introduce one: a hook
  // after a conditional return is what made every BJJ session a black screen,
  // and `react-hooks/rules-of-hooks` is the only check that sees it.

  const title = 'Scan a barcode';

  /*
   * No camera in this binary at all.
   *
   * Checked BEFORE the permission branches, and the order is the point: with
   * no native module there is no permission to grant, so falling through would
   * tell the athlete to go and enable something in Settings that Settings does
   * not list. This says the honest thing instead, and offers the path that
   * still works.
   *
   * Written as a null check on the component rather than against a separate
   * boolean, so that TypeScript — not a comment — is what stops the camera
   * being rendered when there is none. It also narrows `CameraView` to
   * non-null for the `scanning` branch below.
   *
   * On a correctly built app this is unreachable. It exists because the
   * alternative to rendering it was the process being killed — see
   * `lib/cameraModule.ts`.
   */
  if (!CameraView) {
    return (
      <Shell title={title}>
        <Text style={styles.lead} testID="scan-unavailable">
          Scanning isn&apos;t available in this build.
        </Text>
        <Text style={styles.body}>
          The camera can&apos;t be reached, so a barcode can&apos;t be read. Describing the food
          works, and gives you the same entry to check.
        </Text>
        <Pressable
          onPress={() => router.replace(describeHref(meal, date))}
          style={[styles.primary, { backgroundColor: accent.accent }]}
          accessibilityRole="button"
          // No `accessibilityLabel`: the visible text IS the label. An override
          // reading "Describe the food instead" over a button that says
          // "Describe it instead" is a label-in-name mismatch (WCAG 2.5.3) —
          // Voice Control users say what they can see, and it would not match.
          testID="scan-unavailable-describe"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>Describe it instead</Text>
        </Pressable>
      </Shell>
    );
  }

  if (!permission) {
    return (
      <Shell title={title}>
        <ActivityIndicator accessibilityLabel="Checking camera access" />
      </Shell>
    );
  }

  if (!permission.granted) {
    return (
      <Shell title={title}>
        <Text style={styles.lead}>
          {permission.canAskAgain
            ? 'VOLA needs the camera to read a barcode.'
            : 'VOLA does not have camera access.'}
        </Text>
        <Text style={styles.body}>
          The barcode is decoded on your phone. No picture is taken, and nothing is uploaded — only
          the digits are sent, to look the food up.
        </Text>
        {permission.canAskAgain ? (
          <Pressable
            onPress={() => void requestPermission()}
            style={[styles.primary, { backgroundColor: accent.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Allow camera access"
            testID="scan-request-permission"
          >
            <Text style={[styles.primaryText, { color: accent.on }]}>Allow the camera</Text>
          </Pressable>
        ) : (
          <Text style={styles.body}>You can turn it on in Settings, under VOLA.</Text>
        )}
        <Pressable
          onPress={() => router.replace(describeHref(meal, date))}
          accessibilityRole="button"
          accessibilityLabel="Describe the food instead"
          testID="scan-permission-describe"
        >
          <Text style={styles.link}>Describe the food instead</Text>
        </Pressable>
      </Shell>
    );
  }

  if (phase.kind === 'scanning') {
    return (
      <Shell title={title} scroll={false}>
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            // Restricted to the symbologies that are actually on food. A QR
            // code on a cereal box points at a marketing site and would
            // resolve to nothing while looking like a successful scan.
            barcodeScannerSettings={{ barcodeTypes: [...FOOD_BARCODE_TYPES] }}
            onBarcodeScanned={onScanned}
            testID="scan-camera"
          />
          <View style={styles.reticle} pointerEvents="none" />
        </View>
        {/* Android announces via the live region; iOS via the effect above,
            because `accessibilityLiveRegion` does nothing there. */}
        <Text style={styles.hint} testID="scan-hint" accessibilityLiveRegion="polite">
          {misread
            ? "That didn't read cleanly — try again, flatter to the light."
            : 'Point the camera at the barcode on the packet.'}
        </Text>
        <Pressable
          onPress={() => router.replace(describeHref(meal, date))}
          accessibilityRole="button"
          accessibilityLabel="Describe the food instead"
          testID="scan-describe"
        >
          <Text style={styles.link}>No barcode? Describe it instead</Text>
        </Pressable>
      </Shell>
    );
  }

  if (phase.kind === 'looking-up') {
    return (
      <Shell title={title}>
        <ActivityIndicator accessibilityLabel="Looking this up" />
        <Text style={styles.body} testID="scan-looking-up">
          Looking up {phase.code}…
        </Text>
        {/* An exit, because there is no request timeout beneath this. On one
            bar — not offline, just slow, which is this feature's own described
            environment — the OS can take tens of seconds to give up, and a
            spinner with no way out is indistinguishable from a hang. Raised in
            review. */}
        <Pressable
          onPress={scanAgain}
          accessibilityRole="button"
          accessibilityLabel="Stop looking this up"
          testID="scan-cancel-lookup"
        >
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </Shell>
    );
  }

  if (phase.kind === 'unknown') {
    return (
      <Shell title={title}>
        {/* Names the digits it read. Without them the athlete cannot tell a
            missing product from a misread packet, and cannot report it. */}
        <Text style={styles.lead} testID="scan-unknown">
          We don&apos;t have this one.
        </Text>
        <Text style={styles.body} testID="scan-unknown-detail">
          Barcode {phase.code} isn&apos;t in the food catalog. That means we haven&apos;t got it
          yet — not that anything went wrong.
        </Text>
        <Pressable
          onPress={() => router.replace(describeHref(meal, date, phase.code))}
          style={[styles.primary, { backgroundColor: accent.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Describe this food instead"
          testID="scan-unknown-describe"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>Describe it instead</Text>
        </Pressable>
        <Text style={styles.footnote}>
          Photograph the label or say what it is, and we&apos;ll draft the numbers for you to
          check. Confirm it and this barcode will find it next time.
        </Text>
        <Pressable
          onPress={scanAgain}
          accessibilityRole="button"
          accessibilityLabel="Scan another barcode"
          testID="scan-unknown-again"
        >
          <Text style={styles.link}>Scan another</Text>
        </Pressable>
      </Shell>
    );
  }

  if (phase.kind === 'unreachable') {
    return (
      <Shell title={title}>
        {/* Deliberately NOT "we don't have this one". The catalog may well have
            it; we could not ask. Saying otherwise states something false about
            the catalog because the signal was bad. */}
        <Text style={styles.lead} testID="scan-unreachable">
          Couldn&apos;t check this one.
        </Text>
        <Text style={styles.body}>{phase.message}</Text>
        <Pressable
          onPress={() => void resolve(phase.code)}
          style={[styles.primary, { backgroundColor: accent.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Try the lookup again"
          testID="scan-retry"
        >
          <Text style={[styles.primaryText, { color: accent.on }]}>Try again</Text>
        </Pressable>
        <Pressable
          onPress={() => router.replace(describeHref(meal, date))}
          accessibilityRole="button"
          accessibilityLabel="Describe the food instead"
          testID="scan-unreachable-describe"
        >
          <Text style={styles.link}>Describe it instead</Text>
        </Pressable>
      </Shell>
    );
  }

  // phase.kind === 'draft' — `quantifiable` was computed above, memoised,
  // alongside the other hooks; never null here (the phase-kind check runs
  // before this line).

  // Whether this food states a real gram basis. `phase.food.serving_grams`
  // is always 100 for a barcode this build resolved fresh, but is `null`
  // for the AI-cached-as-barcode path (`describe.tsx`, e.g. "1 egg") — a
  // plain `const`, not a hook, so it is fine to compute this late.
  const canWeigh = canLogByWeight(phase.food);

  return (
    <Shell title={title}>
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
              testID={`scan-slot-${m}`}
            >
              <Text style={[styles.slotText, on && { color: accent.on }]}>{mealLabel(m)}</Text>
            </Pressable>
          );
        })}
      </View>

      <SectionHeader label="Check this before logging" />

      <View style={styles.card}>
        <Text style={styles.name} testID="scan-name">
          {displayName(phase.food)}
        </Text>
        {/* The ARITHMETIC basis every amount below is computed against —
            always "100 g" for a resolved barcode (unchanged by N117), or the
            food's own stated serving (e.g. "1 egg") for the AI-cached path
            below, whose `serving_grams` is null and which is why that path
            uses a servings multiplier rather than a grams field. States what
            the numbers are per, so the arithmetic below is checkable (N117's
            own criterion). */}
        <Text style={styles.serving}>Per {phase.food.serving_label}</Text>

        {/* N426: Amount is the headline row, not a field buried in the
            middle of the card — reported against a reference screenshot
            where the amount is the first thing the athlete acts on. Tapping
            it opens the editor rather than showing it inline; the editor
            itself (below, in the sheet) is unchanged N117 machinery. */}
        <Pressable
          onPress={() => setAmountSheetOpen(true)}
          style={styles.amountRow}
          accessibilityRole="button"
          accessibilityLabel={`Amount, ${
            effectiveQuantity ? amountSummary(phase.food, canWeigh, effectiveQuantity.servings) : 'not set'
          }. Opens the amount editor.`}
          testID="scan-amount-row"
        >
          <Text style={styles.amountLabel}>Amount</Text>
          <Text style={styles.amountValue} testID="scan-amount-value">
            {effectiveQuantity ? amountSummary(phase.food, canWeigh, effectiveQuantity.servings) : '—'}
          </Text>
        </Pressable>

        <View style={styles.divider} />

        {/* N426: the same hero-calorie-and-macro-grid layout `add.tsx`'s
            food-detail screen already ships (N59) — this screen was the one
            place in the app that still summarised a food as one line of
            text ("Logs as X kcal, Y g protein") instead of a real
            breakdown. */}
        <NutritionPanel macros={effectiveQuantity?.macros ?? ZERO_MACROS} />
      </View>

      <AmountSheet visible={amountSheetOpen} onClose={() => setAmountSheetOpen(false)}>
        {canWeigh ? (
          // N117: the amount an athlete actually had, in grams or ounces,
          // defaulting to the packet's own printed serving when one is known
          // (via `quantifiable.portions` above) rather than always "100 g" —
          // every macro recalculates live as it changes. `hideBuiltInFooter`
          // and `hideName`: the sheet has its own "Done" action and the
          // food's name is already on the card behind this sheet.
          <FoodQuantity
            // Never null here: `quantifiable` is null only when
            // `phase.kind !== 'draft'`, and this branch already established
            // it is. TypeScript cannot see across the `if` above, hence `!`.
            food={quantifiable!}
            onLog={() => setAmountSheetOpen(false)}
            onQuantityChange={(q) =>
              setQuantity({
                servings: servingsForGrams(phase.food, q.grams),
                valid: q.valid,
                macros: q.macros,
              })
            }
            hideBuiltInFooter
            hideName
            busy={saving}
          />
        ) : (
          // Found in review: a food with no honest gram weight
          // (`serving_grams: null`) must never be offered a grams field —
          // see the `confirm` doc comment above for why.
          <ServingsFallback food={phase.food} onChange={setQuantity} />
        )}
      </AmountSheet>

      {/* Says where the numbers came from, because the two are not equally
          trustworthy. Open Food Facts is crowd-sourced and can be wrong in
          ways a curated row is not, and an athlete correcting a figure is
          entitled to know which they are looking at. */}
      <Text style={styles.provenance} testID="scan-provenance">
        {provenanceCopy(phase.source, phase.cached)}
      </Text>

      {saveError ? (
        <Text style={styles.error} testID="scan-save-error" accessibilityLiveRegion="assertive">
          {saveError}
        </Text>
      ) : null}

      <Pressable
        onPress={() => void confirm()}
        style={[
          styles.primary,
          { backgroundColor: accent.accent },
          (saving || !effectiveQuantity?.valid) && styles.off,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Log ${phase.food.name}`}
        disabled={saving || !effectiveQuantity?.valid}
        accessibilityState={{ disabled: saving || !effectiveQuantity?.valid }}
        testID="scan-log"
      >
        <Text style={[styles.primaryText, { color: accent.on }]}>
          {saving ? 'Logging…' : 'Log it'}
        </Text>
      </Pressable>

      <Pressable
        onPress={scanAgain}
        accessibilityRole="button"
        accessibilityLabel="Scan a different packet"
        disabled={saving}
        accessibilityState={{ disabled: saving }}
        testID="scan-again"
      >
        <Text style={[styles.link, saving && styles.off]}>Scan a different packet</Text>
      </Pressable>
    </Shell>
  );
}

/** The screen frame, so five branches do not each repeat it. */
function Shell({
  title,
  children,
  scroll = true,
}: {
  title: string;
  children: React.ReactNode;
  scroll?: boolean;
}) {
  return (
    <>
      <Stack.Screen options={{ title }} />
      {scroll ? (
        <KeyboardAwareScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </KeyboardAwareScrollView>
      ) : (
        <View style={styles.scroll}>{children}</View>
      )}
    </>
  );
}

/**
 * The amount control for a food with NO honest gram weight (found in
 * review) — the AI-cached-as-barcode path in `describe.tsx` stores
 * `serving_grams: null` because a described "1 egg" has no honest gram
 * figure, and `FoodQuantity`'s whole model (grams as the state, a basis to
 * scale against) does not apply to a food that has none.
 *
 * Silently defaulting to 100 g here — which routing this food through
 * `FoodQuantity` would do, via `servingBasisGrams`'s fallback — is exactly
 * the fabricated-basis bug N117's own acceptance criteria forbid. This
 * renders a plain SERVINGS multiplier instead: basis-agnostic, the same
 * shape the whole screen used before N117, restricted to the one case
 * (`!canWeigh`, in the caller) where a gram amount cannot be honestly
 * offered.
 */
function ServingsFallback({
  food,
  onChange,
}: {
  food: Macros & { serving_label: string };
  onChange: (state: { servings: number; valid: boolean; macros: Macros }) => void;
}) {
  const [text, setText] = useState('1');

  // Reports on every change to the typed text, mirroring `FoodQuantity`'s
  // own `onQuantityChange` effect. `food` is deliberately absent from the
  // deps for the same reason that effect gives: this only needs to re-fire
  // on the athlete's own typing, not on a re-render that leaves the number
  // the same.
  useEffect(() => {
    const n = parseQuantity(text);
    onChange({ servings: n ?? 0, valid: n != null, macros: macrosForServings(food, n ?? 0) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <View style={styles.fallbackRow}>
      <TextInput
        value={text}
        onChangeText={setText}
        keyboardType="decimal-pad"
        selectTextOnFocus
        style={styles.fallbackInput}
        placeholderTextColor={vola.textDim}
        accessibilityLabel={`Servings of ${food.serving_label}`}
        testID="scan-servings-fallback"
      />
      <Text style={styles.fallbackUnit}>× {food.serving_label}</Text>
    </View>
  );
}

/**
 * Why a lookup did not happen, in words the athlete can act on.
 *
 * The middle branch is not hypothetical housekeeping — it is the GUARANTEED
 * experience until N46 ships the endpoint. `apiRequest` fills `code` with
 * `unknown` when a response carries no error envelope, which is what an
 * unrouted path returns, so without this the screen shows the raw
 * "Request failed (404)." Honest, and useless to somebody holding a packet.
 *
 * Note it still renders under `unreachable` rather than `unknown`: we did not
 * ask successfully, so we cannot say the catalog lacks the food.
 */
function messageForLookupFailure(err: unknown): string {
  // Every dead request, not just an absent radio (N55). This used to test
  // `isOffline` alone, and once the transport started telling a timeout and a
  // dropped connection apart from no-route, those two stopped matching and
  // fell through to the raw message — losing the one thing this screen knows
  // that the transport does not, which is that the scan cache still works.
  const diagnosis = transportDiagnosis(err);
  if (diagnosis) {
    return `${diagnosis} A barcode you've scanned on this phone before still works.`;
  }
  if (err instanceof ApiError && err.status === 404 && err.code !== 'not_found') {
    return 'The server this app is talking to does not have barcode lookup. Describing the food works now.';
  }
  if (err instanceof Error && err.message) return err.message;
  return 'The food lookup could not be reached. Try again in a moment.';
}

/**
 * `phase.food` adapted for `FoodQuantity`/`quantityOptions` (N117, factored
 * out for N426) — the packet's own serving becomes a single PORTION CHIP,
 * `serving_grams` stays the unchanged arithmetic basis. Shared by the
 * `quantifiable` memo (what `FoodQuantity` itself renders) and
 * `defaultQuantityFor` below (what seeds `quantity` before the sheet ever
 * opens) so the two can never compute a different default from each other.
 */
function adaptForQuantity(food: ScannedFood): QuantifiableFood {
  return {
    ...food,
    portions:
      food.packet_serving_grams != null && food.packet_serving_label != null
        ? [{ seq: 0, label: food.packet_serving_label, grams: food.packet_serving_grams }]
        : [],
  };
}

/**
 * The default `quantity` for a freshly opened draft (N426) — computed
 * directly, without mounting `FoodQuantity`/`ServingsFallback`, so the
 * "Amount" headline row reads correctly on first look rather than "—" until
 * the athlete taps it open. Mirrors `FoodQuantity`'s own `initial` (the
 * first `quantityOptions` entry) and `ServingsFallback`'s own default text
 * ("1") exactly — this is not a second source of truth, it is the same
 * arithmetic run one render earlier.
 */
function defaultQuantityFor(
  food: ScannedFood,
  adapted: QuantifiableFood,
): { servings: number; valid: boolean; macros: Macros } {
  if (!canLogByWeight(food)) {
    return { servings: 1, valid: true, macros: macrosForServings(food, 1) };
  }
  const options = quantityOptions(adapted, adapted.portions);
  const grams = options[0]?.grams ?? FALLBACK_SERVING_GRAMS;
  return { servings: servingsForGrams(food, grams), valid: true, macros: macrosForGrams(adapted, grams) };
}

/**
 * The headline row's value (N426) — "2 pieces (25 g)" when the current
 * amount matches the packet's own serving, otherwise a plain "{grams} g" or,
 * for a food with no gram basis at all, "{servings} × {serving_label}".
 *
 * Grams, not a fabricated "Pieces" unit — VOLA does not parse a piece-count
 * unit from Open Food Facts yet (N427). Showing the packet's OWN label when
 * the amount matches it gets the reference screenshot's readability ("2
 * pieces") without claiming a unit VOLA cannot actually convert.
 */
function amountSummary(food: ScannedFood, canWeigh: boolean, servings: number): string {
  if (!canWeigh) {
    return `${trimmed(servings)} × ${food.serving_label}`;
  }
  const grams = Math.round(servings * servingBasisGrams(food));
  if (
    food.packet_serving_grams != null &&
    food.packet_serving_label != null &&
    Math.abs(grams - food.packet_serving_grams) < 1
  ) {
    return food.packet_serving_label;
  }
  return `${grams} g`;
}

/** Drops a trailing `.0` a plain `String()` would otherwise keep on some inputs. */
function trimmed(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * `NutritionPanel`'s required shape before the amount control has reported
 * in — the same "nothing to show yet" instant `quantity` being null already
 * covers, made concrete rather than a second null-check inside the panel.
 */
const ZERO_MACROS: Macros = {
  kcal: 0,
  protein_g: 0,
  carb_g: 0,
  fat_g: 0,
  fibre_g: null,
  saturated_fat_g: null,
  sugar_g: null,
  added_sugar_g: null,
  sodium_mg: null,
  cholesterol_mg: null,
};

function provenanceCopy(source: CachedSource, cached: boolean): string {
  const where = cached ? ' Held on this phone, so it works offline.' : '';
  switch (source) {
    case 'ai':
      // The one source whose numbers are NOT off a packet. Said plainly,
      // because everything else about this screen implies they are.
      return `Drafted from your own description, not read off the packet — worth checking against the label.${where}`;
    case 'off':
      return `From Open Food Facts, which is crowd-sourced — worth a glance against the packet.${where}`;
    case 'other':
      // Named neither, because we do not know which. Claiming the VOLA catalog
      // would be false and naming Open Food Facts would be false about someone
      // else — the same mistake the describe screen's photo disclosure warns
      // about, where a specific wrong recipient is worse than a vague one.
      return `From an outside food database — worth a glance against the packet.${where}`;
    default:
      return `From the VOLA food catalog.${where}`;
  }
}

/**
 * Through to the describe path.
 *
 * **The barcode is carried ONLY from the `unknown` branch**, and that
 * restriction is the whole subtlety here. Carrying it tells the describe
 * screen to cache what the athlete confirms against that packet, which is
 * right when the catalog has genuinely answered "no". From the `unreachable`
 * branch we do not know that — the catalog may hold the real product — so
 * caching a drafted guess there would shadow the correct answer on this phone
 * permanently, and the athlete would have no way to tell it had happened.
 */
function describeHref(meal: Meal, date: string, barcode?: string) {
  const base = `/food/describe?meal=${meal}&date=${date}`;
  return (barcode ? `${base}&barcode=${encodeURIComponent(barcode)}` : base) as Href;
}

function mealLabel(m: Meal): string {
  return m === 'snack' ? 'Snacks' : m[0].toUpperCase() + m.slice(1);
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 48, flexGrow: 1 },
  cameraWrap: {
    // Reported "too short" at the old fixed 280 — a third of a typical
    // screen's height for what is supposed to be the whole point of this
    // screen. `flex: 1` fills whatever the `hint` text and the "Describe it
    // instead" link below don't need, rather than a second magic number that
    // would only be right on one device size; the parent (`styles.scroll`,
    // `flexGrow: 1`) already gives this View the room to grow into.
    flex: 1,
    minHeight: 420,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  reticle: {
    width: '78%',
    height: 108,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 12,
  },
  hint: { fontSize: 13, color: vola.textMuted, lineHeight: 18, textAlign: 'center' },
  lead: { fontSize: 17, fontWeight: '700' },
  body: { fontSize: 13, color: vola.textMuted, lineHeight: 19 },
  footnote: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  link: { fontSize: 13, color: vola.textMuted, fontWeight: '600', textAlign: 'center' },
  error: { fontSize: 13, color: vola.danger, lineHeight: 18 },
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
  card: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 12,
    padding: 12,
    gap: 4,
    backgroundColor: vola.surface,
  },
  name: { fontSize: 16, fontWeight: '700' },
  serving: { fontSize: 12, color: vola.textDim },
  // N426: the headline row — "Amount" on the left, the current value on the
  // right, the whole row tappable. Visually the most prominent editable
  // thing in the card, matching the reference's own "Amount" row.
  amountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    marginTop: 4,
  },
  amountLabel: { fontSize: 14, color: vola.textMuted, fontWeight: '600' },
  amountValue: { fontSize: 16, color: vola.text, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: vola.line, marginVertical: 4 },
  fallbackRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fallbackInput: {
    flex: 1,
    fontSize: 22,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: vola.surface,
    color: vola.text,
  },
  fallbackUnit: { fontSize: 13, color: vola.textMuted, flexShrink: 1 },
  provenance: { fontSize: 12, color: vola.textDim, lineHeight: 17 },
  primary: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
});
