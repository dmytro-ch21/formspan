import { ActivityIndicator, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import type { ChangeView } from '@/lib/progress';

/**
 * The interpretation, above every number on this tab.
 *
 * ## Why this is second and not fourth
 *
 * The ticket's hierarchy is interpretation → recent context → discipline
 * drill-down → raw charts, and this is the interpretation layer. "Am I getting
 * better?" is a question about MEANING, and a screen that opens with a heatmap
 * has answered a different one — it has handed the athlete the evidence and
 * asked them to do the reading. Every chart on this tab is still here; they are
 * simply underneath the sentence they support.
 *
 * ## Nothing here is invented
 *
 * Each insight is a restatement of a figure that already exists somewhere in
 * this app — a fresh personal best from `lib/records.ts`, a week-on-week
 * session count from `lib/weekReview.ts`, a smoothed weight delta from
 * `lib/anthropometry.ts`. `whatChanged` picks and phrases; it does not compute
 * a second opinion about any of them.
 *
 * ## The state that is easy to get wrong
 *
 * "Nothing stands out" is a claim about the athlete's week and it is only true
 * once every source has answered. `whatChanged` is what enforces that, and this
 * component simply renders the four kinds it returns — which is the point of
 * having them be four kinds. A `checking` that fell through to the quiet copy
 * would tell an athlete mid-fetch that nothing they did this week mattered.
 */
export function WhatChanged({ view, testID }: { view: ChangeView; testID?: string }) {
  const accent = useAccent();

  if (view.state === 'checking') {
    return (
      <View style={styles.card} testID={testID}>
        <ActivityIndicator accessibilityLabel="Looking for what changed" />
      </View>
    );
  }

  if (view.state === 'unavailable') {
    return (
      <View style={styles.card} testID={testID}>
        <Text style={styles.muted} testID="what-changed-unavailable">
          Couldn&apos;t read your history just now, so there is nothing to compare against yet.
        </Text>
      </View>
    );
  }

  if (view.state === 'quiet') {
    return (
      <View style={styles.card} testID={testID}>
        {/* Not "you did nothing" and not a nudge. A week that held steady is a
            legitimate week — rest is a training state — so this reports the
            absence of NEWS rather than the absence of effort. */}
        <Text style={styles.muted} testID="what-changed-quiet">
          Nothing has moved much since last week. Steady is a result too.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID={testID}>
      {view.insights.map((i, n) => (
        <RNView
          key={i.id}
          style={[styles.insight, n > 0 && styles.divided]}
          accessible
          // One stop per insight. Read as two elements, the headline and its
          // evidence arrive as unrelated fragments — and the evidence is the
          // half that makes the headline believable.
          accessibilityLabel={`${i.headline}. ${i.detail}`}
          testID={`what-changed-${i.id}`}
        >
          <RNView style={[styles.pip, { backgroundColor: accent.accent }]} />
          <RNView style={styles.body}>
            <Text style={styles.headline}>{i.headline}</Text>
            <Text style={styles.detail}>{i.detail}</Text>
          </RNView>
        </RNView>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 12,
  },
  insight: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.line,
    paddingTop: 12,
  },
  // A mark rather than an icon: there is no glyph that means "this changed",
  // and an approximate one would be read as a category.
  pip: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  body: { flex: 1, gap: 2, backgroundColor: 'transparent' },
  headline: { fontSize: 15, fontWeight: '700', lineHeight: 20 },
  detail: { fontSize: 13, color: vola.textMuted, lineHeight: 18 },
  muted: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
});
