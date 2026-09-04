import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';

/**
 * "What time did it actually end?" — the correction N487/#848 adds to BJJ's
 * two end-time defaults: a duration preset on the post-hoc log screen
 * (`app/bjj/log.tsx`), and "now" on the live Finish button
 * (`app/bjj/session/[id].tsx`). Neither default is wrong most of the time —
 * both assume the athlete is filling this in right after class, which is the
 * common case — but N476/N477 already join a session's HR data to
 * `started_at`..`ended_at`, and the one case the defaults get wrong (logged
 * hours late) silently feeds the wrong window into that join: couch heart
 * rate instead of training heart rate. This is what lets the athlete correct
 * it, and only when they choose to — see each call site for why the fast
 * path is untouched when they don't.
 *
 * **A row, not a form.** Collapsed it reads as a fact ("Ended at 8:42 PM");
 * tapping it opens a sheet with the same shape as the reschedule sheet
 * elsewhere in this app (`app/bjj/session/[id].tsx`'s `commitReschedule`
 * modal) — quick chips for the common case (an offset from real "now"), one
 * tap and done, plus a coarser/finer nudge pair for anything the chips don't
 * land on exactly. There is no native time-picker dependency in this app
 * (see that sheet's own comment on why) and adding one for a single optional
 * correction is not worth a prebuild for every device.
 */

/** Common "class ran long and I'm only logging it now" gaps, in minutes. */
const QUICK_OFFSETS_MIN = [0, 30, 60, 120, 180, 240];

function formatOffset(min: number): string {
  if (min === 0) return 'Just now';
  if (min < 60) return `${min}m ago`;
  return `${min / 60}h ago`;
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function EndTimeCorrection({
  value,
  now,
  notBefore,
  onChange,
  testID = 'end-time',
}: {
  /** The end time currently in effect — a computed default, or a prior correction. */
  value: Date;
  /**
   * Produces the real "now" the quick-offset chips subtract from, called once
   * when the sheet OPENS rather than read as a live value. Two reasons, both
   * load-bearing: `value` may already carry a correction, and "1h ago" is a
   * claim about the real world at the moment the athlete opens the sheet —
   * chaining offsets off a once-corrected value would make each visit drift
   * further from what was meant. And a function evaluated once decouples the
   * chips from however many times the parent screen re-renders while the
   * sheet is open (a background fetch settling, say) — a plain `Date` prop
   * recomputed on every parent render would let "now" creep forward under
   * the athlete's thumb between opening the sheet and tapping a chip.
   */
  now: () => Date;
  /**
   * A floor the corrected end time may never fall below — the live-session
   * Finish flow passes the session's own `started_at` (N487 review finding):
   * without it, a mis-tapped "4h ago" on a session that started 40 minutes
   * ago produces a negative duration `minutesBetween` (`bjj/session/[id].tsx`)
   * silently clamps to zero rather than rejecting, and that bad `ended_at`
   * still reaches the backend and feeds the exact HR join this component
   * exists to fix — worse than the pre-ticket behaviour, which always had
   * `ended_at >= started_at` by construction ("now" can't be earlier than a
   * session already in progress). The post-hoc log screen has no equivalent
   * floor: `started_at` there is DERIVED from the chosen end time, so
   * ordering is structurally safe and it passes nothing.
   */
  notBefore?: Date;
  onChange: (d: Date) => void;
  testID?: string;
}) {
  const accent = useAccent();
  const [open, setOpen] = useState(false);
  // The sheet's own working value, seeded from `value` each time it opens —
  // so the nudge buttons adjust a local draft and Cancel truly discards,
  // rather than every nudge committing immediately to the screen behind it.
  const [draft, setDraft] = useState<Date>(value);
  // Captured once per open, for the reason `now`'s own doc explains.
  const [openedAt, setOpenedAt] = useState<Date>(value);

  function openSheet() {
    setDraft(value);
    setOpenedAt(now());
    setOpen(true);
  }

  /** Never below `notBefore` — the floor `applyOffset`/`nudge`/`save` all share. */
  function clamp(d: Date): Date {
    return notBefore && d.getTime() < notBefore.getTime() ? notBefore : d;
  }

  function applyOffset(min: number) {
    onChange(clamp(new Date(openedAt.getTime() - min * 60_000)));
    setOpen(false);
  }

  function nudge(minutes: number) {
    setDraft((d) => clamp(new Date(d.getTime() + minutes * 60_000)));
  }

  function save() {
    onChange(clamp(draft));
    setOpen(false);
  }

  return (
    <>
      <Pressable
        onPress={openSheet}
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel={`Ended at ${formatClock(value)}. Tap to correct the end time.`}
        testID={`${testID}-row`}
      >
        <RNView>
          <Text style={styles.rowLabel}>Ended at</Text>
          <Text style={styles.rowValue} testID={`${testID}-value`}>
            {formatClock(value)}
          </Text>
        </RNView>
        <Text style={[styles.rowHint, { color: accent.ink }]}>Correct</Text>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
        testID={`${testID}-sheet-modal`}
      >
        <View style={styles.sheet} lightColor={vola.bg} darkColor={vola.bg} testID={`${testID}-sheet`}>
          <RNView style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>When did it actually end?</Text>
            <Pressable
              onPress={() => setOpen(false)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              testID={`${testID}-cancel`}
            >
              <Text style={[styles.close, { color: accent.ink }]}>Cancel</Text>
            </Pressable>
          </RNView>

          <Text style={styles.sectionLabel}>How long ago</Text>
          <RNView style={styles.chips}>
            {QUICK_OFFSETS_MIN.map((min) => {
              // Disabled rather than silently clamped-on-tap: a chip that
              // reads "4h ago" but actually lands on `notBefore` when tapped
              // would show the athlete one time and record another.
              const disabled =
                notBefore != null &&
                new Date(openedAt.getTime() - min * 60_000).getTime() < notBefore.getTime();
              return (
                <Pressable
                  key={min}
                  onPress={() => applyOffset(min)}
                  disabled={disabled}
                  style={[styles.chip, disabled && styles.chipDisabled]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled }}
                  testID={`${testID}-offset-${min}`}
                >
                  <Text style={[styles.chipText, disabled && styles.chipTextDisabled]}>
                    {formatOffset(min)}
                  </Text>
                </Pressable>
              );
            })}
          </RNView>
          {notBefore != null && (
            <Text style={styles.floorNote}>Can’t be before this session started.</Text>
          )}

          <Text style={styles.sectionLabel}>Or fine-tune the exact time</Text>
          <RNView style={styles.exactRow}>
            {(() => {
              const atFloor =
                notBefore != null && draft.getTime() - 15 * 60_000 < notBefore.getTime();
              return (
                <Pressable
                  onPress={() => nudge(-15)}
                  disabled={atFloor}
                  style={[styles.nudgeBtn, atFloor && styles.nudgeBtnDisabled]}
                  accessibilityRole="button"
                  accessibilityLabel="15 minutes earlier"
                  accessibilityState={{ disabled: atFloor }}
                  testID={`${testID}-nudge-back`}
                >
                  <Text style={[styles.nudgeSign, atFloor && styles.nudgeSignDisabled]}>−15m</Text>
                </Pressable>
              );
            })()}
            <Text style={styles.exactValue} testID={`${testID}-draft-value`}>
              {formatClock(draft)}
            </Text>
            <Pressable
              onPress={() => nudge(15)}
              style={styles.nudgeBtn}
              accessibilityRole="button"
              accessibilityLabel="15 minutes later"
              testID={`${testID}-nudge-forward`}
            >
              <Text style={styles.nudgeSign}>+15m</Text>
            </Pressable>
          </RNView>

          <Pressable
            onPress={save}
            style={[styles.save, { backgroundColor: accent.accent }]}
            accessibilityRole="button"
            testID={`${testID}-save`}
          >
            <Text style={[styles.saveText, { color: accent.on }]}>Save</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 44,
    marginTop: 10,
  },
  rowLabel: {
    fontSize: 11,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  rowValue: { fontSize: 15, fontWeight: '700', color: vola.text, marginTop: 1 },
  rowHint: { fontSize: 13, fontWeight: '700' },

  sheet: { flex: 1, padding: 20 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: vola.text },
  close: { fontWeight: '700', fontSize: 15 },

  sectionLabel: {
    fontSize: 11,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
    marginTop: 8,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: {
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipText: { color: vola.text, fontSize: 13, fontWeight: '600' },
  // A chip that would land before `notBefore` — opacity only, same 0.4-0.5
  // range every other disabled control in this app uses (e.g. `log.tsx`'s
  // `styles.disabled`), never a colour swap that would need a second theme
  // check.
  chipDisabled: { opacity: 0.4 },
  chipTextDisabled: { color: vola.textDim },
  floorNote: { color: vola.textDim, fontSize: 11, marginBottom: 4, marginTop: -4 },

  exactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    marginBottom: 24,
  },
  nudgeBtn: {
    minWidth: 64,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nudgeBtnDisabled: { opacity: 0.4 },
  nudgeSign: { fontSize: 15, fontWeight: '700', color: vola.text },
  nudgeSignDisabled: { color: vola.textDim },
  exactValue: { fontSize: 22, fontWeight: '800', color: vola.text, fontVariant: ['tabular-nums'] },

  save: { borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  saveText: { fontWeight: '800', fontSize: 16 },
});
