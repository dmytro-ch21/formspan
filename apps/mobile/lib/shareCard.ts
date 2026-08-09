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
 * pre-loaded, which is one tap fewer — and it cannot work here. It needs a
 * Facebook App ID registered with Meta AND a custom dev client, because the
 * scheme has to be declared by the app; this project still runs on Expo Go,
 * which registers `exp://` and cannot own a custom scheme. That is the same
 * wall Google sign-in hit.
 *
 * The OS share sheet needs neither. Instagram, Messages and WhatsApp all
 * appear in it, the image arrives the same way, and it works on the build the
 * athlete is already carrying. When this app moves off Expo Go, the Stories
 * deep link drops in beside this without changing the capture.
 *
 * ## Why PNG and not JPEG
 *
 * The card is flat colour, hairlines and type over one photograph. JPEG rings
 * badly around 1px rules on dark grounds, which is most of this design.
 */

export const CARD_EXPORT_WIDTH = 1080;

export type ShareResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'failed'; message: string };

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

  try {
    const uri = await captureRef(ref, {
      format: 'png',
      quality: 1,
      // Explicit pixel size rather than a scale factor: a scale would make the
      // exported image depend on the phone's screen density, so the same
      // session would post at 780px from an SE and 1170px from a Pro Max.
      width: CARD_EXPORT_WIDTH,
      height: CARD_EXPORT_WIDTH,
      result: 'tmpfile',
    });

    await Sharing.shareAsync(uri, {
      mimeType: 'image/png',
      // iOS uses this to pick which apps can receive it; without it the sheet
      // offers file-manager targets instead of Instagram.
      UTI: 'public.png',
      dialogTitle: 'Share your session',
    });
    return { ok: true };
  } catch (err) {
    // A dismissed share sheet is not an error on either platform, but the
    // libraries disagree about whether it rejects — so anything that throws
    // here is reported as a failure the caller may choose to stay quiet about.
    return {
      ok: false,
      reason: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
