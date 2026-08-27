import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View as RNView } from 'react-native';

import { KeyboardAwareFlatList } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fetchFocus, setFocus, MAX_FOCUS, type Focus } from '@/lib/bjjFocus';
import {
  bucketOf,
  fetchProficiencyFull,
  MIN_TRIES_FOR_RATE,
  type Bucket,
  type Proficiency,
  type ProficiencySummary,
} from '@/lib/proficiency';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The technique funnel, browsable on the phone — N84, row 10 of the
 * phone-impossible audit.
 *
 * **This is a list, not a chart**, and deliberately so: the ticket that filed
 * this said explicitly it may not need one — a well-organised browse view
 * satisfies "reachable and usable" without inventing chart real estate for
 * CLAUDE.md's mobile-chart carve-out to have to police. Nothing here plots a
 * value against time, so the carve-out's rules (one metric, no picker, preset
 * windows) do not apply to this screen at all — there is no window to preset.
 *
 * It is a direct port of `apps/web/src/app/dashboard/proficiency/page.tsx`'s
 * bucketing, filtering and headline logic (`bucketOf` lives in
 * `lib/proficiency.ts` precisely so the two screens cannot quietly disagree
 * about which bucket a technique falls in), reshaped from a wide table into a
 * scrollable list of rows — the same reduction the Records screen already
 * makes for personal records.
 *
 * The Today card already reads `fetchProficiency` for its own suggestion
 * logic; this is the first screen that reads the FULL list to show it back.
 */
export default function ProficiencyScreen() {
  const getToken = useAuthToken();
  const accent = useAccent();

  const [rows, setRows] = useState<Proficiency[] | null>(null);
  const [summary, setSummary] = useState<ProficiencySummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [focus, setFocusState] = useState<Focus[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>('all');
  const [search, setSearch] = useState('');
  // Same reasoning as web's page: only the newest save's outcome applies, so
  // two taps inside one round trip cannot let a stale response undo a later one.
  const saveSeq = useRef(0);

  const load = useCallback(() => {
    const c = new AbortController();
    fetchProficiencyFull(getToken, c.signal)
      .then((r) => {
        setRows(r.techniques);
        setSummary(r.summary);
        setFailed(false);
      })
      .catch(() => setFailed(true));
    // The focus read is independent and best-effort: a failure here leaves
    // the funnel readable with its stars simply unfilled, matching web's
    // `Promise.allSettled` split rather than failing the whole load.
    fetchFocus(getToken, c.signal)
      .then(setFocusState)
      .catch(() => {});
    return () => c.abort();
  }, [getToken]);

  // On FOCUS, not mount-only: reflecting on a technique in the BJJ wizard
  // changes exactly this data, and returning to this screen afterward must
  // not show what was here before that reflection.
  useFocusEffect(load);

  const focusIDs = useMemo(() => new Set(focus.map((f) => f.technique_id)), [focus]);

  const save = useCallback(
    (next: Focus[]) => {
      setNotice(null);
      const previous = focus;
      const seq = ++saveSeq.current;
      setFocusState(next);
      setFocus(
        getToken,
        next.map((f) => f.technique_id),
      )
        .then(() => {
          // The write endpoint returns void on this app's wire layer (unlike
          // web's, which echoes the stored list) — see `bjjFocus.ts`. The
          // optimistic state IS the result here; there is nothing to
          // reconcile it against.
          if (seq !== saveSeq.current) return;
        })
        .catch(() => {
          if (seq !== saveSeq.current) return;
          setFocusState(previous);
          // A fixed sentence, not the wire error's own message — API
          // conventions say a message is not part of the contract, and this
          // screen's other failure states (`proficiency-unavailable`) already
          // say something fixed rather than surfacing whatever the server
          // sent.
          setNotice("Couldn't save that — try again.");
        });
    },
    [focus, getToken],
  );

  const toggleFocus = useCallback(
    (p: Proficiency) => {
      const has = focusIDs.has(p.technique_id);
      if (!has && focus.length >= MAX_FOCUS) {
        setNotice(`A focus list is at most ${MAX_FOCUS} — drop one first. Keeping it short is the point.`);
        return;
      }
      const next = has
        ? focus.filter((f) => f.technique_id !== p.technique_id)
        : [
            ...focus,
            {
              technique_id: p.technique_id,
              name: p.name,
              position: p.position,
              category: p.category,
              started_on: '',
            },
          ];
      save(next);
    },
    [focus, focusIDs, save],
  );

  const shown = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((p) => {
      if (bucket !== 'all' && bucketOf(p) !== bucket) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.position.toLowerCase().includes(q);
    });
  }, [rows, bucket, search]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { all: rows?.length ?? 0, untried: 0, working: 0, stalled: 0, against: 0 };
    for (const p of rows ?? []) c[bucketOf(p)] += 1;
    return c;
  }, [rows]);

  return (
    <View style={styles.screen} testID="proficiency-screen">
      <Stack.Screen options={{ title: 'Technique funnel' }} />

      {rows === null ? (
        failed ? (
          <RNView style={styles.centre}>
            <Text style={styles.muted} testID="proficiency-unavailable">
              Couldn&apos;t load your funnel. Pull down or reopen to try again.
            </Text>
          </RNView>
        ) : (
          <ActivityIndicator style={styles.centre} accessibilityLabel="Loading your funnel" />
        )
      ) : (
        <KeyboardAwareFlatList
          data={shown}
          keyExtractor={(p: Proficiency) => p.technique_id}
          contentContainerStyle={styles.list}
          testID="proficiency-list"
          ListHeaderComponent={
            <RNView style={styles.header}>
              {summary && <Funnel summary={summary} accentColor={accent.accent} />}

              {focus.length > 0 && <FocusPanel focus={focus} onDrop={(id) => save(focus.filter((f) => f.technique_id !== id))} />}

              {notice && (
                <Text style={styles.notice} accessibilityLiveRegion="polite" testID="proficiency-notice">
                  {notice}
                </Text>
              )}

              <TextInput
                style={styles.search}
                placeholder="Search by technique or position"
                placeholderTextColor={vola.textDim}
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={100}
                testID="proficiency-search"
              />

              <RNView style={styles.chips}>
                {BUCKETS.map((b) => {
                  const active = bucket === b.key;
                  return (
                    <Pressable
                      key={b.key}
                      onPress={() => setBucket(b.key)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={[styles.chip, active && { backgroundColor: accent.accent, borderColor: accent.accent }]}
                      testID={`proficiency-bucket-${b.key}`}
                    >
                      <Text style={[styles.chipText, active && { color: accent.on }]}>
                        {b.label} {counts[b.key]}
                      </Text>
                    </Pressable>
                  );
                })}
              </RNView>

              {rows.length === 0 && (
                <Text style={styles.muted} testID="proficiency-empty">
                  This fills in from the reflection you do after a session — the techniques you
                  drilled, and whether you took any of them into a live round.
                </Text>
              )}
              {rows.length > 0 && shown.length === 0 && (
                <Text style={styles.muted} testID="proficiency-no-match">
                  Nothing in this filter{search.trim() ? ' matches that search' : ''}.
                </Text>
              )}
            </RNView>
          }
          renderItem={({ item }: { item: Proficiency }) => (
            <TechniqueRow p={item} starred={focusIDs.has(item.technique_id)} onToggleStar={() => toggleFocus(item)} />
          )}
        />
      )}
    </View>
  );
}

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'against', label: 'Used on you' },
  { key: 'untried', label: 'Never tried live' },
  { key: 'working', label: 'Landing' },
  { key: 'stalled', label: 'Not landing yet' },
];

/** The headline — three counts of TECHNIQUES, matching web's ordering and phrasing. */
function Funnel({ summary, accentColor }: { summary: ProficiencySummary; accentColor: string }) {
  const stages = [
    { label: 'Drilled', value: summary.drilled },
    { label: 'Tried live', value: summary.tried_live },
    { label: 'Landed', value: summary.landed },
  ];
  const widest = Math.max(1, summary.drilled, summary.tried_live, summary.landed);
  return (
    <View style={styles.funnel} testID="proficiency-funnel">
      {stages.map((s) => (
        <RNView key={s.label} style={styles.funnelRow}>
          <Text style={styles.funnelLabel}>{s.label}</Text>
          <RNView style={styles.funnelTrack}>
            <RNView
              style={[styles.funnelFill, { width: `${(s.value / widest) * 100}%`, backgroundColor: accentColor }]}
            />
          </RNView>
          <Text style={styles.funnelValue}>{s.value}</Text>
        </RNView>
      ))}
    </View>
  );
}

function FocusPanel({ focus, onDrop }: { focus: Focus[]; onDrop: (id: string) => void }) {
  return (
    <View style={styles.focusPanel} testID="proficiency-focus-panel">
      <RNView style={styles.focusHead}>
        <Text style={styles.focusTitle}>Working on</Text>
        <Text style={styles.focusCount}>
          {focus.length}/{MAX_FOCUS}
        </Text>
      </RNView>
      {focus.map((f) => (
        <RNView key={f.technique_id} style={styles.focusRow}>
          <Text style={styles.focusName} numberOfLines={1}>
            {f.name}
          </Text>
          <Pressable
            onPress={() => onDrop(f.technique_id)}
            accessibilityRole="button"
            accessibilityLabel={`Done with ${f.name}`}
            hitSlop={8}
            testID={`proficiency-focus-drop-${f.technique_id}`}
          >
            <Text style={styles.focusDone}>Done</Text>
          </Pressable>
        </RNView>
      ))}
    </View>
  );
}

function TechniqueRow({
  p,
  starred,
  onToggleStar,
}: {
  p: Proficiency;
  starred: boolean;
  onToggleStar: () => void;
}) {
  const accent = useAccent();
  const tried = p.attempted + p.scored;
  const hitRate = tried >= MIN_TRIES_FOR_RATE ? `${Math.round((p.scored / tried) * 100)}%` : null;

  return (
    <RNView style={styles.row} testID={`proficiency-row-${p.technique_id}`}>
      <Pressable
        onPress={onToggleStar}
        accessibilityRole="button"
        accessibilityState={{ selected: starred }}
        accessibilityLabel={`Working on ${p.name}`}
        hitSlop={8}
        style={styles.star}
        testID={`proficiency-star-${p.technique_id}`}
      >
        <Text style={[styles.starGlyph, starred && { color: accent.accent }]}>{starred ? '★' : '☆'}</Text>
      </Pressable>
      <RNView style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1}>
          {p.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {p.position || '—'} · drilled {p.drilled || 0} · tried {tried || 0} · landed {p.scored || 0}
          {hitRate ? ` · ${hitRate}` : tried > 0 && tried < MIN_TRIES_FOR_RATE ? ' · too few for a rate' : ''}
        </Text>
      </RNView>
      {p.drilled > 0 && tried === 0 && (
        <RNView style={styles.badge}>
          <Text style={styles.badgeText}>never tried live</Text>
        </RNView>
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: vola.textMuted, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  list: { padding: 16, paddingBottom: 48, gap: 4 },
  header: { gap: 14, marginBottom: 6 },
  notice: { color: vola.text, fontSize: 13, lineHeight: 18 },

  search: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: vola.text,
    backgroundColor: vola.surface,
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: vola.line,
  },
  chipText: { fontSize: 12, fontWeight: '600' },

  funnel: { gap: 8, borderWidth: 1, borderColor: vola.lineSoft, borderRadius: 14, padding: 14 },
  funnelRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  funnelLabel: { width: 78, fontSize: 12, color: vola.textMuted },
  funnelTrack: { flex: 1, height: 8, borderRadius: 999, backgroundColor: vola.surfaceRaised, overflow: 'hidden' },
  funnelFill: { height: '100%', borderRadius: 999 },
  funnelValue: { width: 28, textAlign: 'right', fontSize: 13, fontWeight: '700' },

  focusPanel: { gap: 8, borderWidth: 1, borderColor: vola.lineSoft, borderRadius: 14, padding: 14 },
  focusHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  focusTitle: { fontSize: 14, fontWeight: '700' },
  focusCount: { fontSize: 12, color: vola.textMuted },
  focusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  focusName: { flex: 1, fontSize: 14, fontWeight: '600' },
  focusDone: { fontSize: 12, fontWeight: '600', color: vola.textMuted },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.lineSoft,
  },
  star: { width: 30, alignItems: 'center' },
  starGlyph: { fontSize: 18, color: vola.textDim },
  rowBody: { flex: 1, gap: 2 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12, color: vola.textMuted },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: vola.surfaceRaised },
  badgeText: { fontSize: 10, fontWeight: '600', color: vola.textMuted },
});
