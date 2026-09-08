import type { IconName } from '@/components/ui/Icon';

import { ANDROID_ACTIVE_ICON_COLOR, ANDROID_INACTIVE_ICON_COLOR, TABS } from '../tabs';
import {
  IOS_ICON_RASTER_COLOR,
  tabIconRenderingMode,
  tabIconRequestKey,
  tabIconRequests,
  tabIconSource,
} from '../tabIconPlan';

/**
 * Pure and platform-parameterised on purpose (N504) — same convention as
 * `lib/shareCard.ts`'s `cardCaptureSize`, and for the identical reason:
 * `jest-expo` reports `Platform.OS === 'ios'`, so a function that read
 * `Platform.OS` directly would leave the Android branch untested by anything
 * in this suite, not merely unexercised by this one file.
 */

describe('what needs rasterising', () => {
  it('asks for one neutral raster per icon on iOS', () => {
    const requests = tabIconRequests('ios');
    expect(requests).toHaveLength(TABS.length);
    expect(requests.every((r) => r.color === IOS_ICON_RASTER_COLOR)).toBe(true);
    expect(requests.map((r) => r.name).sort()).toEqual([...TABS.map((t) => t.icon)].sort());
  });

  it('asks for two rasters per icon on Android — inactive and active', () => {
    const requests = tabIconRequests('android');
    expect(requests).toHaveLength(TABS.length * 2);
    for (const { icon } of TABS) {
      expect(requests).toContainEqual({ name: icon, color: ANDROID_INACTIVE_ICON_COLOR });
      expect(requests).toContainEqual({ name: icon, color: ANDROID_ACTIVE_ICON_COLOR });
    }
  });

  // Guards against a platform check degenerating into "not android" catching
  // everything, including a genuine typo like 'Android' or 'ANDROID'.
  it('treats anything other than "android" as the iOS shape', () => {
    expect(tabIconRequests('web')).toHaveLength(TABS.length);
    expect(tabIconRequests('windows')).toHaveLength(TABS.length);
  });
});

describe('reading a raster back for one tab', () => {
  const icon = TABS[0].icon;

  function fakeSources(pairs: [IconName, string][]): Record<string, { uri: string }> {
    const out: Record<string, { uri: string }> = {};
    for (const [name, color] of pairs) out[tabIconRequestKey({ name, color })] = { uri: `${name}:${color}` };
    return out;
  }

  it('on iOS, uses the SAME image for default and selected', () => {
    const sources = fakeSources([[icon, IOS_ICON_RASTER_COLOR]]);
    const { default: d, selected: s } = tabIconSource(icon, sources, 'ios');
    expect(d).toBe(s);
    expect(d).toEqual({ uri: `${icon}:${IOS_ICON_RASTER_COLOR}` });
  });

  it('on Android, uses two DIFFERENT images — inactive for default, active for selected', () => {
    const sources = fakeSources([
      [icon, ANDROID_INACTIVE_ICON_COLOR],
      [icon, ANDROID_ACTIVE_ICON_COLOR],
    ]);
    const { default: d, selected: s } = tabIconSource(icon, sources, 'android');
    expect(d).toEqual({ uri: `${icon}:${ANDROID_INACTIVE_ICON_COLOR}` });
    expect(s).toEqual({ uri: `${icon}:${ANDROID_ACTIVE_ICON_COLOR}` });
    expect(d).not.toEqual(s);
  });
});

describe('rendering mode', () => {
  it('is template on iOS — the mode that lets a custom icon be recoloured', () => {
    expect(tabIconRenderingMode('ios')).toBe('template');
  });

  it('is original everywhere else — Android has no equivalent mode', () => {
    expect(tabIconRenderingMode('android')).toBe('original');
    expect(tabIconRenderingMode('web')).toBe('original');
  });
});
