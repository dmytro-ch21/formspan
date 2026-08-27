import { useState } from 'react';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { monogramFor } from '@/lib/monogram';

/**
 * A person's avatar — the real uploaded photo when there is one (N12), the
 * monogram (`lib/monogram.ts`) otherwise.
 *
 * **Two reasons the monogram renders, and both are acceptance criteria for
 * N12, not just a stylistic default**: `url` is absent (nobody has uploaded
 * one, or storage is not configured on this deploy — `profile.avatar_url` is
 * simply missing either way), OR `url` is present and the image FAILS to
 * load — a presigned URL that expired, a dropped connection, a 404 for an
 * object a moderation takedown just removed. Falling through to the same
 * fallback for both means an athlete never sees a broken-image icon, which
 * a component that only checked `url == null` would not catch.
 *
 * `handle` drives the monogram exactly as it does everywhere else in the
 * app — the stable, unique identity, never `display_name` — so the same
 * person is the same monogram on every screen that has not (or cannot)
 * load their photo.
 */
export function Avatar({
  url,
  handle,
  size = 40,
}: {
  url?: string | null;
  handle: string;
  size?: number;
}) {
  // The URL that failed, not a bare boolean — compared against the CURRENT
  // url at render time rather than reset from an effect. A fresh upload
  // hands this component a new url, and a new url was never the one that
  // failed, so the photo is retried automatically with no extra state
  // transition: without tracking the url itself, `failed` from a stale
  // attempt would keep the monogram showing forever even after a
  // successful re-upload produced a url that works fine.
  const [failedURL, setFailedURL] = useState<string | null>(null);
  const showPhoto = !!url && url !== failedURL;
  const dim = { width: size, height: size, borderRadius: size / 2 };

  if (showPhoto) {
    return (
      <Image
        source={{ uri: url }}
        style={dim}
        contentFit="cover"
        // `cachePolicy` is currently DECORATIVE, worth knowing rather than
        // trusting: expo-image keys its cache on the URI itself, and `url`
        // is a presigned link whose signature rotates every time
        // `getProfile` runs — so this rarely, if ever, hits. A stable key
        // (`source.cacheKey`, e.g. the account's user id) would make it
        // real, at the cost of needing an explicit cache-bust on replace so
        // a new upload isn't served the old cached bytes under the same
        // key. Not done here — one avatar per screen, so the miss rate
        // costs little today.
        cachePolicy="memory-disk"
        transition={150}
        onError={() => setFailedURL(url ?? null)}
        // Decorative — the name beside it already says who this is.
        alt=""
        accessible={false}
        testID="avatar-photo"
      />
    );
  }

  const { initials, background, ink } = monogramFor(handle);
  return (
    <View
      style={[styles.monogram, dim, { backgroundColor: background }]}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="avatar-monogram"
    >
      <Text style={[styles.initials, { color: ink, fontSize: size * 0.4 }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  monogram: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontWeight: '700' },
});
