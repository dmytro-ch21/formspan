import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import type { View } from 'react-native';
import type { RefObject } from 'react';

/**
 * Turning the session card into something you can post.
 *
 * ## The share sheet, not a direct Instagram hand-off
 *
 * `instagram-stories://share` would drop straight into Stories with the card
 * pre-loaded, which is one tap fewer. It is NOT blocked any more, and this
 * comment used to say it was: the Expo Go wall came down on 2026-08-09 when the
 * app moved to a development build, so `vola://` is the app's own scheme now
 * and a custom one can be declared. What remains is a Facebook App ID
 * registered with Meta, which is an account decision rather than a technical
 * one.
 *
 * The share sheet stays the default regardless, because it needs neither and
 * reaches further: Instagram, Messages and WhatsApp all appear in it and the
 * image arrives the same way. The Stories deep link would drop in beside this
 * without changing the capture — nobody has built it.
 *
 * ## The temp file is left behind, deliberately
 *
 * `result: 'tmpfile'` writes a ~1-2 MB PNG into the cache directory per share
 * and nothing here removes it. Deleting it would need `expo-file-system` — a
 * THIRD native dependency, on an app that now builds its own binary, where
 * every native module added is a rebuild and a `dyld` version risk. That is a
 * disproportionate price for tidying a directory the OS already purges under
 * pressure and that a reinstall clears. Revisit if anything else in the app
 * needs the filesystem anyway.
 *
 * ## Why PNG and not JPEG
 *
 * The card is flat colour, hairlines and type over one photograph. JPEG rings
 * badly around 1px rules on dark grounds, which is most of this design.
 */

export const CARD_EXPORT_WIDTH = 1080;

export type ShareResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * `unavailable` — the device cannot share at all.
       * `capture` — the image was never produced. ALWAYS worth surfacing.
       * `failed` — the share sheet itself threw, which on both platforms may
       *   simply be the athlete dismissing it. Callers stay quiet about this
       *   one; see `shareCard` for why the two are no longer the same reason.
       */
      reason: 'unavailable' | 'capture' | 'failed';
      message: string;
    };

/**
 * Capture a mounted card and open the share sheet on it.
 *
 * The ref must point at a MOUNTED view — `captureRef` reads the native view
 * tree, so a card that has never been laid out captures blank. Callers render
 * it off-screen rather than not at all; see the export host in the session
 * screen.
 */
export async function shareCard(ref: RefObject<View | null>): Promise<ShareResult> {
  if (!ref.current) {
    return { ok: false, reason: 'failed', message: 'The card was not ready to share.' };
  }

  // Checked BEFORE capturing. Capturing first would write a file, fail to
  // share it, and leave the athlete with an error and a temp file nobody
  // cleans up.
  if (!(await Sharing.isAvailableAsync())) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Sharing is not available on this device.',
    };
  }

  // TWO try blocks, not one, because only ONE of these failures is ever the
  // athlete's own doing. A dismissed share sheet may reject — the libraries
  // disagree about whether it does — so a `shareAsync` throw has to stay quiet.
  // `captureRef` throwing is never a dismissal; it means the image was not
  // produced. Wrapped together, a real capture failure rendered as
  // "Share → Preparing… → Share" with no sheet and no message, which is
  // indistinguishable from the athlete changing their mind.
  let uri: string;
  try {
    uri = await captureRef(ref, {
      format: 'png',
      quality: 1,
      // Explicit pixel size rather than a scale factor: a scale would make the
      // exported image depend on the phone's screen density, so the same
      // session would post at 780px from an SE and 1170px from a Pro Max.
      width: CARD_EXPORT_WIDTH,
      height: CARD_EXPORT_WIDTH,
      result: 'tmpfile',
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'capture',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await Sharing.shareAsync(uri, {
      mimeType: 'image/png',
      // iOS uses this to pick which apps can receive it; without it the sheet
      // offers file-manager targets instead of Instagram.
      UTI: 'public.png',
      dialogTitle: 'Share your session',
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
