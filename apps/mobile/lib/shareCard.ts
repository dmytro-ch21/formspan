import * as Sharing from 'expo-sharing';
import { captureRef, releaseCapture } from 'react-native-view-shot';
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
 * ## The temp file IS released now, on a delay (L5, #384)
 *
 * `result: 'tmpfile'` writes a PNG into the cache directory per share.
 * `react-native-view-shot` exports `releaseCapture(uri)` — implemented
 * natively on both platforms (`RNViewShot.mm`, `RNViewShotModule.java`) —
 * which deletes exactly this file, and `shareCard` now calls it once
 * `shareAsync` settles, success or failure.
 *
 * **Why a delay, and not a call in the same tick `shareAsync` resolves:**
 * `shareAsync`'s promise does not mean "the target app has read the file". It
 * means "the OS says its part is done", and those are different moments on
 * each platform, confirmed by reading the native module rather than assumed:
 *
 * - **iOS** — `SharingModule.swift` resolves from
 *   `UIActivityViewController.completionWithItemsHandler`, which UIKit calls
 *   once the activity (and, for one that presents its own UI — Mail's
 *   compose sheet, Messages — that UI too) has been dismissed. For a
 *   well-behaved share extension this is after it has called
 *   `completeRequest`, i.e. after it is done with the file. The safer of the
 *   two platforms, but still not a documented guarantee for every extension.
 * - **Android** — `SharingModule.kt` resolves from `OnActivityResult` on the
 *   `startActivityForResult` call wrapping `Intent.createChooser`. That
 *   fires once the **chooser** activity finishes, which is when it hands off
 *   to the picked target and Android returns control to the caller — **not**
 *   when the target has read the `content://` URI. A target that reads the
 *   stream lazily (after its own UI finishes composing, say) can still be
 *   reading after this promise resolves. This is the real risk the ticket
 *   named, confirmed by the source rather than the doc, and it is Android-
 *   specific: nothing here makes iOS immune, but Android's resolution point
 *   is structurally earlier.
 *
 * So an immediate `releaseCapture` risks exactly the "share silently produces
 * nothing" failure mode. `RELEASE_DELAY_MS` waits before releasing, rather
 * than firing on the same tick — three times the 500ms
 * `react-native-view-shot` gives its own internal capture-to-capture release
 * (`ViewShotComponent` releases its *previous* capture 500ms after producing
 * a new one; `src/index.tsx`), longer because this is releasing into an
 * external app's hand-off rather than the library's own next capture. This
 * narrows the window without the file living forever. **It is a mitigation,
 * not a proof**: a slow enough reader on a loaded device could still lose
 * the race. This is exactly what acceptance criterion 2 (device
 * verification against every share target) exists to catch, and code
 * review cannot substitute for it.
 *
 * One thing works in this delay's favour specifically on the Android path
 * the risk above names: React Native suspends JS timers while the app is
 * backgrounded (the JS thread pauses on iOS; Android's timer bridge pauses
 * on host-pause and resumes on host-resume). So in the actual dangerous
 * sequence — the chooser hands off, the target app foregrounds, VOLA goes to
 * the background while the target is still reading — the countdown stops
 * and only resumes once the athlete returns to VOLA, which in practice is
 * after the target has finished. The residual risk this delay cannot cover
 * is narrower than it first looks: a target that reads the file lazily
 * *without* ever taking the foreground away from VOLA within the window.
 *
 * `releaseCapture` itself never throws back into the share flow — it runs
 * inside its own `try`/`catch`, because a missing file, a permission error,
 * or (real, if `RNViewShot`'s native module were ever unlinked) the JS
 * wrapper itself throwing must never surface as a share failure the athlete
 * did not cause.
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
 * How long to wait, after `shareAsync` settles, before deleting the capture.
 * See the module comment above for why this is not zero — three times the
 * 500ms `react-native-view-shot` gives its own internal capture-to-capture
 * release, not equal to it: that delay only has to outlast the library's own
 * next `captureRef`, this one has to outlast a share target reading the file.
 */
export const RELEASE_DELAY_MS = 1500;

/**
 * Delete a capture's temp file without ever letting the deletion fail loudly.
 *
 * Fired after `shareAsync` settles (share OR cancel — the two are the same
 * promise outcome; see the module comment) and after a real share failure
 * too, since either way the file is no longer needed and would otherwise
 * leak. Delayed by `RELEASE_DELAY_MS` for the timing reason above.
 *
 * `releaseCapture` itself is void, not a promise — the native side never
 * rejects it — but the JS wrapper reads `RNViewShot.releaseCapture` off the
 * native module object first, which throws synchronously if that module
 * were ever missing. Wrapped regardless of how likely that is: a cleanup
 * step must never be the reason a share the athlete already saw complete
 * gets reported as failed.
 */
function scheduleRelease(uri: string): void {
  setTimeout(() => {
    try {
      releaseCapture(uri);
    } catch (err) {
      if (__DEV__) {
        console.warn('shareCard: releaseCapture failed', err);
      }
    }
  }, RELEASE_DELAY_MS);
}

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
  } finally {
    // Runs whether `shareAsync` resolved (share OR cancel — indistinguishable
    // here, see the module comment) or rejected. Either way the temp file's
    // job is done.
    scheduleRelease(uri);
  }
}
