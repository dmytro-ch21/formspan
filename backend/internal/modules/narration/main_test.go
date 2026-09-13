package narration

import (
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/testdb"
)

// This package's Postgres test writes metering rows and counts them, which does
// not survive a second copy of a test binary on the same database. The lock makes
// this binary the sole writer for as long as it runs. See internal/platform/testdb.
//
// With TEST_DATABASE_URL unset the Postgres test skips, so there is nothing to
// lock and the pure-logic tests here are unaffected.
func TestMain(m *testing.M) { os.Exit(testdb.Main(m)) }

// The lock is the fix, so it is asserted: delete the TestMain above and this goes red.
func TestTheFixtureLockIsHeldForThisBinary(t *testing.T) { testdb.AssertHeld(t) }
