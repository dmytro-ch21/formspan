import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { categoryBadge } from '@/components/LibraryTile';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import {
  executionSteps,
  fetchRulesets,
  fetchTechnique,
  type Ruleset,
  type Technique,
} from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * One technique, built to be *read* rather than skimmed past.
 *
 * The screen this replaced was structurally correct and unusable: eight stacked
 * sections in identical type, no visual anchor, and the execution instructions
 * delivered as a single 121-character sentence. It was described, accurately,
 * as "just a bunch of text".
 *
 * Three things fix that, in order of how much they matter:
 *
 * 1. **The description is a step list, so it renders as one.** The library
 *    authors it as one comma-separated sentence; `executionSteps` splits it,
 *    which works for 458 of 466 (the rest fall back to prose). This is the
 *    difference between a paragraph you re-read and a sequence you can follow
 *    between rounds.
 * 2. **A hero that is a designed object, not a missing photo.** Techniques have
 *    no image field yet and will get one; the hero is built as that slot, filled
 *    meanwhile with the category mark. `heroImage` is the single prop that turns
 *    it into a photo when the media lands — no layout change needed.
 * 3. **Sections sit on surfaces.** Cards give the eye somewhere to stop, which
 *    flat stacked text never did.
 *
 * One rule carries over unchanged, because it exists to stop the screen lying:
 * a section with no content does not render at all. Its companion — "an edge is
 * only tappable if it resolves" — is gone with the links themselves; nothing on
 * this screen navigates any more.
 */
export default function TechniqueScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();

  const [technique, setTechnique] = useState<Technique | null>(null);
  const [ruleset, setRuleset] = useState<Ruleset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!id) return;
      // Both, and in this order. Without setLoading(true) a retry renders the
      // fallback branch — "Technique not found." — for the entire request,
      // because error is cleared while technique is still null.
      setLoading(true);
      setError(null);
      try {
        const t = await fetchTechnique(id, getToken, signal);
        setTechnique(t);
        // Get already resolves the ruleset, so this is only a fallback for a
        // technique seeded before the rulesets existed.
        if (t.ibjjf) setRuleset(t.ibjjf);
        else if (t.ibjjf_ruleset_id) {
          const all = await fetchRulesets(getToken, signal);
          setRuleset(all.get(t.ibjjf_ruleset_id) ?? null);
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setError('Could not load this technique. Check your connection and try again.');
      } finally {
        setLoading(false);
      }
    },
    [id, getToken],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={vola.lime} />
      </View>
    );
  }

  // An honest failure, not an empty technique. This screen must never render
  // blank fields that read as "this technique has no description".
  if (error || !technique) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error} testID="technique-error">
          {error ?? 'Technique not found.'}
        </Text>
        <Pressable onPress={() => void load()} hitSlop={10} accessibilityRole="button">
          <Text style={styles.retry}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const t = technique;
  const [code, accent] = categoryBadge(t.category);
  const steps = executionSteps(t.description);

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="technique-detail">
      <Hero technique={t} code={code} accent={accent} />

      <View style={styles.body}>
        <RNView style={styles.chipRow}>
          <Chip label={t.position} />
          {!!t.position_detail && <Chip label={t.position_detail} />}
          <Chip label={t.gi_no_gi} />
        </RNView>

        {/* The headline change: instructions as a sequence, not a sentence. */}
        {steps.length > 0 ? (
          <Card title="How it works" accent={accent}>
            {steps.map((s, i) => (
              <RNView
                key={i}
                style={styles.step}
                accessible
                accessibilityLabel={`Step ${i + 1} of ${steps.length}: ${s}`}
              >
                <RNView style={[styles.stepNum, { borderColor: accent }]}>
                  <Text style={[styles.stepNumText, { color: accent }]}>{i + 1}</Text>
                </RNView>
                <Text style={styles.stepText}>{s}</Text>
              </RNView>
            ))}
          </Card>
        ) : (
          // 8 of 466 don't split into a sequence. A one-item numbered list
          // reads as a bug, so those keep their paragraph.
          !!t.description && (
            <Card title="How it works" accent={accent}>
              <Text style={styles.prose}>{t.description}</Text>
            </Card>
          )
        )}

        {!!t.when_to_use && (
          <Card title="When to use it" accent={accent}>
            <Text style={styles.prose}>{t.when_to_use}</Text>
          </Card>
        )}

        {ruleset && <Legality ruleset={ruleset} />}

        {/* The graph. Grouped rather than scattered, because "what leads here
            and what follows" is one question, not three. */}
        <Edges label="Set up from" items={t.setup_from} />
        <Edges label="Common next moves" items={t.common_next_moves} />
        <Edges label="Common counters" items={t.common_counters} />

        {/* Deliberately last and deliberately quiet. An observation about where
            this is usually taught, NOT a rule and NOT a prerequisite — the rule
            is the legality panel above. Two belt-shaped facts on one screen
            need a clear hierarchy or they get confused for each other. */}
        {!!t.typical_belt && (
          <Text style={styles.footnote}>Commonly taught from {t.typical_belt} belt onwards.</Text>
        )}
        {!!t.source_notes && <Text style={styles.footnote}>{t.source_notes}</Text>}
      </View>
    </ScrollView>
  );
}

/**
 * The hero — and the media slot.
 *
 * Techniques have no image field yet. Rather than leave a grey rectangle that
 * reads as a failed download on all 466, the band carries the category mark:
 * the tile, plus an oversized tinted watermark, as a deliberate graphic. When
 * real imagery arrives, pass `heroImage` and it takes over the same space with
 * no layout change — which is the point of building the slot now.
 */
function Hero({
  technique,
  code,
  accent,
  heroImage,
}: {
  technique: Technique;
  code: string;
  accent: string;
  /** Not populated yet — the slot exists so imagery is a drop-in. */
  heroImage?: string | null;
}) {
  return (
    <RNView style={styles.hero}>
      {heroImage ? (
        <Image
          source={{ uri: heroImage }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={200}
          alt=""
          accessible={false}
        />
      ) : (
        <RNView
          style={[StyleSheet.absoluteFill, { backgroundColor: `${accent}14` }]}
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {/* Oversized and very low contrast. Reads as texture, never as a
              label competing with the title beside it. */}
          <Text style={[styles.watermark, { color: `${accent}1F` }]} numberOfLines={1}>
            {code}
          </Text>
        </RNView>
      )}

      {/* A scrim, not decoration. Today it keeps the title clear of the
          watermark; the moment `heroImage` is real it is what stops white text
          landing on a white gi. Solid rather than a gradient because
          expo-linear-gradient isn't a dependency and one overlay doesn't
          justify adding a native module. */}
      <RNView style={styles.heroScrim} pointerEvents="none" />

      <RNView style={styles.heroContent}>
        <Text style={[styles.eyebrow, { color: accent }]}>{technique.category.toUpperCase()}</Text>
        <Text style={styles.title}>{technique.name}</Text>
        {technique.aliases.length > 0 && (
          <Text style={styles.aliases} numberOfLines={2}>
            Also called {technique.aliases.join(' · ')}
          </Text>
        )}
      </RNView>
    </RNView>
  );
}

function Card({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <RNView style={styles.card}>
      <RNView style={styles.cardHead}>
        <RNView style={[styles.cardRule, { backgroundColor: accent }]} />
        <Text style={styles.cardTitle}>{title.toUpperCase()}</Text>
      </RNView>
      {children}
    </RNView>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <RNView style={styles.chip}>
      <Text style={styles.chipText}>{label}</Text>
    </RNView>
  );
}

/**
 * IBJJF competition legality.
 *
 * `is_restricted` comes from the API and is NOT re-derived here. Adult no-gi
 * has no white belt division, so a no-gi list of "Blue, Purple, Brown, Black"
 * is the baseline rather than a restriction — inferring from belt counts marks
 * ~130 ordinary techniques as restricted when the real number is 20.
 */
function Legality({ ruleset }: { ruleset: Ruleset }) {
  const warn = ruleset.is_restricted;
  return (
    <RNView style={[styles.card, warn && styles.cardWarn]}>
      <RNView style={styles.cardHead}>
        <RNView style={[styles.cardRule, { backgroundColor: warn ? vola.warn : vola.textDim }]} />
        <Text style={[styles.cardTitle, warn && { color: vola.warn }]}>
          {warn ? 'RESTRICTED IN IBJJF COMPETITION' : 'IBJJF COMPETITION'}
        </Text>
      </RNView>

      <Text style={styles.ruleClass}>{ruleset.rule_class}</Text>

      <RNView style={styles.divisionRow}>
        <Division label="Gi" belts={ruleset.gi_allowed_belts} note={ruleset.gi_note} />
        <Division label="No-Gi" belts={ruleset.no_gi_allowed_belts} note={ruleset.no_gi_note} />
      </RNView>

      {!!ruleset.notes && <Text style={styles.ruleNotes}>{ruleset.notes}</Text>}
    </RNView>
  );
}

/**
 * An empty belt list means "this division does not apply" — a gi-only technique
 * has no no-gi belts — and must never render as "allowed at no belt", which
 * would read as prohibited. The note carries the real reason.
 */
function Division({ label, belts, note }: { label: string; belts: string[]; note: string }) {
  return (
    <RNView style={styles.division}>
      <Text style={styles.divisionLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.divisionValue}>
        {belts.length > 0 ? belts.join(', ') : note || 'Not specified'}
      </Text>
    </RNView>
  );
}

/**
 * The graph, as reference text.
 *
 * These were tappable links until the coverage was looked at honestly: only
 * ~80% of `setup_from` entries name a real library entry, and for
 * `common_next_moves` it is ~29%, for `common_counters` ~6%. The rest is prose
 * — "establish grips or inside ties". So most rows were plain text sitting
 * beside a few links, which reads as a feature that half-works rather than a
 * graph.
 *
 * The information is worth keeping: knowing an armbar chains to a triangle is
 * useful whether or not the app can navigate there. The navigation is not. If
 * coverage ever reaches the point where nearly every entry resolves, this is
 * the place to reconsider.
 */
function Edges({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <RNView style={styles.edgeBlock}>
      <Text style={styles.edgeLabel}>{label.toUpperCase()}</Text>
      <RNView style={styles.edgeWrap}>
        {items.map((raw) => (
          <RNView key={raw} style={styles.edgeFlat}>
            <Text style={styles.edgeFlatText}>{raw}</Text>
          </RNView>
        ))}
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 48 },
  body: { padding: 20, gap: 16 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  error: { color: vola.danger, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retry: { color: vola.lime, fontSize: 14, fontWeight: '600' },

  hero: {
    minHeight: 168,
    justifyContent: 'flex-end',
    backgroundColor: vola.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
    overflow: 'hidden',
  },
  // Bled well off the right edge and sitting high, so it reads as texture in
  // the corner rather than a word running through the title. At -30 it did
  // exactly that: "SUB" crossed straight through "Armbar from Closed".
  watermark: {
    position: 'absolute',
    right: -46,
    top: -30,
    fontSize: 132,
    fontWeight: '900',
    letterSpacing: -4,
  },
  heroScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: '32%',
    backgroundColor: 'rgba(8,11,18,0.55)',
  },
  heroContent: { padding: 20, paddingTop: 28, gap: 4 },
  eyebrow: { fontSize: 11, letterSpacing: 1.4, fontWeight: '800' },
  title: { fontSize: 25, fontWeight: '700', lineHeight: 30 },
  aliases: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { color: vola.textMuted, fontSize: 12, fontWeight: '600' },

  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  cardWarn: { borderColor: `${vola.warn}66` },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  cardRule: { width: 3, height: 13, borderRadius: 2 },
  cardTitle: { color: vola.textDim, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },

  // Generous line height on purpose: this is read standing up, often between
  // rounds, and cramped leading is the first thing to fail in that state.
  prose: { fontSize: 15, lineHeight: 23, color: vola.text },

  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNumText: { fontSize: 12, fontWeight: '800' },
  stepText: { flex: 1, fontSize: 15, lineHeight: 22, color: vola.text },

  ruleClass: { fontSize: 15, fontWeight: '600' },
  divisionRow: { flexDirection: 'row', gap: 14 },
  division: {
    flex: 1,
    gap: 3,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 10,
    padding: 11,
  },
  divisionLabel: { color: vola.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  divisionValue: { color: vola.text, fontSize: 13, lineHeight: 18 },
  ruleNotes: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },

  edgeBlock: { gap: 9 },
  edgeLabel: { color: vola.textDim, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },
  edgeWrap: { gap: 7 },
  // Full-width rows rather than wrapped pills: technique names are long and
  // pills truncated them.
  edgeFlat: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  edgeFlatText: { color: vola.textMuted, fontSize: 14, lineHeight: 19 },

  footnote: { color: vola.textDim, fontSize: 12, lineHeight: 18 },
});
