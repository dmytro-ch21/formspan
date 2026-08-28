package classplan

import (
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/testdb"
)

// This package's Postgres tests seed shared `techniques` rows with fixed ids
// and delete them again, exactly like sequence's own tests — see
// internal/platform/testdb for the mechanism, the measurements and why the
// key is one per database rather than one per package (#454). The lock makes
// this binary the sole writer of its database for as long as it runs.
//
// With TEST_DATABASE_URL unset every Postgres test skips, so there is
// nothing to own and nothing to lock; the pure-logic tests here are
// unaffected.
func TestMain(m *testing.M) { os.Exit(testdb.Main(m)) }

// The lock IS the fix, so it is asserted rather than described in a comment:
// delete the TestMain above and this is the thing that goes red. Matching
// sequence.TestTheFixtureLockIsHeldForThisBinary.
func TestTheFixtureLockIsHeldForThisBinary(t *testing.T) { testdb.AssertHeld(t) }
