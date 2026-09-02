package running

import (
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/testdb"
)

// This package's Postgres tests seed real `sessions` rows with fixed ids and
// delete them again on the way out — the same shape bjj's tests take, for
// the same reason: a second copy of this binary running against the same
// shared database is the ordinary state of this repo, not a rare one. The
// lock makes this binary the sole writer of its database for as long as it
// runs. See internal/platform/testdb for the mechanism and the measurements.
//
// With TEST_DATABASE_URL unset every Postgres test skips, so there is
// nothing to own and nothing to lock.
func TestMain(m *testing.M) { os.Exit(testdb.Main(m)) }

// The lock IS the fix, so it is asserted rather than described in a
// comment — delete the TestMain above and this is what goes red.
func TestTheFixtureLockIsHeldForThisBinary(t *testing.T) { testdb.AssertHeld(t) }
