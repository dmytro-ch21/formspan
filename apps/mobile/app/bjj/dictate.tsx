/**
 * Say what happened, and correct what comes back.
 *
 * ## Why this screen exists
 *
 * N33 shipped `POST /v1/bjj/reflect/draft` and nothing an athlete could touch.
 * A server route is not a feature — the third time that pattern appeared in one
 * day, after N42's catalog with no mobile search and N7's identify with no
 * camera. This is the surface.
 *
 * ## A draft, never a session
 *
 * Nothing is written until the athlete taps Save. What comes back arrives
 * editable, and the two things most likely to be wrong — the counts, and any
 * technique the words did not pin down — are put where the eye goes rather than
 * behind a disclosure. Same rule N26 set for describing a meal, and the same
 * reason: a confident-looking wrong number is worse than an obviously uncertain
 * one, because nobody has cause to check it.
 *
 * ## The counts are the dangerous field
 *
 * N40 measured this class of model flagging what it invents while stating a
 * miscount flatly. "Rolled five" coming back as six is the error that survives
 * review — the item is real, only the number is wrong, and it reads as correct.
 * So every count is a stepper the thumb can reach, not a number to squint at,
 * and anything the server could not hear in the words is shown as blank with
 * the reason beside it rather than filled with a plausible guess.
 *
 * ## Unresolved phrases are never guessed
 *
 * The server validates every technique id against the 542-row catalog and hands
 * back the phrases that pick out more than one entry. **This screen must not
 * undo that by auto-selecting the top match.** A guess arrives pre-ticked,
 * plausible, and one tap from permanent; the picker costs one tap and cannot be
 * wrong. That is the failure N44 was built to avoid and N47 was filed to fix.
 *
 * ## Transcription is on-device
 *
 * The athlete dictates with the system keyboard's own microphone. No audio
 * leaves the phone, nothing is recorded, and there is no audio dependency
 * anywhere in this feature. The *text* does leave, which is a different fact
 * and one the screen states before it sends rather than after.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  KINDS,
  describeRPE,
  type Kind,
  type SessionDetail,
  type Tag,
} from '@/lib/bjjSession';
import {
  MAX_DICTATION_CHARS,
  describeNotice,
  draftErrorMessage,
  draftReflection,
  draftToDetail,
  type Draft,
  type DraftQuota,
  type UnresolvedPhrase,
} from '@/lib/reflectApi';
import { saveLocalBjjDetail, startLocalSession } from '@/lib/sessionStore';
import { request as requestSync } from '@/lib/sync';
import { fetchTechniques, rankTechniques, type TechniqueSummary } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/** The fallback when the athlete never said what kind of session it was. */
const DEFAULT_KIND: Kind = 'class';

/**
 * What a retry in progress says, in one place.
 *
 * Shared by the rendered line and the VoiceOver announcement so the two cannot
 * drift — a screen reader hearing something the screen does not say is its own
 * small bug.
 */
const RETRY_NOTICE = 'Still working on it — trying again.';

export default function DictateReflectionScreen() {
  const router = useRouter();
  const accent = useAccent();
  const getToken = useAuthToken();
  const { userId } = useAuth();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // A retry in flight is NOT an error state, and keeping the two apart is most
  // of N118: what the athlete met was a failure they were asked to fix, at a
  // moment the app was perfectly capable of fixing it itself.
  const [retrying, setRetrying] = useState(false);
  // A live region is Android-only, so VoiceOver needs telling directly — the
  // pattern `app/sign-in.tsx` and `app/forgot-password.tsx` already use. Said
  // once per attempt: this is reassurance that work is still happening, and
  // repeating it over a two-attempt sequence would be chatter.
  const announceRetry = useCallback(() => {
    setRetrying(true);
    AccessibilityInfo.announceForAccessibility(RETRY_NOTICE);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [quota, setQuota] = useState<DraftQuota | null>(null);

  // The editable copy. Separate from `draft` so the notices and unresolved
  // list keep describing what the MODEL said while the athlete edits away from
  // it — a notice that silently stopped matching the field beside it would be
  // worse than no notice.
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [unresolved, setUnresolved] = useState<UnresolvedPhrase[]>([]);

  // The technique library, fetched ONCE for the whole screen rather than once
  // per unresolved phrase. `fetchTechniques` caches, but only after the first
  // call resolves — so N phrases mounting together fired N parallel 197 KB
  // requests before this was hoisted.
  const [catalog, setCatalog] = useState<TechniqueSummary[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);

  const [saving, setSaving] = useState(false);
  // Reuse a session created by a failed attempt rather than minting a second —
  // the trap `log.tsx` documents, where a retry puts the class in history twice.
  const createdRef = useRef<string | null>(null);

  // Loaded when the first phrase might need it, not on mount: most dictations
  // resolve cleanly and never open a picker.
  useEffect(() => {
    if (unresolved.length === 0 || catalog !== null || catalogFailed) return;
    let cancelled = false;
    fetchTechniques(getToken)
      .then((list) => {
        if (!cancelled) setCatalog(list);
      })
      .catch(() => {
        // The phrase stays unresolved, which is the honest outcome — it costs
        // the athlete nothing they had, and the wizard can still add it.
        if (!cancelled) setCatalogFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [unresolved.length, catalog, catalogFailed, getToken]);

  async function read() {
    const said = text.trim();
    if (!said || sending) return;
    setSending(true);
    setRetrying(false);
    setError(null);
    try {
      // `said` is a local copy and `text` is never cleared on any path, so the
      // dictation survives every failure and every retry. Re-recording is not
      // a recovery anybody should be asked for.
      const res = await draftReflection(getToken, said, {
        onRetry: () => announceRetry(),
      });
      setDraft(res.draft);
      setQuota(res.quota);
      setDetail(draftToDetail(res.draft, DEFAULT_KIND));
      setUnresolved(res.draft.unresolved);
    } catch (err) {
      // NEVER `err.message`. The server's prose is written for an API consumer
      // and one sentence of it told an athlete they had spoken badly about a
      // failure that was not theirs — see `draftErrorMessage`.
      setError(draftErrorMessage(err));
    } finally {
      setSending(false);
      setRetrying(false);
    }
  }

  async function save() {
    if (!userId || !detail || saving) return;
    setSaving(true);
    setError(null);
    try {
      let sessionId = createdRef.current;
      if (!sessionId) {
        // Rounds × length is the honest duration when it was said; an hour is
        // the fallback, and the athlete can fix it in the wizard. `ended_at`
        // has to be set either way — history derives every duration from it,
        // and a BJJ session without one contributes nothing to mat time.
        const minutes =
          detail.rounds && detail.round_minutes ? detail.rounds * detail.round_minutes : 60;
        const startedAt = new Date(Date.now() - minutes * 60_000);
        const session = await startLocalSession(userId, {
          sport: 'bjj',
          name: KINDS.find((k) => k.key === detail.kind)?.label ?? 'BJJ',
          started_at: startedAt.toISOString(),
          ended_at: new Date().toISOString(),
        });
        sessionId = session.id;
        createdRef.current = sessionId;
      }
      await saveLocalBjjDetail(userId, sessionId, detail);
      requestSync('bjj-dictated');
      // Into the ordinary wizard, so what was dictated is corrected with the
      // same controls as anything typed. There is no separate "review a
      // dictated session" surface, deliberately.
      router.replace({ pathname: '/bjj/reflect/[id]', params: { id: sessionId } });
    } catch {
      // Local storage, not the network — so no transport wording, and no raw
      // SQLite text either. The draft on screen is untouched by a failed save.
      setError('Couldn’t save that just now. Your draft is still here — try Save again.');
      setSaving(false);
    }
  }

  function patch(next: Partial<SessionDetail>) {
    setDetail((d) => (d ? { ...d, ...next } : d));
  }

  function setTagCount(i: number, count: number) {
    setDetail((d) =>
      d ? { ...d, tags: d.tags.map((t, n) => (n === i ? { ...t, count } : t)) } : d,
    );
  }

  function dropTag(i: number) {
    setDetail((d) => (d ? { ...d, tags: d.tags.filter((_, n) => n !== i) } : d));
  }

  /** Resolving a phrase adds the tag it was always going to be. */
  const resolvePhrase = useCallback((p: UnresolvedPhrase, t: TechniqueSummary) => {
    setDetail((d) =>
      d
        ? {
            ...d,
            tags: [
              ...d.tags,
              {
                category: p.category,
                event: p.event,
                position: '',
                technique_id: t.id,
                count: 1,
              } as Tag,
            ],
          }
        : d,
    );
    setUnresolved((list) => list.filter((x) => x !== p));
  }, []);

  const dismissPhrase = useCallback((p: UnresolvedPhrase) => {
    setUnresolved((list) => list.filter((x) => x !== p));
  }, []);

  return (
    <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
      <Stack.Screen options={{ title: 'Say what happened' }} />

      {!draft && (
        <>
          <Text style={styles.lead}>
            Tap the microphone on your keyboard and talk through the session — what you drilled,
            what worked, what kept happening to you.
          </Text>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={MAX_DICTATION_CHARS}
            placeholder="Hour of gi. Drilled the knee cut, then five rounds. Swept the big guy twice from half guard, got armbarred once from mount…"
            placeholderTextColor={vola.textDim}
            editable={!sending}
            accessibilityLabel="What happened in the session"
          />
          {/* Before it is sent, not after: a privacy consequence discovered
              afterwards is not a choice the athlete made. The distinction that
              matters is that the RECORDING never leaves — the transcription is
              the keyboard's, on the phone — and the words do. */}
          <Text style={styles.disclosure}>
            Your keyboard does the listening on this phone — no audio is recorded or sent. The
            words you end up with are sent to an AI service to be read into chips.
          </Text>
          <Pressable
            onPress={read}
            disabled={!text.trim() || sending}
            style={[
              styles.primary,
              { backgroundColor: accent.ink },
              (!text.trim() || sending) && styles.disabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Read what I said"
          >
            {sending ? (
              <ActivityIndicator color={vola.bg} />
            ) : (
              <Text style={styles.primaryLabel}>Read it</Text>
            )}
          </Pressable>
          {/* Said only once a first attempt has already failed, so the ordinary
              case never sees it. Not styled as an error, because it is not one
              — the athlete has nothing to do and nothing has gone wrong yet. */}
          {retrying && (
            <Text
              style={styles.muted}
              testID="dictate-retrying"
              accessibilityLiveRegion="polite"
            >
              {RETRY_NOTICE}
            </Text>
          )}
        </>
      )}

      {error && (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* A well-formed answer with nothing in it. Distinct from an error, and
          distinct from an empty confirm screen that looks like it worked. */}
      {draft?.empty && (
        <View style={styles.card} testID="dictate-empty">
          <Text style={styles.emptyTitle}>Nothing was picked up from that</Text>
          {/* A 200 with nothing in it — the draft was spent, so this is NOT
              retried automatically. The wording still had to change: "try again
              with what you drilled" reads as *you left that out*, and the same
              words often come back with a session in them on the next pass. */}
          <Text style={styles.muted}>
            It didn’t come back as a session this time. You can send the same words again, or log
            it by hand instead.
          </Text>
          <Pressable
            onPress={() => {
              setDraft(null);
              setDetail(null);
            }}
            style={styles.secondary}
            accessibilityRole="button"
            accessibilityLabel="Try saying it again"
          >
            <Text style={[styles.secondaryLabel, { color: accent.ink }]}>Try again</Text>
          </Pressable>
          {/* An empty draft still spent one. Inviting a retry without saying so
              sends the athlete into a 429 they had no way to see coming. */}
          <QuotaLine quota={quota} />
        </View>
      )}

      {draft && !draft.empty && detail && (
        <>
          <Text style={styles.lead}>
            Here’s what we heard. Check the numbers — they’re the part most worth a second look.
          </Text>

          <SectionHeader label="The session" />
          <View style={styles.card}>
            <Row label="Type">
              <View style={styles.chips}>
                {KINDS.map((k) => (
                  <Pressable
                    key={k.key}
                    onPress={() => patch({ kind: k.key })}
                    style={[
                      styles.chip,
                      detail.kind === k.key && { backgroundColor: accent.ink, borderColor: accent.ink },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: detail.kind === k.key }}
                  >
                    <Text style={[styles.chipLabel, detail.kind === k.key && { color: vola.bg }]}>
                      {k.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </Row>
            <Row label="Gi">
              <View style={styles.chips}>
                {[
                  { v: true, label: 'Gi' },
                  { v: false, label: 'No-gi' },
                ].map((o) => (
                  <Pressable
                    key={o.label}
                    onPress={() => patch({ gi: detail.gi === o.v ? null : o.v })}
                    style={[
                      styles.chip,
                      detail.gi === o.v && { backgroundColor: accent.ink, borderColor: accent.ink },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: detail.gi === o.v }}
                  >
                    <Text style={[styles.chipLabel, detail.gi === o.v && { color: vola.bg }]}>
                      {o.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </Row>
            <Stepper
              label="Rounds"
              value={detail.rounds}
              onChange={(v) => patch({ rounds: v })}
              max={40}
            />
            <Stepper
              label="Minutes a round"
              value={detail.round_minutes}
              onChange={(v) => patch({ round_minutes: v })}
              max={30}
            />
            <Stepper
              label="How hard"
              value={detail.session_rpe}
              onChange={(v) => patch({ session_rpe: v })}
              max={10}
              hint={detail.session_rpe ? describeRPE(detail.session_rpe) : undefined}
            />
          </View>

          {/* The model's changes, in the athlete's words. Shown rather than
              swallowed — "we couldn't find that number in what you said" is
              something you can act on; a blank field is just blank. */}
          {draft.notices.length > 0 && (
            <>
              <SectionHeader label="What we changed" />
              <View style={styles.card} testID="dictate-notices">
                {draft.notices.map((n, i) => (
                  <Text key={`${n.field}-${i}`} style={styles.notice}>
                    {describeNotice(n)}
                  </Text>
                ))}
              </View>
            </>
          )}

          {unresolved.length > 0 && (
            <>
              <SectionHeader label="Which one did you mean?" />
              {unresolved.map((p, i) => (
                <PickOne
                  key={`${p.phrase}-${i}`}
                  phrase={p}
                  catalog={catalog}
                  failed={catalogFailed}
                  onPick={(t) => resolvePhrase(p, t)}
                  onSkip={() => dismissPhrase(p)}
                />
              ))}
            </>
          )}

          {detail.tags.length > 0 && (
            <>
              <SectionHeader label="What happened" />
              <View style={styles.card}>
                {detail.tags.map((t, i) => (
                  <TagRow
                    key={i}
                    tag={t}
                    onCount={(c) => setTagCount(i, c)}
                    onRemove={() => dropTag(i)}
                  />
                ))}
              </View>
            </>
          )}

          {/* Gated on what the MODEL extracted, never on the live value —
              gating on `detail.note` unmounted the field the moment the athlete
              backspaced it empty, dropping the keyboard mid-edit with no way to
              bring the section back. */}
          {!!draft.note && (
            <>
              <SectionHeader label="Note" />
              <View style={styles.card}>
                <TextInput
                  style={styles.noteInput}
                  value={detail.note}
                  onChangeText={(v) => patch({ note: v })}
                  multiline
                  accessibilityLabel="Session note"
                />
              </View>
            </>
          )}

          {/* Shown for the same reason the note is: this screen's premise is
              that everything it saves arrived editable. A body note the model
              pulled out — "knee popped in round three" — is exactly the kind of
              thing that must not be written sight-unseen. */}
          {!!draft.body_note && (
            <>
              <SectionHeader label="Body" />
              <View style={styles.card}>
                <TextInput
                  style={styles.noteInput}
                  value={detail.body_note}
                  onChangeText={(v) => patch({ body_note: v })}
                  multiline
                  accessibilityLabel="Note about your body"
                />
              </View>
            </>
          )}

          <Pressable
            onPress={save}
            disabled={saving}
            style={[styles.primary, { backgroundColor: accent.ink }, saving && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel="Save this session"
          >
            {saving ? (
              <ActivityIndicator color={vola.bg} />
            ) : (
              <Text style={styles.primaryLabel}>Save it</Text>
            )}
          </Pressable>
          <Text style={styles.muted}>
            Nothing’s been saved yet. You can keep correcting this in the next screen.
          </Text>

          <QuotaLine quota={quota} />
        </>
      )}
    </KeyboardAwareScrollView>
  );
}

/** Says how many are left, but only once it is worth saying. */
function QuotaLine({ quota }: { quota: DraftQuota | null }) {
  if (!quota || quota.remaining > 3) return null;
  return (
    <Text style={styles.muted} testID="dictate-quota">
      {quota.remaining === 0
        ? 'That was your last one for today.'
        : `${quota.remaining} more of these today.`}
    </Text>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

/**
 * A count, corrected with the thumb.
 *
 * A stepper rather than a keyboard field because this is the value most likely
 * to be quietly wrong and least likely to be checked — see the note at the top
 * on N40. **Blank is a real state**, distinct from zero: it means the athlete
 * never said, and filling it with a plausible number is the exact failure this
 * screen exists to avoid.
 */
function Stepper({
  label,
  value,
  onChange,
  max,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  max: number;
  hint?: string;
}) {
  const accent = useAccent();
  return (
    <View style={styles.row}>
      <View style={styles.rowLabelWrap}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      <View style={styles.stepper}>
        <Pressable
          onPress={() => onChange(value === null || value <= 1 ? null : value - 1)}
          style={styles.stepButton}
          accessibilityRole="button"
          accessibilityLabel={`One fewer ${label}`}
        >
          <Text style={styles.stepGlyph}>−</Text>
        </Pressable>
        <Text
          style={[styles.stepValue, value === null && styles.stepBlank]}
          accessibilityLabel={value === null ? `${label}: not set` : `${label}: ${value}`}
        >
          {value === null ? '—' : value}
        </Text>
        <Pressable
          onPress={() => onChange(Math.min(max, (value ?? 0) + 1))}
          style={styles.stepButton}
          accessibilityRole="button"
          accessibilityLabel={`One more ${label}`}
        >
          <Text style={[styles.stepGlyph, { color: accent.ink }]}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function TagRow({
  tag,
  onCount,
  onRemove,
}: {
  tag: Tag;
  onCount: (c: number) => void;
  onRemove: () => void;
}) {
  // Named, because with three tags "One fewer" × 3 is three indistinguishable
  // buttons to anyone using a screen reader.
  const title = `${tag.event} ${tag.category}${tag.position ? ` · ${tag.position}` : ''}`;
  return (
    <View style={styles.tagRow}>
      <View style={styles.tagText}>
        <Text style={styles.tagTitle}>{title}</Text>
      </View>
      <View style={styles.stepper}>
        <Pressable
          onPress={() => (tag.count <= 1 ? onRemove() : onCount(tag.count - 1))}
          style={styles.stepButton}
          accessibilityRole="button"
          accessibilityLabel={tag.count <= 1 ? `Remove ${title}` : `One fewer ${title}`}
        >
          <Text style={styles.stepGlyph}>−</Text>
        </Pressable>
        <Text style={styles.stepValue} accessibilityLabel={`${tag.count} ${title}`}>
          {tag.count}
        </Text>
        <Pressable
          onPress={() => onCount(tag.count + 1)}
          style={styles.stepButton}
          accessibilityRole="button"
          accessibilityLabel={`One more ${title}`}
        >
          <Text style={styles.stepGlyph}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * A phrase that names more than one technique.
 *
 * **Nothing is pre-selected, and the list is not narrowed to one.** The server
 * deliberately declined to guess; picking the top match here would put the
 * guess back and make it look like the athlete's own answer.
 */
function PickOne({
  phrase,
  catalog,
  failed,
  onPick,
  onSkip,
}: {
  phrase: UnresolvedPhrase;
  /** null while the library is still loading. */
  catalog: TechniqueSummary[] | null;
  failed: boolean;
  onPick: (t: TechniqueSummary) => void;
  onSkip: () => void;
}) {
  const accent = useAccent();

  // Memoised on the phrase and the library, not recomputed on every parent
  // render — otherwise this re-ranks 542 entries per keystroke in the note
  // field, times the number of unresolved phrases.
  const matches = useMemo(
    () => (catalog ? rankTechniques(catalog, phrase.phrase).slice(0, 6) : []),
    [catalog, phrase.phrase],
  );

  /**
   * Three different states, told apart.
   *
   * They were one `matches.length === 0` branch reading "couldn't load the
   * library", which was wrong in two of the three: it flashed during every
   * first load, and it was permanently wrong when the library HAD loaded and
   * the client's ranker simply scored nothing — the server's matcher and
   * `rankTechniques` are different algorithms and nothing makes them agree.
   * Saying the wrong reason is worse than saying none, because it sends the
   * athlete to fix a connection that is fine.
   */
  let body: React.ReactNode;
  if (failed) {
    body = (
      <Text style={styles.muted}>
        Couldn’t load the library just now. You can add this in the next screen.
      </Text>
    );
  } else if (catalog === null) {
    body = <ActivityIndicator accessibilityLabel="Loading the technique library" />;
  } else if (matches.length === 0) {
    body = (
      <Text style={styles.muted}>
        Nothing in the library matches that. You can add it in the next screen.
      </Text>
    );
  } else {
    body = (
      <>
        {matches.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => onPick(t)}
            style={styles.pickOption}
            accessibilityRole="button"
            accessibilityLabel={`${t.name}, for “${phrase.phrase}”`}
          >
            <Text style={styles.pickOptionLabel}>{t.name}</Text>
          </Pressable>
        ))}
      </>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.pickPrompt}>
        You said <Text style={styles.pickPhrase}>“{phrase.phrase}”</Text> — which one?
      </Text>
      {body}
      <Pressable
        onPress={onSkip}
        style={styles.secondary}
        accessibilityRole="button"
        accessibilityLabel={`Skip “${phrase.phrase}”`}
      >
        <Text style={[styles.secondaryLabel, { color: accent.ink }]}>Skip this one</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 12, paddingBottom: 64 },
  lead: { color: vola.textMuted, fontSize: 14, lineHeight: 21 },
  input: {
    minHeight: 140,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    color: vola.text,
    fontSize: 16,
    lineHeight: 23,
    textAlignVertical: 'top',
  },
  noteInput: {
    minHeight: 70,
    color: vola.text,
    fontSize: 15,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
  disclosure: { color: vola.textDim, fontSize: 12, lineHeight: 18 },
  primary: { borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 4 },
  primaryLabel: { color: vola.bg, fontSize: 16, fontWeight: '800' },
  disabled: { opacity: 0.5 },
  secondary: { paddingVertical: 10, alignItems: 'center' },
  secondaryLabel: { fontSize: 14, fontWeight: '700' },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 12,
  },
  errorCard: {
    borderWidth: 1,
    borderColor: vola.danger,
    borderRadius: 14,
    padding: 14,
  },
  errorText: { color: vola.danger, fontSize: 14, lineHeight: 20 },
  emptyTitle: { fontSize: 16, fontWeight: '800' },
  muted: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
  notice: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowLabelWrap: { flexShrink: 1 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  rowHint: { color: vola.textDim, fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, flexShrink: 1, justifyContent: 'flex-end' },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipLabel: { fontSize: 13, fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepButton: { paddingHorizontal: 14, paddingVertical: 6 },
  stepGlyph: { fontSize: 20, fontWeight: '800' },
  stepValue: { fontSize: 17, fontWeight: '800', minWidth: 34, textAlign: 'center' },
  stepBlank: { color: vola.textDim },
  tagRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  tagText: { flexShrink: 1 },
  tagTitle: { fontSize: 14, fontWeight: '600', textTransform: 'capitalize' },
  pickPrompt: { fontSize: 15, lineHeight: 22 },
  pickPhrase: { fontWeight: '800' },
  pickOption: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  pickOptionLabel: { fontSize: 15, fontWeight: '600' },
});
