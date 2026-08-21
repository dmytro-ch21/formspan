package migrateguard

import (
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/testdb"
)

// This package's Postgres tests create and drop a FIXED schema name
// (`migrateguard_test`), which is the same hazard as a fixed row id: two copies
// of this binary running against one database — the ordinary state of a repo
// where a dozen worktrees share `vola_test` — would `DROP SCHEMA … CASCADE`
// each other mid-test. The lock makes this binary the sole writer of its
// database for as long as it runs.
//
// See internal/platform/testdb for the mechanism and the measurements. #454.
//
// With TEST_DATABASE_URL unset every Postgres test skips, so there is nothing
// to own and nothing to lock; the pure-logic and git-fixture tests here are
// unaffected.
func TestMain(m *testing.M) { os.Exit(testdb.Main(m)) }

// The lock IS the fix, so it is asserted rather than described in a comment:
// delete the TestMain above and this is the thing that goes red.
func TestTheFixtureLockIsHeldForThisBinary(t *testing.T) { testdb.AssertHeld(t) }
