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
 *
 * ## This screen is where a dictated session ends (N120/#509)
 *
 * It used to save the draft and then `router.replace` into the ordinary
 * three-step wizard (`/bjj/reflect/[id]`) "so what was dictated is corrected
 * with the same controls as anything typed" — a real design decision, not an
 * oversight, and the wrong one anyway: the athlete had already said the
 * rounds, the gi, what was drilled and what happened live, and out loud is
 * not typed. Routing into a wizard that asks for all of it again is the
 * literal bug this ticket reports — *"once we do the verbal log … it should
 * be enough. If we log by audio this should fill everything and we should be
 * done."*
 *
 * So this screen now carries editing surfaces for everything the wizard's
 * three steps would ask about — including two the confirm screen never had:
 * adding a technique the model missed entirely (below the tag list, matching
 * the wizard's own search-and-add pattern), and correcting what a tag's
 * `event` actually was (drilled/attempted/scored/conceded/defended — a chip
 * row under each tag). Save lands on the session's own read view
 * (`/bjj/session/[id]`), not back in the wizard. **The wizard is not
 * removed** — that screen's own "Add detail" button still opens it, exactly
 * as it does for a session logged by hand — it is just never entered
 * automatically for a dictated one any more. Draft-then-confirm is
 * unchanged throughout: nothing above is written until Save is tapped.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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
import { LibraryTile, categoryBadge } from '@/components/LibraryTile';
import { Text } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { backdatedTimestamp } from '@/lib/calendar';
import {
  KINDS,
  describeRPE,
  familyOf,
  toCategory,
  type Event,
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
  uncertainCountFlags,
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
  /**
   * Carried through from `/bjj/log` when this is backfilling a missed
   * session (N434/#721) rather than dictating today's — see that screen's
   * own `date` comment. Absent on the ordinary path.
   */
  const { date } = useLocalSearchParams<{ date?: string }>();

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
  // Parallel to `detail.tags`, index for index — NOT part of `detail` itself,
  // because `Tag` is the shared domain type the manual wizard also writes and
  // this is purely a "did the athlete confirm this number" flag for the
  // dictation screen. Kept in step with `detail.tags` by every operation that
  // resizes it: `setTagCount` clears an index, `dropTag` splices one out,
  // `resolvePhrase` appends `false` for the freshly-picked tag. See N121/#510:
  // a count the server could not verify (floored to 1 rather than left null,
  // because `Tag.count` has no null to floor TO) used to render identically to
  // a count the athlete actually said was 1 — this is what tells them apart.
  const [countUncertain, setCountUncertain] = useState<boolean[]>([]);

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

  // Loaded once the confirm screen has a real draft to show, not on mount:
  // most of this screen (the dictation box, an empty-draft result) never
  // needs the catalog at all.
  //
  // Gated on `detail !== null` — a BOOLEAN, not the `detail` object itself —
  // on purpose. `detail` gets a new reference on every keystroke and every
  // tap (`patch`, `setTagCount`, …), and this effect must fire once per
  // draft, not once per edit: N120/#509 made this the trigger for BOTH the
  // unresolved-phrase picker and the always-present "add a technique"
  // search below, so a second cause for the old N-parallel-requests bug this
  // comment used to warn about (see history.md) would be easy to reintroduce
  // here by depending on the object instead of the transition into having one.
  useEffect(() => {
    if (detail === null || catalog !== null || catalogFailed) return;
    let cancelled = false;
    fetchTechniques(getToken)
      .then((list) => {
        if (!cancelled) setCatalog(list);
      })
      .catch(() => {
        // The phrase stays unresolved and the search stays unusable, which is
        // the honest outcome — it costs the athlete nothing they had, and the
        // wizard can still add a technique by hand.
        if (!cancelled) setCatalogFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `detail !== null` is the intended trigger, not `detail` itself; see the comment above.
  }, [detail !== null, catalog, catalogFailed, getToken]);

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
      setCountUncertain(uncertainCountFlags(res.draft));
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
        // N434/#721 — same rule as `log.tsx`'s own `commit`: `date` absent
        // means `endBase` is real "now", so this is byte-identical to before
        // this ticket touched the file on the ordinary path.
        const endBase = date ? backdatedTimestamp(date, new Date()) : new Date();
        const startedAt = new Date(endBase.getTime() - minutes * 60_000);
        const session = await startLocalSession(userId, {
          sport: 'bjj',
          name: KINDS.find((k) => k.key === detail.kind)?.label ?? 'BJJ',
          started_at: startedAt.toISOString(),
          ended_at: endBase.toISOString(),
        });
        sessionId = session.id;
        createdRef.current = sessionId;
      }
      await saveLocalBjjDetail(userId, sessionId, detail);
      requestSync('bjj-dictated');
      // N120/#509: NOT the wizard any more — this screen's own doc comment
      // explains why. The session's read view is where a manually-logged
      // session lands too when the athlete goes on to add detail, and it is
      // where the wizard is still reachable from ("Add detail"/"Edit
      // detail"), unconditionally, for anyone who wants to correct this
      // later.
      router.replace({ pathname: '/bjj/session/[id]', params: { id: sessionId } });
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
    // The athlete just chose a number with their thumb, so whatever the model
    // guessed no longer matters — this is now confirmed the ordinary way.
    setCountUncertain((flags) => flags.map((f, n) => (n === i ? false : f)));
  }

  function dropTag(i: number) {
    setDetail((d) => (d ? { ...d, tags: d.tags.filter((_, n) => n !== i) } : d));
    setCountUncertain((flags) => flags.filter((_, n) => n !== i));
  }

  /**
   * Correct what a tag actually was.
   *
   * N120/#509: the model's read on drilled vs. attempted vs. scored vs.
   * conceded vs. defended is a judgement call exactly like the count above,
   * and getting it wrong is exactly as invisible — a technique correctly
   * named under the wrong outcome reads as right on this screen and lands
   * wrong in the funnel. The count is unaffected; only what happened
   * changes.
   */
  function setTagEvent(i: number, event: Event) {
    setDetail((d) =>
      d ? { ...d, tags: d.tags.map((t, n) => (n === i ? { ...t, event } : t)) } : d,
    );
  }

  /**
   * A technique the dictation never named at all.
   *
   * `resolvePhrase` above answers the model naming something it could not
   * pin to one catalog entry. This answers the other gap N120/#509 found:
   * something the athlete drilled or rolled that the transcript's picture
   * never contained in the first place. Without this the only way to add it
   * was the wizard this screen no longer routes into — which would have put
   * "audio log, then correct in the wizard" back under a different name.
   *
   * Added as `drilled`, the same default the wizard's own search-and-add
   * uses for a technique picked by name rather than named in an exchange;
   * the event chips on the tag below correct it from there. Guarded the same
   * way the wizard guards its own picker — against adding the identical
   * technique twice as `drilled`, which would double the funnel's first
   * stage for one real repetition — but only a `drilled` duplicate: the same
   * technique already recorded as `scored` is a different fact and adding it
   * as `drilled` too is not a mistake.
   */
  function addManualTechnique(t: TechniqueSummary) {
    let added = false;
    setDetail((d) => {
      if (!d) return d;
      if (d.tags.some((tag) => tag.technique_id === t.id && tag.event === 'drilled')) return d;
      added = true;
      return {
        ...d,
        tags: [
          ...d.tags,
          {
            category: toCategory(t.category),
            event: 'drilled',
            position: familyOf(t.position),
            technique_id: t.id,
            count: 1,
          } as Tag,
        ],
      };
    });
    // Picked by hand, just now — as confirmed as anything the athlete typed.
    if (added) setCountUncertain((flags) => [...flags, false]);
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
    // Appended, not floored — the athlete just picked this technique
    // themselves, so its count is exactly as confirmed as if they had typed it.
    setCountUncertain((flags) => [...flags, false]);
  }, []);

  const dismissPhrase = useCallback((p: UnresolvedPhrase) => {
    setUnresolved((list) => list.filter((x) => x !== p));
  }, []);

  // N434/#721: names the day this backfills in the header, the one place
  // guaranteed visible on every state this screen renders — the draft view,
  // the empty-draft view and the error view all sit under the same Stack
  // header, so this is cheaper than repeating a banner in each.
  const title = date
    ? `Say what happened — ${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      })}`
    : 'Say what happened';

  return (
    <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
      <Stack.Screen options={{ title }} />

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
                    index={i}
                    tag={t}
                    countUncertain={countUncertain[i] ?? false}
                    onCount={(c) => setTagCount(i, c)}
                    onRemove={() => dropTag(i)}
                    onEvent={(e) => setTagEvent(i, e)}
                  />
                ))}
              </View>
            </>
          )}

          {/* N120/#509: something the dictation never named at all, not just
              a phrase it couldn't pin down. Always here, tags or not — a
              session where nothing was picked up from the words but the
              athlete DID drill something must still be able to add it,
              without the wizard this screen no longer routes into. */}
          <SectionHeader label="Add something you did" />
          <View style={styles.card}>
            <AddTechnique
              catalog={catalog}
              failed={catalogFailed}
              existing={detail.tags}
              onAdd={addManualTechnique}
            />
          </View>

          {/* N120/#509: unconditional now, where this used to be gated on
              `draft.note`. The wizard's own note step is always present
              regardless of what was said, and this screen replaces it rather
              than handing off to it — hiding the field whenever dictation
              said nothing about it would leave an athlete who drilled in
              silence no way to add one at all. The placeholder, not a value,
              is what keeps "nothing was said" honest instead of inventing
              text or reading as broken. */}
          <SectionHeader label="Note" />
          <View style={styles.card}>
            <TextInput
              style={styles.noteInput}
              value={detail.note}
              onChangeText={(v) => patch({ note: v })}
              multiline
              placeholder="Nothing said about this — add anything worth remembering"
              placeholderTextColor={vola.textDim}
              accessibilityLabel="Session note"
            />
          </View>

          {/* Same reasoning as the note above, and the same reason it used to
              be shown only some of the time: this screen's premise is that
              everything it saves arrived editable, and that includes a body
              note the athlete never mentioned. */}
          <SectionHeader label="Body" />
          <View style={styles.card}>
            <TextInput
              style={styles.noteInput}
              value={detail.body_note}
              onChangeText={(v) => patch({ body_note: v })}
              multiline
              placeholder="Nothing said — add anything that hurt"
              placeholderTextColor={vola.textDim}
              accessibilityLabel="Note about your body"
            />
          </View>

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
          {/* N120/#509: used to say "in the next screen", true when Save
              always continued into the wizard. It no longer does — this
              screen is the whole correction surface now, and the true
              remaining fact is just that nothing above is written yet. */}
          <Text style={styles.muted}>Nothing’s been saved yet. Everything above is still editable.</Text>

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
  index,
  countUncertain,
  onCount,
  onRemove,
  onEvent,
}: {
  tag: Tag;
  /** Position in `detail.tags` — only used to keep the event chips' testIDs
   *  addressable per row; nothing here reorders or reindexes on its own. */
  index: number;
  /**
   * True when the server floored this count to 1 rather than confirming it —
   * "the athlete never said" and "the athlete said one" are different answers
   * (N121/#510), so this renders as blank rather than as a normal 1 until the
   * athlete's own thumb sets a number.
   */
  countUncertain: boolean;
  onCount: (c: number) => void;
  onRemove: () => void;
  /** N120/#509: what actually happened, correctable — see `setTagEvent`. */
  onEvent: (e: Event) => void;
}) {
  const accent = useAccent();
  // Named, because with three tags "One fewer" × 3 is three indistinguishable
  // buttons to anyone using a screen reader.
  const title = `${tag.event} ${tag.category}${tag.position ? ` · ${tag.position}` : ''}`;
  return (
    <View style={styles.tagBlock}>
      <View style={styles.tagRow}>
        <View style={styles.tagText}>
          <Text style={styles.tagTitle}>{title}</Text>
          {countUncertain && <Text style={styles.rowHint}>How many? We weren’t sure.</Text>}
        </View>
        <View style={styles.stepper}>
          <Pressable
            onPress={() => {
              // Blank confirms downward first — a "−" here means "it happened,
              // but not more than that", which is the floor already on record.
              // Only a second press, once the number is a real one, removes it.
              if (countUncertain) {
                onCount(tag.count);
                return;
              }
              if (tag.count <= 1) onRemove();
              else onCount(tag.count - 1);
            }}
            style={styles.stepButton}
            accessibilityRole="button"
            accessibilityLabel={
              countUncertain ? `Confirm ${title} at ${tag.count}` : tag.count <= 1 ? `Remove ${title}` : `One fewer ${title}`
            }
          >
            <Text style={styles.stepGlyph}>−</Text>
          </Pressable>
          <Text
            style={[styles.stepValue, countUncertain && styles.stepBlank]}
            accessibilityLabel={countUncertain ? `${title}: how many? not set` : `${tag.count} ${title}`}
          >
            {countUncertain ? '—' : tag.count}
          </Text>
          <Pressable
            onPress={() => {
              // Same reasoning as "−": the count is already floored to 1
              // underneath a blank stepper, invisibly. Incrementing THAT (to 2)
              // is not what an athlete tapping "+" once from "—" is asking for
              // — matches the session-level `Stepper`'s own null-count
              // semantics, where "+" from blank also lands on 1, not 2.
              onCount(countUncertain ? tag.count : tag.count + 1);
            }}
            style={styles.stepButton}
            accessibilityRole="button"
            // Both step buttons confirm the same floor on a first press from
            // blank — worded differently from "−"'s so the two remain
            // individually addressable to a screen reader (and to a test).
            accessibilityLabel={countUncertain ? `Set ${title} to ${tag.count}` : `One more ${title}`}
          >
            <Text style={styles.stepGlyph}>+</Text>
          </Pressable>
        </View>
      </View>
      {/* N120/#509: what this tag actually was, correctable — five outcomes,
          same vocabulary as the title above (drilled/attempted/scored/
          conceded/defended) rather than new copy invented for this row. */}
      <View style={styles.eventChips}>
        {EVENT_OPTIONS.map((o) => {
          const active = tag.event === o.key;
          return (
            <Pressable
              key={o.key}
              onPress={() => onEvent(o.key)}
              style={[styles.eventChip, active && { backgroundColor: accent.ink, borderColor: accent.ink }]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${o.label}, for ${title}`}
              testID={`dictate-tag-${index}-event-${o.key}`}
            >
              <Text style={[styles.eventChipLabel, active && { color: vola.bg }]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The five outcomes a tag can record — see `bjjSession.ts`'s own doc on `Event`. */
const EVENT_OPTIONS: { key: Event; label: string }[] = [
  { key: 'drilled', label: 'Drilled' },
  { key: 'attempted', label: 'Attempted' },
  { key: 'scored', label: 'Scored' },
  { key: 'conceded', label: 'Conceded' },
  { key: 'defended', label: 'Defended' },
];

/**
 * A technique the dictation never named at all.
 *
 * `PickOne` (below) covers the model naming something it could not pin to
 * one catalog entry. This is the other gap N120/#509 found: something the
 * athlete drilled or rolled that never made it into the transcript's picture
 * in the first place. Search-first, same as the wizard's own picker — the
 * athlete already knows what they are looking for.
 */
function AddTechnique({
  catalog,
  failed,
  existing,
  onAdd,
}: {
  /** null while still loading; shared with `PickOne` via the parent screen. */
  catalog: TechniqueSummary[] | null;
  failed: boolean;
  existing: Tag[];
  onAdd: (t: TechniqueSummary) => void;
}) {
  const accent = useAccent();
  const [query, setQuery] = useState('');

  const matches = useMemo(
    () => (catalog && query.trim() ? rankTechniques(catalog, query).slice(0, 6) : []),
    [catalog, query],
  );
  // Only a `drilled` duplicate is blocked — see `addManualTechnique`'s own
  // comment on why the same technique already recorded under a different
  // event is not a duplicate at all.
  const already = useMemo(
    () => new Set(existing.filter((t) => t.event === 'drilled').map((t) => t.technique_id)),
    [existing],
  );

  return (
    <>
      <TextInput
        style={styles.techSearch}
        value={query}
        onChangeText={setQuery}
        placeholder="Search techniques"
        placeholderTextColor={vola.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Add a technique"
        testID="dictate-add-technique-search"
      />
      {query.trim().length > 0 &&
        (failed ? (
          <Text style={styles.muted}>Couldn’t load the library just now.</Text>
        ) : catalog === null ? (
          <ActivityIndicator accessibilityLabel="Loading the technique library" />
        ) : matches.length === 0 ? (
          <Text style={styles.muted}>No technique matches “{query.trim()}”.</Text>
        ) : (
          matches.map((t) => {
            const [code, badgeAccent] = categoryBadge(t.category);
            const added = already.has(t.id);
            return (
              <Pressable
                key={t.id}
                onPress={() => {
                  if (added) return;
                  onAdd(t);
                  setQuery('');
                }}
                style={[styles.addResult, added && styles.disabled]}
                accessibilityRole="button"
                accessibilityLabel={added ? `${t.name}, already added` : `Add ${t.name}`}
                testID={`dictate-add-technique-${t.id}`}
              >
                <LibraryTile code={code} accent={badgeAccent} />
                <Text style={styles.addResultName} numberOfLines={1}>
                  {t.name}
                </Text>
                {!added && <Text style={[styles.techPlus, { color: accent.ink }]}>＋</Text>}
              </Pressable>
            );
          })
        ))}
    </>
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
        Couldn’t load the library just now. Skip this one — nothing else on this screen needs it.
      </Text>
    );
  } else if (catalog === null) {
    body = <ActivityIndicator accessibilityLabel="Loading the technique library" />;
  } else if (matches.length === 0) {
    // N120/#509: "the next screen" used to mean the wizard this screen no
    // longer routes into. "Add something you did" below is the same library
    // search, on this same screen — the honest replacement, not a rewrite of
    // the old sentence to say nothing.
    body = (
      <Text style={styles.muted}>
        Nothing in the library matches that. Skip this one — you can search for it under “Add
        something you did” below.
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
  tagBlock: { gap: 8 },
  tagRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  tagText: { flexShrink: 1 },
  tagTitle: { fontSize: 14, fontWeight: '600', textTransform: 'capitalize' },
  // N120/#509: the per-tag event correction. Small on purpose — this is a
  // fix-up control for the rare wrong read, not a primary input, and the
  // count stepper above stays the thing the eye goes to first.
  eventChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  eventChip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  eventChipLabel: { fontSize: 11, fontWeight: '600' },
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
  // N120/#509: the "add a technique the dictation missed" search, styled to
  // match the wizard's own `search`/`result` pattern (`reflect/[id].tsx`) so
  // this reads as the same control rather than a new one invented here.
  techSearch: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  addResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineSoft,
  },
  addResultName: { flex: 1, fontSize: 15, fontWeight: '600' },
  techPlus: { fontSize: 20, fontWeight: '700' },
});
