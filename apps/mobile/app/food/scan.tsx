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
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareScrollView, useEnsureVisible } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { FOOD_BARCODE_TYPES, normaliseBarcode } from '@/lib/barcode';
import { lookupBarcode, type CachedSource, type ScannedFood } from '@/lib/barcodeApi';
import { cachedBarcode, rememberBarcode } from '@/lib/barcodeCache';
import { isOffline } from '@/lib/apiError';
import { parseOr } from '@/lib/draftNumber';
import { logFood } from '@/lib/foodLog';
import { MEALS, scale, slotForClock, todayString, type Food, type Meal } from '@/lib/nutrition';
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
  const [servingsText, setServingsText] = useState('1');
  const [kcalText, setKcalText] = useState('');
  const [proteinText, setProteinText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
      setServingsText('1');
      setKcalText(String(Math.round(food.kcal)));
      setProteinText(String(Math.round(food.protein_g)));
      setPhase({ kind: 'draft', code, food, source, cached });
    },
    [],
  );

  const resolve = useCallback(
    async (code: string) => {
      if (!userId) return;
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
          message: isOffline(err)
            ? "You're offline, so a new barcode can't be looked up. A food you've scanned on this phone before still works without signal."
            : err instanceof Error && err.message
              ? err.message
              : 'The food lookup could not be reached. Try again in a moment.',
        });
      }
    },
    [userId, getToken, openDraft],
  );

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      if (handling.current) return;
      const code = normaliseBarcode(data);
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
   * Confirm the draft.
   *
   * The per-serving figures are scaled ONCE here, at confirm time — the same
   * shape `add.tsx` uses for a saved food, because a barcode IS a saved food's
   * worth of data rather than an estimate's. The stored entry copies the
   * numbers rather than pointing at the cache row, so purging or correcting a
   * cached product can never rewrite a meal already logged.
   */
  const confirm = useCallback(async () => {
    if (phase.kind !== 'draft' || !userId || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const servings = parseOr(servingsText, 1);
      const perServing = {
        ...phase.food,
        kcal: parseOr(kcalText, phase.food.kcal),
        protein_g: parseOr(proteinText, phase.food.protein_g),
      };
      await logFood(userId, {
        eaten_on: date,
        meal,
        name: displayName(phase.food),
        servings,
        serving_label: phase.food.serving_label,
        ...scale(asFood(perServing), servings),
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
      setSaving(false);
    }
  }, [phase, userId, saving, servingsText, kcalText, proteinText, date, meal, router]);

  // ---- render ------------------------------------------------------------
  // Every hook is above this line. Nothing below may introduce one: a hook
  // after a conditional return is what made every BJJ session a black screen,
  // and `react-hooks/rules-of-hooks` is the only check that sees it.

  const title = 'Scan a barcode';

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
        <Text style={styles.hint} testID="scan-hint">
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

  // phase.kind === 'draft'
  const servings = parseOr(servingsText, 1);
  const total = scale(
    asFood({
      ...phase.food,
      kcal: parseOr(kcalText, phase.food.kcal),
      protein_g: parseOr(proteinText, phase.food.protein_g),
    }),
    servings,
  );

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
          {phase.food.name}
        </Text>
        {phase.food.brand ? <Text style={styles.brand}>{phase.food.brand}</Text> : null}
        <Text style={styles.serving}>Per {phase.food.serving_label}</Text>

        <View style={styles.fields}>
          <Field
            label="Servings"
            value={servingsText}
            onChange={setServingsText}
            testID="scan-servings"
            editable={!saving}
            // The cursor lands here, because this is the ONE number a barcode
            // cannot tell us. The macros are printed on the packet; how much of
            // the packet you ate is not.
            autoFocus
          />
          <Field
            label="Calories"
            value={kcalText}
            onChange={setKcalText}
            testID="scan-kcal"
            editable={!saving}
          />
          <Field
            label="Protein (g)"
            value={proteinText}
            onChange={setProteinText}
            testID="scan-protein"
            editable={!saving}
          />
        </View>

        <Text style={styles.total} testID="scan-total">
          Logs as {Math.round(total.kcal)} kcal, {Math.round(total.protein_g)} g protein
        </Text>
      </View>

      {/* Says where the numbers came from, because the two are not equally
          trustworthy. Open Food Facts is crowd-sourced and can be wrong in
          ways a curated row is not, and an athlete correcting a figure is
          entitled to know which they are looking at. */}
      <Text style={styles.provenance} testID="scan-provenance">
        {provenanceCopy(phase.source, phase.cached)}
      </Text>

      {saveError ? (
        <Text style={styles.error} testID="scan-save-error">
          {saveError}
        </Text>
      ) : null}

      <Pressable
        onPress={() => void confirm()}
        style={[styles.primary, { backgroundColor: accent.accent }, saving && styles.off]}
        accessibilityRole="button"
        accessibilityLabel={`Log ${phase.food.name}`}
        disabled={saving}
        accessibilityState={{ disabled: saving }}
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

function Field({
  label,
  value,
  onChange,
  testID,
  editable = true,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testID: string;
  editable?: boolean;
  autoFocus?: boolean;
}) {
  const ensureVisible = useEnsureVisible();
  const inputRef = useRef<TextInput>(null);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        ref={inputRef}
        style={[styles.fieldInput, !editable && styles.off]}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        inputMode="decimal"
        accessibilityLabel={label}
        testID={testID}
        editable={editable}
        autoFocus={autoFocus}
        // Selected rather than merely focused, so the first keystroke replaces
        // the value instead of appending to it.
        selectTextOnFocus
        // Lifts the field clear when the keyboard is ALREADY up at the same
        // height — moving between the three fields by tap. The native inset
        // adjustment covers the keyboard appearing; this is the case it does
        // not.
        onFocus={() => ensureVisible(inputRef.current)}
      />
    </View>
  );
}

/**
 * A scanned product in the shape `scale` takes.
 *
 * `scale` is the same function the quick-add sheet uses for a saved food, and
 * reusing it is the point: a barcode result IS a saved food's worth of data —
 * per-serving figures plus a serving label — rather than an estimate's. The
 * empty `id` is never read; nothing here is persisted as a food.
 */
function asFood(food: ScannedFood): Food {
  return { ...food, id: '', kind: 'food' };
}

/** Brand and name, without repeating the brand when it is already in the name. */
function displayName(food: ScannedFood): string {
  if (!food.brand) return food.name;
  if (food.name.toLowerCase().includes(food.brand.toLowerCase())) return food.name;
  return `${food.brand} ${food.name}`;
}

function provenanceCopy(source: CachedSource, cached: boolean): string {
  const where = cached ? ' Held on this phone, so it works offline.' : '';
  switch (source) {
    case 'ai':
      // The one source whose numbers are NOT off a packet. Said plainly,
      // because everything else about this screen implies they are.
      return `Drafted from your own description, not read off the packet — worth checking against the label.${where}`;
    case 'off':
      return `From Open Food Facts, which is crowd-sourced — worth a glance against the packet.${where}`;
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
    height: 280,
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
  brand: { fontSize: 13, color: vola.textMuted },
  serving: { fontSize: 12, color: vola.textDim },
  fields: { flexDirection: 'row', gap: 10, marginTop: 8 },
  field: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 11, color: vola.textDim, fontWeight: '600' },
  fieldInput: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: vola.text,
    fontSize: 14,
  },
  total: { fontSize: 12, color: vola.textMuted, marginTop: 8, fontWeight: '600' },
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
