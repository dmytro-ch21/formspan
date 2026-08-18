import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { fetchRoundMap, type RoundMap, type RoundMapNode } from '@/lib/positions';
import { ladderRows } from '@/lib/roundMapLadder';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * How a round goes — the map, as a ladder.
 *
 * **Not the position map.** `/bjj/positions` is the athlete's own heatmap:
 * where THEY score and get stuck, computed from their logs. This is the sport
 * itself, identical for everybody, and read once. Two screens, one word, so the
 * titles do the separating: "Your positions" against "How a round goes".
 *
 * **Why a ladder and not the web diagram.** Web draws the same content as a
 * node graph with 28 labelled arrows, which is right on a screen you read
 * sitting down. On a phone that is a pinch-to-zoom picture nobody reads. But
 * the *hierarchy* is the half a beginner most needs — "the back is above mount
 * is above side control, and the whole sport is trading upward" — and a
 * hierarchy is a vertical list. `tier` carries it, so this screen needs none of
 * the edges to teach the thing the diagram exists for.
 *
 * The edges are still here, as words, under each position: "From here: Pass →
 * Side control". That is the adjacency list, which reads fine in a column and
 * would be unreadable as arrows at this width.
 *
 * Per the platform rule this is reference, not analysis — no picker, no ranges,
 * no numbers off an axis. It is the same content on both platforms, drawn the
 * way each screen can carry it.
 */
export default function RoundMapScreen() {
  const getToken = useAuthToken();
  const router = useRouter();
  const [map, setMap] = useState<RoundMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  // On mount, not on focus: this is content that cannot change while the app
  // runs, and it is served from a lifetime cache after the first read.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const m = await fetchRoundMap(getToken, ac.signal);
        if (!ac.signal.aborted) setMap(m);
      } catch (e) {
        if (!ac.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Could not load the map.');
        }
      } finally {
        if (!ac.signal.aborted) setLoaded(true);
      }
    })();
    return () => ac.abort();
  }, [getToken]);

  /**
   * Rows in ladder order, each tagged with the band it opens — best first.
   *
   * Grouped by BAND rather than by tier: a phone column with eight headings
   * over sixteen rows is mostly headings. Three bands is the reading key the
   * content already ships, and the tier ordering survives inside each one.
   */
  const rows = useMemo(() => (map === null ? [] : ladderRows(map)), [map]);

  const toggle = useCallback((id: string) => {
    setOpen((cur) => (cur === id ? null : id));
  }, []);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'How a round goes' }} />
      <ScrollView contentContainerStyle={styles.content}>
        {!loaded && <ActivityIndicator style={styles.loading} color={vola.textMuted} />}

        {loaded && error !== null && <Text style={styles.error}>{error}</Text>}

        {/* Null is an API older than this build, not a failure — see
            `fetchRoundMap`. Said plainly rather than drawn as an error. */}
        {loaded && error === null && map === null && (
          <Text style={styles.empty}>This version of the app cannot show the map yet.</Text>
        )}

        {map !== null && (
          <>
            <Text style={styles.intro}>{map.intro}</Text>

            {rows.map(({ node, band }) => (
              <RNView key={node.id}>
                {band !== null && (
                  <RNView style={styles.bandHeader}>
                    <Text style={styles.bandLabel} accessibilityRole="header">
                      {band.label}
                    </Text>
                    <Text style={styles.bandNote}>{band.note}</Text>
                  </RNView>
                )}
                <Row
                  node={node}
                  map={map}
                  expanded={open === node.id}
                  onToggle={toggle}
                  onOpenLibrary={() =>
                    router.push({
                      pathname: '/(tabs)/library',
                      params: { sport: 'bjj', position: node.position_id },
                    })
                  }
                />
              </RNView>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Row({
  node,
  map,
  expanded,
  onToggle,
  onOpenLibrary,
}: {
  node: RoundMapNode;
  map: RoundMap;
  expanded: boolean;
  onToggle: (id: string) => void;
  onOpenLibrary: () => void;
}) {
  const from = map.edges.filter((e) => e.from === node.id);
  const into = map.edges.filter((e) => e.to === node.id);
  const label = (id: string) => map.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <RNView style={styles.card}>
      <Pressable
        onPress={() => onToggle(node.id)}
        accessibilityRole="button"
        // The state has to be spoken: collapsed and expanded look obviously
        // different and sound identical.
        accessibilityState={{ expanded }}
        accessibilityLabel={`${node.label}. ${expanded ? 'Collapse' : 'Expand'}`}
        testID={`roundmap-row-${node.id}`}
        style={({ pressed }) => [styles.rowHead, pressed && styles.pressed]}
      >
        <Text style={styles.rowLabel}>{node.label}</Text>
        <Text style={styles.chevron} aria-hidden>
          {expanded ? '−' : '+'}
        </Text>
      </Pressable>

      {expanded && (
        <RNView style={styles.body}>
          <Text style={styles.note}>{node.note}</Text>

          {from.length > 0 && (
            <RNView style={styles.edges}>
              <Text style={styles.edgeHeading}>From here</Text>
              {from.map((e, i) => (
                <Text key={`${e.to}-${i}`} style={styles.edge}>
                  {e.label} → {label(e.to)}
                </Text>
              ))}
            </RNView>
          )}

          {into.length > 0 && (
            <RNView style={styles.edges}>
              <Text style={styles.edgeHeading}>You arrive here by</Text>
              {into.map((e, i) => (
                <Text key={`${e.from}-${i}`} style={styles.edge}>
                  {e.label}, from {label(e.from)}
                </Text>
              ))}
            </RNView>
          )}

          <Pressable
            onPress={onOpenLibrary}
            accessibilityRole="button"
            accessibilityLabel={`Techniques from ${node.label}`}
            testID={`roundmap-library-${node.id}`}
            style={({ pressed }) => [styles.libraryLink, pressed && styles.pressed]}
          >
            <Text style={styles.libraryLinkText}>Techniques from {node.label.toLowerCase()}</Text>
          </Pressable>
        </RNView>
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { gap: 8, padding: 16, paddingBottom: 48 },
  loading: { marginTop: 32 },
  error: { color: vola.danger, fontSize: 14, lineHeight: 20 },
  empty: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  intro: { color: vola.textMuted, fontSize: 14, lineHeight: 21, marginBottom: 8 },
  bandHeader: { gap: 4, marginBottom: 8, marginTop: 20 },
  bandLabel: {
    color: vola.text,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  bandNote: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
  card: {
    borderColor: vola.line,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 8,
    overflow: 'hidden',
  },
  rowHead: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  pressed: { opacity: 0.6 },
  rowLabel: { color: vola.text, fontSize: 15, fontWeight: '700' },
  chevron: { color: vola.textMuted, fontSize: 18 },
  body: { gap: 12, paddingBottom: 14, paddingHorizontal: 14 },
  note: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  edges: { gap: 3 },
  edgeHeading: {
    color: vola.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  edge: { color: vola.text, fontSize: 14 },
  libraryLink: {
    alignItems: 'center',
    borderColor: vola.line,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
  },
  libraryLinkText: { color: vola.text, fontSize: 14, fontWeight: '600' },
});
