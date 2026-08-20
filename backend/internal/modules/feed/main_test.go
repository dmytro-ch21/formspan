package feed

import (
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/testdb"
)

// This package's Postgres tests seed shared rows with FIXED ids and delete them
// again, and some of them assert counts they do not scope to their own fixtures.
// Neither survives a SECOND copy of a test binary running against the same
// database — which is the ordinary state of this repo, where a dozen worktrees
// share `vola_test`. The lock makes this binary the sole writer of its database
// for as long as it runs.
//
// See internal/platform/testdb for the mechanism, the measurements and why the
// key is one per database rather than one per package. #454.
//
// With TEST_DATABASE_URL unset every Postgres test skips, so there is nothing to
// own and nothing to lock; the pure-logic tests here are unaffected.
func TestMain(m *testing.M) { os.Exit(testdb.Main(m)) }

// The lock IS the fix, so it is asserted rather than described in a comment:
// delete the TestMain above and this is the thing that goes red. Without it the
// removal is silent and this package goes back to passing alone and failing in a
// fleet, which is the exact shape of #426 and #454.
func TestTheFixtureLockIsHeldForThisBinary(t *testing.T) { testdb.AssertHeld(t) }
