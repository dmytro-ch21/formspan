import * as ImageManipulator from 'expo-image-manipulator';

/**
 * The one place a picked photo is turned into what an upload request sends
 * (N74, #392).
 *
 * `food/describe.tsx`, `session/[id]/identify.tsx`, `profile/edit.tsx` and
 * `checkin/[date].tsx` each independently learned the same three facts —
 * resize to 1080px, `compress: 0.8` JPEG, and an explicit `image/jpeg` mime
 * type, because the manipulator re-encodes regardless of what the source
 * file claimed to be. `food/describe.tsx` shipped with it;
 * `session/[id]/identify.tsx` shipped without it and was reported from a
 * real phone as N73 (#361, "Could not reach the server. Try again when you
 * have signal." on four bars) — `quality: 1` on a recent iPhone is a
 * 4–12MB frame, well past both the ~5MB a single image is allowed to decode
 * to (`nutrition.MaxImageBytes` / the identify endpoint's own doc: "generous
 * enough for a 5MB photo") and the 8MB multipart-body envelope around it
 * (`maxEstimateBody`, `maxIdentifyBody`) — and past a 60s iOS request budget
 * shared with vision latency, so the request never returns a status and the
 * no-status fallback reads as a signal problem it never was.
 * `profile/edit.tsx` and `checkin/[date].tsx` both already had the downscale
 * (so N73 never happened to them), but each kept its own copy of the same
 * three lines — found in review on this same ticket.
 *
 * All three steps are easy to leave out with no symptom until a real phone
 * with a real camera hits a real cap. Folding them into one function every
 * screen has to call means a screen that forgets the downscale is the only
 * way to omit it — and that omission is a missing call, visible in review,
 * rather than three missing lines buried in an inline `try`.
 *
 * **Deliberately does not catch.** Each caller already has its own copy for a
 * manipulator failure — camera vs. library wording on `describe.tsx`,
 * `retake` vs. `retry` on `identify.tsx`, a shared generic message on
 * `profile/edit.tsx` and `checkin/[date].tsx` — and that message is about
 * what the athlete should do next, which only the screen knows. Catching
 * here would mean re-throwing something to preserve that, which is the same
 * code with an extra hop.
 */
export type UploadableImage = {
  uri: string;
  mimeType: string;
};

/**
 * A picked asset, from either `expo-image-picker`'s `assets[0]` or an
 * equivalent. Only the `uri` is read — the manipulator re-encodes the file,
 * so nothing else about the source (its own mime type, width, height) is
 * relevant to what gets sent.
 */
export type PickedAsset = {
  uri: string;
};

export async function prepareImageForUpload(asset: PickedAsset): Promise<UploadableImage> {
  const shrunk = await ImageManipulator.manipulateAsync(
    asset.uri,
    [{ resize: { width: 1080 } }],
    { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
  );
  return {
    uri: shrunk.uri,
    // The manipulator re-encodes to JPEG regardless of the source format, so
    // the asset's own mime type (`image/heic` off a recent iPhone camera) is
    // stale the moment `manipulateAsync` returns.
    mimeType: 'image/jpeg',
  };
}
