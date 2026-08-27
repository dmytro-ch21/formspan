import { readFileSync } from 'fs';
import { join } from 'path';

import { prepareImageForUpload } from '../imageUpload';

/**
 * `prepareImageForUpload` (N74, #392) — the one place a picked photo is
 * turned into what an upload request sends.
 *
 * `food/describe.tsx` and `session/[id]/identify.tsx` are the two paths the
 * issue named, and `session/[id]/identify.tsx` shipped without the downscale
 * at all — N73 (#361), reported from a real phone as "Could not reach the
 * server. Try again when you have signal." on four bars, because the raw
 * camera frame blew the endpoint's cap and the request never returned a
 * status. Review on this same ticket found two MORE screens carrying an
 * identical inline copy — `profile/edit.tsx` (avatar) and
 * `checkin/[date].tsx` (progress photo) — so all four now call this helper;
 * see the "lives in exactly one place" describe block below for all four.
 *
 * The assertion below is on WHICH URI AND MIME TYPE REACH THE WIRE, not on
 * the manipulator having been called — `identifyScreen.test.tsx`'s own
 * comment on this exact point: "a call whose result is then ignored would
 * satisfy the weaker check while shipping the original bug intact." A helper
 * that is called and then ignored, or that hands back the original asset
 * unchanged, must fail this test. See the mutation record below the test.
 */

const mockManipulate = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  manipulateAsync: (...a: unknown[]) => mockManipulate(...a),
}));

const RAW_URI = 'file:///camera/IMG_9001_48mp.heic';
const SHRUNK_URI = 'file:///cache/ImageManipulator/shrunk-1080.jpg';

beforeEach(() => {
  mockManipulate.mockReset().mockResolvedValue({ uri: SHRUNK_URI, width: 1080, height: 1440 });
});

it('returns the DOWNSCALED uri, not the picked asset unchanged', async () => {
  const result = await prepareImageForUpload({ uri: RAW_URI });

  // THE assertion. `expect(mockManipulate).toHaveBeenCalled()` alone would
  // pass against a helper that shrinks the frame and then returns
  // `asset.uri` anyway — the exact shape of bug N73 was, one layer down.
  expect(result.uri).toBe(SHRUNK_URI);
  expect(result.uri).not.toBe(RAW_URI);
});

it('sets the mime type explicitly to image/jpeg, since the manipulator re-encodes regardless of source format', async () => {
  const result = await prepareImageForUpload({ uri: RAW_URI });
  expect(result.mimeType).toBe('image/jpeg');
});

it('asks for 1080px at compress 0.8, JPEG — matching what both screens used before the dedupe', async () => {
  await prepareImageForUpload({ uri: RAW_URI });

  expect(mockManipulate).toHaveBeenCalledWith(
    RAW_URI,
    [{ resize: { width: 1080 } }],
    // `compress` pinned, not just `format`: omitting it defaults to 1.0, a
    // silently more expensive upload no other assertion here would notice.
    { compress: 0.8, format: 'jpeg' },
  );
});

it('propagates a manipulator failure rather than swallowing it', async () => {
  // Each caller has its own copy for this (camera vs. library wording on
  // describe.tsx, retake vs. retry on identify.tsx) — the helper must not
  // decide that for them.
  mockManipulate.mockRejectedValue(new Error('cannot read'));
  await expect(prepareImageForUpload({ uri: RAW_URI })).rejects.toThrow('cannot read');
});

/**
 * Criteria 2 and 5: every screen that uploads a picked photo calls the ONE
 * helper, and none keeps its own copy of the resize/compress/mime-type
 * steps. "Visible in review" should be true because a grep for the
 * manipulator call finds it in exactly one file — checked here rather than
 * trusted, since a doc comment claiming this is exactly the kind of claim
 * this repo has been burned by before (review on this ticket found the
 * ORIGINAL version of this file only checked two of what were actually four
 * upload paths, which would have let this exact test pass while
 * `profile/edit.tsx` and `checkin/[date].tsx` kept their own inline copies —
 * so all four are listed here, not just the two the issue named).
 *
 * Each screen is a SEPARATE `it.each` case rather than one loop with a
 * shared assertion, so a failure names which screen regressed instead of
 * requiring a stack trace to find it.
 */
describe('the resize/compress/mime-type steps live in exactly one place', () => {
  const HELPER = readFileSync(join(__dirname, '../imageUpload.ts'), 'utf8');

  const SCREENS = [
    ['food/describe.tsx', '../../app/food/describe.tsx'],
    ['session/[id]/identify.tsx', '../../app/session/[id]/identify.tsx'],
    ['profile/edit.tsx', '../../app/profile/edit.tsx'],
    ['checkin/[date].tsx', '../../app/checkin/[date].tsx'],
  ] as const;

  it('the helper module is the one that calls the manipulator', () => {
    expect(HELPER).toMatch(/manipulateAsync/);
    expect(HELPER).toMatch(/resize:\s*{\s*width:\s*1080\s*}/);
    expect(HELPER).toMatch(/compress:\s*0\.8/);
  });

  it.each(SCREENS)(
    '%s does not import expo-image-manipulator or call manipulateAsync directly, and does call the helper',
    (_name, relativePath) => {
      const src = readFileSync(join(__dirname, relativePath), 'utf8');
      expect(src).not.toMatch(/expo-image-manipulator/);
      expect(src).not.toMatch(/manipulateAsync/);
      expect(src).toMatch(/prepareImageForUpload/);
    },
  );
});

/**
 * MUTATION RECORD (per this ticket's own step 2 and the CLAUDE.md discipline
 * on verifying a check can fail).
 *
 * `prepareImageForUpload` was temporarily edited to:
 *
 *   return { uri: asset.uri, mimeType: 'image/jpeg' };
 *
 * — i.e. hand back the ORIGINAL picked uri unchanged, skipping the
 * manipulator call's result entirely (the manipulator was still invoked, so
 * a call-count check would have stayed green). With that mutation in place:
 *
 *   - "returns the DOWNSCALED uri, not the picked asset unchanged" went RED
 *     (`result.uri` was `RAW_URI`, expected `SHRUNK_URI`).
 *
 * The mutation was then reverted and the suite re-run green. This is not
 * simulated in code — a test cannot assert its own mutation-worthiness
 * without becoming exactly the redundant-guard trap CLAUDE.md warns about
 * ("two check-digit guards validating arithmetic the code had just performed
 * itself"). The record here is the account of having done it by hand.
 */
