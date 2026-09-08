import type { ImageSourcePropType } from 'react-native';

import type { IconName } from '@/components/ui/Icon';

import { ANDROID_ACTIVE_ICON_COLOR, ANDROID_INACTIVE_ICON_COLOR, TABS } from './tabs';
import type { TabIconRequest } from './tabIconRaster';

/**
 * Which icon rasters `(tabs)/_layout.tsx` needs, and how to read them back —
 * kept PURE and taking `platform` as a parameter, rather than reading
 * `Platform.OS` inline, for the same reason `lib/shareCard.ts`'s
 * `cardCaptureSize` does: a direct `Platform.OS` read is untestable for
 * whichever branch jest's platform is not currently reporting (`jest-expo`
 * reports `ios`, so the Android branch would otherwise be unobserved by any
 * test rather than merely unexercised by this ONE test file).
 *
 * See `lib/tabs.ts`'s top-of-file comment for WHY the two platforms want
 * different things here; this file is only the HOW.
 */

/**
 * The one neutral colour iOS's raster is captured in — irrelevant beyond its
 * alpha, since `renderingMode: 'template'` discards the original colour
 * entirely and uses the shape as a mask.
 */
export const IOS_ICON_RASTER_COLOR = '#000000';

/** Every icon+colour pair that needs rasterising for the five tabs, on `platform`. */
export function tabIconRequests(platform: string): TabIconRequest[] {
  if (platform === 'android') {
    // Two rasters per icon: `renderingMode: 'template'` (which lets one image
    // be recoloured at render time) is iOS-only, so Android bakes both the
    // inactive and the active colour into their own images up front.
    return TABS.flatMap(({ icon }) => [
      { name: icon, color: ANDROID_INACTIVE_ICON_COLOR },
      { name: icon, color: ANDROID_ACTIVE_ICON_COLOR },
    ]);
  }
  // iOS: one neutral raster per icon, reused for both the default and
  // selected state — see `tabIconSource` below.
  return TABS.map(({ icon }) => ({ name: icon, color: IOS_ICON_RASTER_COLOR }));
}

/** The cache/lookup key `lib/tabIconRaster.tsx`'s `useRasterizedIcons` uses for one request. */
export function tabIconRequestKey(req: TabIconRequest): string {
  return `${req.name}:${req.color}`;
}

/**
 * The `default`/`selected` image-source pair `<NativeTabs.Trigger.Icon src=…>`
 * wants for one tab's icon, on `platform`.
 *
 * iOS gets the SAME neutral raster for both states — `renderingMode:
 * 'template'` plus the navigator's `iconColor`/`selectedIconColor` (set from
 * `useAccent()` in `(tabs)/_layout.tsx`) do the recolouring, so there is
 * nothing for a second image to add. Android has no such mode for a custom
 * image source (it always renders one with its own baked-in colour), so it
 * gets two genuinely different rasters instead.
 */
export function tabIconSource(
  icon: IconName,
  sources: Record<string, ImageSourcePropType>,
  platform: string,
): { default: ImageSourcePropType; selected: ImageSourcePropType } {
  if (platform === 'android') {
    return {
      default: sources[tabIconRequestKey({ name: icon, color: ANDROID_INACTIVE_ICON_COLOR })],
      selected: sources[tabIconRequestKey({ name: icon, color: ANDROID_ACTIVE_ICON_COLOR })],
    };
  }
  const neutral = sources[tabIconRequestKey({ name: icon, color: IOS_ICON_RASTER_COLOR })];
  return { default: neutral, selected: neutral };
}

/** `template` lets iOS recolour a custom icon at render time; Android has no equivalent and always renders the source as-is. */
export function tabIconRenderingMode(platform: string): 'template' | 'original' {
  return platform === 'ios' ? 'template' : 'original';
}
