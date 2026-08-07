import { Image } from 'expo-image';
import { Link, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { categoryBadge } from '@/components/LibraryTile';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  executionSteps,
  fetchRulesets,
  fetchTechnique,
  fetchTechniques,
  type Ruleset,
  type Technique,
  type TechniqueSummary,
} from '@/lib/techniques';
import { buildEdgeIndex, buildTechniqueGraph, follows, resolveEdge } from '@/lib/techniqueGraph';
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
 *    which works for 535 of 542 (the rest fall back to prose). This is the
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
  // `accent` is taken in this file for the technique badge's own colour.
  const ui = useAccent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();

  const [technique, setTechnique] = useState<Technique | null>(null);
  /**
   * What FOLLOWS this technique.
   *
   * `setup_from` has always pointed the other way — "what is this set up
   * from" — which is not a question anyone asks. Inverting it over the cached
   * summary list turns the library into something you can walk forwards:
   * from here, these are the next moves people actually make.
   *
   * The list is already fetched and cached for the Library, so this costs no
   * request and works offline.
   */
  const [leadsTo, setLeadsTo] = useState<TechniqueSummary[]>([]);
  // Built from the same fetch as `leadsTo`, so linking the edge rows costs no
  // extra request and — like the rest of this screen — works offline once the
  // Library has been opened.
  const [edgeIndex, setEdgeIndex] = useState<Map<string, TechniqueSummary> | null>(null);
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
      // Cleared too. Expo Router reuses this route rather than pushing a new
      // one, so without this a technique with no ruleset would inherit the
      // previous one's legality table. Safe only by a data invariant today
      // (every seeded row has one) — and a code path held up by a data
      // invariant is a bug waiting for the content to change.
      setRuleset(null);
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

  // Best-effort and non-blocking: the screen's own content never waits on it,
  // and offline it simply shows no "Leads to" rather than an error.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchTechniques(getToken)
      .then((list) => {
        if (cancelled) return;
        setLeadsTo(follows(buildTechniqueGraph(list), id));
        setEdgeIndex(buildEdgeIndex(list));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, getToken]);

  // By RESOLVED ID, not a lowercase name compare. The old string match and
  // `resolveEdge` normalise differently — the latter folds dashes and follows
  // aliases — so a next-move written as an alias of something already in
  // "Leads to" would render twice under the same visible name. Zero
  // occurrences in the shipped catalog today; this closes the trap rather
  // than a live bug.
  const shownIDs = new Set(leadsTo.map((n) => n.id));
  const remainingNextMoves = (technique?.common_next_moves ?? []).filter((m) => {
    const hit = edgeIndex ? resolveEdge(edgeIndex, m, technique?.id) : null;
    return hit ? !shownIDs.has(hit.id) : true;
  });

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={ui.accent} />
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
          <Text style={[styles.retry, { color: ui.ink }]}>Try again</Text>
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
          // 7 of 542 don't split into a sequence. A one-item numbered list
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
        {/* Derived, and tappable — unlike the three prose lists below it.
            Those are authored strings; this is the inverse of the same
            `setup_from` edge, resolved to real entries, so each row can be
            walked. That difference is the whole reason the section exists:
            "what follows from here" is the question the library could not
            answer despite having stored the data all along. */}
        {leadsTo.length > 0 && (
          <RNView style={styles.leadsTo}>
            <Text style={styles.leadsToLabel} accessibilityRole="header">
              Leads to
            </Text>
            {leadsTo.map((n) => (
              <Link key={n.id} href={{ pathname: '/technique/[id]', params: { id: n.id } }} asChild>
                <Pressable
                  style={styles.leadRow}
                  // "button", matching every other navigate-to-a-technique
                  // control in the app. On iOS "link" announces as leaving
                  // for a URL, which this does not do.
                  accessibilityRole="button"
                  accessibilityLabel={`${n.name}. ${n.category}`}
                  testID={`leads-to-${n.id}`}
                >
                  <Text style={styles.leadName}>{n.name}</Text>
                  <Text style={styles.leadMeta}>{n.category}</Text>
                </Pressable>
              </Link>
            ))}
          </RNView>
        )}

        <Edges label="Set up from" items={t.setup_from} index={edgeIndex} selfID={t.id} />
        {/* Minus whatever "Leads to" already showed. 72% of these strings
            are verbatim repeats of a row rendered just above — same name,
            tappable there and inert here, with nothing explaining the
            difference. That overlap is good news about the edge data and bad
            news on screen. What remains is the genuinely prose-only advice
            ("Stabilize top position"), which is worth its own heading. */}
        {/* NO `index`, and this differs from web ON PURPOSE — measured, not
            assumed. This list is what REMAINS after "Leads to" above has
            already shown every next-move that resolves to a real technique, so
            the rows most likely to link have been promoted out of it. As
            rendered on this screen that leaves 252 of 1507 linked (17%), and
            295 of the 505 screens with this section show ZERO links in it.
            A section that occasionally has a link and usually does not is the
            half-works feel the counters are excluded for. Web renders the same
            field unfiltered at 31% and has no "Leads to", so there it earns
            the links; here it does not. */}
        <Edges label="Common next moves" items={remainingNextMoves} />
        {/* NO `index` here, deliberately. Only 8% of counters name a library
            entry — the rest are reactions and grips ("Sprawl", "Crossface",
            "Hand fight") that are not techniques and should not become them.
            One tappable row in ten is the half-works feel this screen removed
            links for in the first place. */}
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
 * reads as a failed download on all 542, the band carries the category mark:
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
 * 441 ordinary techniques as restricted when the real number is 27.
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
 * The graph, navigable where it resolves and prose where it does not.
 *
 * THESE WERE LINKS, THEN TEXT, AND ARE NOW BOTH. The history matters because
 * the middle step was right for its reason and that reason has not gone away:
 * coverage is uneven — measured over the 542-entry catalog, `setup_from`
 * resolves 84%, `common_next_moves` 31%, `common_counters` 10% — so linking
 * everything produced "most rows plain text sitting beside a few links, which
 * reads as a feature that half-works".
 *
 * The old comment said to reconsider "if coverage ever reaches the point where
 * nearly every entry resolves". **It has not**, and this is not that. The
 * change is to the AFFORDANCE rather than the data: a resolved row is visibly
 * a link — chevron, accent text, a real button role — and an unresolved one
 * carries no affordance at all. The original failure was that the two looked
 * identical, so a reader had to guess and learned not to try. Made distinct,
 * the mixture is honest: some of this names a technique and some of it is
 * advice, which is what the field actually holds.
 *
 * `index` is optional and its absence is meaningful, not a default: passing
 * none renders the whole block as plain text. `common_counters` is called that
 * way on purpose.
 */
function Edges({
  label,
  items,
  index,
  selfID,
}: {
  label: string;
  items: string[];
  index?: Map<string, TechniqueSummary> | null;
  selfID?: string;
}) {
  if (items.length === 0) return null;
  return (
    <RNView style={styles.edgeBlock}>
      <Text style={styles.edgeLabel}>{label.toUpperCase()}</Text>
      <RNView style={styles.edgeWrap}>
        {items.map((raw) => {
          const hit = index ? resolveEdge(index, raw, selfID) : null;
          if (!hit) {
            return (
              <RNView key={raw} style={styles.edgeFlat}>
                <Text style={styles.edgeFlatText}>{raw}</Text>
              </RNView>
            );
          }
          return (
            // `accessibilityLabel` uses `hit.name`, matching the visible text.
            // With `raw` VoiceOver announced a different destination than the
            // screen showed on the 22 rows where a reference is an alias — the
            // accessible name has to contain the visible label.
            <Link key={raw} href={`/technique/${hit.id}`} asChild>
              <Pressable
                style={styles.edgeLink}
                accessibilityRole="link"
                accessibilityLabel={`${hit.name}, open technique`}
                testID={`technique-edge-${hit.id}`}
              >
                {/* The library's OWN name, not the raw reference string. They
                    differ whenever the reference used an alias or the other
                    dash, and showing where you are actually going beats
                    echoing what was typed. */}
                <Text style={styles.edgeLinkText}>{hit.name}</Text>
                <Text style={styles.edgeChevron}>›</Text>
              </Pressable>
            </Link>
          );
        })}
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  edgeLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    // minHeight 44 because `leadRow` in this same file enforces it and a
    // tappable row that misses the target is worse than an untappable one.
    // The padding and type size are >= edgeFlat's deliberately: the first
    // version made links SMALLER than the inert rows beside them, which
    // inverts the whole affordance argument — the tappable thing has to look
    // heavier than the prose, not lighter.
    minHeight: 44,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    backgroundColor: vola.surfaceHover,
  },
  edgeLinkText: { color: vola.text, fontSize: 14, fontWeight: '600' },
  edgeChevron: { color: vola.textMuted, fontSize: 15 },

  scroll: { paddingBottom: 48 },
  body: { padding: 20, gap: 16 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  error: { color: vola.danger, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retry: { fontSize: 14, fontWeight: '600' },

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
  leadsTo: { marginTop: 24, gap: 2 },
  // NOT edgeLabel: that is vola.textDim, which measures 3.95:1 on bg — under
  // AA, and 11px/800 does not qualify as large text. The position screen
  // already found and annotated this exact token. textMuted is 7.37:1.
  leadsToLabel: {
    color: vola.textMuted,
    fontSize: 11,
    letterSpacing: 1.2,
    fontWeight: '800',
  },
  leadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
  },
  leadName: { flex: 1, fontSize: 15, color: vola.text, paddingRight: 12 },
  leadMeta: { fontSize: 12, color: vola.textMuted },
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
