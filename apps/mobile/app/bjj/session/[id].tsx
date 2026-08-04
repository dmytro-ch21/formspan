import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import {
  getDetail,
  KINDS,
  LIVE_ROWS,
  describeRPE,
  rollingMinutes,
  techniqueOutcomeCount,
  type SessionDetail,
} from '@/lib/bjjSession';
import {
  deleteLocalSession,
  saveLocalBjjDetail,
  finishLocalSession,
  readLocalBjjDetail,
  readLocalSession,
  renameLocalSession,
  type LocalSession,
} from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { fetchTechniques, type TechniqueSummary } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Reading a BJJ session back.
 *
 * This screen exists because the logging half shipped without it, and that
 * turned out to be the whole feature rather than a missing corner. Today's
 * list sent every session to `/session/[id]`, which knows only about sets —
 * so a class opened to "Sets 0 · Reps 0 · Volume —" and an empty list, and
 * the reflection was reachable from nowhere at all. You could record what you
 * drilled and what happened live, and the app would never show it to you
 * again.
 *
 * The rule it now follows is the same one the log screen follows: a BJJ
 * session is not a strength session with the numbers missing, it is a
 * different shape. What a mat session has is time, rounds, effort and
 * evidence; showing it a volume tile is showing it a column it can never
 * fill.
 */

function minutesBetween(startedAt: string, endedAt: string | null): number {
  if (!endedAt) return 0;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return ms > 0 ? Math.round(ms / 60_000) : 0;
}

export default function BjjSessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { userId } = useAuth();
  const getToken = useAuthToken();

  const [session, setSession] = useState<LocalSession | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);

  const [error, setError] = useState<string | null>(null);
  // True once the server has been asked and had nothing either.
  const [remoteMissing, setRemoteMissing] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');

  const load = useCallback(async () => {
    if (!userId || !id) return;
    try {
      const [s, d] = await Promise.all([
        readLocalSession(userId, id),
        readLocalBjjDetail(userId, id),
      ]);
      setSession(s);
      setDetail(d);

      // The blob is local-only: the pull writes the session row but not
      // `bjj_json`, so after a reinstall or on a second device a reflection
      // the SERVER is holding reads as "nothing recorded" — the same
      // write-only failure this screen exists to fix, displaced one device
      // over. Fall back to the API and cache what comes back, so the next
      // open is offline-fast and the wizard can edit it.
      if (!d) {
        setRemoteMissing(false);
        try {
          const { detail: fromServer } = await getDetail(getToken, id);
          setDetail(fromServer);
          await saveLocalBjjDetail(userId, id, fromServer);
        } catch {
          // Offline, or genuinely no reflection. Either way the floor still
          // rendered; `remoteMissing` only decides which sentence shows.
          setRemoteMissing(true);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userId, id, getToken]);

  // On focus, not just on mount: the whole point of this screen is that the
  // wizard is reachable from it, and coming back from an edit to the numbers
  // you just changed still showing the old ones would read as the edit having
  // been lost — which is the exact class of doubt this screen exists to fix.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Technique names for the drilled chips. Best-effort and non-blocking: the
  // reflection stores ids, and a cold offline launch has no catalog — the
  // chips fall back to the id rather than the section vanishing, because
  // "you drilled 3 things but we can't name them" is still worth showing.
  useEffect(() => {
    let cancelled = false;
    fetchTechniques(getToken)
      .then((list) => {
        if (!cancelled) setTechniques(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  /**
   * Delete and Finish, which live here because nothing else offers them.
   *
   * Both had exactly one call site in the app — the strength session screen —
   * and routing BJJ away from it silently removed them. A double-logged class
   * would have been permanent on the phone, still feeding mat time and the
   * consistency grid, with no way to remove it.
   */
  function confirmDelete() {
    if (!userId || !id) return;
    Alert.alert('Delete this session?', 'It will be removed everywhere, not just on this phone.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            await deleteLocalSession(userId, id);
            requestSync('bjj-session-deleted');
            router.back();
          })();
        },
      },
    ]);
  }

  async function finishNow() {
    if (!userId || !id) return;
    await finishLocalSession(userId, id);
    await load();
    requestSync('bjj-session-finished');
  }

  async function commitRename() {
    if (!userId || !id) return;
    const ok = await renameLocalSession(userId, id, draftName);
    setRenaming(false);
    if (ok) {
      await load();
      requestSync('bjj-session-renamed');
    }
  }

  if (loading) {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Session' }} />
        <ActivityIndicator accessibilityLabel="Loading your session" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centre} testID="bjj-session-missing">
        <Stack.Screen options={{ title: 'Session' }} />
        <Text style={styles.centreTitle}>This session isn’t on this device</Text>
        <Text style={styles.centreMuted}>
          It may have been logged elsewhere and not synced here yet.
        </Text>
      </View>
    );
  }

  const minutes = minutesBetween(session.started_at, session.ended_at);
  const rolling = detail ? rollingMinutes(detail) : 0;
  const kindLabel = detail ? (KINDS.find((k) => k.key === detail.kind)?.label ?? detail.kind) : '';

  const drilled = (detail?.tags ?? []).filter((t) => t.event === 'drilled');
  // Every technique with evidence, drilled or not — the same union the wizard's
  // live step takes, and for the same reason. Keyed off the drilled list alone,
  // a technique tried live but not drilled today showed NOWHERE: saved, synced,
  // and invisible. Reachable without a focus list even existing — remove a
  // drilled chip and its attempted/scored rows deliberately survive.
  const techniqueRows = useMemo(() => {
    const ids: string[] = [];
    for (const t of detail?.tags ?? []) {
      if (!t.technique_id) continue;
      if (t.event === 'conceded') continue;
      if (!ids.includes(t.technique_id)) ids.push(t.technique_id);
    }
    return ids;
  }, [detail?.tags]) as string[];
  // `scored` here is untagged only, mirroring the wizard's tagCount. The
  // category grid is fed by the wizard's live step, which writes untagged
  // rows; counting the drilled step's per-technique outcomes as well would
  // make this screen report a bigger number than the wizard shows for the
  // same session, with nothing to explain the gap.
  //
  // `conceded` is NOT filtered that way, and the asymmetry is deliberate. No
  // screen in this app can author a technique-tagged conceded row — the API
  // accepts one and removeDrilledTechnique goes out of its way to preserve
  // one — so filtering it here would leave it with no display surface
  // anywhere: saved, synced, and invisible. There is no editor for it to
  // disagree with, so the grid is the honest place for it.
  const live = (detail?.tags ?? []).filter(
    (t) => t.event === 'conceded' || (!t.technique_id && t.event === 'scored'),
  );
  const summary = detail
    ? [kindLabel, detail.gi === null ? null : detail.gi ? 'Gi' : 'No-gi', detail.academy || null]
        .filter(Boolean)
        .join(' · ')
    : '';
  const hasAnyDetail =
    drilled.length + live.length + techniqueRows.length > 0 ||
    !!detail?.note ||
    !!detail?.body_note ||
    !!detail?.academy ||
    detail?.session_rpe != null ||
    detail?.gi != null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.body} testID="bjj-session-screen">
      <Stack.Screen options={{ title: 'Session' }} />

      {/* Name, and the ability to change it. The default comes from the kind,
          which is right until the session was a seminar or a comp class. */}
      {renaming ? (
        <RNView style={styles.renameRow}>
          <TextInput
            value={draftName}
            onChangeText={setDraftName}
            autoFocus
            selectTextOnFocus
            style={styles.renameInput}
            placeholder="Session name"
            placeholderTextColor={vola.textMuted}
            // Matches the server's maxNameLen. A longer name is a permanent
            // 400, and a permanent rejection on the push path strands the row.
            maxLength={120}
            returnKeyType="done"
            onSubmitEditing={commitRename}
            accessibilityLabel="Session name"
            testID="bjj-session-name-input"
          />
          <Pressable onPress={commitRename} hitSlop={10} accessibilityRole="button" testID="bjj-session-name-save">
            <Text style={styles.renameAction}>Save</Text>
          </Pressable>
        </RNView>
      ) : (
        <Pressable
          onPress={() => {
            setDraftName(session.name);
            setRenaming(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${session.name}. Rename this session`}
          testID="bjj-session-rename"
        >
          <Text style={styles.title}>{session.name}</Text>
          <Text style={styles.renameHint}>Tap to rename</Text>
        </Pressable>
      )}

      <Text style={styles.when}>
        {new Date(session.started_at).toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
      </Text>

      {/* The numbers a mat session actually has. Deliberately not a volume
          tile — see the file header. */}
      <RNView style={styles.stats}>
        <Stat value={minutes > 0 ? `${minutes}` : '—'} unit="min on the mat" />
        <Stat value={rolling > 0 ? `${rolling}` : '—'} unit="min rolling" />
        <Stat
          value={detail?.session_rpe ? `${detail.session_rpe}` : '—'}
          unit={detail?.session_rpe ? describeRPE(detail.session_rpe).toLowerCase() : 'effort'}
        />
      </RNView>

      {/* Only when it says something the title doesn't. The name defaults to
          the kind, so an un-renamed session with no gi answer and no academy
          would otherwise render "Class" directly under "Class". */}
      {summary !== '' && summary !== session.name && (
        <Text style={styles.summary}>{summary}</Text>
      )}

      {techniqueRows.length > 0 && (
        <Section title="Techniques">
          <RNView style={styles.chips}>
            {techniqueRows.map((techniqueID) => {
              // The funnel, read back. Without these numbers `attempted` would
              // be written by the wizard and displayed nowhere — the exact
              // defect this feature exists to fix, recreated one screen along.
              const wasDrilled = drilled.some((d) => d.technique_id === techniqueID);
              const name = techniques.find((x) => x.id === techniqueID)?.name ?? techniqueID;
              const tried = techniqueOutcomeCount(detail?.tags ?? [], techniqueID, 'attempted');
              const landed = techniqueOutcomeCount(detail?.tags ?? [], techniqueID, 'scored');
              return (
                <RNView key={techniqueID} style={styles.chip}>
                  <Text style={styles.chipText}>{name}</Text>
                  <Text style={styles.chipFunnel}>
                    {/* "Drilled" is now one fact among several rather than the
                        thing that puts a technique on this screen at all. */}
                    {wasDrilled && 'drilled'}
                    {wasDrilled && tried + landed > 0 ? ' · ' : ''}
                    {tried > 0 && `${tried} tried`}
                    {landed > 0 && tried > 0 ? ' · ' : ''}
                    {landed > 0 && <Text style={styles.scored}>{landed} landed</Text>}
                  </Text>
                </RNView>
              );
            })}
          </RNView>
        </Section>
      )}

      {live.length > 0 && (
        <Section title="What happened live">
          <RNView style={styles.liveRow}>
            <Text style={styles.liveLabel} />
            <Text style={styles.liveHead}>you</Text>
            <Text style={styles.liveHead}>them</Text>
          </RNView>
          {LIVE_ROWS.map((row) => {
            const scored = live
              .filter((t) => t.category === row.category && t.event === 'scored')
              .reduce((n, t) => n + t.count, 0);
            const conceded = live
              .filter((t) => t.category === row.category && t.event === 'conceded')
              .reduce((n, t) => n + t.count, 0);
            if (scored === 0 && conceded === 0) return null;
            return (
              <RNView key={row.category} style={styles.liveRow}>
                <Text style={styles.liveLabel}>{row.label}</Text>
                <Text style={[styles.liveNum, styles.scored]}>{scored || '—'}</Text>
                <Text style={[styles.liveNum, styles.conceded]}>{conceded || '—'}</Text>
              </RNView>
            );
          })}
        </Section>
      )}

      {!!detail?.note && (
        <Section title="Note">
          <Text style={styles.note}>{detail.note}</Text>
        </Section>
      )}
      {!!detail?.body_note && (
        <Section title="Body">
          <Text style={styles.note}>{detail.body_note}</Text>
        </Section>
      )}

      {/* The way back in. Without this the wizard is a one-way door: it is
          reached by `replace` from the log screen and nothing else links to
          it, so a session logged with "Log it" could never gain detail and a
          mis-tapped counter could never be corrected. */}
      <Pressable
        onPress={() => router.push({ pathname: '/bjj/reflect/[id]', params: { id: session.id } })}
        style={styles.cta}
        accessibilityRole="button"
        testID="bjj-session-edit-detail"
      >
        <Text style={styles.ctaText}>
          {drilled.length + live.length > 0 ? 'Edit detail' : 'Add detail'}
        </Text>
      </Pressable>

      {/* Only for a session with no end time. A BJJ session is normally
          logged complete, so this is the recovery path for one that was not —
          without it, Today's "in progress" card opens a screen with no way to
          close the session. */}
      {!session.ended_at && (
        <Pressable
          onPress={finishNow}
          style={styles.cta}
          accessibilityRole="button"
          testID="bjj-session-finish"
        >
          <Text style={styles.ctaText}>Finish this session</Text>
        </Pressable>
      )}

      <Pressable
        onPress={confirmDelete}
        style={styles.destructive}
        accessibilityRole="button"
        testID="bjj-session-delete"
      >
        <Text style={styles.destructiveText}>Delete session</Text>
      </Pressable>

      {/* Counts EVERY field the wizard writes, not just the tags: skipping
          both tag steps and typing a body note used to render the note above
          and "no detail recorded" beneath it, on the screen built to answer
          "I can't see any logs I've entered". */}
      {!hasAnyDetail && (
        <Text style={styles.footnote}>
          {remoteMissing
            ? 'No detail recorded — the session still counts. Add it any time; there’s no window that closes.'
            : 'Detail hasn’t reached this device yet. It’s safe on the server; pull to refresh once you have signal.'}
        </Text>
      )}
      {!!error && <Text style={styles.footnote}>Couldn’t load everything: {error}</Text>}
    </ScrollView>
  );
}

function Stat({ value, unit }: { value: string; unit: string }) {
  return (
    <RNView style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statUnit}>{unit}</Text>
    </RNView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <RNView style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: vola.bg },
  body: { padding: 20, paddingBottom: 48, gap: 4 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  centreTitle: { fontSize: 18, fontWeight: '700', color: vola.text, textAlign: 'center' },
  centreMuted: { fontSize: 14, color: vola.textMuted, textAlign: 'center' },

  title: { fontSize: 28, fontWeight: '800', color: vola.text },
  renameHint: { fontSize: 12, color: vola.textMuted, marginTop: 2 },
  when: { fontSize: 14, color: vola.textMuted, marginBottom: 16 },

  renameRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  renameInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
    color: vola.text,
    borderBottomWidth: 2,
    borderBottomColor: vola.lime,
    paddingVertical: 6,
    minHeight: 44,
  },
  renameAction: { fontSize: 16, fontWeight: '700', color: vola.lime },

  stats: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  stat: {
    flex: 1,
    backgroundColor: vola.surface,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 12,
    gap: 2,
  },
  statValue: { fontSize: 26, fontWeight: '800', color: vola.text },
  statUnit: { fontSize: 12, color: vola.textMuted },

  summary: { fontSize: 15, color: vola.text, marginBottom: 8 },

  section: { marginTop: 20, gap: 10 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    color: vola.textMuted,
    textTransform: 'uppercase',
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: vola.surface,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: { fontSize: 14, color: vola.text },
  // The funnel numbers under the technique name. Muted by default because
  // the technique is what the eye is scanning for; `landed` picks up the
  // scored accent so the good half is findable at a glance.
  chipFunnel: { fontSize: 12, color: vola.textMuted, marginTop: 2 },

  liveRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  liveLabel: { flex: 1, fontSize: 15, color: vola.text },
  liveNum: { width: 56, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  liveHead: {
    width: 56,
    textAlign: 'center',
    fontSize: 11,
    letterSpacing: 1,
    color: vola.textMuted,
    textTransform: 'uppercase',
  },
  scored: { color: vola.lime },
  conceded: { color: vola.warn },

  note: { fontSize: 15, lineHeight: 22, color: vola.text },

  cta: {
    marginTop: 28,
    backgroundColor: vola.surface,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  ctaText: { fontSize: 16, fontWeight: '700', color: vola.lime },
  destructive: {
    marginTop: 12,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  destructiveText: { fontSize: 15, fontWeight: '600', color: vola.danger },
  footnote: { fontSize: 13, color: vola.textMuted, marginTop: 12, lineHeight: 19 },
});
