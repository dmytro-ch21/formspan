import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { MODULE_TOGGLE_LOCATION } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import {
  fetchPositions,
  headline,
  liveOf,
  rankPositions,
  winShare,
  type PositionMap,
  type PositionStat,
} from '@/lib/positionStats';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The position map: where the athlete scores, and where they get stuck.
 *
 * Its own route rather than a section of `/bjj`, which is the *rank* screen —
 * a belt and a promotion history, read once every few months. This is read
 * after a hard week, and putting the two together would bury each in the other.
 *
 * ## It describes; it does not prescribe
 *
 * There is no "drill this" anywhere on this screen, deliberately. Concessions
 * from a position are equally consistent with a hole in the athlete's game and
 * with them starting every round there on purpose, and nothing in this data
 * separates the two — the backend module says so in as many words. A
 * recommendation would be confidently wrong about a third of the time, and
 * wrong in the direction of telling a guard player to stop playing guard.
 *
 * ## Why a bar and not a percentage
 *
 * A win share is a ratio, and a ratio hides its denominator: 100% off two
 * exchanges and 60% off forty are not the same claim. The bar shows the split
 * and the counts sit beside it, so the denominator is never out of sight —
 * the same reasoning that keeps `Proficiency` from collapsing into a 1–5.
 */
export default function PositionMapScreen() {
  const accent = useAccent();
  const getToken = useAuthToken();
  // Same gate as `/bjj`, and here for the same reason: the route is reachable
  // from a stale back-stack entry made before BJJ was switched off, and
  // functional-scenarios.md promises the route is absent, not just its link.
  const { modules, ready: modulesReady } = useModules();
  const bjjEnabled = modulesReady && modules.some((m) => m.key === 'bjj' && m.enabled);

  const [map, setMap] = useState<PositionMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!bjjEnabled) return;
      const c = new AbortController();
      fetchPositions(getToken, c.signal)
        .then((m) => {
          if (c.signal.aborted) return;
          setMap(m);
          setError(null);
        })
        .catch(() => {
          if (!c.signal.aborted) setError("Couldn't load your position map just now.");
        });
      return () => c.abort();
    }, [getToken, bjjEnabled]),
  );

  const minLive = map?.summary.min_live ?? 0;
  const ranked = useMemo(
    () => rankPositions(map?.positions ?? [], minLive),
    [map?.positions, minLive],
  );

  if (modulesReady && !bjjEnabled) {
    return (
      <View style={styles.centre} testID="positions-disabled">
        <Stack.Screen options={{ title: 'Position map' }} />
        <Text style={styles.emptyTitle}>BJJ tracking is off</Text>
        <Text style={styles.muted}>Turn it back on under {MODULE_TOGGLE_LOCATION} in your profile.</Text>
      </View>
    );
  }

  const nothing =
    map !== null &&
    ranked.strong.length === 0 &&
    ranked.leaking.length === 0 &&
    ranked.thin.length === 0;

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="bjj-positions-screen">
      <Stack.Screen options={{ title: 'Position map' }} />

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}

      {map === null && !error ? (
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading your position map" />
      ) : (
        map !== null && (
          <>
            <Text style={styles.headline}>{headline(ranked, minLive)}</Text>

            {nothing ? (
              <View style={styles.card}>
                <Text style={styles.muted}>
                  When you log a session, tag which position each exchange happened in. A few rounds
                  of that and this fills in.
                </Text>
              </View>
            ) : (
              <>
                <Group
                  label="Going against you"
                  blurb="More exchanges lost than won here."
                  rows={ranked.leaking}
                  tone={vola.textMuted}
                  accentInk={accent.ink}
                  minLive={minLive}
                />
                <Group
                  label="Going your way"
                  blurb="More won than lost."
                  rows={ranked.strong}
                  tone={vola.textMuted}
                  accentInk={accent.ink}
                  minLive={minLive}
                />
                <Group
                  label="Too early to say"
                  blurb={`Under ${minLive} live exchanges — shown, but not judged.`}
                  rows={ranked.thin}
                  tone={vola.textMuted}
                  accentInk={accent.ink}
                  minLive={minLive}
                />
              </>
            )}
          </>
        )
      )}
    </ScrollView>
  );
}

function Group({
  label,
  blurb,
  rows,
  tone,
  accentInk,
  minLive,
}: {
  label: string;
  blurb: string;
  rows: PositionStat[];
  tone: string;
  accentInk: string;
  minLive: number;
}) {
  // An empty group is omitted entirely rather than rendered with a "none" row:
  // three headings on a fresh account, two of them apologising, reads as a
  // broken screen.
  if (rows.length === 0) return null;
  return (
    <>
      <Text style={styles.sectionLabel}>{label}</Text>
      <Text style={styles.sectionBlurb}>{blurb}</Text>
      {rows.map((p) => (
        <Row key={p.position} p={p} tone={tone} accentInk={accentInk} minLive={minLive} />
      ))}
    </>
  );
}

function Row({
  p,
  tone,
  accentInk,
  minLive,
}: {
  p: PositionStat;
  tone: string;
  accentInk: string;
  minLive: number;
}) {
  const live = liveOf(p);
  // **No percentage below the threshold.** `thin` is a refusal, and a bold
  // "100%" off a single exchange is the most verdict-like thing that could sit
  // on the row — it would undo the refusal the section heading just made. The
  // counts stay: they are facts, and they are what the athlete can act on.
  const share = live < minLive ? null : winShare(p);
  const won = p.scored + p.defended;
  const lost = p.conceded + p.attempted;

  return (
    <View
      style={styles.row}
      accessible
      // The four counts spelled out, not just the won/lost totals. Because the
      // container is `accessible` the child Texts collapse into this one string,
      // so anything left out is simply unavailable — and "17 lost" is not the
      // finding. "3 scored, 14 conceded" is, which is the whole reason the API
      // reports the pair rather than a ratio.
      accessibilityLabel={
        `${p.position}: ${p.scored} scored, ${p.conceded} conceded, ` +
        `${p.defended} defended, ${p.attempted} missed. ` +
        (share == null
          ? 'Not enough live rounds to judge yet. '
          : `${Math.round(share * 100)} percent of exchanges won. `) +
        `Across ${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'}` +
        (p.drilled > 0 ? `, drilled ${p.drilled} times.` : '.')
      }
    >
      <RNView style={styles.rowHead}>
        <Text style={styles.rowTitle}>{p.position}</Text>
        <Text style={styles.rowShare}>
          {share == null ? '—' : `${Math.round(share * 100)}%`}
        </Text>
      </RNView>

      {/* Two segments whose WIDTHS carry the split, so it survives greyscale
          and the monochrome accent — hue is doing no work here. */}
      <RNView style={styles.bar} aria-hidden>
        {live > 0 && (
          <>
            <RNView style={{ flex: won, backgroundColor: accentInk }} />
            <RNView style={{ flex: lost, backgroundColor: vola.line }} />
          </>
        )}
      </RNView>

      <Text style={[styles.rowDetail, { color: tone }]}>
        {p.scored} scored · {p.conceded} conceded · {p.defended} defended · {p.attempted} missed
      </Text>
      <Text style={styles.rowMeta}>
        {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'}
        {/* Drilling is shown but never counted into the split above — it is
            practice, not a round, and the backend excludes it for that reason. */}
        {p.drilled > 0 ? ` · ${p.drilled} drilled` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 4, paddingBottom: 48 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  loading: { marginTop: 32 },
  headline: { fontSize: 17, fontWeight: '700', lineHeight: 24, marginBottom: 10 },
  emptyTitle: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 18,
  },
  sectionBlurb: { fontSize: 12, color: vola.textMuted, marginBottom: 8 },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 16,
  },
  row: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 16,
    paddingVertical: 13,
    marginBottom: 8,
    gap: 7,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { fontSize: 15, fontWeight: '700', flex: 1 },
  rowShare: { fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  bar: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: vola.line },
  rowDetail: { fontSize: 12 },
  rowMeta: { fontSize: 11, color: vola.textDim },
  muted: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
  error: { color: vola.danger, fontSize: 14 },
});
