import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View as RNView } from 'react-native';

import { categoryBadge, positionBadge } from '@/components/LibraryTile';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fetchPosition, techniquesInPosition, type Position } from '@/lib/positions';
import { FUNCTION_ORDER, groupByFunction } from '@/lib/techniqueGraph';
import { fetchTechniques, type TechniqueSummary } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * One position, explained.
 *
 * The library had 466 techniques and nothing that said what any of them
 * happened *inside* of — "Armbar from Closed Guard" is unreadable to someone
 * who has never been in a closed guard. This is the other half of that: the
 * node, rather than the edge.
 *
 * Built on `technique/[id]`'s visual language on purpose — same hero, same
 * cards, same measurements — because the two are peers in the Library and
 * reading one after the other should not feel like changing app. Four things
 * differ, each for a reason:
 *
 * 1. **No step list.** A technique is a sequence and splits into numbered
 *    steps; a position is a *state*, and numbering "keep your elbows in" as
 *    step 3 of 5 would invent an order that isn't there.
 * 2. **No legality card.** Positions aren't IBJJF-restricted — techniques are.
 * 3. **The cross-linked techniques ARE tappable**, unlike that screen's edge
 *    lists. There the names are prose that mostly doesn't resolve to a real
 *    entry; here every row came out of the fetched library, so all of them
 *    navigate. This is the payoff of the whole feature: read what side control
 *    is, then go straight to escaping it.
 * 4. **It is a FlatList, not a ScrollView.** That is not symmetry with the
 *    Library for its own sake — the Guard entries cross-link 161 techniques,
 *    and mounting ~900 native views to draw them stalls the screen a beginner
 *    opens first. `technique/[id]`'s ScrollView is safe only because its edge
 *    lists are 6-29 items. The prose rides along as the list header.
 *
 * The one rule carried over verbatim: a section with no content does not
 * render at all.
 */

/**
 * The same deadline the Library uses, for the same reason: iOS gives a request
 * ~60s before it gives up, and a captive portal accepts the connection and then
 * says nothing — so without this the screen spins for a minute with no error
 * and nothing to retry.
 *
 * The abort REASON is half of it, and leaving it out is worse than having no
 * deadline at all. Both an unmount and a timeout abort the same controller, and
 * they need opposite handling: an unmount must set no state, a timeout must set
 * an error. Treating them alike — returning early on `signal.aborted` — leaves
 * `loading` true forever, replacing a slow screen that eventually errors with a
 * spinner that never resolves and has no retry on it. `library.tsx` carries the
 * same pair for the same reason.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const TIMED_OUT = 'timed-out';

/** A row is either a verb heading or a technique under it. */
type ListRow =
  | { kind: 'header'; id: string; label: string; count: number }
  | { kind: 'technique'; id: string; technique: TechniqueSummary };

export default function PositionScreen() {
  // `accent` is taken in this file for the position badge's own colour.
  const ui = useAccent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const getToken = useAuthToken();

  const [position, setPosition] = useState<Position | null>(null);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      // `loading` starts true, so returning here without clearing it would
      // leave the same permanent spinner the deadline handling exists to
      // prevent — a route with no id is unreachable in practice, but "in
      // practice" is what the timeout branch assumed too.
      if (!id) {
        setError('Position not found.');
        setLoading(false);
        return;
      }
      // Both, and in this order. Without setLoading(true) a retry renders the
      // fallback branch for the whole request, because error is cleared while
      // position is still null.
      setLoading(true);
      setError(null);

      // Independent requests, so they run together — a cold-start deep link
      // otherwise pays two serialized round trips. allSettled rather than all
      // because their failures mean different things, handled separately below.
      const [p, list] = await Promise.allSettled([
        fetchPosition(id, getToken, signal),
        fetchTechniques(getToken, signal),
      ]);

      const timedOut = signal?.aborted && signal.reason === TIMED_OUT;
      // An abort that is NOT the deadline is an unmount or a supersede: the
      // screen is gone, so setting state would be pointless at best. The
      // deadline falls through deliberately and is reported below.
      if (signal?.aborted && !timedOut) return;

      if (p.status === 'rejected') {
        // A missing position, a dead network and a timeout are three different
        // problems, and only two of them are worth retrying. Telling someone to
        // check their connection because they followed a dead link is a wrong
        // answer delivered confidently.
        setError(
          timedOut
            ? 'This is taking too long. Check your connection and try again.'
            : /\(404\)/.test(String((p.reason as Error)?.message))
              ? 'That position is not in the library.'
              : 'Could not load this position. Check your connection and try again.',
        );
        setLoading(false);
        return;
      }
      setPosition(p.value);

      // Deliberately not fatal, and deliberately silent. The glossary entry is
      // what the athlete opened this screen for; failing the whole screen
      // because the library did not load would hide the prose that did arrive.
      // The cost is that a failed library is indistinguishable from a position
      // with no techniques — accepted, because the alternative is an error
      // about content nobody asked for.
      setTechniques(list.status === 'fulfilled' ? list.value : []);
      setLoading(false);
    },
    [id, getToken],
  );

  // One place that arms a deadline, so the retry below gets the same treatment
  // as the initial load. Without it a retry after a captive-portal hang — the
  // single likeliest moment for one — runs with no deadline at all.
  const loadWithDeadline = useCallback(
    (external?: AbortController) => {
      const ac = external ?? new AbortController();
      const deadline = setTimeout(() => ac.abort(TIMED_OUT), REQUEST_TIMEOUT_MS);
      void load(ac.signal).finally(() => clearTimeout(deadline));
      return () => {
        clearTimeout(deadline);
        ac.abort();
      };
    },
    [load],
  );

  useEffect(() => loadWithDeadline(), [loadWithDeadline]);

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={ui.accent} />
      </View>
    );
  }

  // An honest failure, not an empty position. This screen must never render
  // blank fields that read as "this position has no description".
  if (error || !position) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error} testID="position-error">
          {error ?? 'Position not found.'}
        </Text>
        <Pressable onPress={() => loadWithDeadline()} hitSlop={10} accessibilityRole="button">
          <Text style={[styles.retry, { color: ui.ink }]}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const p = position;
  const [code, accent] = positionBadge(p.id);
  const related = techniquesInPosition(techniques, p);

  // Grouped by what each technique DOES, not alphabetically.
  //
  // The whole point of the `function` column, and the first surface to read
  // it. Flat, this is up to 124 names in one alphabetical run, which answers
  // "what exists here" and not the question someone actually has standing in
  // the position: from here I can advance, reverse, escape, control or
  // finish — and these are the ways.
  //
  // Flattened into the FlatList rather than moving to a SectionList, because
  // this list's virtualisation is deliberately tuned (see the props below)
  // and a header row is cheaper than re-deriving that reasoning.
  const rows: ListRow[] = groupByFunction(related).flatMap((g) => [
    { kind: 'header' as const, id: `h-${g.fn}`, label: g.label, count: g.techniques.length },
    ...g.techniques.map((t) => ({ kind: 'technique' as const, id: t.id, technique: t })),
  ]);
  // Movement fundamentals carry no function, so grouping drops them. Kept
  // under their own heading rather than vanishing from a screen that
  // previously listed them.
  // Total, not `!t.function`: a value outside FUNCTION_ORDER would be in
  // neither the groups nor this bucket, so it would vanish while the section
  // header above still counted it — "· 45" over 44 rows. Unreachable today
  // (the seed validates the five), free to make impossible.
  const ungrouped = related.filter(
    (t) => !FUNCTION_ORDER.includes(t.function as (typeof FUNCTION_ORDER)[number]),
  );
  if (ungrouped.length > 0) {
    rows.push({ kind: 'header', id: 'h-other', label: 'Also here', count: ungrouped.length });
    rows.push(...ungrouped.map((t) => ({ kind: 'technique' as const, id: t.id, technique: t })));
  }

  return (
    <FlatList
      testID="position-detail"
      data={rows}
      keyExtractor={(r) => r.id}
      contentContainerStyle={styles.list}
      // The 124-row case is why this is virtualised at all.
      //
      // No removeClippedSubviews, deliberately, though the Library uses it: RN
      // documents it as able to drop content, and the shapes that trigger that
      // are absolutely-positioned children and negative margins — both of which
      // this list's header has (the hero's absoluteFill watermark, and the
      // -20 margin that cancels the list padding). If it misfired, what would
      // vanish is the prose, which is the entire point of the screen. windowSize
      // already caps the mounted set, so the marginal gain is small and the
      // downside is unverifiable without a device.
      initialNumToRender={10}
      windowSize={7}
      ListHeaderComponent={
        <>
          <Hero position={p} code={code} accent={accent} />
          <View style={styles.body}>
            {!!p.description && (
              <Card title="What it is" accent={accent}>
                <Text style={styles.prose}>{p.description}</Text>
              </Card>
            )}
            {!!p.priorities && (
              <Card title="What matters here" accent={accent}>
                <Priorities text={p.priorities} />
              </Card>
            )}
            {related.length > 0 && (
              <Text style={styles.edgeLabel} accessibilityRole="header">
                {sectionLabel(p, related.length)}
              </Text>
            )}
          </View>
        </>
      }
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <Text style={[styles.groupLabel, { color: ui.ink }]} accessibilityRole="header">
            {item.label} · {item.count}
          </Text>
        ) : (
          <TechniqueRow technique={item.technique} />
        )
      }
    />
  );
}

/**
 * Name the family when it isn't the position's own name.
 *
 * This is the honest version of a compromise the data forces. `Position.family`
 * is coarse — `techniques.position` only records "Guard - Bottom", never
 * closed vs open — so Closed Guard and Open Guard cross-link to the *same* 187
 * techniques, and Knee on Belly borrows Side Control's.
 *
 * Left unlabelled, the Open Guard screen listed 36 techniques whose names begin
 * "Closed-Guard …" directly beneath its own sentence saying the ankles are NOT
 * locked. That is worse than an empty list: an empty one looks broken, this one
 * looks authoritative and wrong, to precisely the reader with no way to tell.
 * Saying "from the guard family" costs one word and stops the screen claiming
 * something it cannot know.
 */
function sectionLabel(p: Position, count: number): string {
  // Two conditions, and both are about whether the list is honestly this
  // position's own.
  //
  // A detail filter means it is: closed and open guard each narrow the shared
  // Guard family down to their own techniques, so "FROM HERE" is true of them
  // even though their family is broader than their name.
  //
  // Without one, the name-vs-family check decides. startsWith rather than
  // equality because Back Control's family is "Back" — an artefact of the rows
  // saying "Back - Top (Back Control)", not a broader scope; nothing else maps
  // to it. That leaves Knee on Belly as the only qualified entry, which is
  // right: it genuinely borrows Side Control's list, having none of its own.
  const scoped = p.detail_includes.length > 0 || p.detail_excludes.length > 0;
  const own = scoped || p.name.toLowerCase().startsWith(p.family.toLowerCase());
  return `TECHNIQUES FROM ${own ? 'HERE' : `THE ${p.family} FAMILY`} · ${count}`.toUpperCase();
}

/**
 * Priorities, split by player.
 *
 * The field is authored as one or two paragraphs, and where there are two they
 * are labelled ("Bottom: …" / "Top: …") because every position is someone's
 * good news and someone else's problem. Pulling that label out as a heading is
 * what lets a reader find their own half at a glance instead of reading both.
 *
 * The label is detected rather than stored in its own column: the split is not
 * universal (standing has no top or bottom) and a schema that insisted on two
 * sides would force empty or duplicated prose on the entries that have one.
 */
function Priorities({ text }: { text: string }) {
  const ui = useAccent();
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <>
      {paragraphs.map((para, i) => {
        // Only a short leading word or two counts as a label. Without the
        // length bound any sentence containing a colon loses its first clause
        // to a heading — Standing's opening sentence has one at offset 56.
        const match = /^([A-Z][A-Za-z\s-]{0,14}):\s+([\s\S]+)$/.exec(para);
        if (!match) {
          return (
            <Text key={i} style={styles.prose}>
              {para}
            </Text>
          );
        }
        return (
          <RNView key={i} style={styles.sideBlock}>
            <Text style={[styles.sideLabel, { color: ui.ink }]} accessibilityRole="header">
              {match[1].toUpperCase()}
            </Text>
            <Text style={styles.prose}>{match[2]}</Text>
          </RNView>
        );
      })}
    </>
  );
}

/**
 * One cross-linked technique — the reason a glossary entry beats a dictionary
 * definition. Resolved locally from the library the app already holds, so the
 * whole list costs no request and works offline.
 */
function TechniqueRow({ technique }: { technique: TechniqueSummary }) {
  const [code, accent] = categoryBadge(technique.category);
  return (
    <Pressable
      style={({ pressed }) => [styles.edgeRow, pressed && styles.edgeRowPressed]}
      onPress={() => router.push(`/technique/${technique.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${technique.name}, ${technique.category}`}
      testID={`position-technique-${technique.id}`}
    >
      <RNView style={[styles.edgeCode, { borderColor: `${accent}44` }]}>
        <Text style={[styles.edgeCodeText, { color: accent }]}>{code}</Text>
      </RNView>
      <Text style={styles.edgeRowText} numberOfLines={2}>
        {technique.name}
      </Text>
    </Pressable>
  );
}

/**
 * Same band as the technique hero, same media slot for when position artwork
 * lands — a diagram helps here more than it does for a technique, so this is
 * the likelier of the two to get filled.
 */
function Hero({ position, code, accent }: { position: Position; code: string; accent: string }) {
  return (
    <RNView style={styles.hero}>
      <RNView
        style={[StyleSheet.absoluteFill, { backgroundColor: `${accent}14` }]}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={[styles.watermark, { color: `${accent}1F` }]} numberOfLines={1}>
          {code}
        </Text>
      </RNView>

      <RNView style={styles.heroScrim} pointerEvents="none" />

      <RNView style={styles.heroContent}>
        <Text style={[styles.eyebrow, { color: accent }]}>POSITION</Text>
        <Text style={styles.title}>{position.name}</Text>
        {position.aliases.length > 0 && (
          <Text style={styles.aliases} numberOfLines={2}>
            Also called {position.aliases.join(' · ')}
          </Text>
        )}
      </RNView>
    </RNView>
  );
}

function Card({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <RNView style={styles.card}>
      <RNView style={styles.cardHead}>
        <RNView style={[styles.cardRule, { backgroundColor: accent }]} />
        <Text style={styles.cardTitle} accessibilityRole="header">
          {title.toUpperCase()}
        </Text>
      </RNView>
      {children}
    </RNView>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 48, paddingHorizontal: 20 },
  // The header holds the hero, which is full-bleed, so it cancels the list's
  // own horizontal padding rather than inheriting it.
  body: { paddingVertical: 16, gap: 16 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  error: { color: vola.danger, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retry: { fontSize: 14, fontWeight: '600' },

  hero: {
    minHeight: 168,
    justifyContent: 'flex-end',
    backgroundColor: vola.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.line,
    overflow: 'hidden',
    marginHorizontal: -20,
  },
  watermark: {
    position: 'absolute',
    right: -46,
    top: -30,
    fontSize: 132,
    fontWeight: '900',
    letterSpacing: -4,
  },
  heroScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: '32%',
    backgroundColor: 'rgba(8,11,18,0.55)',
  },
  heroContent: { padding: 20, paddingTop: 28, gap: 4 },
  eyebrow: { fontSize: 11, letterSpacing: 1.4, fontWeight: '800' },
  title: { fontSize: 25, fontWeight: '700', lineHeight: 30 },
  aliases: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },

  card: {
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  cardRule: { width: 3, height: 13, borderRadius: 2 },
  // textMuted, not textDim: at 11px/800 this is not WCAG "large text", so 4.5:1
  // applies and textDim measures 3.67:1 on `surface`. Same correction as the
  // Library's glossary label.
  cardTitle: { color: vola.textMuted, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },

  // Generous line height on purpose: this is read standing up, often between
  // rounds, and cramped leading is the first thing to fail in that state.
  prose: { fontSize: 15, lineHeight: 23, color: vola.text },

  sideBlock: { gap: 5 },
  sideLabel: { fontSize: 11, letterSpacing: 1.2, fontWeight: '800' },

  // The verb headings inside the list. Distinct from edgeLabel, which names
  // the whole section once in the header — these repeat down the list and so
  // need top space to separate one group from the rows of the previous one.
  groupLabel: {
    fontSize: 12,
    letterSpacing: 1.2,
    fontWeight: '800',
    textTransform: 'uppercase',
    marginTop: 22,
    marginBottom: 6,
  },
  edgeLabel: {
    color: vola.textMuted, // 3.96:1 at textDim — under AA. See cardTitle.
    fontSize: 11,
    letterSpacing: 1.2,
    fontWeight: '800',
    // Pulls the label down toward the rows it names. The header's own 16pt
    // padding otherwise leaves it equidistant between the card above and the
    // list below, so it reads as floating rather than as a section heading.
    marginBottom: -7,
  },
  edgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: vola.surface,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    borderRadius: 10,
    paddingHorizontal: 13,
    // 13, not 11: these rows are tappable where the technique screen's
    // equivalents are inert, which brings the 44pt minimum target into scope.
    // At 11 the row measured ~41pt.
    paddingVertical: 13,
    marginBottom: 7,
  },
  edgeRowPressed: { backgroundColor: vola.surfaceRaised },
  // A 3-letter mark rather than a chevron: it says what KIND of technique the
  // row is (submission, escape, sweep) in the space an affordance arrow would
  // have used, and the whole row being pressable already reads as tappable.
  edgeCode: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  edgeCodeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  edgeRowText: { flex: 1, color: vola.text, fontSize: 14, lineHeight: 19 },
});
