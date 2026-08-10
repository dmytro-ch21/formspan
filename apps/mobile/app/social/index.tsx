import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
  View as RNView,
} from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { SessionCard } from '@/components/SessionCard';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  agoLabel,
  cardFromFeedItem,
  fetchFeed,
  feedMetrics,
  FEED_PAGE,
  type FeedItem,
} from '@/lib/feed';
import { getPendingCounts, listFriends } from '@/lib/friends';
import { labelFor } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import type { UnitSystem } from '@/lib/units';
import { useUnits } from '@/lib/useUnits';
import { isNotFound } from '@/lib/apiError';
import { getProfile, type Profile } from '@/lib/profile';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Social — what your training partners have been doing.
 *
 * **MOBILE ONLY.** The web app sees shared content and manages friends; a feed
 * is a phone thing, the same way live logging is. There is no web counterpart
 * to this screen and there should not be one.
 *
 * ## What is on it, and in what order
 *
 * A friends PANE at the top — a count, whatever is waiting, and a way through
 * to the full management screen — then the feed. The pane is deliberately a
 * summary rather than the whole of `app/friends/`: adding a partner is a thing
 * you do occasionally and reading the feed is the thing you came for, so the
 * management surface stays one tap away rather than above the fold.
 *
 * ## Nothing here is cached
 *
 * ONLINE-ONLY, like the rest of the social surface. The offline outbox exists
 * so an athlete's own training survives a gym dead-spot; this is other people's
 * data, and a cached feed is a claim about what they have been doing lately
 * that gets less true every hour. It shows its failure instead.
 *
 * ## The nudge, and why it is a nudge
 *
 * Seeing a friend's training does not require sharing your own — the gate is
 * entirely on the OWNER's opt-in, so a reader who has not opted in still sees
 * whatever their friends chose to share. That asymmetry is deliberate (a
 * reciprocity requirement would make the switch coercive), but it is worth
 * saying out loud, so an athlete who has not opted in gets one quiet line
 * offering to. Once. Not a banner, not a modal, not repeated.
 */

/**
 * One finished session, as somebody else's feed shows it.
 *
 * **THE SAME CARD THE ATHLETE SAW WHEN THEY FINISHED IT.** That is the point
 * of the redesign: the thing you are proud of at the end of a session is the
 * thing your training partners see, rather than a list row that happens to
 * describe the same workout. `SessionCard` takes a plain `CardData` and reads
 * nothing from a screen, which is what lets the completion screen, this feed
 * and the exported PNG all be one component.
 *
 * The attribution sits ABOVE the card rather than inside it. Who trained is
 * the question this screen exists to answer — on your own Today tab it is
 * never in question, which is why the card itself does not carry it — and a
 * header strip keeps the poster below it a poster. It is also why the card is
 * built without a handle: its foot falls back to the wordmark, so a column of
 * these reads as posters instead of as repeated signatures.
 *
 * What the card cannot show here — calories, the VOLA Score, a PR badge — is
 * documented at `cardFromFeedItem`. All three are derived from the owner's own
 * profile or history, and none of them may cross to a reader.
 */
const FeedRow = memo(function FeedRow({
  item,
  sportLabel,
  now,
  units,
  width,
}: {
  item: FeedItem;
  sportLabel: string;
  now: number;
  units: UnitSystem;
  width: number;
}) {
  const tone = sportColor(item.sport) ?? vola.textMuted;
  const glyph = sportIcon(item.sport);
  const metrics = feedMetrics(item, units);
  const who = item.display_name || `@${item.from}`;
  const when = agoLabel(item.ended_at, now);
  const card = cardFromFeedItem(item, units, now);

  return (
    <RNView
      style={styles.post}
      // ONE stop per post. Left to its parts, VoiceOver walks who, when, the
      // headline, every stat and every detail line as separate elements —
      // a dozen stops to read one card, on a screen that is nothing but cards.
      // The card itself is `importantForAccessibility="no-hide-descendants"`
      // below, so it contributes nothing and this label is the whole reading.
      accessible
      accessibilityLabel={[
        who,
        item.name || sportLabel,
        ...metrics.map((m) => `${m.value} ${m.label}`),
        ...(item.detail ?? []).map((d) =>
          [d.name, d.figure ?? d.outcome, d.count && d.count > 1 ? `${d.count} times` : null]
            .filter(Boolean)
            .join(' '),
        ),
        when,
      ]
        .filter(Boolean)
        .join(', ')}
      testID={`feed-${item.id}`}
    >
      <RNView style={styles.by}>
        {glyph && (
          <RNView style={[styles.byBadge, { backgroundColor: sportTint(tone) }]}>
            <Icon name={glyph} size={15} color={tone} />
          </RNView>
        )}
        <RNView style={styles.byBody}>
          {/* The person leads. */}
          <Text style={styles.who} numberOfLines={1}>
            {who}
          </Text>
          <Text style={styles.byMeta} numberOfLines={1}>
            {[sportLabel, when].filter(Boolean).join(' · ')}
          </Text>
        </RNView>
      </RNView>

      {/* Hidden from the reader entirely: the label above already reads the
          whole post, and a card full of decorative text would otherwise make
          VoiceOver say all of it twice. */}
      <RNView importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <SessionCard data={card} width={width} />
      </RNView>
    </RNView>
  );
});

export default function SocialScreen() {
  const getToken = useAuthToken();
  const accent = useAccent();
  const router = useRouter();
  const { modules } = useModules();
  const { units } = useUnits();
  // The card is square and sized from the content width, so it fills the
  // column on every device instead of carrying a fixed size that is right on
  // one phone. `styles.scroll` pads 20 a side; the clamp keeps it from
  // becoming a wall on a tablet, where a full-width square would be taller
  // than the viewport and only ever show one post.
  const { width: screenWidth } = useWindowDimensions();
  const cardWidth = Math.min(screenWidth - 40, 460);

  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [friendCount, setFriendCount] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [sharing, setSharing] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * `now` is captured per load, not read at render.
   *
   * `agoLabel` takes it as an argument precisely so this screen decides when
   * "now" is. Reading the clock inside the row would make every re-render
   * produce slightly different text for unchanged data, and would make the
   * whole list untestable.
   */
  const [now, setNow] = useState(() => Date.now());

  // Single-flight, the same guard `app/friends/index.tsx` documents: a stalled
  // load must not resolve after a refresh and repaint stale rows over fresh
  // ones. A `.then` chain rather than async/await inside the effect, because
  // `react-hooks/set-state-in-effect` treats an async body as synchronous.
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    setNow(Date.now());
    // One round trip for everything the screen shows. A waterfall would put
    // the pane and the feed on screen at visibly different moments.
    return Promise.all([
      fetchFeed(getToken, { limit: FEED_PAGE, offset: 0 }, c.signal),
      listFriends(getToken, c.signal),
      getPendingCounts(getToken, c.signal),
      // A 404 here is the ORDINARY first-run case — an account that has never
      // saved a profile genuinely has no row, as `profile/edit.tsx` records.
      // Left to reject it takes the whole `Promise.all` with it, so a brand
      // new athlete sees "not found" where the feed should be, with the feed,
      // friends and counts calls having all succeeded. Absent means never
      // opted in, which is exactly `false`.
      getProfile(getToken).catch((err: unknown) => {
        if (isNotFound(err)) return { share_training_with_friends: false } as Profile;
        throw err;
      }),
    ])
      .then(([page, friends, counts, profile]) => {
        if (c.signal.aborted) return;
        setItems(page.items);
        setTotal(page.total);
        setFriendCount(friends.length);
        setWaiting(counts.friend_requests ?? 0);
        setSharing(profile.share_training_with_friends);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (c.signal.aborted || (err as Error)?.name === 'AbortError') return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!c.signal.aborted) setRefreshing(false);
      });
  }, [getToken]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => inflight.current?.abort();
    }, [load]),
  );

  const loadMore = useCallback(() => {
    if (loadingMore || items === null || items.length >= total) return;
    setLoadingMore(true);
    // Deliberately NOT single-flighted against `load`: a refresh that lands
    // mid-append would replace the list anyway, and aborting the page would
    // leave the button spinning. The offset is read from what is on screen, so
    // a stale append can duplicate at worst — and the dedupe below makes even
    // that harmless.
    fetchFeed(getToken, { limit: FEED_PAGE, offset: items.length })
      .then((page) => {
        setItems((prev) => {
          if (prev === null) return page.items;
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
        });
        setTotal(page.total);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoadingMore(false));
  }, [getToken, items, total, loadingMore]);

  return (
    <>
      <Stack.Screen options={{ title: 'Social' }} />
      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        testID="social-screen"
      >
        {/* The friends pane. A summary and a way through, not the whole
            management screen — adding a partner is occasional, reading the
            feed is why you opened this. */}
        <Pressable
          onPress={() => router.push('/friends')}
          style={styles.pane}
          accessibilityRole="button"
          // Mirrors the VISIBLE copy below rather than substituting 0 for an
          // unknown count — "0 training partners" is a claim, and the screen
          // carefully avoids making it until it knows.
          accessibilityLabel={[
            'Friends',
            friendCount === null
              ? 'Training partners'
              : friendCount === 1
                ? '1 training partner'
                : `${friendCount} training partners`,
            waiting > 0 ? `${waiting} waiting on you` : '',
          ]
            .filter(Boolean)
            .join('. ')}
          testID="social-friends-pane"
        >
          <RNView style={styles.paneBody}>
            <Text style={styles.paneLabel}>Friends</Text>
            <Text style={styles.muted}>
              {friendCount === null
                ? 'Training partners'
                : friendCount === 1
                  ? '1 training partner'
                  : `${friendCount} training partners`}
            </Text>
          </RNView>
          {waiting > 0 && (
            <View
              style={[styles.badgePill, { backgroundColor: accent.accent }]}
              // The pane's own label already speaks the count.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              testID="social-friends-badge"
            >
              <Text style={[styles.badgePillText, { color: accent.on }]}>
                {waiting >= 100 ? '99+' : waiting}
              </Text>
            </View>
          )}
          <Text style={[styles.chevron, { color: accent.ink }]}>›</Text>
        </Pressable>

        {loadError && (
          <Text style={styles.error} accessibilityLiveRegion="polite" testID="social-error">
            {loadError}
          </Text>
        )}

        {/* null is LOADING and [] is a genuinely quiet feed. A failed load must
            render as NEITHER — "nobody has trained" is a claim about other
            people, and inventing it from a failed request is worse than saying
            the request failed. */}
        {items === null && !loadError && (
          <ActivityIndicator style={styles.loader} accessibilityLabel="Loading" />
        )}

        {items !== null && items.length === 0 && (
          <View style={styles.empty} testID="social-empty">
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Text style={styles.muted}>
              {friendCount === 0
                ? 'Add a training partner, and their sessions show up here once they choose to share them.'
                : 'Your training partners haven’t shared any sessions yet. Sharing is off until someone turns it on.'}
            </Text>
          </View>
        )}

        {items?.map((item) => (
          <FeedRow
            key={item.id}
            item={item}
            sportLabel={labelFor(modules, item.sport)}
            now={now}
            units={units}
            width={cardWidth}
          />
        ))}

        {items !== null && items.length < total && (
          <Pressable
            onPress={loadMore}
            disabled={loadingMore}
            style={[styles.more, loadingMore && styles.disabled]}
            accessibilityRole="button"
            accessibilityState={{ busy: loadingMore }}
            testID="social-load-more"
          >
            <Text style={[styles.moreText, { color: accent.ink }]}>
              {loadingMore ? 'Loading…' : 'Show older'}
            </Text>
          </Pressable>
        )}

        {/* The nudge. Once, quietly, and only when there is something to nudge
            about — seeing a friend's training does not require sharing your
            own, so this is an offer rather than a condition. */}
        {sharing === false && items !== null && (
          <Pressable
            onPress={() => router.push('/settings')}
            style={styles.nudge}
            accessibilityRole="button"
            accessibilityLabel="Share your own training with friends. Opens Settings."
            testID="social-nudge"
          >
            <Text style={styles.muted}>
              Your own sessions stay private. You can share them with friends in Settings.
            </Text>
          </Pressable>
        )}
      </KeyboardAwareScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 10, paddingBottom: 40 },
  pane: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  paneBody: { flex: 1, gap: 2 },
  paneLabel: { fontSize: 15, fontWeight: '700' },
  chevron: { fontSize: 22, fontWeight: '700' },
  badgePill: {
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgePillText: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },

  error: { fontSize: 13, color: vola.danger },
  loader: { marginTop: 16 },
  muted: { fontSize: 13, color: vola.textMuted },
  empty: {
    borderWidth: 1,
    borderColor: vola.line,
    borderStyle: 'dashed',
    borderRadius: 14,
    padding: 20,
    gap: 6,
    marginTop: 6,
  },
  emptyTitle: { fontSize: 15, fontWeight: '700' },

  // A post is the attribution strip plus the card, with more air between
  // posts than inside one — otherwise a column of square cards reads as a
  // contact sheet and the eye cannot tell where one session ends.
  post: { gap: 8, marginBottom: 12 },
  by: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  byBadge: {
    width: 30,
    height: 30,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  byBody: { flex: 1, minWidth: 0 },
  who: { fontSize: 15, fontWeight: '700' },
  byMeta: { fontSize: 11, color: vola.textDim, marginTop: 1 },

  more: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 24 },
  moreText: { fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  nudge: { paddingTop: 8 },
});
