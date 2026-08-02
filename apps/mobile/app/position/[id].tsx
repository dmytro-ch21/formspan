import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View as RNView } from 'react-native';

import { categoryBadge, positionBadge } from '@/components/LibraryTile';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { fetchPosition, techniquesInPosition, type Position } from '@/lib/positions';
import { fetchTechniques, type TechniqueSummary } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * One position, explained.
 *
 * The library had 466 techniques and nothing that said what any of them
 * happened *inside* of — "Armbar from Closed Guard" is unreadable to someone
 * who has never been in a closed guard. This is the other half of that: the
 * node, rather than the edge.
 *
 * Built on `technique/[id]`'s visual language on purpose — same hero, same
 * cards, same measurements — because the two are peers in the Library and
 * reading one after the other should not feel like changing app. Four things
 * differ, each for a reason:
 *
 * 1. **No step list.** A technique is a sequence and splits into numbered
 *    steps; a position is a *state*, and numbering "keep your elbows in" as
 *    step 3 of 5 would invent an order that isn't there.
 * 2. **No legality card.** Positions aren't IBJJF-restricted — techniques are.
 * 3. **The cross-linked techniques ARE tappable**, unlike that screen's edge
 *    lists. There the names are prose that mostly doesn't resolve to a real
 *    entry; here every row came out of the fetched library, so all of them
 *    navigate. This is the payoff of the whole feature: read what side control
 *    is, then go straight to escaping it.
 * 4. **It is a FlatList, not a ScrollView.** That is not symmetry with the
 *    Library for its own sake — the Guard entries cross-link 187 techniques,
 *    and mounting ~900 native views to draw them stalls the screen a beginner
 *    opens first. `technique/[id]`'s ScrollView is safe only because its edge
 *    lists are 6-29 items. The prose rides along as the list header.
 *
 * The one rule carried over verbatim: a section with no content does not
 * render at all.
 */

/**
 * The same deadline the Library uses, for the same reason: iOS gives a request
 * ~60s before it gives up, and a captive portal accepts the connection and then
 * says nothing — so without this the screen spins for a minute with no error
 * and nothing to retry.
 */
const REQUEST_TIMEOUT_MS = 10_000;

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
      // Both, and in this order. Without setLoading(true) a retry renders the
      // fallback branch for the whole request, because error is cleared while
      // position is still null.
      setLoading(true);
      setError(null);

      // Independent requests, so they run together — a cold-start deep link
      // otherwise pays two serialized round trips. allSettled rather than all
      // because their failures mean different things, handled separately below.
      const [p, list] = await Promise.allSettled([
        fetchPosition(id, getToken, signal),
        fetchTechniques(getToken, signal),
      ]);

      if (signal?.aborted) return;

      if (p.status === 'rejected') {
        if ((p.reason as Error)?.name === 'AbortError') return;
        // A missing position and an unreachable server are different problems
        // and only one of them is worth retrying. Telling someone to check
        // their connection because they followed a dead link is a wrong answer
        // delivered confidently.
        setError(
          /\(404\)/.test(String((p.reason as Error)?.message))
            ? 'That position is not in the library.'
            : 'Could not load this position. Check your connection and try again.',
        );
        setLoading(false);
        return;
      }
      setPosition(p.value);

      // Deliberately not fatal, and deliberately silent. The glossary entry is
      // what the athlete opened this screen for; failing the whole screen
      // because the library did not load would hide the prose that did arrive.
      // The cost is that a failed library is indistinguishable from a position
      // with no techniques — accepted, because the alternative is an error
      // about content nobody asked for.
      setTechniques(list.status === 'fulfilled' ? list.value : []);
      setLoading(false);
    },
    [id, getToken],
  );

  useEffect(() => {
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    void load(ac.signal).finally(() => clearTimeout(deadline));
    return () => {
      clearTimeout(deadline);
      ac.abort();
    };
  }, [load]);

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={vola.lime} />
      </View>
    );
  }

  // An honest failure, not an empty position. This screen must never render
  // blank fields that read as "this position has no description".
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
  const [code, accent] = positionBadge(p.id);
  const related = techniquesInPosition(techniques, p.family);

  return (
    <FlatList
      testID="position-detail"
      data={related}
      keyExtractor={(t) => t.id}
      contentContainerStyle={styles.list}
      // The 187-row case is why this is virtualised at all.
      initialNumToRender={10}
      windowSize={7}
      removeClippedSubviews
      ListHeaderComponent={
        <>
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
            {related.length > 0 && (
              <Text style={styles.edgeLabel} accessibilityRole="header">
                {sectionLabel(p, related.length)}
              </Text>
            )}
          </View>
        </>
      }
      renderItem={({ item }) => <TechniqueRow technique={item} />}
    />
  );
}

/**
 * Name the family when it isn't the position's own name.
 *
 * This is the honest version of a compromise the data forces. `Position.family`
 * is coarse — `techniques.position` only records "Guard - Bottom", never
 * closed vs open — so Closed Guard and Open Guard cross-link to the *same* 187
 * techniques, and Knee on Belly borrows Side Control's.
 *
 * Left unlabelled, the Open Guard screen listed 36 techniques whose names begin
 * "Closed-Guard …" directly beneath its own sentence saying the ankles are NOT
 * locked. That is worse than an empty list: an empty one looks broken, this one
 * looks authoritative and wrong, to precisely the reader with no way to tell.
 * Saying "from the guard family" costs one word and stops the screen claiming
 * something it cannot know.
 */
function sectionLabel(p: Position, count: number): string {
  const scope = p.family.toLowerCase() === p.name.toLowerCase() ? 'HERE' : `THE ${p.family} FAMILY`;
  return `TECHNIQUES FROM ${scope} · ${count}`.toUpperCase();
}

/**
 * Priorities, split by player.
 *
 * The field is authored as one or two paragraphs, and where there are two they
 * are labelled ("Bottom: …" / "Top: …") because every position is someone's
 * good news and someone else's problem. Pulling that label out as a heading is
 * what lets a reader find their own half at a glance instead of reading both.
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
        // Only a short leading word or two counts as a label. Without the
        // length bound any sentence containing a colon loses its first clause
        // to a heading — Standing's opening sentence has one at offset 56.
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
            <Text style={styles.sideLabel} accessibilityRole="header">
              {match[1].toUpperCase()}
            </Text>
            <Text style={styles.prose}>{match[2]}</Text>
          </RNView>
        );
      })}
    </>
  );
}

/**
 * One cross-linked technique — the reason a glossary entry beats a dictionary
 * definition. Resolved locally from the library the app already holds, so the
 * whole list costs no request and works offline.
 */
function TechniqueRow({ technique }: { technique: TechniqueSummary }) {
  const [code, accent] = categoryBadge(technique.category);
  return (
    <Pressable
      style={({ pressed }) => [styles.edgeRow, pressed && styles.edgeRowPressed]}
      onPress={() => router.push(`/technique/${technique.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${technique.name}, ${technique.category}`}
      testID={`position-technique-${technique.id}`}
    >
      <RNView style={[styles.edgeCode, { borderColor: `${accent}44` }]}>
        <Text style={[styles.edgeCodeText, { color: accent }]}>{code}</Text>
      </RNView>
      <Text style={styles.edgeRowText} numberOfLines={2}>
        {technique.name}
      </Text>
    </Pressable>
  );
}

/**
 * Same band as the technique hero, same media slot for when position artwork
 * lands — a diagram helps here more than it does for a technique, so this is
 * the likelier of the two to get filled.
 */
function Hero({ position, code, accent }: { position: Position; code: string; accent: string }) {
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
        <Text style={styles.cardTitle} accessibilityRole="header">
          {title.toUpperCase()}
        </Text>
      </RNView>
      {children}
    </RNView>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 48, paddingHorizontal: 20 },
  // The header holds the hero, which is full-bleed, so it cancels the list's
  // own horizontal padding rather than inheriting it.
  body: { paddingVertical: 16, gap: 16 },
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
    marginHorizontal: -20,
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

  // Generous line height on purpose: this is read standing up, often between
  // rounds, and cramped leading is the first thing to fail in that state.
  prose: { fontSize: 15, lineHeight: 23, color: vola.text },

  sideBlock: { gap: 5 },
  sideLabel: { color: vola.lime, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },

  edgeLabel: { color: vola.textDim, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },
  edgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 10,
    paddingHorizontal: 13,
    // 13, not 11: these rows are tappable where the technique screen's
    // equivalents are inert, which brings the 44pt minimum target into scope.
    // At 11 the row measured ~41pt.
    paddingVertical: 13,
    marginBottom: 7,
  },
  edgeRowPressed: { backgroundColor: vola.surfaceRaised },
  // A 3-letter mark rather than a chevron: it says what KIND of technique the
  // row is (submission, escape, sweep) in the space an affordance arrow would
  // have used, and the whole row being pressable already reads as tappable.
  edgeCode: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  edgeCodeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  edgeRowText: { flex: 1, color: vola.text, fontSize: 14, lineHeight: 19 },
});
