import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import { PixelRatio, Platform, type View } from 'react-native';
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
 * nothing here removes it. That is a directory the OS purges under pressure and
 * a reinstall clears, so it has been left alone.
 *
 * **Both halves of the reason this paragraph used to give were wrong**, and
 * review caught them together:
 *
 * 1. It said deleting the file "would need `expo-file-system` — a THIRD native
 *    dependency". It would not. `react-native-view-shot` already exports
 *    `releaseCapture(uri)`, implemented natively on both platforms
 *    (`RNViewShot.mm`, `RNViewShotModule.java`), which deletes exactly this
 *    file. No new dependency, no rebuild, no `dyld` risk.
 * 2. It priced the trade at "~1-2 MB per share" when the real figure was
 *    **10.5 MB** — the capture was exporting at 3× its intended size. It is
 *    1.6 MB now, back inside the bracket, but that is the bug being fixed
 *    rather than the estimate having been right.
 *
 * So the conclusion stands on a much weaker argument than it appeared to. It is
 * kept rather than changed here because calling `releaseCapture` after
 * `shareAsync` resolves is a behaviour change that wants device verification —
 * iOS resolves that promise when the sheet dismisses, and whether every share
 * target has finished reading the file by then is a question, not an
 * assumption. Recorded as **L5** in `docs/TASKS.md`.
 *
 * ## Why PNG and not JPEG
 *
 * The card is flat colour, hairlines and type over one photograph. JPEG rings
 * badly around 1px rules on dark grounds, which is most of this design.
 */

/** How wide the exported image is, in PIXELS. */
export const CARD_EXPORT_WIDTH = 1080;

/**
 * What to ask `captureRef` for, so the export is `CARD_EXPORT_WIDTH` pixels
 * square — **which is a different number on each platform, because the option
 * means a different thing on each platform.**
 *
 * This is the whole subtlety, and it is invisible from the JS API: `width` and
 * `height` are one name for two units.
 *
 * - **iOS — POINTS, multiplied by the device scale.** `ios/RNViewShot.mm`
 *   builds its format with `rendererFormat.scale = 0` ("use device scale") and
 *   hands `initWithSize:` the requested size, so the bitmap comes back at
 *   `size × scale`. Passing 1080 exported **3240 × 3240 at 10.5 MB** on a 3×
 *   phone, and would have exported 2160 on a 2× one — precisely the density
 *   dependence the constant was introduced to prevent. So iOS divides first:
 *   360 pt × 3 and 540 pt × 2 both land on 1080 px.
 * - **Android — PIXELS, already final.** `RNViewShotModule.java` reads them
 *   with `options.getInt(...)`, and `ViewShot.java` finishes with
 *   `Bitmap.createScaledBitmap(bitmap, width, height, true)` — the output is
 *   exactly `width × height` px, with no density anywhere in the chain. **The
 *   original code was right here.** Dividing on Android would export a 360 px
 *   card from a 3× phone, which is the same bug inverted, and `getInt` would
 *   truncate a fractional scale's result on the way in.
 *
 * Review caught the Android half; the first version of this fix divided on
 * both. Worth stating plainly because nothing about the API hints at it and the
 * two platforms fail in opposite directions.
 *
 * `platform` is a parameter rather than a direct `Platform.OS` read so both
 * branches are testable — jest-expo reports `ios`, so an Android regression
 * would otherwise be untestable here as well as unobservable.
 */
export function cardCaptureSize(
  scale = PixelRatio.get(),
  platform: string = Platform.OS,
): number {
  // Anything that is not iOS takes the size as final pixels. Written as "not
  // iOS" rather than "is android" because web and any future target follow the
  // pixel reading; iOS is the one that multiplies.
  if (platform !== 'ios') return CARD_EXPORT_WIDTH;
  // A zero, negative or non-finite scale would divide the card into something
  // enormous or NaN. Falling back to 1 exports at 1080 pt — wrong by the same
  // factor the old code was, but bounded and recognisable.
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
