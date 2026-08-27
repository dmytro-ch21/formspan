import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View as RNView } from 'react-native';

import { KeyboardAwareFlatList } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { sportColor } from '@/components/ui/sport';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isTransportFailure } from '@/lib/apiError';
import { formatDuration, SPANS, spanRange, type SpanKey } from '@/lib/history';
import { enabledSports, labelFor } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import {
  contributesVolume,
  countsAsSet,
  listSessionsPage,
  totalWeightKg,
  type Session,
} from '@/lib/sessions';
import { listLocalSessions } from '@/lib/sessionStore';
import { sessionHref } from '@/lib/startSession';
import { formatVolume, type UnitSystem } from '@/lib/units';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * All of an athlete's sessions, searchable — N85.
 *
 * ## What this fixes, and why it is a screen rather than a bigger month sheet
 *
 * `docs/decisions/phone-impossible-audit.md` row 12: web's `/dashboard/sessions`
 * has name search, a sport filter and a paged list; the phone had none of it,
 * and the routine sync pull (`sessionStore.ts`'s `runSync`) only ever fetched
 * the 20 most recent sessions — so on a fresh install, older sessions were not
 * merely hard to find, they were **never on the device at all**. The pull side
 * of that is fixed in `runSync` itself (a bounded fresh-install backfill); this
 * screen is the other half — actually finding one.
 *
 * **This is a REDUCED form of web's page, not a port of it.** Per CLAUDE.md's
 * "which platform gets a feature" rule, a capability may be richer on web; it
 * may not be absent on the phone. What is reduced: no bulk actions, no side
 * pane, one filter row instead of a full toolbar. What is NOT reduced: the
 * name search and the sport filter both hit the same `GET /v1/sessions` query
 * web's page does, so a search here finds exactly what a search there finds.
 *
 * **The period control is `SPANS`/`spanRange`** (`lib/history.ts`) — the same
 * four preset windows the check-in trend chart already uses, all ending today,
 * plus "All". That is deliberate: CLAUDE.md's mobile-chart carve-out already
 * blessed "preset windows that all end today" as the mobile-appropriate
 * alternative to a start/end date-range picker (which is comparison, and stays
 * web's job) — reusing the same enum here means an athlete learns the mapping
 * once rather than once per screen.
 *
 * ## Network-first, and why
 *
 * This goes straight at `GET /v1/sessions` rather than reading local SQLite,
 * because the whole point is reaching sessions this device may never have
 * pulled down — a local-only read would just be a smaller, sadder version of
 * the bug this screen fixes. Offline, it falls back to whatever
 * `listLocalSessions` holds and SAYS SO: rendering the fallback silently would
 * make "couldn't reach the server" indistinguishable from "you have no older
 * sessions", which is exactly the silent-cap failure N85 exists to end.
 */

const PAGE_SIZE = 20;
type Period = SpanKey | 'all';
const PERIODS: { key: Period; label: string }[] = [
  ...SPANS.map((s) => ({ key: s.key as Period, label: s.label })),
  { key: 'all', label: 'All' },
];

/** Sets the athlete would call a set — mirrors `TrainingCalendar.tsx`'s copy
 *  of the same backend rule (`countsAsSet`). Not shared with it: this file's
 *  rows are a plain flat list, not `TrainingCalendar`'s per-day grouping, and
 *  the codebase already carries this exact duplication once (`weekReview.ts`)
 *  rather than extracting three call sites into a shared helper. */
function workingSets(s: Session): number {
  return s.sets.filter(countsAsSet).length;
}

function sessionVolumeKg(s: Session): number {
  let kg = 0;
  for (const set of s.sets) {
    if (contributesVolume(set) && set.weight_kg != null && set.reps != null) {
      kg += totalWeightKg(set) * set.reps;
    }
  }
  return kg;
}

function durationSeconds(s: Session): number | null {
  if (!s.ended_at) return null;
  return (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000;
}

export default function SessionHistoryScreen() {
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const { modules } = useModules();
  const { units } = useUnits();
  const accent = useAccent();
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sport, setSport] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('all');

  const [items, setItems] = useState<Session[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinguished from `error`: this is "couldn't reach the server, showing
  // what's on the device", not a claim that the request failed outright — see
  // the header note on why it renders instead of the network list rather than
  // alongside it.
  const [offline, setOffline] = useState(false);

  const inflight = useRef<AbortController | null>(null);

  // Debounced, same 250ms as `library.tsx` and `app/records/pinned.tsx` — a
  // search box that fires on every keystroke spends a round trip per letter.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    setLoading(true);
    setError(null);
    setOffline(false);
    const range = period === 'all' ? null : spanRange(period);

    listSessionsPage(
      getToken,
      {
        limit: PAGE_SIZE,
        offset: 0,
        q: query || undefined,
        sport: sport ?? undefined,
        from: range?.from,
        to: range?.to,
      },
      c.signal,
    )
      .then((page) => {
        if (c.signal.aborted) return;
        setItems(page.sessions);
        setTotal(page.total);
      })
      .catch((err: unknown) => {
        if (c.signal.aborted || (err as Error)?.name === 'AbortError') return;
        if (isTransportFailure(err) && userId) {
          setOffline(true);
          setTotal(0);
          listLocalSessions(userId, 100)
            .then((rows) => {
              if (!c.signal.aborted) setItems(rows);
            })
            .catch(() => {
              if (!c.signal.aborted) setItems([]);
            });
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
  }, [getToken, query, sport, period, userId]);

  // `useFocusEffect`, not a bare `useEffect` — re-runs on every dependency
  // change the same way (see the identical shape in `app/social/index.tsx`),
  // and additionally on return to this screen, so finishing a session
  // elsewhere and coming back shows it without a manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      load();
      return () => inflight.current?.abort();
    }, [load]),
  );

  const loadMore = useCallback(() => {
    // Offline's fallback list is already everything `listLocalSessions` has —
    // there is no server page behind it to ask for.
    if (loadingMore || offline || items === null || items.length >= total) return;
    setLoadingMore(true);
    const range = period === 'all' ? null : spanRange(period);
    listSessionsPage(getToken, {
      limit: PAGE_SIZE,
      offset: items.length,
      q: query || undefined,
      sport: sport ?? undefined,
      from: range?.from,
      to: range?.to,
    })
      .then((page) => {
        setItems((prev) => {
          if (prev === null) return page.sessions;
          const seen = new Set(prev.map((s) => s.id));
          return [...prev, ...page.sessions.filter((s) => !seen.has(s.id))];
        });
        setTotal(page.total);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoadingMore(false));
  }, [getToken, items, total, offline, loadingMore, query, sport, period]);

  const sportChips = [{ key: null as string | null, label: 'All' }, ...enabledSports(modules).map((m) => ({
    key: m.key as string | null,
    label: labelFor(modules, m.key),
  }))];

  return (
    <View style={styles.container} testID="session-history-screen">
      <Stack.Screen options={{ title: 'All sessions' }} />

      <RNView style={styles.controls}>
        <TextInput
          style={styles.search}
          placeholder="Search sessions by name"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Search sessions by name"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={100}
          testID="session-history-search"
        />

        <RNView style={styles.chips} accessibilityRole="tablist">
          {PERIODS.map((p) => {
            const active = period === p.key;
            return (
              <Pressable
                key={p.key}
                onPress={() => setPeriod(p.key)}
                style={[
                  styles.chip,
                  active && { backgroundColor: accent.accent, borderColor: accent.accent },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Show ${p.label === 'All' ? 'all time' : p.label}`}
                testID={`session-history-period-${p.key}`}
              >
                <Text style={[styles.chipText, active && { color: accent.on }]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </RNView>

        <RNView style={styles.chips} accessibilityRole="tablist">
          {sportChips.map((s) => {
            const active = sport === s.key;
            return (
              <Pressable
                key={s.key ?? 'all'}
                onPress={() => setSport(s.key)}
                style={[
                  styles.chip,
                  active && { backgroundColor: accent.accent, borderColor: accent.accent },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Filter by ${s.label}`}
                testID={`session-history-sport-${s.key ?? 'all'}`}
              >
                <Text style={[styles.chipText, active && { color: accent.on }]}>{s.label}</Text>
              </Pressable>
            );
          })}
        </RNView>

        {offline && (
          <Text style={styles.offlineNote} accessibilityLiveRegion="polite" testID="session-history-offline">
            Couldn&apos;t reach the server — showing what&apos;s saved on this device. Reconnect to
            search your full history.
          </Text>
        )}

        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite" testID="session-history-error">
            {error}
          </Text>
        )}
      </RNView>

      {loading && items === null ? (
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading sessions" />
      ) : (
        <KeyboardAwareFlatList
          data={items ?? []}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              sportLabel={labelFor(modules, item.sport)}
              units={units}
              onPress={() => router.push(sessionHref(item, modules))}
            />
          )}
          ListEmptyComponent={
            // A failed load (network or otherwise) must never render as "no
            // sessions" — see the note in `app/social/index.tsx` for the same
            // property on the feed. `offline`'s fallback can genuinely be empty
            // (a fresh device with nothing synced yet), which is its own
            // message rather than this one.
            !loading && !error ? (
              <RNView style={styles.empty} testID="session-history-empty">
                <Text style={styles.emptyTitle}>
                  {offline ? 'Nothing saved on this device yet' : 'No sessions match'}
                </Text>
                {(query || sport || period !== 'all') && !offline && (
                  <Text style={styles.muted}>Try clearing the search or a filter.</Text>
                )}
              </RNView>
            ) : null
          }
          ListFooterComponent={
            items !== null && !offline && items.length < total ? (
              <Pressable
                onPress={loadMore}
                disabled={loadingMore}
                style={[styles.more, loadingMore && styles.disabled]}
                accessibilityRole="button"
                accessibilityState={{ busy: loadingMore }}
                testID="session-history-load-more"
              >
                <Text style={[styles.moreText, { color: accent.ink }]}>
                  {loadingMore ? 'Loading…' : `Show older (${total - items.length} more)`}
                </Text>
              </Pressable>
            ) : null
          }
          testID="session-history-list"
        />
      )}
    </View>
  );
}

function SessionRow({
  session,
  sportLabel,
  units,
  onPress,
}: {
  session: Session;
  sportLabel: string;
  units: UnitSystem;
  onPress: () => void;
}) {
  const secs = durationSeconds(session);
  const kg = sessionVolumeKg(session);
  const n = workingSets(session);
  const meta = [
    new Date(session.started_at).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    secs != null ? formatDuration(secs) : null,
    n > 0 ? `${n} ${n === 1 ? 'set' : 'sets'}` : null,
    kg > 0 ? formatVolume(kg, units) : null,
  ].filter(Boolean);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${session.name || sportLabel}, ${meta.join(', ')}`}
      testID={`session-history-row-${session.id}`}
    >
      <RNView style={[styles.rowRule, { backgroundColor: sportColor(session.sport) ?? vola.green }]} />
      <RNView style={styles.rowBody}>
        <Text style={styles.rowSport}>{sportLabel.toUpperCase()}</Text>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {session.name || `${sportLabel} session`}
        </Text>
        <Text style={styles.rowMeta}>{meta.join(' · ')}</Text>
      </RNView>
      <Icon name="chevron" size={13} color={vola.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  controls: { paddingHorizontal: 20, paddingTop: 12, gap: 12 },

  search: {
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: vola.text,
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipText: { color: vola.textMuted, fontSize: 13, fontWeight: '600' },

  offlineNote: { color: vola.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: vola.danger, fontSize: 13 },

  loading: { marginTop: 32 },
  list: { paddingHorizontal: 20, paddingBottom: 32, paddingTop: 4, gap: 8 },

  empty: { paddingTop: 40, alignItems: 'center', gap: 6 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 13 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 10,
    paddingRight: 10,
    overflow: 'hidden',
  },
  rowPressed: { backgroundColor: vola.surfaceHover },
  rowRule: { width: 3, alignSelf: 'stretch' },
  rowBody: { flex: 1, paddingVertical: 9, paddingLeft: 8, gap: 1 },
  rowSport: { fontSize: 9, fontWeight: '700', letterSpacing: 0.9, color: vola.textDim },
  rowTitle: { fontSize: 14, fontWeight: '700' },
  rowMeta: { fontSize: 12, color: vola.textMuted, fontVariant: ['tabular-nums'] },

  more: { paddingVertical: 14, alignItems: 'center' },
  disabled: { opacity: 0.6 },
  moreText: { fontWeight: '700', fontSize: 13 },
});
