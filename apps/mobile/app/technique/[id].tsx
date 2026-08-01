import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAuthToken } from '@/lib/useAuthToken';
import {
  fetchRulesets,
  fetchTechnique,
  fetchTechniques,
  indexByName,
  type Ruleset,
  type Technique,
  type TechniqueSummary,
} from '@/lib/techniques';

/**
 * One technique, with everything the library knows about it.
 *
 * Two rules govern what this screen renders, both of them about not lying:
 *
 * 1. **A section that has no content does not appear.** `video_reference` is
 *    empty for every technique in the current library, so an always-present
 *    "Video" heading would imply a missing asset on all 466. Same for any edge
 *    array that came back empty.
 * 2. **An edge is only tappable if it resolves to a technique.** ~80% of
 *    `setup_from` entries name a real one; `common_next_moves` is ~29% and
 *    `common_counters` ~6% — the rest is prose like "establish grips or inside
 *    ties". Styling those as links would produce dead taps, so unresolved
 *    labels render as plain text and look like plain text.
 */
export default function TechniqueScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();
  const router = useRouter();

  const [technique, setTechnique] = useState<Technique | null>(null);
  const [byName, setByName] = useState<Map<string, TechniqueSummary>>(new Map());
  const [ruleset, setRuleset] = useState<Ruleset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!id) return;
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
        // The index is only for deciding which edge labels are tappable. It
        // failing must not stop the technique rendering, so it is caught
        // separately and simply leaves every edge as plain text.
        try {
          setByName(indexByName(await fetchTechniques(getToken, signal)));
        } catch {
          /* edges stay plain text */
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
      </View>
    );
  }

  const t = technique;

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="technique-detail">
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>{t.category.toUpperCase()}</Text>
        <Text style={styles.title}>{t.name}</Text>
        {t.aliases.length > 0 && (
          <Text style={styles.aliases}>Also called {t.aliases.join(' · ')}</Text>
        )}
      </View>

      <View style={styles.chipRow}>
        <Chip label={t.position} />
        {!!t.position_detail && <Chip label={t.position_detail} />}
        <Chip label={t.gi_no_gi} />
      </View>

      {/* The mechanics and the decision are separate sections because they
          answer separate questions. Merged, neither reads well. */}
      {!!t.description && <Section title="How it works" body={t.description} />}
      {!!t.when_to_use && <Section title="When to use it" body={t.when_to_use} />}

      {ruleset && <Legality ruleset={ruleset} />}

      <Edges label="Set up from" items={t.setup_from} byName={byName} router={router} />
      <Edges
        label="Common next moves"
        items={t.common_next_moves}
        byName={byName}
        router={router}
      />
      <Edges label="Common counters" items={t.common_counters} byName={byName} router={router} />

      {/* Deliberately last and deliberately quiet. It is an observation about
          where this is usually taught, NOT a rule and NOT a prerequisite — the
          rule is the legality panel above. Two belt-shaped facts on one screen
          need a clear hierarchy or they get confused for each other. */}
      {!!t.typical_belt && (
        <Text style={styles.footnote}>Commonly taught from {t.typical_belt} belt onwards.</Text>
      )}
      {!!t.source_notes && <Text style={styles.footnote}>{t.source_notes}</Text>}
    </ScrollView>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
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
  return (
    <View style={[styles.section, styles.legality, ruleset.is_restricted && styles.legalityWarn]}>
      <Text style={[styles.sectionTitle, ruleset.is_restricted && styles.legalityWarnTitle]}>
        {ruleset.is_restricted ? 'Restricted in IBJJF competition' : 'IBJJF competition'}
      </Text>
      <Text style={styles.ruleClass}>{ruleset.rule_class}</Text>

      <View style={styles.divisionRow}>
        <Division label="Gi" belts={ruleset.gi_allowed_belts} note={ruleset.gi_note} />
        <Division label="No-Gi" belts={ruleset.no_gi_allowed_belts} note={ruleset.no_gi_note} />
      </View>

      {!!ruleset.notes && <Text style={styles.ruleNotes}>{ruleset.notes}</Text>}
    </View>
  );
}

/**
 * An empty belt list means "this division does not apply" — a gi-only
 * technique has no no-gi belts — and must never render as "allowed at no
 * belt", which would read as prohibited. The note carries the real reason.
 */
function Division({ label, belts, note }: { label: string; belts: string[]; note: string }) {
  return (
    <View style={styles.division}>
      <Text style={styles.divisionLabel}>{label}</Text>
      <Text style={styles.divisionValue}>
        {belts.length > 0 ? belts.join(', ') : note || 'Not specified'}
      </Text>
    </View>
  );
}

function Edges({
  label,
  items,
  byName,
  router,
}: {
  label: string;
  items: string[];
  byName: Map<string, TechniqueSummary>;
  router: ReturnType<typeof useRouter>;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{label}</Text>
      <View style={styles.edgeWrap}>
        {items.map((raw) => {
          const hit = byName.get(raw.trim().toLowerCase());
          if (!hit) {
            // Most of these name something that isn't a library entry. Plain
            // text, and it must LOOK like plain text.
            return (
              <Text key={raw} style={styles.edgeText}>
                {raw}
              </Text>
            );
          }
          return (
            <Pressable
              key={raw}
              onPress={() => router.push(`/technique/${hit.id}`)}
              hitSlop={6}
              accessibilityRole="link"
              accessibilityLabel={`Open ${hit.name}`}
            >
              <Text style={styles.edgeLink}>{raw}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 20, paddingBottom: 48 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: vola.danger, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  hero: { gap: 4 },
  eyebrow: { color: vola.lime, fontSize: 11, letterSpacing: 1.4, fontWeight: '700' },
  title: { fontSize: 26, fontWeight: '700' },
  aliases: { color: vola.textMuted, fontSize: 13, marginTop: 2 },

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

  section: { gap: 8 },
  sectionTitle: { color: vola.textDim, fontSize: 11, letterSpacing: 1.2, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },

  legality: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    padding: 16,
  },
  legalityWarn: { borderColor: vola.warn },
  legalityWarnTitle: { color: vola.warn },
  ruleClass: { fontSize: 15, fontWeight: '600' },
  divisionRow: { flexDirection: 'row', gap: 16, marginTop: 4 },
  division: { flex: 1, gap: 2 },
  divisionLabel: { color: vola.textDim, fontSize: 11, fontWeight: '700' },
  divisionValue: { color: vola.text, fontSize: 13 },
  ruleNotes: { color: vola.textMuted, fontSize: 13, lineHeight: 19, marginTop: 6 },

  edgeWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  edgeText: { color: vola.textMuted, fontSize: 14 },
  edgeLink: { color: vola.lime, fontSize: 14, fontWeight: '600' },

  footnote: { color: vola.textDim, fontSize: 12, lineHeight: 18 },
});
