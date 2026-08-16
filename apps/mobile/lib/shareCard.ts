import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import { PixelRatio, type View } from 'react-native';
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
 * `result: 'tmpfile'` writes a PNG into the cache directory per share and
 * nothing here removes it. Deleting it would need `expo-file-system` — a THIRD
 * native dependency, on an app that now builds its own binary, where every
 * native module added is a rebuild and a `dyld` version risk. That is a
 * disproportionate price for tidying a directory the OS already purges under
 * pressure and that a reinstall clears. Revisit if anything else in the app
 * needs the filesystem anyway.
 *
 * **That trade was priced at "~1-2 MB", and it was measured at 10.5 MB** — the
 * capture was exporting at 3× the intended size, so each share left a file five
 * times larger than this paragraph assumed. The size bug is fixed below; the
 * conclusion survives it, because the real figure is now back inside the
 * bracket that made leaving it acceptable. Worth re-checking rather than
 * trusting, if the card ever grows.
 *
 * ## Why PNG and not JPEG
 *
 * The card is flat colour, hairlines and type over one photograph. JPEG rings
 * badly around 1px rules on dark grounds, which is most of this design.
 */

/** How wide the exported image is, in PIXELS. */
export const CARD_EXPORT_WIDTH = 1080;

/**
 * The same square, in the unit `captureRef` actually takes: POINTS.
 *
 * **`width` and `height` are points, not pixels, and the renderer multiplies
 * them by the device scale.** From `react-native-view-shot`'s
 * `ios/RNViewShot.mm`, the format is built with `rendererFormat.scale = 0`
 * ("use device scale") and handed the requested size — so the bitmap comes back
 * at `size × scale`. Passing 1080 therefore exported **3240 × 3240 at 10.5 MB**
 * on a 3× phone and would have exported 2160 on a 2× one.
 *
 * Which is precisely the failure the constant was introduced to prevent. The
 * comment here used to read "explicit pixel size rather than a scale factor: a
 * scale would make the exported image depend on the phone's screen density" —
 * a correct argument attached to a value that did not carry it out. The number
 * was not neutral about density; it was multiplied by it.
 *
 * Dividing first is what makes the promise true: 360 pt × 3 and 540 pt × 2 both
 * land on 1080 px, so the same session posts at the same size from every phone.
 *
 * Non-integer Android scales (2.625, 3.5) can land a pixel either side after
 * rounding. That is a rounding error, not a density dependence, and nothing
 * downstream can tell 1079 from 1080.
 */
export function cardCaptureSize(scale = PixelRatio.get()): number {
  // A zero or nonsense scale would divide the card into something huge or
  // infinite. Falling back to 1 exports at 1080 pt, which is wrong by the same
  // factor the old code was — bounded and recognisable beats unbounded.
  return CARD_EXPORT_WIDTH / (Number.isFinite(scale) && scale > 0 ? scale : 1);
}

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
    // Points, converted from the pixel size we actually want — see
    // `cardCaptureSize` for why passing the pixel figure straight in exported
    // a 3240px, 10.5 MB card from a 3× phone.
    const side = cardCaptureSize();
    uri = await captureRef(ref, {
      format: 'png',
      quality: 1,
      width: side,
      height: side,
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
