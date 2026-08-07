import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isNotFound } from '@/lib/apiError';
import {
  acceptRequest,
  lookupUser,
  listFriends,
  listRequests,
  removeFriend,
  sendFriendRequest,
  type FriendCard,
  type FriendRequests,
  type PublicProfile,
} from '@/lib/friends';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Friends: search a handle, ask, answer, and see who said yes.
 *
 * ONLINE-ONLY — the one screen in this app that is, and on purpose. The
 * offline spine exists so an athlete's own training survives a dead-spot; a
 * friend request is a message to another person, and queueing one against a
 * stale view means asking someone who already answered. Failures surface as
 * copy instead of an outbox.
 *
 * Search is EXACT-MATCH by design (the API refuses to be an enumeration
 * surface), so the empty state teaches the interaction: type the whole handle
 * a friend told you.
 */
export default function FriendsScreen() {
  const accent = useAccent();
  const getToken = useAuthToken();

  const [friends, setFriends] = useState<FriendCard[] | null>(null);
  const [requests, setRequests] = useState<FriendRequests | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [query, setQuery] = useState('');
  const [result, setResult] = useState<PublicProfile | null>(null);
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'missing' | 'error'>('idle');
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  // A .then chain rather than async/await, and that is the lint ratchet
  // speaking, not taste: `react-hooks/set-state-in-effect` traces the call
  // graph of anything an effect invokes, and an async body counts its whole
  // self as synchronous. Every setState here lives strictly in .then/.catch
  // callbacks, which run after the effect returned. Errors clear on SUCCESS,
  // covering the retry-after-error path; a failed load leaves `friends` null,
  // which must never render as "no friends".
  const load = useCallback(
    (signal?: AbortSignal) =>
      Promise.all([listFriends(getToken, signal), listRequests(getToken, signal)])
        .then(([f, r]) => {
          setFriends(f);
          setRequests(r);
          setLoadError(null);
        })
        .catch((err) => {
          if (signal?.aborted) return;
          setLoadError(err instanceof Error ? err.message : String(err));
        }),
    [getToken],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function search() {
    const q = query.trim().toLowerCase();
    if (!q) return;
    setSearchState('searching');
    setSearchMessage(null);
    setResult(null);
    try {
      setResult(await lookupUser(getToken, q));
      setSearchState('idle');
    } catch (err) {
      if (isNotFound(err)) {
        // The API's one-404-for-everything is deliberate; the copy here turns
        // it into instruction rather than mystery.
        setSearchState('missing');
        setSearchMessage(`Nobody goes by “${q}”. Handles are exact — check the spelling with your friend.`);
      } else {
        setSearchState('error');
        setSearchMessage(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function act(key: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setConfirmingRemove(null);
    }
  }

  const alreadyLinked = (username: string) =>
    (friends ?? []).some((f) => f.username === username) ||
    (requests?.incoming ?? []).some((f) => f.username === username) ||
    (requests?.outgoing ?? []).some((f) => f.username === username);

  return (
    <View style={styles.container} testID="friends-screen">
      <Stack.Screen options={{ title: 'Friends' }} />
      {/* The shared keyboard container, not a bare ScrollView — the
          keyboard-coverage suite enforces this on every screen that takes
          typing, and this screen was its first catch. */}
      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {actionError && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {actionError}
          </Text>
        )}

        <Text style={styles.label}>ADD A FRIEND</Text>
        <RNView style={styles.searchRow}>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={(v) => setQuery(v.toLowerCase())}
            placeholder="their exact handle, e.g. dmytro_bjj"
            placeholderTextColor={vola.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => void search()}
            accessibilityLabel="Search by username"
            testID="friends-search"
          />
          <Pressable
            onPress={() => void search()}
            disabled={searchState === 'searching' || !query.trim()}
            accessibilityRole="button"
            testID="friends-search-go"
          >
            <Text style={[styles.action, { color: accent.ink }, !query.trim() && styles.dim]}>
              {searchState === 'searching' ? '…' : 'Find'}
            </Text>
          </Pressable>
        </RNView>
        {searchMessage && <Text style={styles.muted}>{searchMessage}</Text>}
        {result && (
          <RNView style={styles.card} testID="friends-result">
            <RNView style={styles.cardBody}>
              <Text style={styles.cardName}>@{result.username}</Text>
              {result.display_name && <Text style={styles.muted}>{result.display_name}</Text>}
            </RNView>
            {alreadyLinked(result.username) ? (
              <Text style={styles.muted}>already in your lists</Text>
            ) : (
              <Pressable
                onPress={() =>
                  void act(`add-${result.username}`, () => sendFriendRequest(getToken, result.username))
                }
                disabled={busy !== null}
                accessibilityRole="button"
                testID="friends-add"
              >
                <Text style={[styles.action, { color: accent.ink }]}>
                  {busy === `add-${result.username}` ? 'Sending…' : 'Add friend'}
                </Text>
              </Pressable>
            )}
          </RNView>
        )}

        {loadError && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {loadError}
          </Text>
        )}
        {friends === null && !loadError && <ActivityIndicator style={styles.spinner} />}

        {requests !== null && requests.incoming.length > 0 && (
          <>
            <Text style={styles.label}>WANT TO BE YOUR FRIEND</Text>
            {requests.incoming.map((c) => (
              <RNView key={c.username} style={styles.card} testID={`friends-incoming-${c.username}`}>
                <RNView style={styles.cardBody}>
                  <Text style={styles.cardName}>@{c.username}</Text>
                  {c.display_name && <Text style={styles.muted}>{c.display_name}</Text>}
                </RNView>
                <Pressable
                  onPress={() => void act(`accept-${c.username}`, () => acceptRequest(getToken, c.username))}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Accept ${c.username}`}
                  testID={`friends-accept-${c.username}`}
                >
                  <Text style={[styles.action, { color: accent.ink }]}>
                    {busy === `accept-${c.username}` ? '…' : 'Accept'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void act(`decline-${c.username}`, () => removeFriend(getToken, c.username))}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Decline ${c.username}`}
                  hitSlop={10}
                  testID={`friends-decline-${c.username}`}
                >
                  <Text style={styles.declineText}>Decline</Text>
                </Pressable>
              </RNView>
            ))}
          </>
        )}

        {requests !== null && requests.outgoing.length > 0 && (
          <>
            <Text style={styles.label}>WAITING ON</Text>
            {requests.outgoing.map((c) => (
              <RNView key={c.username} style={styles.card}>
                <RNView style={styles.cardBody}>
                  <Text style={styles.cardName}>@{c.username}</Text>
                </RNView>
                <Pressable
                  onPress={() => void act(`cancel-${c.username}`, () => removeFriend(getToken, c.username))}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Cancel request to ${c.username}`}
                  testID={`friends-cancel-${c.username}`}
                >
                  <Text style={styles.declineText}>Cancel</Text>
                </Pressable>
              </RNView>
            ))}
          </>
        )}

        {friends !== null && (
          <>
            <Text style={styles.label}>FRIENDS</Text>
            {friends.length === 0 ? (
              <Text style={styles.muted}>
                Nobody yet. Ask a training partner for their handle — sharing lands here next.
              </Text>
            ) : (
              friends.map((c) => (
                <RNView key={c.username} style={styles.card} testID={`friends-row-${c.username}`}>
                  <RNView style={styles.cardBody}>
                    <Text style={styles.cardName}>@{c.username}</Text>
                    {c.display_name && <Text style={styles.muted}>{c.display_name}</Text>}
                  </RNView>
                  <Pressable
                    onPress={() =>
                      confirmingRemove === c.username
                        ? void act(`remove-${c.username}`, () => removeFriend(getToken, c.username))
                        : setConfirmingRemove(c.username)
                    }
                    disabled={busy !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${c.username}`}
                    hitSlop={10}
                    testID={`friends-remove-${c.username}`}
                  >
                    {/* Two-step in place, like the sequence delete — and it
                        announces, because a label swap on a focused control is
                        silent to a screen reader otherwise. */}
                    <Text style={styles.declineText} accessibilityLiveRegion="polite">
                      {busy === `remove-${c.username}`
                        ? '…'
                        : confirmingRemove === c.username
                          ? 'Really remove?'
                          : 'Remove'}
                    </Text>
                  </Pressable>
                </RNView>
              ))
            )}
          </>
        )}
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 10, paddingBottom: 40 },
  label: { fontSize: 12, fontWeight: '700', color: vola.textMuted, letterSpacing: 1, marginTop: 14 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  search: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: vola.text,
    fontSize: 15,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    borderRadius: 12,
    padding: 12,
  },
  cardBody: { flex: 1, gap: 2 },
  cardName: { fontSize: 15, fontWeight: '600' },
  action: { fontSize: 15, fontWeight: '700', minHeight: 44, paddingVertical: 12 },
  declineText: { color: vola.textMuted, fontSize: 15, minHeight: 44, paddingVertical: 12 },
  dim: { opacity: 0.4 },
  muted: { color: vola.textMuted, fontSize: 13 },
  error: { color: '#e5484d', fontSize: 13 },
  spinner: { marginTop: 16 },
});
