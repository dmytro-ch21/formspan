import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { categoryBadge, positionBadge } from '@/components/LibraryTile';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { fetchPosition, techniquesInPosition, type Position } from '@/lib/positions';
import { fetchTechniques, type TechniqueSummary } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * One position, explained.
 *
 * The library had 466 techniques and nothing that said what any of them happened
 * *inside* of — "Armbar from Closed Guard" is unreadable to someone who has
 * never been in a closed guard. This is the other half of that: the node, rather
 * than the edge.
 *
 * Built on `technique/[id]`'s structure on purpose — same hero, same cards, same
 * measurements — because the two are peers in the Library and reading one after
 * the other should not feel like changing app. Three things differ, each for a
 * reason:
 *
 * 1. **No step list.** A technique is a sequence and splits into numbered steps;
 *    a position is a *state*, and numbering "keep your elbows in" as step 3 of 5
 *    would invent an order that isn't there.
 * 2. **No legality card.** Positions aren't IBJJF-restricted — techniques are.
 * 3. **The cross-linked techniques ARE tappable**, unlike that screen's edge
 *    lists. There the names are prose that mostly doesn't resolve to a real
 *    entry; here every row came out of the fetched library, so all of them
 *    navigate. This is the payoff of the whole feature: read what side control
 *    is, then go straight to escaping it.
 *
 * The one rule carried over verbatim: a section with no content does not render
 * at all.
 */
export default function PositionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();

  const [position, setPosition] = useState<Position | null>(null);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!id) return;
      setLoading(true);
      setError(null);
      try {
        const p = await fetchPosition(id, getToken, signal);
        setPosition(p);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setError('Could not load this position. Check your connection and try again.');
        setLoading(false);
        return;
      }

      // Separately, and deliberately not fatal. The glossary entry is the point
      // of this screen; the technique cross-links are an extra. Failing the
      // whole screen because the library did not load would hide the prose that
      // did — so this failure just renders no "Techniques from here" section,
      // which is the same as a position that has none.
      try {
        setTechniques(await fetchTechniques(getToken, signal));
      } catch {
        setTechniques([]);
      }
      setLoading(false);
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

  if (error || !position) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error} testID="position-error">
          {error ?? 'Position not found.'}
        </Text>
        <Pressable onPress={() => void load()} hitSlop={10} accessibilityRole="button">
          <Text style={styles.retry}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const p = position;
  const [code, accent] = positionBadge(p.family);
  const related = techniquesInPosition(techniques, p.family);

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="position-detail">
      <Hero position={p} code={code} accent={accent} />

      <View style={styles.body}>
        {!!p.description && (
          <Card title="What it is" accent={accent}>
            <Text style={styles.prose}>{p.description}</Text>
          </Card>
        )}

        {!!p.priorities && (
          <Card title="What matters here" accent={accent}>
            <Priorities text={p.priorities} />
          </Card>
        )}

        <RelatedTechniques items={related} />
      </View>
    </ScrollView>
  );
}

/**
 * Priorities, split by player.
 *
 * The field is authored as one or two paragraphs, and where there are two they
 * are labelled ("Bottom: …" / "Top: …") because every position is someone's good
 * news and someone else's problem. Pulling that label out as a heading is what
 * lets a reader find their own half at a glance instead of reading both.
 *
 * The label is detected rather than stored in its own column: the split is not
 * universal (standing has no top or bottom) and a schema that insisted on two
 * sides would force empty or duplicated prose on the entries that have one.
 */
function Priorities({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <>
      {paragraphs.map((para, i) => {
        // Only a short leading word or two counts as a label — without the
        // length bound, any sentence containing a colon loses its first clause
        // to a heading.
        const match = /^([A-Z][A-Za-z\s-]{0,14}):\s+([\s\S]+)$/.exec(para);
        if (!match) {
          return (
            <Text key={i} style={styles.prose}>
              {para}
            </Text>
          );
        }
        return (
          <RNView key={i} style={styles.sideBlock}>
            <Text style={styles.sideLabel}>{match[1].toUpperCase()}</Text>
            <Text style={styles.prose}>{match[2]}</Text>
          </RNView>
        );
      })}
    </>
  );
}

/**
 * The techniques that happen here — the reason a glossary entry beats a
 * dictionary definition.
 *
 * Resolved locally from the library the app already holds, so this list costs no
 * request and works offline. Renders nothing when empty rather than an empty
 * heading, per the screen's rule.
 */
function RelatedTechniques({ items }: { items: TechniqueSummary[] }) {
  if (items.length === 0) return null;
  return (
    <RNView style={styles.edgeBlock}>
      <Text style={styles.edgeLabel}>TECHNIQUES FROM HERE · {items.length}</Text>
      <RNView style={styles.edgeWrap}>
        {items.map((t) => {
          const [tCode, tAccent] = categoryBadge(t.category);
          return (
            <Pressable
              key={t.id}
              style={({ pressed }) => [styles.edgeRow, pressed && styles.edgeRowPressed]}
              onPress={() => router.push(`/technique/${t.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`${t.name}, ${t.category}`}
              testID={`position-technique-${t.id}`}
            >
              <RNView style={[styles.edgeCode, { borderColor: `${tAccent}44` }]}>
                <Text style={[styles.edgeCodeText, { color: tAccent }]}>{tCode}</Text>
              </RNView>
              <Text style={styles.edgeRowText} numberOfLines={2}>
                {t.name}
              </Text>
            </Pressable>
          );
        })}
      </RNView>
    </RNView>
  );
}

/**
 * Same band as the technique hero, same media slot for when position artwork
 * lands — a diagram helps here more than it does for a technique, so this is the
 * likelier of the two to get filled.
 */
function Hero({
  position,
  code,
  accent,
}: {
  position: Position;
  code: string;
  accent: string;
}) {
  return (
    <RNView style={styles.hero}>
      <RNView
        style={[StyleSheet.absoluteFill, { backgroundColor: `${accent}14` }]}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={[styles.watermark, { color: `${accent}1F` }]} numberOfLines={1}>
          {code}
        </Text>
      </RNView>

      <RNView style={styles.heroScrim} pointerEvents="none" />

      <RNView style={styles.heroContent}>
        <Text style={[styles.eyebrow, { color: accent }]}>POSITION</Text>
        <Text style={styles.title}>{position.name}</Text>
        {position.aliases.length > 0 && (
          <Text style={styles.aliases} numberOfLines={2}>
            Also called {position.aliases.join(' · ')}
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

  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  cardRule: { width: 3, height: 13, borderRadius: 2 },
  cardTitle: { color: vola.textDim, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },

  prose: { fontSize: 15, lineHeight: 23, color: vola.text },

  sideBlock: { gap: 5 },
  sideLabel: { color: vola.lime, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },

  edgeBlock: { gap: 9 },
  edgeLabel: { color: vola.textDim, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },
  edgeWrap: { gap: 7 },
  edgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  edgeRowPressed: { backgroundColor: vola.surfaceRaised },
  // A 3-letter mark rather than a chevron: it says what KIND of technique the
  // row is (submission, escape, sweep) in the same space an affordance arrow
  // would have used, and the whole row being pressable already reads as tappable.
  edgeCode: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  edgeCodeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  edgeRowText: { flex: 1, color: vola.text, fontSize: 14, lineHeight: 19 },
});
