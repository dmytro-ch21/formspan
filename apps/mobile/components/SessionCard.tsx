import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { forwardRef } from 'react';
import { StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { sportIcon } from '@/components/ui/sport';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { MOUNTAINS, mountainFor } from '@/lib/mountains';
import { headlineFor, type CardData } from '@/lib/sessionCard';

/**
 * The card a finished session ends on, and the image people post.
 *
 * ONE COMPONENT, THREE DENSITIES. The completion screen, the feed row and the
 * exported PNG are the same card at different sizes, because three renderings
 * of one thing drift apart — the feed would gain a stat the export never got,
 * and nobody would notice until somebody screenshotted the wrong one.
 *
 * ## Everything comes from `data`
 *
 * No hooks that reach into a screen, no fetching. That is what makes the card
 * renderable OFF-SCREEN for the export: `captureRef` needs a mounted view, and
 * a component that reads the session screen's state can only ever be mounted
 * by the session screen. The predecessor card carried a note saying it was
 * "meant to become a shareable image later" and kept itself to a plain summary
 * for exactly this reason; this is that later.
 *
 * ## The accent is the athlete's, not the card's
 *
 * The glow behind the peak, the eyebrow and the score ring all take
 * `accent.accent`. Six accents × eight peaks is forty-eight looks before
 * anything repeats, which is what stops a feed of these reading as a template
 * — and it costs nothing, because the accent already exists as a setting.
 *
 * ## What the lime does NOT do
 *
 * It never marks an ordinary number. Volume, duration and exercises are white.
 * The accent is reserved for what was earned — a PR, a streak — because if
 * every figure glowed, none of them would mean anything.
 */
export const SessionCard = forwardRef<RNView, { data: CardData; width: number }>(
  function SessionCard({ data, width }, ref) {
    const accent = useAccent();
    const peak = mountainFor(data.id);
    const glyph = sportIcon(data.sport);

    // The card is square. Everything below scales off its width so one
    // component serves a 358pt phone card and a 1080px export without a second
    // set of numbers to keep in sync.
    const u = width / 390;
    const s = stylesFor(u);

    return (
      <RNView ref={ref} style={[s.card, { width, height: width }]} collapsable={false}>
        {/* An athlete's own photo (N449, #747) takes the frame the mountain
            otherwise fills — same `s.photo` box, same `cover` fit, so an
            arbitrary phone photo crops the same way a mountain sized for
            this frame would rather than needing its own layout. */}
        <Image
          source={data.backgroundUri ? { uri: data.backgroundUri } : MOUNTAINS[peak]}
          style={s.photo}
          contentFit="cover"
          transition={0}
          testID="session-card-photo"
        />

        {/* The glow sits BEHIND the peak's silhouette and above the photo, so
            the accent reads as light coming off the summit rather than a
            coloured overlay on a picture. */}
        <RNView style={[s.glow, { backgroundColor: accent.accent }]} pointerEvents="none" />

        {/* Two gradients, not one. A single top-to-bottom scrim either drowns
            the sky or leaves the stat strip illegible; this darkens the left
            third for the headline and the bottom for the numbers, and leaves
            the peak itself untouched. */}
        <LinearGradient
          colors={['rgba(8,11,18,0.94)', 'rgba(8,11,18,0.55)', 'rgba(8,11,18,0)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <LinearGradient
          colors={['rgba(8,11,18,0)', 'rgba(8,11,18,0.82)', 'rgba(8,11,18,0.97)']}
          locations={[0.35, 0.72, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />

        <RNView style={s.inner}>
          <RNView style={s.top}>
            <Text style={s.wordmark}>VOLA</Text>
            <RNView style={s.date}>
              <Text style={s.dateText}>{data.dateLabel}</Text>
            </RNView>
          </RNView>

          <RNView style={s.headline}>
            <RNView style={s.eyebrowRow}>
              {glyph && <Icon name={glyph} size={13 * u} color={accent.ink} strokeWidth={2.2} />}
              <Text style={[s.eyebrow, { color: accent.ink }]}>{data.eyebrow}</Text>
            </RNView>
            <Text style={s.title} numberOfLines={2}>
              {headlineFor(data)}
            </Text>
            <Text style={s.subtitle} numberOfLines={1}>
              {data.title}
            </Text>
          </RNView>

          <RNView style={s.stats}>
            {data.stats.slice(0, 4).map((stat) => (
              <RNView key={stat.label} style={s.stat}>
                <Text style={s.statLabel}>{stat.label.toUpperCase()}</Text>
                <Text style={s.statValue}>{stat.value}</Text>
                {stat.unit ? <Text style={s.statUnit}>{stat.unit}</Text> : null}
              </RNView>
            ))}
          </RNView>

          {/* What was actually done. Absent until the server's numbers arrive
              and permanently absent offline — the card is complete without it,
              so this is a resting state rather than a loading one and gets no
              spinner. */}
          {(data.detail?.length ?? 0) > 0 && (
            <RNView style={s.detail}>
              {data.detail!.slice(0, 3).map((d) => (
                <RNView key={`${d.name}-${d.outcome ?? ''}`} style={s.detailRow}>
                  <Text style={s.detailName} numberOfLines={1}>
                    {d.name}
                  </Text>
                  <Text style={s.detailFigure}>
                    {d.figure ??
                      [d.outcome, d.count && d.count > 1 ? `×${d.count}` : null]
                        .filter(Boolean)
                        .join(' ')}
                  </Text>
                </RNView>
              ))}
              {(data.more ?? 0) + Math.max(0, (data.detail?.length ?? 0) - 3) > 0 && (
                <Text style={s.detailMore}>
                  {`+${(data.more ?? 0) + Math.max(0, (data.detail?.length ?? 0) - 3)} more`}
                </Text>
              )}
            </RNView>
          )}

          {/* Earned things only. Absent entirely when there are none — an
              empty badge rail would make an ordinary session look like it
              failed to win something. */}
          {data.badges.length > 0 && (
            <RNView style={s.badges}>
              {data.badges.slice(0, 2).map((b) => (
                <RNView key={b} style={[s.badge, { backgroundColor: accent.accent }]}>
                  <Text style={[s.badgeText, { color: accent.on }]} numberOfLines={1}>
                    {b}
                  </Text>
                </RNView>
              ))}
            </RNView>
          )}

          <RNView style={s.foot}>
            <RNView style={[s.footRule, { backgroundColor: accent.accent }]} />
            <Text style={s.footText} numberOfLines={1}>
              {data.handle ? `@${data.handle}` : 'VOLA'}
            </Text>
          </RNView>
        </RNView>
      </RNView>
    );
  },
);

/**
 * Styles are built per scale factor and CACHED on it.
 *
 * `StyleSheet.create` of ~25 entries ran on every render of every card. On the
 * completion screen that is invisible; in the feed it is once per post per
 * re-render, and the screen re-renders on refresh, on paging and on the clock
 * tick that recomputes "2h ago". Every card at a given width produces byte-for
 * -byte identical styles, so there is nothing to recompute — and the key space
 * is tiny in practice (one feed width, one export width, one modal width).
 */
const styleCache = new Map<number, ReturnType<typeof buildStyles>>();

function stylesFor(u: number) {
  const hit = styleCache.get(u);
  if (hit) return hit;
  const built = buildStyles(u);
  styleCache.set(u, built);
  return built;
}

const buildStyles = (u: number) =>
  StyleSheet.create({
    card: {
      backgroundColor: vola.bg,
      borderRadius: 26 * u,
      overflow: 'hidden',
    },
    // Anchored top-right at native scale rather than bleeding full-frame: the
    // source renders top out at 1254px, and filling a card at 3× would upscale
    // them visibly. See assets/images/mountains/README.md.
    photo: { position: 'absolute', top: 0, right: 0, width: '100%', height: '78%' },
    glow: {
      position: 'absolute',
      top: '10%',
      right: '6%',
      width: 190 * u,
      height: 190 * u,
      borderRadius: 95 * u,
      opacity: 0.34,
    },
    inner: { flex: 1, padding: 22 * u },

    top: { flexDirection: 'row', alignItems: 'center' },
    wordmark: {
      fontFamily: 'BarlowCondensedBold',
      fontSize: 22 * u,
      letterSpacing: 3.2 * u,
      color: vola.text,
    },
    date: {
      marginLeft: 'auto',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(243,246,250,0.28)',
      borderRadius: 999,
      paddingHorizontal: 11 * u,
      paddingVertical: 4 * u,
    },
    dateText: {
      fontFamily: 'BarlowCondensedSemiBold',
      fontSize: 11 * u,
      letterSpacing: 1.3 * u,
      color: vola.textMuted,
    },

    headline: { marginTop: 'auto' },
    eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 6 * u, marginBottom: 5 * u },
    eyebrow: { fontFamily: 'BarlowSemiBold', fontSize: 11 * u, letterSpacing: 2.4 * u },
    title: {
      fontFamily: 'BarlowCondensedBold',
      fontSize: 46 * u,
      lineHeight: 44 * u,
      color: vola.text,
      letterSpacing: -0.3 * u,
    },
    subtitle: { fontFamily: 'Barlow', fontSize: 14 * u, color: vola.textMuted, marginTop: 6 * u },

    stats: {
      flexDirection: 'row',
      marginTop: 18 * u,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(243,246,250,0.14)',
      paddingVertical: 12 * u,
    },
    stat: { flex: 1 },
    statLabel: {
      fontFamily: 'BarlowSemiBold',
      fontSize: 9 * u,
      letterSpacing: 1.4 * u,
      color: vola.textDim,
    },
    statValue: {
      fontFamily: 'BarlowCondensedBold',
      fontSize: 27 * u,
      lineHeight: 29 * u,
      color: vola.text,
      fontVariant: ['tabular-nums'],
      marginTop: 2 * u,
    },
    statUnit: { fontFamily: 'Barlow', fontSize: 10 * u, color: vola.textDim, marginTop: -1 * u },

    detail: { marginTop: 11 * u, gap: 2 * u },
    detailRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 * u },
    detailName: {
      flex: 1,
      fontFamily: 'Barlow',
      fontSize: 12 * u,
      color: vola.text,
    },
    detailFigure: {
      fontFamily: 'BarlowSemiBold',
      fontSize: 11 * u,
      color: vola.textMuted,
      fontVariant: ['tabular-nums'],
    },
    detailMore: { fontFamily: 'Barlow', fontSize: 11 * u, color: vola.textDim, marginTop: 2 * u },

    badges: { flexDirection: 'row', gap: 6 * u, marginTop: 12 * u },
    badge: { borderRadius: 999, paddingHorizontal: 10 * u, paddingVertical: 4 * u, maxWidth: '62%' },
    badgeText: { fontFamily: 'BarlowSemiBold', fontSize: 11 * u },

    foot: { flexDirection: 'row', alignItems: 'center', gap: 8 * u, marginTop: 14 * u },
    footRule: { width: 2 * u, height: 13 * u, borderRadius: 1 },
    footText: { fontFamily: 'Barlow', fontSize: 12 * u, color: vola.textMuted },
  });
