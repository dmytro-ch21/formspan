import { useAuth } from '@clerk/clerk-expo';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { Text, View } from '@/components/Themed';
import { UpNextCard } from '@/components/today/UpNextCard';
import { Icon } from '@/components/ui/Icon';
import { SectionHeader } from '@/components/ui/Section';
import { SessionCard, type Metric } from '@/components/ui/SessionCard';
import { sportColor, sportIcon, sportTint } from '@/components/ui/sport';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { shortDate } from '@/lib/calendar';
import { formatDuration } from '@/lib/history';
import { enabledSports, labelFor, logsAfterwards, offSports } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { countsAsSet, type Session } from '@/lib/sessions';
import { sessionHref, startSessionHref } from '@/lib/startSession';
import type { PlannedOffer, Source } from '@/lib/trainBoard';
import { useTrainBoard } from '@/lib/useTrainBoard';

/**
 * Train — what can I do now?
 *
 * ## What this screen owns, and what it does not
 *
 * Execution. Plan owns future intent and programming; Progress answers whether
 * it is working. Train's whole job is to get an athlete from standing in a gym
 * to logging, in as few taps as the situation allows, and to be honest about
 * the situation when it cannot.
 *
 * **It creates nothing.** Every action here is a `router.push` at an existing
 * screen — `/session/start`, `/session/[id]`, `/bjj/log`, `/bjj/session/[id]` —
 * chosen by `lib/startSession.ts`, which Today calls too. There is no second
 * session engine, no second start path, and nothing on this screen writes a
 * session, a set or a plan. That is the ticket's hard line and it is also the
 * epic's non-regression: an athlete mid-workout cannot tell this screen
 * happened, because nothing they touch during a workout was re-entered.
 *
 * It replaces N176's honest shell, which was one button and a dashed note
 * saying the rest was coming. The button's job is now done by Quick start.
 *
 * ## Resume outranks everything, structurally rather than by position
 *
 * An unfinished session is the only thing on this screen with a clock already
 * running against it, and offering to start a second one beside it is how an
 * athlete ends up with two open sessions and a week summary that disagrees with
 * its own list. So when there is one, the primary slot holds **only** the
 * resume card: today's plan and its Start button are not rendered at all, and
 * Quick start drops to a secondary row of outlined chips. `TODAY` is not a
 * heading that reappears under it.
 *
 * ## Where the reads come from
 *
 * `lib/useTrainBoard.ts` — three SQLite reads through the app's existing
 * functions, so the whole screen renders with no network. `lib/trainBoard.ts`
 * turns them into the four blocks below, and is where the ordering rule and the
 * three-state discipline actually live; both have their own tests. The screen
 * is a render of that answer and holds no derivation of its own.
 *
 * ## Nothing here claims an absence it has not checked
 *
 * Every block reads a {@link Source}, which is `unread`, `unavailable` or
 * `ready` — never a bare array. An unanswered read renders **nothing at all**
 * in its block, and a failed one says it failed. It never renders the empty
 * state, because "nothing planned today" and "we have not looked yet" are
 * different sentences and only one of them is a fact about the athlete.
 *
 * That collapse has shipped here three times, always the same way: a union with
 * one fewer kind than reality has, with *not answered yet* the missing kind.
 * Today still has the live instance — its plan state starts `[]` and its read
 * swallows its own errors, so it asserts "Nothing planned" on the first frame
 * of every cold open. Train reads the same table and deliberately does not
 * inherit it.
 *
 * ## The dashed rule
 *
 * #468: a placeholder standing WHERE content would stand is dashed; one
 * standing BESIDE content is a card. The unavailable notes here are dashed for
 * that reason — each one occupies the slot its block's content would have — and
 * they say what happened rather than showing a plausible empty state.
 */
export default function TrainScreen() {
  const { modules } = useModules();
  const { userId } = useAuth();
  const accent = useAccent();
  const router = useRouter();

  // Refreshed on focus rather than ticked. A tab screen stays mounted for the
  // life of the process, so a `now` captured at mount would still be yesterday
  // when the app is reopened — and the 24-hour staleness boundary and the plan
  // window are both measured from it.
  //
  // Deliberately NOT a 1 Hz interval. Today runs one, because Today draws a
  // live elapsed clock on its resume card; this screen shows the session's
  // start time instead, which is a fact that does not need re-rendering. A
  // running clock is the session screen's job, and that is the screen this card
  // is one tap from.
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
    }, []),
  );

  const board = useTrainBoard(userId ?? null, modules, now);

  const startable = enabledSports(modules);
  const off = offSports(modules);

  // Bound to a local before it is read, so the resume session is one value the
  // whole render agrees on. Reading `board.resume.value` again inside the
  // press handler would reach a `Source` that had been narrowed at the JSX and
  // is not narrowed inside a closure — which is where a non-null assertion
  // creeps in and stops being checked.
  const resume = board.resume.state === 'ready' ? board.resume.value : null;

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Train" />
      <ScrollView contentContainerStyle={styles.body}>
        {resume ? (
          <ResumeBlock
            session={resume.session}
            stale={resume.stale}
            showSets={!logsAfterwards(resume.session.sport, modules)}
            accent={accent}
            onPress={() => router.push(sessionHref(resume.session, modules))}
          />
        ) : (
          <TodayBlock
            today={board.today}
            modules={modules}
            onStart={(p) => router.push(startSessionHref(p, modules))}
          />
        )}

        {/* Later is shown alongside a resume card, unlike today's plan. It is
            not a competing action — there is no button on it — it is the
            answer to "and after this?", which an athlete finishing a session
            is entitled to have. */}
        <LaterBlock later={board.later} modules={modules} />

        <RNView style={styles.section}>
          <SectionHeader label="Quick start" />
          {startable.length > 0 ? (
            <RNView style={styles.quickRow} testID="train-quick-start">
              {startable.map((m) => (
                <Pressable
                  key={m.key}
                  onPress={() =>
                    router.push(startSessionHref({ sport: m.key, workoutId: null }, modules))
                  }
                  style={({ pressed }) => [
                    styles.quick,
                    // Filled only when it is the screen's primary action. With
                    // a session already open these stay outlined, so the resume
                    // card is the one filled control on the screen.
                    !resume && { borderColor: accent.accent },
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    logsAfterwards(m.key, modules) ? `Log ${m.label}` : `Start ${m.label}`
                  }
                  testID={`train-quick-${m.key}`}
                >
                  <QuickGlyph sportKey={m.key} />
                  <Text numberOfLines={1} style={styles.quickLabel}>
                    {m.label}
                  </Text>
                </Pressable>
              ))}
            </RNView>
          ) : (
            <Pressable
              style={styles.choose}
              onPress={() => router.push('/profile/edit')}
              accessibilityRole="button"
              accessibilityLabel="Choose what you train"
              testID="train-choose-sports"
            >
              <Text style={styles.chooseText}>Choose what you train</Text>
            </Pressable>
          )}

          {/*
            Off disciplines are named, and this is N61 rather than clutter.
            They are NOT in Quick start — nothing here starts one — but an
            athlete who cannot see a discipline cannot tell "turned off" from
            "not built" from "broken", and the one time that happened the user
            went looking on a real phone and reported working features as
            missing. Naming them costs one line and answers it.
          */}
          {startable.length > 0 && off.length > 0 && (
            <Pressable
              onPress={() => router.push('/profile/edit')}
              accessibilityRole="button"
              accessibilityLabel={`${off.map((m) => m.label).join(' and ')} turned off. Choose what you train.`}
              testID="train-off-sports"
              hitSlop={8}
            >
              <Text style={styles.offNote}>
                {off.map((m) => m.label).join(' and ')}{' '}
                {off.length === 1 ? 'is' : 'are'} turned off. Choose what you train.
              </Text>
            </Pressable>
          )}
        </RNView>

        <RecentBlock
          recent={board.recent}
          modules={modules}
          onOpen={(s) => router.push(sessionHref(s, modules))}
        />
      </ScrollView>
    </View>
  );
}

/** The sport's glyph on its own tint, or nothing for a discipline we have no mark for. */
function QuickGlyph({ sportKey }: { sportKey: string }) {
  const tone = sportColor(sportKey);
  const glyph = sportIcon(sportKey);
  if (!tone || !glyph) return null;
  return (
    <RNView style={[styles.quickDisc, { backgroundColor: sportTint(tone) }]}>
      <Icon name={glyph} size={16} color={tone} />
    </RNView>
  );
}

/**
 * The unfinished session.
 *
 * Past a day old it stops claiming to be in progress and offers to finish or
 * discard instead — the same 24-hour boundary Today applies, from the same
 * constant, for the same reason: a resume button on a session opened last
 * Tuesday is not an invitation, it is a mess to clear up, and saying so is what
 * makes the mess clearable.
 *
 * The start TIME rather than an elapsed count, which is the one deliberate
 * difference from Today's card. An elapsed figure is only true while something
 * re-renders it; a start time is true forever, and the screen with the running
 * clock on it is one tap away.
 */
function ResumeBlock({
  session,
  stale,
  showSets,
  accent,
  onPress,
}: {
  session: Session;
  stale: boolean;
  /** A discipline that cannot hold a set gets no set count — not a zero. */
  showSets: boolean;
  accent: ReturnType<typeof useAccent>;
  onPress: () => void;
}) {
  const sets = session.sets.filter(countsAsSet).length;
  const started = new Date(session.started_at);
  const when = stale
    ? started.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
    : `Started ${started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.resume,
        { borderColor: stale ? vola.warn : accent.accent },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={
        stale
          ? `Unfinished ${session.name || session.sport} session from ${started.toLocaleDateString()}. Open to finish or discard it.`
          : `Continue ${session.name || session.sport} session in progress, started ${started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      }
      testID="train-resume"
    >
      <Text style={[styles.resumeEyebrow, { color: stale ? vola.warn : accent.ink }]}>
        {stale ? 'UNFINISHED' : 'IN PROGRESS'}
      </Text>
      <Text style={styles.resumeTitle} numberOfLines={1}>
        {session.name || session.sport}
      </Text>
      <RNView style={styles.resumeMeta}>
        <RNView style={styles.chip}>
          <Icon name={stale ? 'calendar' : 'timer'} size={13} color={vola.textMuted} />
          <Text style={styles.chipText}>{when}</Text>
        </RNView>
        {showSets && (
          <RNView style={styles.chip}>
            <Icon name="layers" size={13} color={vola.textMuted} />
            <Text style={styles.chipText}>
              {sets} {sets === 1 ? 'working set' : 'working sets'}
            </Text>
          </RNView>
        )}
      </RNView>
      <RNView
        style={[
          styles.resumeAction,
          stale ? styles.resumeActionStale : { backgroundColor: accent.accent },
        ]}
      >
        <Text
          style={[styles.resumeActionText, { color: stale ? vola.text : accent.on }]}
        >
          {stale ? 'Finish or discard' : 'Resume'}
        </Text>
      </RNView>
    </Pressable>
  );
}

/** Today's plan — one card per thing still owed. */
function TodayBlock({
  today,
  modules,
  onStart,
}: {
  today: Source<PlannedOffer[]>;
  modules: ReturnType<typeof useModules>['modules'];
  onStart: (p: PlannedOffer) => void;
}) {
  return (
    <RNView style={styles.section}>
      <SectionHeader label="Today" />
      {/* Nothing at all until the read answers. Rendering the empty state here
          is the collapse this screen's docstring is about — and it is one
          frame, which is exactly long enough to be read and exactly short
          enough never to show up in a bug report. */}
      {today.state === 'unread' ? null : today.state === 'unavailable' ? (
        <Dashed testID="train-today-unavailable">
          Today&apos;s plan could not be read. Quick start below still works.
        </Dashed>
      ) : today.value.length > 0 ? (
        today.value.map((p) => (
          <UpNextCard
            key={p.id}
            sport={p.sport}
            title={p.workoutName ?? `${labelFor(modules, p.sport)} session`}
            when="Today"
            logLabel={p.logsAfterwards ? 'Log' : 'Start'}
            onLog={() => onStart(p)}
            onOpen={() => onStart(p)}
            testID={`train-today-${p.id}`}
          />
        ))
      ) : (
        <Text style={styles.quiet} testID="train-today-none">
          Nothing planned for today. Start anything below, or plan a day in Plan.
        </Text>
      )}
    </RNView>
  );
}

/** The next planned day after today. Read-only — Plan owns changing it. */
function LaterBlock({
  later,
  modules,
}: {
  later: Source<PlannedOffer | null>;
  modules: ReturnType<typeof useModules>['modules'];
}) {
  // Nothing is drawn for an unread OR an empty answer. An athlete who plans
  // nothing should not be given a heading over a sentence telling them so on
  // every visit — the block simply is not there, which is the honest rendering
  // of "there is no next thing" and is not a claim about anything.
  if (later.state === 'unread') return null;
  if (later.state === 'unavailable') {
    return (
      <RNView style={styles.section}>
        <SectionHeader label="Later" />
        <Dashed testID="train-later-unavailable">The rest of the plan could not be read.</Dashed>
      </RNView>
    );
  }
  if (!later.value) return null;

  const p = later.value;
  return (
    <RNView style={styles.section} testID="train-later">
      <SectionHeader label="Later" />
      <RNView style={styles.laterRow}>
        <QuickGlyph sportKey={p.sport} />
        <RNView style={styles.laterText}>
          <Text style={styles.laterTitle} numberOfLines={1}>
            {p.workoutName ?? `${labelFor(modules, p.sport)} session`}
          </Text>
          <Text style={styles.laterWhen}>{shortDate(p.day)}</Text>
        </RNView>
      </RNView>
    </RNView>
  );
}

/** The most recent session per discipline. */
function RecentBlock({
  recent,
  modules,
  onOpen,
}: {
  recent: Source<Session[]>;
  modules: ReturnType<typeof useModules>['modules'];
  onOpen: (s: Session) => void;
}) {
  if (recent.state === 'unread') return null;

  return (
    <RNView style={styles.section}>
      <SectionHeader label="Recent" />
      {recent.state === 'unavailable' ? (
        <Dashed testID="train-recent-unavailable">Your recent sessions could not be read.</Dashed>
      ) : recent.value.length === 0 ? (
        <Text style={styles.quiet} testID="train-recent-none">
          Nothing logged yet. Whatever you start above shows up here.
        </Text>
      ) : (
        recent.value.map((s) => (
          <SessionCard
            key={s.id}
            name={s.name || labelFor(modules, s.sport)}
            sport={labelFor(modules, s.sport)}
            sportKey={s.sport}
            when={new Date(s.started_at).toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
            })}
            metrics={recentMetrics(s, modules)}
            complete={s.ended_at != null}
            onPress={() => onOpen(s)}
            accessibilityLabel={`${s.name || labelFor(modules, s.sport)}, ${new Date(s.started_at).toLocaleDateString()}`}
            testID={`train-recent-${s.id}`}
          />
        ))
      )}
    </RNView>
  );
}

/**
 * A recent session's measures — omitted rather than zeroed when they do not apply.
 *
 * The same rule `SessionCard`'s own docstring records: a BJJ session cannot
 * legally hold a set, so "0 sets" on one is not a neutral default, it reads as
 * an abandoned session. A card with no chips at all is the honest rendering.
 */
function recentMetrics(s: Session, modules: ReturnType<typeof useModules>['modules']): Metric[] {
  const out: Metric[] = [];
  if (s.ended_at) {
    const seconds = (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000;
    out.push({ icon: 'timer', value: formatDuration(seconds) });
  }
  if (!logsAfterwards(s.sport, modules)) {
    const n = s.sets.filter(countsAsSet).length;
    out.push({ icon: 'layers', value: `${n} ${n === 1 ? 'set' : 'sets'}` });
  }
  return out;
}

/** #468's placeholder: dashed, because it stands WHERE content would stand. */
function Dashed({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <RNView style={styles.dashed} testID={testID}>
      <Text style={styles.dashedText}>{children}</Text>
    </RNView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: 20, paddingBottom: TAB_BAR_CLEARANCE, gap: 22 },
  section: { gap: 10 },
  pressed: { opacity: 0.85 },

  resume: {
    backgroundColor: vola.surfaceRaised,
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    gap: 4,
  },
  resumeEyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  resumeTitle: { fontSize: 22, fontWeight: '700' },
  resumeMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipText: {
    fontSize: 13,
    color: vola.textMuted,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  resumeAction: {
    marginTop: 14,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A stale session is not the accent action — finishing or discarding it is
  // housekeeping, and painting it in the "act here" colour would make clearing
  // up look like training.
  resumeActionStale: { borderWidth: 1, borderColor: vola.line },
  resumeActionText: { fontSize: 15, fontWeight: '700', letterSpacing: 0.4 },

  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  quick: {
    flexGrow: 1,
    flexBasis: 100,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  quickDisc: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickLabel: { fontSize: 15, fontWeight: '700', flexShrink: 1 },

  choose: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.lineSoft,
  },
  chooseText: { fontSize: 15, fontWeight: '600' },
  // textMuted rather than textDim: at 13pt this is small text, and textDim
  // measures 3.96:1 on `bg`, below AA's 4.5:1.
  offNote: { fontSize: 13, lineHeight: 19, color: vola.textMuted },

  laterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  laterText: { flex: 1, gap: 1 },
  laterTitle: { fontSize: 16, fontWeight: '700' },
  laterWhen: { fontSize: 12, color: vola.textMuted },

  quiet: { fontSize: 13, lineHeight: 19, color: vola.textMuted },

  dashed: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.lineSoft,
    borderRadius: 14,
    padding: 16,
  },
  dashedText: { fontSize: 13, lineHeight: 19, color: vola.textMuted },
});
