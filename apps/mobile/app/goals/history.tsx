/**
 * What you have been eating to, and how to correct it.
 *
 * ## The gap this closes
 *
 * N72 put manual target entry on the phone, and it wrote for TODAY and only
 * today. So an athlete who mis-keyed a target had the number in front of them
 * and no way to fix the record: the history, a backdated effective date and
 * deletion all lived on a laptop. That is the mobile-first rule's own failure
 * shape one step on from the one that produced it — the reasoning was
 * reachable, then the action was, and the *correction* still was not.
 *
 * ## What changing a past target does to numbers already derived from it
 *
 * **They are recomputed, everywhere, and that is not a choice this screen
 * makes — it is what the data model already is.** Nothing caches a target:
 * `nutrition_targets` holds one row per effective date and every consumer
 * resolves "the target live on day X" at read time. The day totals endpoint
 * does it with a lateral join per day; the weekly adjustment recomputes
 * adherence as a query rather than reading a stored counter; the phone's own
 * confidence block calls `targetOn(targets, day)` for each of the last
 * fourteen days. There is no second copy anywhere to leave stale or to mark
 * superseded.
 *
 * That is also the right answer on its own terms. A target IS the yardstick a
 * day was measured against, so correcting a typo has to move the yardstick —
 * leaving yesterday's remaining-calories line measured against a target nobody
 * meant would preserve the mistake and call it history. The alternative,
 * showing the old figure as *superseded*, would mean storing a derived number
 * that today is never stored, inventing a second source of truth for "what was
 * my target" — and the first thing it would do is disagree with the web app,
 * which resolves from the row like everything else.
 *
 * **What is NOT recomputed is the `basis`** — the frozen arithmetic on a
 * derived row saying how that number was reached. It is stored at the moment
 * of acceptance and never recomputed on read, because weight, phase and
 * training history all move and a live explanation would be a confident lie
 * about a past decision. So a corrected target changes what every day MEANS and
 * changes no explanation of how any target was DERIVED — which is why typing
 * over a derived row drops its basis rather than keeping it (see `editCost`).
 *
 * The consequence is surprising enough to be said on screen rather than left in
 * this comment: correcting a past target restates what those days were measured
 * against.
 *
 * ## Three primitives, not one editor
 *
 * Because the date is the row's identity, "fix this" splits into operations
 * that cannot be one control:
 *
 *  - **Edit** the numbers of a row — a PUT to that row's own date. This is the
 *    common case and the reason the ticket exists.
 *  - **Remove** a row — the only way a target filed under the wrong DAY leaves
 *    the record, since a PUT can never move one.
 *  - **Add** one for an earlier day — for a target that has been in force for a
 *    while and was never entered.
 *
 * ## Undo
 *
 * A delete has no server-side undo, so the row is held in memory and offered
 * straight back. Every field is on the wire response, `basis` included, so
 * putting it back is exact rather than approximate. This is the answer to the
 * only question worth asking of a destructive screen, and the confirmation says
 * what the delete costs BEFORE it happens as well — `deletionEffect` computes
 * that, including the case where the honest answer is that we cannot see far
 * enough back to know.
 */

import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { HoldToConfirm } from '@/components/HoldToConfirm';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { ManualTarget } from '@/components/nutrition/ManualTarget';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { transportDiagnosis } from '@/lib/apiError';
import { formatDayLong } from '@/lib/history';
import {
  draftFrom,
  refusalOrWeather,
  type ManualTargetInput,
} from '@/lib/manualTarget';
import { todayString } from '@/lib/nutrition';
import {
  deleteTarget,
  listTargets,
  saveTarget,
  type StoredTarget,
} from '@/lib/nutritionApi';
import {
  buildHistory,
  canBackdateTo,
  canStepWeek,
  deletionEffect,
  editCost,
  historyRows,
  historyWindow,
  sourceLabel,
  stepWeek,
  weekStrip,
  type DeletionEffect,
  type HistoryRow,
  type TargetHistory,
  type TargetRead,
} from '@/lib/targetHistory';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Which row, if any, is open — and for what.
 *
 * One piece of state rather than three booleans, so "editing row 2 while the
 * add form is open" is unrepresentable instead of merely unlikely.
 */
type Open = { what: 'edit'; on: string } | { what: 'add' } | null;

export default function TargetHistoryScreen() {
  const getToken = useAuthToken();
  const accent = useAccent();

  const [read, setRead] = useState<TargetRead>({ status: 'unread' });
  /**
   * The day this screen is about, RE-READ ON EVERY FOCUS.
   *
   * A stale read is a nuisance; a stale write is data. Everything here is
   * bounded against `on` — which days may be backdated to, which row is live —
   * so a screen left open past midnight would otherwise refuse today and allow
   * tomorrow. Goals learned this the same way one file over.
   */
  const [on, setOn] = useState(todayString);
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Why the last write failed, and WHICH write.
   *
   * Tagged rather than a bare string, because the two land in different
   * places: a save belongs in the open form's own slot, where the athlete is
   * looking, and a delete or an undo has no form to land in. Untagged, a
   * failed delete rendered under `ManualTarget`'s "why the last save failed"
   * heading — a true sentence filed under a false one.
   */
  const [problem, setProblem] = useState<{ where: 'save' | 'row'; message: string } | null>(null);
  /** The last row removed, held so it can be put straight back. */
  const [undoable, setUndoable] = useState<StoredTarget | null>(null);
  /** The day a new backdated target would be filed under. */
  const [pick, setPick] = useState(todayString);
  /**
   * The last day on the week strip — navigation, kept SEPARATE from the choice.
   *
   * The first version anchored the strip on `pick` itself, which made moving
   * forward impossible: the strip is the seven days *ending* at its anchor, so
   * nothing newer than the anchor is ever a chip, and with the anchor tied to
   * the selection the forward arrow disabled the moment `pick` came within a
   * week of today. Tapping `today-3` therefore stranded the athlete three days
   * from the present with no way back except leaving the screen — which nothing
   * told them. Found in review.
   *
   * Separating the two is what fixes it, and it is also how a calendar behaves:
   * paging the view does not change what is selected, and `From …` below the
   * strip keeps the selection visible while it is off-screen.
   */
  const [anchor, setAnchor] = useState(todayString);

  /**
   * Which read is the newest, so a slow one cannot land on top of it.
   *
   * A per-call `live` flag is enough for the focus cleanup and NOT enough here,
   * because the reload after a write discards its own cleanup — there is
   * nowhere to hang it. Without this, a focus-time `listTargets` that resolves
   * *after* a post-delete reload puts the pre-delete list back on screen: the
   * row the athlete just removed renders as present, directly beneath a banner
   * saying it was removed. Nothing is written from it and the next focus
   * repairs it, which is exactly what makes it the kind of thing that ships.
   *
   * A counter rather than an AbortController: `apiRequest` takes no signal, and
   * the fix needed is about which ANSWER is allowed to land, not about stopping
   * a request that is already paid for.
   */
  const reads = useRef(0);

  const load = useCallback(
    (day: string) => {
      const seq = ++reads.current;
      let live = true;
      const win = historyWindow(day);
      const newest = () => live && seq === reads.current;
      listTargets(getToken, win)
        .then((targets) => {
          if (newest()) setRead({ status: 'read', targets, from: win.from });
        })
        .catch((err) => {
          // `unavailable`, never an empty array. An empty array here would make
          // a request that never returned render as "you have never set a
          // target" — a positive claim about somebody's data, next to a delete
          // button. `apps/web`'s targets page still does exactly that.
          //
          // N94: `err` used to be discarded here, and the render below asserted
          // one fixed "this one needs a connection" sentence for any rejection
          // — including a server 500. `transportDiagnosis` composes the real
          // cause; `null` (a server-answered `ApiError`) falls back to the
          // screen's neutral wording below rather than a network claim.
          if (newest()) setRead({ status: 'unavailable', diagnosis: transportDiagnosis(err) });
        });
      return () => {
        live = false;
      };
    },
    [getToken],
  );

  useFocusEffect(
    useCallback(() => {
      const day = todayString();
      setOn(day);
      setPick(day);
      setAnchor(day);
      return load(day);
    }, [load]),
  );

  const history = buildHistory(read, on);
  const rows = historyRows(history);

  /**
   * The earliest day a target may be filed under — taken from the window that
   * was ACTUALLY READ where there is one, not recomputed from `on`.
   *
   * The two agree except across midnight, and that sliver is the whole reason.
   * A screen held focused overnight would compute a floor one day earlier than
   * the list was fetched with, so the oldest chip would write a target this
   * screen can no longer show — the precise defect `BACKDATE_DAYS` exists to
   * prevent, arriving through the constant meant to prevent it. Deriving it
   * from the read makes the bound the form enforces the bound the list can
   * actually display, by construction rather than by the two staying in step.
   */
  const floor = read.status === 'read' ? read.from : historyWindow(on).from;

  /** Every write funnels here, so the receipt and the failure copy are one. */
  const write = useCallback(
    async (
      job: () => Promise<void>,
      spoken: string,
      where: 'save' | 'row',
      verb: 'save' | 'remove' | 'put it back',
    ) => {
      if (busy) return false;
      setBusy(true);
      setProblem(null);
      try {
        await job();
        load(todayString());
        // Spoken as well as rendered: focus stays on the button that was
        // pressed and iOS has no live regions, so a VoiceOver user would
        // otherwise hear nothing at all and conclude nothing happened.
        AccessibilityInfo.announceForAccessibility(spoken);
        return true;
      } catch (e) {
        const why = refusalOrWeather(e, verb);
        setProblem({ where, message: why });
        AccessibilityInfo.announceForAccessibility(why);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  const saveOn = useCallback(
    async (day: string, input: ManualTargetInput) => {
      const ok = await write(
        () =>
          saveTarget(getToken, day, { ...input, source: 'manual', basis: null }).then(() => {}),
        `Saved. ${input.kcal} kcal from ${formatDayLong(day)}. Days measured against it have been restated.`,
        'save',
        'save',
      );
      if (ok) setOpen(null);
    },
    [getToken, write],
  );

  const remove = useCallback(
    async (row: HistoryRow) => {
      const ok = await write(
        () => deleteTarget(getToken, row.from),
        // The NUMBERS are in the receipt, not just the date, and Undo is named.
        // Focus stays on the hold button, so a VoiceOver user is told what was
        // removed and that it can come back — otherwise they have to stumble
        // onto a banner they were never told about. The figure also survives
        // the one state where it exists nowhere else: a second delete
        // overwrites the single undo slot, and the first row's numbers are then
        // gone from the screen, the server and the record alike.
        `Removed the ${row.target.kcal} kcal target from ${formatDayLong(row.from)}. Undo is above the list.`,
        'row',
        'remove',
      );
      // Held only on success. Offering to restore a row the server never
      // removed would put a button on screen that undoes nothing.
      if (ok) setUndoable(row.target);
    },
    [getToken, write],
  );

  const undo = useCallback(async () => {
    const t = undoable;
    if (!t) return;
    const ok = await write(
      () =>
        saveTarget(getToken, t.effective_on, {
          kcal: t.kcal,
          protein_g: t.protein_g,
          carb_g: t.carb_g,
          fat_g: t.fat_g,
          fibre_g: t.fibre_g,
          // Exactly what was there. The wire response carries `source` and
          // `basis`, so this restores the row rather than approximating it as a
          // typed target — which would silently strip a derivation the athlete
          // never chose to discard.
          source: t.source ?? 'manual',
          basis: t.basis ?? null,
        }).then(() => {}),
      `Put back. ${t.kcal} kcal from ${formatDayLong(t.effective_on)}.`,
      'row',
      'put it back',
    );
    if (ok) setUndoable(null);
  }, [getToken, undoable, write]);

  return (
    <>
      <Stack.Screen options={{ title: 'Target history' }} />
      <KeyboardAwareScrollView contentContainerStyle={styles.page}>
        <Text style={styles.intro}>
          A target is the yardstick a day was measured against, so correcting one restates what
          those days were measured against. Nothing is recalculated twice — every screen reads the
          target live on the day it is showing.
        </Text>

        {/* The banner carries a delete or an undo, which have no form to land
            in. A failed SAVE goes to the open form's own slot instead, because
            that is where the athlete is looking — and saying it in both places
            reads as two different problems. */}
        {problem?.where === 'row' ? (
          <Text style={styles.problem} testID="history-problem">
            {problem.message}
          </Text>
        ) : null}

        {undoable ? (
          <View style={styles.undo}>
            <Text style={styles.undoText}>
              Removed {undoable.kcal} kcal from {formatDayLong(undoable.effective_on)}.
            </Text>
            <Pressable
              onPress={undo}
              disabled={busy}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Put back the ${undoable.kcal} kcal target from ${formatDayLong(undoable.effective_on)}`}
              testID="history-undo"
            >
              <Text style={[styles.undoAction, { color: accent.accent }]}>Undo</Text>
            </Pressable>
          </View>
        ) : null}

        <Body
          history={history}
          rows={rows}
          open={open}
          busy={busy}
          failed={problem?.where === 'save' ? problem.message : null}
          onOpen={setOpen}
          onSave={saveOn}
          onRemove={remove}
          onRetry={() => {
            setRead({ status: 'unread' });
            load(on);
          }}
        />

        {/* Offered in every state that has an answer — including `none`, where
            adding the first target for a day already past is exactly what
            somebody who has been eating to a coach's number needs. Withheld
            only when we do not know what is there, because adding a row to a
            list we could not read would leave the screen unable to show it. */}
        {history.kind === 'unread' || history.kind === 'unavailable' ? null : (
          <AddEarlier
            on={on}
            floor={floor}
            pick={pick}
            setPick={setPick}
            anchor={anchor}
            setAnchor={setAnchor}
            open={open?.what === 'add'}
            busy={busy}
            failed={problem?.where === 'save' ? problem.message : null}
            existing={rows.some((r) => r.from === pick)}
            onToggle={() => setOpen(open?.what === 'add' ? null : { what: 'add' })}
            onSave={(input) => saveOn(pick, input)}
          />
        )}
      </KeyboardAwareScrollView>
    </>
  );
}

/**
 * The list, or the reason there is not one.
 *
 * Every one of the five states gets its own sentence. The two that matter most
 * are the two that look alike from the outside: `none` says the athlete has
 * never set a target, `unavailable` says we could not find out — and only the
 * first of those is a fact about them.
 */
function Body({
  history,
  rows,
  open,
  busy,
  failed,
  onOpen,
  onSave,
  onRemove,
  onRetry,
}: {
  history: TargetHistory;
  rows: HistoryRow[];
  open: Open;
  busy: boolean;
  failed: string | null;
  onOpen: (o: Open) => void;
  onSave: (day: string, input: ManualTargetInput) => void;
  onRemove: (row: HistoryRow) => void;
  onRetry: () => void;
}) {
  if (history.kind === 'unread') return <ActivityIndicator testID="history-loading" />;

  if (history.kind === 'unavailable') {
    // N94: this used to assert "this one needs a connection" for ANY failed
    // read, including a server 500. `history.diagnosis` is the transport's
    // own composed sentence (`transportDiagnosis(err)` from the catch in
    // `load`), null for a server-answered `ApiError` — which falls back to
    // this screen's own neutral wording, never a network claim.
    return (
      <View style={styles.state}>
        <Text style={styles.stateText} testID="history-unavailable">
          {history.diagnosis ?? 'Could not read your target history.'} It is not gone; we just could
          not ask.
        </Text>
        <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button" testID="history-retry">
          <Text style={styles.stateAction}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (history.kind === 'none') {
    return (
      <Text style={styles.stateText} testID="history-none">
        You have not set a target yet. Derive one in Goals, or add one below for the day you
        actually started.
      </Text>
    );
  }

  return (
    <View style={styles.rows}>
      {rows.map((row, i) => (
        <Row
          key={row.from}
          row={row}
          effect={deletionEffect(rows, i)}
          editing={open?.what === 'edit' && open.on === row.from}
          busy={busy}
          failed={open?.what === 'edit' && open.on === row.from ? failed : null}
          onToggle={() =>
            onOpen(open?.what === 'edit' && open.on === row.from ? null : { what: 'edit', on: row.from })
          }
          onSave={(input) => onSave(row.from, input)}
          onRemove={() => onRemove(row)}
        />
      ))}

      {/* Said out loud rather than left to be inferred from the oldest date.
          A list that stops at a year and does not say so reads as the whole
          record, which is the same overstatement in a quieter register. */}
      {history.kind === 'partial' ? (
        <Text style={styles.foot} testID="history-partial">
          Showing back to {formatDayLong(history.from)}. The oldest row above was already in force
          then — if you set targets before that, they are not on this list.
        </Text>
      ) : null}

      <Text style={styles.foot}>
        Every day between two dates is measured against the target above it.
      </Text>
    </View>
  );
}

/** One target, its span, and what it would cost to change or remove it. */
function Row({
  row,
  effect,
  editing,
  busy,
  failed,
  onToggle,
  onSave,
  onRemove,
}: {
  row: HistoryRow;
  effect: DeletionEffect | null;
  editing: boolean;
  busy: boolean;
  failed: string | null;
  onToggle: () => void;
  onSave: (input: ManualTargetInput) => void;
  onRemove: () => void;
}) {
  const accent = useAccent();
  const t = row.target;
  const cost = editCost(t);

  return (
    <View style={styles.row} testID={`history-row-${row.from}`}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: editing }}
        accessibilityLabel={`${t.kcal} calories, ${span(row)}, ${sourceLabel(t.source)}. ${
          editing ? 'Collapse' : 'Expand to edit or remove'
        }`}
        testID={`history-row-toggle-${row.from}`}
      >
        <View style={styles.rowHead}>
          <Text style={styles.kcal}>{t.kcal} kcal</Text>
          {row.phase === 'live' ? (
            <Text style={[styles.badge, { color: accent.accent, borderColor: accent.accent }]}>
              In force
            </Text>
          ) : row.phase === 'scheduled' ? (
            <Text style={styles.badge}>Scheduled</Text>
          ) : null}
        </View>
        <Text style={styles.span}>{span(row)}</Text>
        <Text style={styles.macros}>
          {t.protein_g}g protein · {t.carb_g}g carbs · {t.fat_g}g fat
          {t.fibre_g == null ? '' : ` · ${t.fibre_g}g fibre`}
        </Text>
        <Text style={styles.source}>{sourceLabel(t.source)}</Text>
      </Pressable>

      {editing ? (
        <View style={styles.actions}>
          {cost === 'loses_derivation' ? (
            <Text style={styles.warn} testID={`history-cost-${row.from}`}>
              This target came from the derivation, and the arithmetic behind it is stored on the
              row. Typing new numbers replaces it with a target you typed, and that explanation
              goes with it.
            </Text>
          ) : cost === 'label_only' ? (
            <Text style={styles.warn} testID={`history-cost-${row.from}`}>
              This came from a weekly adjustment. New numbers make it a target you typed — the
              adjustment&rsquo;s own arithmetic was never stored on the row, so nothing else
              changes.
            </Text>
          ) : null}

          <ManualTarget
            seed={draftFrom(t)}
            on={row.from}
            // A row's own date is by definition not in the future for a past or
            // live row, and a scheduled one governs no elapsed day yet — so the
            // claim is only made where it is true.
            effect={row.phase === 'scheduled' ? 'from_today' : 'restates_past_days'}
            saving={busy}
            failed={failed}
            onSave={onSave}
          />

          {effect ? (
            <>
              <Text style={styles.warn} testID={`history-effect-${row.from}`}>
                {describeDeletion(effect)}
              </Text>
              <HoldToConfirm
                label="Remove this target"
                onConfirm={onRemove}
                confirmTitle={`Remove the target from ${formatDayLong(row.from)}?`}
                confirmBody={describeDeletion(effect)}
                destructive
                fillColor={vola.danger}
                testID={`history-remove-${row.from}`}
              />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A target for a day already gone.
 *
 * The date is chosen a WEEK at a time — seven day chips plus two arrows —
 * rather than by a day stepper or a calendar. A stepper makes backdating a
 * month thirty taps; a calendar means a native module this app does not have,
 * and a native dependency cannot be added without a rebuild. The week strip is
 * already this app's idiom for choosing a day on Today, so it is a gesture
 * people here have made before.
 *
 * **Backwards only.** The floor is the read window, because a target written
 * outside what this list can show is one the athlete can never correct again —
 * this ticket's defect recreated by its own fix. The ceiling is today: the one
 * thing that legitimately writes a future target is the weekly adjustment,
 * which picks its date from a rule the athlete can read, and hand-scheduling
 * one has no surface anywhere explaining what it would do to the days between.
 * Reading forward and writing forward are different permissions, which is why
 * the list shows a scheduled row this form cannot create.
 */
function AddEarlier({
  on,
  floor,
  pick,
  setPick,
  anchor,
  setAnchor,
  open,
  busy,
  failed,
  existing,
  onToggle,
  onSave,
}: {
  on: string;
  /** Earliest day that may be chosen — the window that was actually read. */
  floor: string;
  pick: string;
  setPick: (d: string) => void;
  anchor: string;
  setAnchor: (d: string) => void;
  open: boolean;
  busy: boolean;
  failed: string | null;
  existing: boolean;
  onToggle: () => void;
  onSave: (input: ManualTargetInput) => void;
}) {
  const accent = useAccent();
  // The seven days ENDING at the anchor. The anchor is navigation and `pick` is
  // the choice; conflating them is what stranded the strip three days short of
  // today — see the `anchor` state for the full account.
  const week = weekStrip(anchor);
  const back = stepWeek(anchor, on, 'back');
  const forward = stepWeek(anchor, on, 'forward');
  const canGoBack = canStepWeek(anchor, on, 'back', floor);
  const canGoForward = canStepWeek(anchor, on, 'forward', floor);

  return (
    <View style={styles.add}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        testID="history-add-toggle"
      >
        <Text style={[styles.addToggle, { color: accent.accent }]}>
          {open ? 'Cancel' : 'Add a target for an earlier day'}
        </Text>
      </Pressable>

      {open ? (
        <>
          <View style={styles.strip}>
            <Pressable
              onPress={() => setAnchor(back)}
              disabled={!canGoBack}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Previous week"
              accessibilityState={{ disabled: !canGoBack }}
              testID="history-week-back"
            >
              <Text style={[styles.arrow, !canGoBack && styles.arrowOff]}>◀</Text>
            </Pressable>

            {week.map((day) => {
              const allowed = canBackdateTo(day, on, floor);
              const chosen = day === pick;
              return (
                <Pressable
                  key={day}
                  onPress={() => setPick(day)}
                  disabled={!allowed}
                  hitSlop={4}
                  style={[
                    styles.day,
                    chosen && { backgroundColor: accent.accent, borderColor: accent.accent },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: chosen, disabled: !allowed }}
                  accessibilityLabel={formatDayLong(day)}
                  testID={`history-day-${day}`}
                >
                  <Text
                    style={[
                      styles.dayText,
                      chosen && { color: accent.on },
                      !allowed && styles.arrowOff,
                    ]}
                  >
                    {day.slice(8)}
                  </Text>
                </Pressable>
              );
            })}

            <Pressable
              onPress={() => setAnchor(forward)}
              disabled={!canGoForward}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Next week"
              accessibilityState={{ disabled: !canGoForward }}
              testID="history-week-forward"
            >
              <Text style={[styles.arrow, !canGoForward && styles.arrowOff]}>▶</Text>
            </Pressable>
          </View>

          {/* The choice, always visible. The strip may have been paged away
              from it, and a selection you cannot see is one you cannot check
              before saving. */}
          <Text style={styles.pick} testID="history-pick">
            From {formatDayLong(pick)}
          </Text>

          {/* Overwriting an existing row is allowed — it is the same PUT the
              row's own edit form makes — but it is not what somebody reaching
              for "add" expects, so it is named rather than silently done. */}
          {existing ? (
            <Text style={styles.warn} testID="history-overwrites">
              There is already a target on that day. Saving replaces it.
            </Text>
          ) : null}

          <ManualTarget
            seed={null}
            on={pick}
            effect={pick < on ? 'restates_past_days' : 'from_today'}
            saving={busy}
            failed={failed}
            onSave={onSave}
          />
        </>
      ) : null}
    </View>
  );
}

/** The days a row governed, as a sentence. */
function span(row: HistoryRow): string {
  if (row.phase === 'scheduled') return `Starts ${formatDayLong(row.from)}`;
  if (row.until == null) return `From ${formatDayLong(row.from)}`;
  return `${formatDayLong(row.from)} to ${formatDayLong(row.until)}`;
}

/**
 * What removing a row costs, in a sentence.
 *
 * Rendered before the hold AND inside the screen-reader confirmation, from one
 * function, so the two cannot say different things — which is the ordinary way
 * a confirmation dialog comes to describe an action nobody is taking.
 */
function describeDeletion(e: DeletionEffect): string {
  const days =
    e.until == null
      ? `from ${formatDayLong(e.from)} onward`
      : `${formatDayLong(e.from)} to ${formatDayLong(e.until)}`;
  switch (e.then.kind) {
    case 'earlier':
      return `Your target for ${days} goes back to ${e.then.target.kcal} kcal, the one set on ${formatDayLong(e.then.target.effective_on)}.`;
    case 'nothing':
      return `You will have no target ${days}. Days in that stretch will have nothing to measure against.`;
    case 'unknown':
      // The empty-versus-unknown split, inside a destructive confirmation.
      // Claiming "you will have no target" here would be a confident statement
      // about rows this read never asked for.
      return `This is the oldest target on this list, and it was already in force when the list starts — so we cannot see whether an older one would take over ${days}.`;
  }
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 48 },
  intro: { fontSize: 13, lineHeight: 19, opacity: 0.7 },
  problem: { fontSize: 13, lineHeight: 19, color: vola.danger },
  state: { gap: 8 },
  stateText: { fontSize: 14, lineHeight: 20, opacity: 0.75 },
  stateAction: { fontSize: 14, fontWeight: '700' },
  rows: { gap: 10 },
  row: { borderTopWidth: 1, borderTopColor: vola.line, paddingTop: 10, gap: 2 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kcal: { fontSize: 20, fontWeight: '700' },
  badge: {
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    opacity: 0.8,
  },
  span: { fontSize: 13, opacity: 0.75 },
  macros: { fontSize: 12, opacity: 0.6 },
  source: { fontSize: 11, opacity: 0.5, marginTop: 2 },
  actions: { gap: 12, marginTop: 10 },
  warn: { fontSize: 12, lineHeight: 18, opacity: 0.75 },
  foot: { fontSize: 12, lineHeight: 18, opacity: 0.55, marginTop: 6 },
  undo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    padding: 12,
  },
  undoText: { fontSize: 13, flexShrink: 1 },
  undoAction: { fontSize: 14, fontWeight: '700' },
  add: { gap: 10, marginTop: 8 },
  addToggle: { fontSize: 14, fontWeight: '700' },
  strip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 2 },
  arrow: { fontSize: 14, paddingHorizontal: 4, opacity: 0.8 },
  arrowOff: { opacity: 0.25 },
  day: {
    minWidth: 32,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
  },
  dayText: { fontSize: 13 },
  pick: { fontSize: 13, opacity: 0.75 },
});
