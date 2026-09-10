import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import {
  fetchHRMax,
  hrMaxDerivationLines,
  hrMaxMissingCopy,
  hrMaxSourceLabel,
  type HRMaxResolution,
} from '@/lib/hrMax';
import { ZONE_LABELS, zoneBpmLabel, zoneBpmRanges, zoneColor } from '@/lib/hrZones';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Your heart-rate zones, in beats — N535/#966.
 *
 * ## What this screen is FOR
 *
 * Every zone this app quotes is computed against one number, and until this
 * screen existed that number was invisible. N534's run library says a tempo
 * run is "Zones 3-4"; the session report counts minutes in each zone; the live
 * indicator colours a bpm by zone. Three surfaces speaking in zones, and
 * nowhere an athlete could find out what a zone IS for them, in beats, or
 * where the maximum behind it came from.
 *
 * ## The derivation is the screen, not a footnote
 *
 * `app/goals.tsx` sets the pattern this follows: a target is an argument, and
 * an argument you cannot inspect is a verdict. So "How this was worked out"
 * shows which maximum is in force, where it came from and — for a measured one
 * — when it was recorded and how many readings stand behind it. That last
 * number matters more than it looks: an observed maximum resting on four
 * samples and one resting on forty thousand are different claims, and the
 * athlete is the only person who can tell which of theirs is real.
 *
 * ## The empty state names what is missing, and shows no number
 *
 * With neither a measured maximum nor a usable date of birth there is no
 * honest answer, so the screen says so and names both ways to fix it. It does
 * NOT fall back to a population average, and it does not clamp to
 * `MIN_HR_MAX_BPM` — N485 settled that argument once already against a
 * clamping implementation, and `lib/biometric.ts` records the reasoning:
 * clamping is a fabricated number that happens to sit on a boundary.
 *
 * ## Why the zones themselves are not configurable here
 *
 * The 50/60/70/80/90% floors are the SERVER'S (`trimp.go`'s `zoneFloors`), and
 * a client that let an athlete move them would report every past session in
 * bands the scores were never computed in. See `lib/hrZones.ts`'s doc comment.
 */
export default function HRZonesScreen() {
  const getToken = useAuthToken();
  const [hrMax, setHRMax] = useState<HRMaxResolution | null>(null);
  const [failed, setFailed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      setFailed(false);
      fetchHRMax(getToken, new Date())
        .then((r) => {
          if (live) setHRMax(r);
        })
        .catch(() => {
          // Offline, or the profile read failed. Distinguished from
          // `unresolved` on purpose: "we could not ask" and "there is nothing
          // to go on" are different sentences and only one of them is the
          // athlete's to act on.
          if (live) setFailed(true);
        });
      return () => {
        live = false;
      };
    }, [getToken]),
  );

  if (failed) {
    return (
      <View style={styles.centre}>
        <Text style={styles.emptyTitle} testID="hr-zones-error">
          Could not load your zones
        </Text>
        <Text style={styles.emptyBody}>
          We could not reach your profile just now. Pull back and open this again once you have a
          connection.
        </Text>
      </View>
    );
  }

  if (hrMax == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={vola.textDim} testID="hr-zones-loading" />
      </View>
    );
  }

  if (hrMax.kind === 'unresolved') {
    const copy = hrMaxMissingCopy(hrMax.reason);
    return (
      <ScrollView contentContainerStyle={styles.scroll} testID="hr-zones-unresolved">
        <RNView style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>{copy.title}</Text>
          <Text style={styles.emptyBody}>{copy.body}</Text>
        </RNView>
        <Link href="/profile/edit" style={styles.link} testID="hr-zones-profile-link">
          Open your profile
        </Link>
      </ScrollView>
    );
  }

  const ranges = zoneBpmRanges(hrMax.bpm);
  const derivation = hrMaxDerivationLines(hrMax, new Date());

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="hr-zones">
      <RNView style={styles.hero}>
        <Text style={styles.heroValue} testID="hr-zones-hrmax">
          {hrMax.bpm} bpm
        </Text>
        <Text style={styles.heroLabel}>Your maximum heart rate</Text>
        {/* Design doc §3 step 3 — never silently switch. This badge is the
            whole of "never silently": the number above it changes meaning
            entirely depending on which of the two produced it, and an athlete
            who cannot see which is being told a measurement when they have an
            estimate. */}
        <RNView
          style={[
            styles.badge,
            { borderColor: hrMax.kind === 'observed' ? vola.green : vola.textDim },
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              { color: hrMax.kind === 'observed' ? vola.green : vola.textMuted },
            ]}
            testID="hr-zones-source"
          >
            {hrMaxSourceLabel(hrMax)}
          </Text>
        </RNView>
      </RNView>

      <Section title="Your zones">
        {ranges.map((r) => (
          <RNView key={r.zone} style={styles.zoneRow} testID={`hr-zones-zone-${r.zone}`}>
            <RNView style={[styles.zoneDot, { backgroundColor: zoneColor(r.zone) }]} />
            <Text style={styles.zoneName}>
              Z{r.zone} · {ZONE_LABELS[r.zone]}
            </Text>
            <Text style={styles.zoneBpm}>{zoneBpmLabel(r)}</Text>
          </RNView>
        ))}
      </Section>

      <Section title="How this was worked out">
        {derivation.map((line) => (
          <RNView key={line.label} style={styles.derivRow}>
            <Text style={styles.derivLabel}>{line.label}</Text>
            <Text style={styles.derivValue}>{line.value}</Text>
          </RNView>
        ))}
        {hrMax.kind === 'estimated' && (
          <Text style={styles.note} testID="hr-zones-upgrade-note">
            Wear a heart-rate monitor for a session or two and we will use your own highest reading
            instead — it knows something about you that a formula cannot.
          </Text>
        )}
      </Section>

      <Section title="Where these bands come from">
        <Text style={styles.note}>
          The five zones are the standard 50/60/70/80/90% of your maximum. They are the same bands
          your session reports count minutes in, so what you are coached in and what you are
          reported back are one thing.
        </Text>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <RNView style={styles.section}>
      {/* Matches `run-type/[id].tsx` and `technique/[id].tsx`: a screen reader
          can jump between headings, and without the role these read as loose
          uppercase text between paragraphs. */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </RNView>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  scroll: { padding: 16, gap: 20, paddingBottom: 48 },
  hero: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.line,
  },
  heroValue: { fontSize: 40, fontWeight: '700', color: vola.text },
  heroLabel: { fontSize: 13, color: vola.textMuted },
  badge: {
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeText: { fontSize: 11, fontWeight: '600' },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: vola.textDim,
  },
  zoneRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  zoneDot: { width: 8, height: 8, borderRadius: 4 },
  zoneName: { flex: 1, fontSize: 14, color: vola.text },
  zoneBpm: { fontSize: 14, fontVariant: ['tabular-nums'], color: vola.textMuted },
  derivRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' },
  derivLabel: { fontSize: 13, color: vola.textMuted },
  derivValue: { flex: 1, minWidth: 140, fontSize: 13, color: vola.text },
  note: { fontSize: 13, lineHeight: 19, color: vola.textMuted },
  emptyCard: {
    gap: 8,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.line,
  },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: vola.text },
  emptyBody: { fontSize: 14, lineHeight: 20, color: vola.textMuted },
  link: { fontSize: 14, color: vola.green, paddingVertical: 8 },
});
