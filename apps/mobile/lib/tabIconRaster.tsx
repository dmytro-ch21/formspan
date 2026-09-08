import { useRef, useState } from 'react';
import { PixelRatio, StyleSheet, View as RNView, type ImageSourcePropType } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { Icon, type IconName } from '@/components/ui/Icon';

/**
 * Turning VOLA's own SVG brand icons into tab-bar images, AT RUNTIME.
 *
 * `NativeTabs` (`expo-router/unstable-native-tabs`, N504/#876) wants an
 * `ImageSourcePropType` per icon — an SF Symbol or Material Symbol name, an
 * Xcode asset-catalog entry, or an image source. VOLA's brand kit is none of
 * those: it is `assets/brand/icons/*.svg`, compiled by `generate_icons.mjs`
 * into `components/ui/icons.generated.ts` and drawn live by `react-native-svg`
 * via `<Icon>`. Native tabs cannot render an `<Icon>` component directly.
 *
 * The alternative was a new build-time SVG-to-PNG pipeline (a `sharp`- or
 * `resvg`-based script, a new devDependency, a new `pnpm-workspace.yaml`
 * `allowBuilds` entry). This does the same job with NOTHING new installed:
 * `react-native-view-shot` is already a dependency (`lib/shareCard.ts` uses it
 * for the session share card), so an `<Icon>` rendered off-screen and captured
 * with `captureRef` produces exactly the PNG `NativeTabs` wants, straight from
 * the SAME source of truth the rest of the app uses — no second copy of the
 * kit to drift.
 *
 * ## Off-screen, not hidden — same rule as `ShareCardHost`
 *
 * `captureRef` reads the native view tree, so the icon has to be genuinely
 * laid out: `display: none` captures nothing, and `opacity: 0` captures blank
 * on some iOS versions. `components/SessionShare.tsx`'s `ShareCardHost` solved
 * this the same way — `position: 'absolute', left: -10000` keeps the view
 * real while keeping it off the visible screen — and `useRasterizedIcons`'
 * host follows the identical shape, including hiding it from VoiceOver
 * (`accessibilityElementsHidden` + `importantForAccessibility`), since an
 * off-screen element is still in a screen reader's traversal order.
 *
 * `collapsable={false}` on each icon's wrapper stops Android's view-flattening
 * optimisation from removing the native view `captureRef` needs to find —
 * without it this silently works on iOS and silently fails on Android, which
 * is exactly the asymmetry this repo's own "verify a check can fail" rule
 * warns about: nothing here would throw, the tab would just show no icon.
 *
 * ## A failed or stuck capture degrades ONE tab, never the whole app
 *
 * `(tabs)/_layout.tsx` holds a frame on `sources` being non-null before it
 * renders `NativeTabs` at all — which means every screen behind the tab bar,
 * not just the bar itself, was blocked on this the first time this file was
 * written: a `captureRef` rejection was swallowed with nothing marking that
 * icon settled, so `missing` never emptied and the app sat on the off-screen
 * rig forever. Caught in review, not by a test — see `docs/decisions/
 * history.md`'s N504 entry. Fixed with a second outcome alongside the cache:
 * `failed` is a permanent (this-process-lifetime) record of a request that
 * either rejected or never resolved within `CAPTURE_TIMEOUT_MS`, and a
 * request counts as SETTLED — no longer `missing` — the moment it lands in
 * EITHER map. `tabIconSource` (`lib/tabIconPlan.ts`) reads a failed icon back
 * as `null`, and `(tabs)/_layout.tsx` renders that tab with a label and no
 * icon rather than refusing to render the bar (or the app) at all.
 *
 * ## Cached in memory, once, for the process
 *
 * Keyed on `name:color` rather than name alone, because the two platforms
 * want different things from the same icon (see `lib/tabs.ts` for why): iOS
 * renders one NEUTRAL raster per icon and recolours it at render time via
 * `renderingMode: 'template'`; Android bakes a fixed colour into the raster
 * itself, so it needs two per icon (inactive, active). The cache is plain
 * module state, not `AsyncStorage` or a file — recomputing it every cold
 * start is cheap (five to ten small SVGs) and means it can never go stale
 * against a brand-kit edit the way a persisted cache could.
 */

export type TabIconRequest = { name: IconName; color: string };

/** Big enough that the capture anti-aliases cleanly; NativeTabs scales the result. */
const RASTER_SIZE = 44;

/**
 * How long to wait for one icon's capture before giving up on it.
 *
 * Generous on purpose — a real device snapshot of a tiny off-screen SVG
 * ordinarily settles in well under a second — because giving up too early
 * would trade a rare permanent hang for a routine missing icon on a slow
 * device. This only matters once per cold start, behind the same splash
 * hold `RootLayout` already uses for Clerk/font loading.
 */
const CAPTURE_TIMEOUT_MS = 4000;

const cache = new Map<string, ImageSourcePropType>();
/** Requests that rejected or timed out — settled, but with no icon to show. */
const failed = new Set<string>();
const capturing = new Map<string, ReturnType<typeof setTimeout>>();

function requestKey(req: TabIconRequest): string {
  return `${req.name}:${req.color}`;
}

/**
 * Renders `requests` off-screen, captures each one the first time it is
 * asked for, and returns the resolved sources once every one has SETTLED —
 * captured, or given up on (see the top-of-file comment).
 *
 * `sources` is `null` until every requested icon has settled — callers hold
 * a frame on that the same way `(tabs)/_layout.tsx` already holds one on
 * `useModules()`'s `ready`, so the tab bar's first paint never shows a blank
 * or partially-iconed bar. A settled-but-failed icon is present in `sources`'
 * keys with no way to distinguish it from "never requested" at this layer —
 * `tabIconSource` (`lib/tabIconPlan.ts`) is what turns a missing cache entry
 * into an explicit `null` a caller can render around. `host` is the
 * off-screen element that has to stay mounted (at the screen root, not
 * inside anything that clips or scrolls) while any capture is still
 * pending; once `sources` resolves, `host` is `null` and can be dropped.
 */
export function useRasterizedIcons(requests: readonly TabIconRequest[]): {
  host: React.ReactNode;
  sources: Record<string, ImageSourcePropType> | null;
} {
  const [, bump] = useState(0);
  const refs = useRef(new Map<string, RNView | null>());

  const settled = (key: string) => cache.has(key) || failed.has(key);
  const missing = requests.filter((req) => !settled(requestKey(req)));

  if (missing.length === 0) {
    const sources: Record<string, ImageSourcePropType> = {};
    for (const req of requests) {
      const key = requestKey(req);
      const source = cache.get(key);
      if (source) sources[key] = source;
    }
    return { host: null, sources };
  }

  return {
    sources: null,
    host: (
      <RNView
        style={styles.offscreen}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {missing.map((req) => {
          const key = requestKey(req);
          return (
            <RNView
              key={key}
              ref={(view) => {
                refs.current.set(key, view);
              }}
              collapsable={false}
              style={styles.iconBox}
              onLayout={() => {
                // `onLayout` can fire more than once for the same view (a
                // safe-area/orientation pass, a Fast Refresh); the guard
                // stops a second capture racing the first rather than
                // relying on this only ever firing once.
                if (settled(key) || capturing.has(key)) return;
                const view = refs.current.get(key);
                if (!view) return;

                // See the top-of-file comment: a capture that never settles
                // must not hold every screen behind the tab bar hostage.
                const timer = setTimeout(() => {
                  capturing.delete(key);
                  failed.add(key);
                  if (__DEV__) {
                    console.warn(`tabIconRaster: capture timed out for "${key}"`);
                  }
                  bump((n) => n + 1);
                }, CAPTURE_TIMEOUT_MS);
                capturing.set(key, timer);

                captureRef(view, { format: 'png', result: 'data-uri' })
                  .then((uri) => {
                    // Already timed out and marked failed — a late success
                    // is discarded rather than un-failing it, since the
                    // cache is meant to be settled once per process, not
                    // reconsidered mid-session.
                    if (!capturing.has(key)) return;
                    // `scale` is NOT optional here, and omitting it is what
                    // shipped icons three times too big.
                    //
                    // `captureRef` renders the off-screen view at the DEVICE
                    // PIXEL RATIO, so a `RASTER_SIZE`-point box comes back as
                    // a `RASTER_SIZE * PixelRatio.get()`-PIXEL png — 132px on
                    // a @3x phone. An image source given only a `uri` has
                    // nothing to divide by, so React Native reads those 132
                    // pixels as 132 POINTS and the tab bar draws an icon
                    // three times its intended size: overflowing the bar,
                    // overlapping its own label and the screen above it.
                    //
                    // Declaring the scale is what maps pixels back to points
                    // (132 / 3 = 44). Verified on the iOS 26.5 Simulator both
                    // ways round — without this line the oversized bar is
                    // immediate and obvious, with it the icons sit correctly
                    // inside the bar. `lib/__tests__/tabIconPlan.test.ts`
                    // pins the arithmetic so a future edit cannot quietly
                    // drop it again.
                    cache.set(key, { uri, scale: PixelRatio.get() });
                  })
                  .catch((err) => {
                    if (!capturing.has(key)) return;
                    failed.add(key);
                    if (__DEV__) {
                      console.warn(`tabIconRaster: capture failed for "${key}"`, err);
                    }
                  })
                  .finally(() => {
                    const pending = capturing.get(key);
                    if (pending) clearTimeout(pending);
                    capturing.delete(key);
                    bump((n) => n + 1);
                  });
              }}
            >
              <Icon name={req.name} size={28} color={req.color} strokeWidth={1.6} />
            </RNView>
          );
        })}
      </RNView>
    ),
  };
}

const styles = StyleSheet.create({
  offscreen: { position: 'absolute', left: -10000, top: 0 },
  iconBox: {
    width: RASTER_SIZE,
    height: RASTER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
