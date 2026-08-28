import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { ClassPlanTimer, useClassPlanRun } from '@/components/ClassPlanTimer';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { canAdvance, canGoBack, currentBlock, upcomingBlock } from '@/lib/classPlanRun';
import { getClassPlan, type ClassPlan, type ClassPlanBlock } from '@/lib/classplans';
import { useAuthToken } from '@/lib/useAuthToken';

/** Mirrors `apps/web/src/app/dashboard/classplans/[id]/page.tsx`'s
 *  `BLOCK_LABEL` exactly — the same words either surface, since a coach
 *  reading "Technique drill" on the phone and "technique_drill" on the web
 *  detail page (or vice versa) would read as two different apps. */
const BLOCK_LABEL: Record<ClassPlanBlock['type'], string> = {
  warmup: 'Warmup',
  technique_drill: 'Technique drill',
  live_rounds: 'Live rounds',
  notes: 'Notes',
};

/** The short line "Next up" renders — a technique's name, a drill's free
 *  text, or the generic type label for a block with no library pointer.
 *  Deliberately short: next-up previews what is coming, it does not render
 *  it in full (that would be the current block's job, when it arrives). */
function blockSummary(b: ClassPlanBlock): string {
  if (b.type === 'technique_drill') {
    return (b.technique_id ? b.technique_name : b.free_text) || BLOCK_LABEL[b.type];
  }
  return BLOCK_LABEL[b.type];
}

/**
 * The guided runner: current block, its timer, and next up.
 *
 * **Fetched once, on mount — not on every focus.** `sequence/index.tsx` and
 * this app's other read screens refetch whenever the screen regains focus,
 * which is right for a screen that only ever displays server state. This
 * one is running a live session: refetching mid-block would rebuild the run
 * from block zero the moment the athlete so much as opened another app and
 * came back, discarding exactly the position `lib/classPlanRun.ts` exists to
 * hold onto. So the plan is read once, and everything after that is local.
 *
 * **Position and time live in ONE hook — `useClassPlanRun`.** Which block is
 * current (`lib/classPlanRun.ts`'s pure `RunState`) and how long is left on
 * it are always advanced together, so this screen owns neither directly; it
 * calls `start` once the plan has loaded and reads `run`/`remaining`/`total`/
 * `finished` back. See that hook's header for why the two are not split
 * across a screen/hook boundary the way they might first look like they
 * should be.
 */
export default function ClassPlanRunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();
  const accent = useAccent();
  const router = useRouter();

  const [plan, setPlan] = useState<ClassPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { run, remaining, total, finished, start, goNext, goBack } = useClassPlanRun();

  useEffect(() => {
    if (!id) return;
    const c = new AbortController();
    getClassPlan(getToken, id, c.signal)
      .then((p) => {
        if (c.signal.aborted) return;
        setPlan(p);
        start(p.blocks ?? []);
      })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => c.abort();
    // `start` is stable — `useClassPlanRun` memoizes it with `useCallback`
    // all the way down — so listing it costs nothing and keeps the
    // dependency array honest about what this effect reads.
  }, [getToken, id, start]);

  const block = run ? currentBlock(run) : null;

  if (error && !plan) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'Class plan' }} />
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="classplan-run-error">
          {error}
        </Text>
      </View>
    );
  }

  if (!plan) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'Class plan' }} />
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading this class plan" />
      </View>
    );
  }

  const blocks = plan.blocks ?? [];

  if (blocks.length === 0) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: plan.name }} />
        <Text style={styles.note} testID="classplan-run-empty">
          This class plan has no blocks yet. Add some on the web app, then come back to run it.
        </Text>
      </View>
    );
  }

  if (finished || !run) {
    return (
      <View style={styles.screen} testID="classplan-run-complete">
        <Stack.Screen options={{ title: plan.name }} />
        <Text style={styles.doneTitle}>Plan complete</Text>
        <Text style={styles.note}>
          You ran every block of {plan.name}. Nice class.
        </Text>
        <Pressable
          onPress={() => router.replace('/classplans')}
          accessibilityRole="button"
          style={[styles.primaryButton, { backgroundColor: accent.accent }]}
        >
          <Text style={[styles.primaryButtonText, { color: accent.on }]}>Back to class plans</Text>
        </Pressable>
      </View>
    );
  }

  // Unreachable once the two guards above have run — `run` is non-null and
  // `blocks.length > 0` — but typed as nullable, so this satisfies the
  // compiler without a non-null assertion.
  if (!block) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: plan.name }} />
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading this class plan" />
      </View>
    );
  }

  const upcoming = upcomingBlock(run);

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="classplan-run-screen">
      <Stack.Screen options={{ title: plan.name }} />

      <Text style={styles.progressLabel}>
        Block {run.at + 1} of {blocks.length}
      </Text>

      <View style={styles.card}>
        <Text style={[styles.eyebrow, { color: accent.ink }]} testID="classplan-run-block-type">
          {BLOCK_LABEL[block.type]}
        </Text>

        <ClassPlanTimer remaining={remaining} total={total} tint={accent.accent} />

        <BlockContent block={block} />
      </View>

      <View style={styles.nextCard} testID="classplan-run-next">
        <Text style={styles.nextLabel}>Next up</Text>
        <Text style={styles.nextValue} numberOfLines={2}>
          {upcoming ? `${BLOCK_LABEL[upcoming.type]} · ${blockSummary(upcoming)}` : 'Last block'}
        </Text>
      </View>

      <View style={styles.controls}>
        <Pressable
          onPress={goBack}
          disabled={!canGoBack(run)}
          accessibilityRole="button"
          accessibilityLabel="Back a block"
          accessibilityState={{ disabled: !canGoBack(run) }}
          style={({ pressed }) => [
            styles.controlButton,
            !canGoBack(run) && styles.controlButtonDisabled,
            pressed && styles.pressed,
          ]}
          testID="classplan-run-back"
        >
          <Text style={styles.controlText}>Back</Text>
        </Pressable>
        <Pressable
          onPress={goNext}
          accessibilityRole="button"
          accessibilityLabel={canAdvance(run) ? 'Next block' : 'Finish plan'}
          style={({ pressed }) => [
            styles.controlButton,
            styles.controlButtonPrimary,
            { backgroundColor: accent.accent },
            pressed && styles.pressed,
          ]}
          testID="classplan-run-next-button"
        >
          <Text style={[styles.controlText, { color: accent.on }]}>
            {canAdvance(run) ? 'Next' : 'Finish'}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * A block's own content — mirrors the reasoning of
 * `apps/web/src/app/dashboard/classplans/[id]/page.tsx`'s per-type rendering
 * exactly, not just its result: a `technique_drill` shows the catalog pick OR
 * the free text (never both, matching the backend's XOR), and a `notes`
 * block's note IS the content while every other block's note is
 * supplementary detail underneath.
 */
function BlockContent({ block }: { block: ClassPlanBlock }) {
  return (
    <>
      {block.type === 'technique_drill' && (
        <Text style={styles.mainContent} testID="classplan-run-drill">
          {block.technique_id
            ? `${block.technique_name ?? ''}${
                block.technique_position ? ` · ${block.technique_position}` : ''
              }`
            : block.free_text}
        </Text>
      )}

      {block.type === 'notes' ? (
        block.notes !== '' && (
          <Text style={styles.mainContent} testID="classplan-run-notes-main">
            {block.notes}
          </Text>
        )
      ) : (
        block.notes !== '' && (
          <Text style={styles.supplementary} testID="classplan-run-notes-supplementary">
            {block.notes}
          </Text>
        )
      )}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 20, gap: 12 },
  scroll: { padding: 20, gap: 16, paddingBottom: 48, flexGrow: 1 },
  loading: { marginTop: 32 },
  error: { color: vola.danger, fontSize: 14 },
  note: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  progressLabel: { color: vola.textMuted, fontSize: 13, fontWeight: '600' },
  card: {
    backgroundColor: vola.surface,
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 18,
    padding: 20,
    gap: 16,
    alignItems: 'center',
  },
  eyebrow: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  mainContent: {
    color: vola.text,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  supplementary: {
    color: vola.textMuted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  nextCard: {
    backgroundColor: vola.surfaceRaised,
    borderColor: vola.lineSoft,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 2,
  },
  nextLabel: {
    color: vola.textDim,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  nextValue: { color: vola.textMuted, fontSize: 14, fontWeight: '600' },
  controls: { flexDirection: 'row', gap: 12 },
  // Large touch targets throughout — reachable one-handed, standing up, per
  // the mobile-first rule's live-logging convention.
  controlButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButtonPrimary: { borderWidth: 0, flex: 2 },
  controlButtonDisabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
  controlText: { fontSize: 17, fontWeight: '800', color: vola.text },
  doneTitle: { fontSize: 24, fontWeight: '800', color: vola.text },
  primaryButton: {
    minHeight: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 8,
  },
  primaryButtonText: { fontSize: 16, fontWeight: '800' },
});
