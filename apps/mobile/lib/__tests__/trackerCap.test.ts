import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_LIVE_TRACKERS } from '../trackers';

/**
 * The tracker cap is written down twice, so it is checked against itself.
 *
 * The server's `MaxLiveTrackers` is the one that DECIDES — it is the only copy
 * that can see every device. The client's exists to be timely: an athlete who
 * fills up in a gym with no signal should be told at the moment they tap
 * Create, not by a 409 surfacing on a sync screen an hour later, by which time
 * the form they typed is gone.
 *
 * Two copies of a number is two numbers, and this is the third parity check in
 * this repo for that reason (`check:grip-parity`, `check:rate-parity`). The
 * failure mode when they drift is quiet and one-sided: raise the server's and
 * the phone refuses trackers the server would accept; raise the phone's and the
 * athlete fills in a whole form to have it rejected.
 *
 * **It reads the Go source rather than restating the number**, which is the
 * whole point — a test with its own copy checks the copy. And it fails loudly
 * if the constant cannot be found at all, because a rename that made this
 * silently match nothing would be a check that passes having measured nothing.
 */
it('matches the number the server enforces', () => {
  const go = readFileSync(
    join(__dirname, '../../../../backend/internal/modules/tracker/tracker.go'),
    'utf8',
  );
  const m = go.match(/^const MaxLiveTrackers = (\d+)$/m);
  if (!m) {
    throw new Error(
      'Could not find `const MaxLiveTrackers = N` in backend/internal/modules/tracker/tracker.go.\n' +
        'It was renamed or reshaped — fix this matcher rather than deleting the test, or the ' +
        'cap silently stops being checked at all.',
    );
  }
  expect(MAX_LIVE_TRACKERS).toBe(Number(m[1]));
});
