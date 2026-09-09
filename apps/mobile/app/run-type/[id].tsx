import { Link, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { hrMaxBpmOf, useHRMax } from '@/lib/hrMonitor/useHRMax';
import { ZONE_LABELS, zoneBandBpmLabel, zoneBandLabel, zoneColor } from '@/lib/hrZones';
import { focusCode, RUN_GOALS, runTypeById } from '@/lib/runTypes';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * One run type, read before you go out and do it — N534.
 *
 * ## No loading state, and no error state worth the name
 *
 * Every other detail screen in this app (`technique/[id]`, `exercise/[id]`)
 * opens with a spinner, because its subject arrives over the network. This one
 * cannot: `lib/runTypes.ts` is a local constant, so the answer is available
 * synchronously on the first render, in a basement gym, on a dead connection.
 * That is the whole reason the catalog was built as a constant, and the
 * absence of an `ActivityIndicator` here is what it bought.
 *
 * The one failure that remains is a route param naming a run that does not
 * exist — a stale deep link, or an id renamed by a later ticket. That gets an
 * honest empty state rather than a blank screen of undefined fields, the same
 * rule `technique/[id]` follows: never render blank fields that read as "this
 * run has no description".
 *
 * ## What is deliberately NOT here yet
 *
 * **Beats per minute — FILLED by N535/#966.** This screen used to say
 * "Zones 3-4" and stop, because turning a zone into a number needs the
 * athlete's own HRmax and deriving that honestly was N535's whole job. It now
 * says "152-171 bpm" underneath, whenever there is a maximum worth quoting
 * one from, and links to `app/hr-zones.tsx` for where that maximum came from.
 * When there is not — no measured maximum and no usable date of birth — it
 * falls back to exactly what it said before rather than printing a range off
 * a guess, which is the confident-and-wrong failure this repo keeps naming.
 *
 * **A "start this run" button.** The run types are a reference today, not a
 * plan: N536 is what connects a goal to a week, and until it exists a button
 * here could only start a generic run, which the Today screen already does
 * better. A button that pretends to know what you are about to run is worse
 * than no button.
 */
export default function RunTypeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const run = runTypeById(String(id));
  // Enabled unconditionally: this screen is read BEFORE a run, which is
  // exactly when knowing the beats is worth a round trip. Null while it is in
  // flight or when there is no usable maximum, and the band renders without a
  // bpm line in both cases — the zone words never wait on the network.
  const hrMaxBPM = hrMaxBpmOf(useHRMax(useAuthToken(), true));

  if (!run) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error} testID="run-type-error">
          That run type no longer exists.
        </Text>
        <Text style={styles.errorHint}>
          It may have been renamed. Open the Library to see what is there now.
        </Text>
      </View>
    );
  }

  const band = zoneBandLabel(run.zones[0], run.zones[1]);
  const accent = zoneColor(run.zones[1]);
  // The band's label reads off its HARDEST zone, which is the one that decides
  // what the session costs you — a run spanning zones 2 to 4 is a hard run
  // with an easy start, not a light one.
  const bandLabel = ZONE_LABELS[run.zones[1]];

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="run-type-detail">
      <RNView style={[styles.hero, { borderColor: accent }]}>
        <Text style={[styles.heroCode, { color: accent }]}>{focusCode(run.trains)}</Text>
        <Text style={styles.heroName}>{run.name}</Text>
        <Text style={[styles.heroBand, { color: accent }]}>
          {band} · {bandLabel}
        </Text>
        {hrMaxBPM != null && (
          <Link href="/hr-zones" style={styles.heroBpm} testID="run-type-bpm">
            {zoneBandBpmLabel(run.zones[0], run.zones[1], hrMaxBPM)}
          </Link>
        )}
      </RNView>

      <Section title="What it trains">
        <Text style={styles.body}>{run.trains}</Text>
      </Section>

      {/*
        Effort comes BEFORE the zone band everywhere on this screen, and the
        order is the argument: an athlete with no strap can act on "short
        sentences only" today, while the zone is only actionable once N535 can
        turn it into beats per minute. Leading with the number would put the
        half that does not work yet above the half that always does.
      */}
      <Section title="How it should feel">
        <Text style={styles.body}>{run.effort}</Text>
      </Section>

      <Section title="How it goes">
        <Text style={styles.body}>{run.structure}</Text>
        <Text style={styles.meta}>
          Typically {run.minutes[0]}-{run.minutes[1]} minutes
        </Text>
      </Section>

      {run.hrUnreliable && (
        // Not a footnote. An athlete wearing a strap will otherwise look down
        // mid-stride, see zone 2, and conclude they are not trying hard enough
        // — during an effort that is genuinely maximal. Heart rate lags effort
        // by roughly 30 seconds, and these runs are over before it catches up.
        <Section title="Heart rate will not tell you much here">
          <Text style={styles.body}>
            These efforts are too short for your heart rate to catch up with them — it is still
            climbing when the rep ends. Go by how it feels and how fast you are moving, not by what
            your watch says.
          </Text>
        </Section>
      )}

      <Section title="Worth knowing">
        <Text style={styles.body}>{run.note}</Text>
      </Section>

      <Section title="Good for">
        <RNView style={styles.goals}>
          {run.goals.map((g) => (
            <RNView key={g} style={styles.goalChip}>
              <Text style={styles.goalText}>{RUN_GOALS[g]}</Text>
            </RNView>
          ))}
        </RNView>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <RNView style={styles.section}>
      {/* Matches `technique/[id].tsx`'s section labels: a screen reader can
          jump between headings, and without the role these read as loose
          uppercase text between paragraphs. */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </RNView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 20, paddingBottom: 48 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  error: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  errorHint: { fontSize: 13, color: vola.textDim, textAlign: 'center', lineHeight: 19 },

  hero: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    gap: 6,
    backgroundColor: vola.surface,
  },
  heroCode: { fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  heroName: { fontSize: 26, fontWeight: '800' },
  heroBpm: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    color: vola.textMuted,
    textDecorationLine: 'underline',
    paddingTop: 2,
  },
  heroBand: { fontSize: 13, fontWeight: '700' },

  section: { gap: 6 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: vola.textDim,
  },
  body: { fontSize: 15, lineHeight: 22 },
  meta: { fontSize: 13, color: vola.textDim },

  goals: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  goalChip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  goalText: { fontSize: 12, color: vola.textDim },
});
