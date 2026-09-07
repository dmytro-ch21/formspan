package main

import (
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/testdb"
)

// readyz_test.go's TestReadyz_LiveDatabase_* tests read TEST_DATABASE_URL —
// they only SELECT schema_migrations and never write anything, but the
// convention (vola-testing skill: "if it reads TEST_DATABASE_URL, it gets a
// main_test.go") applies regardless of what a package's own tests touch, so a
// second copy of this binary running against the same database is never
// silently assumed absent.
//
// See internal/platform/testdb for the mechanism and #454.
//
// With TEST_DATABASE_URL unset every Postgres-backed test here skips, so
// there is nothing to own and nothing to lock; every other test in this
// package (the fakeProbe-backed ones, and enrollment_test.go's) is
// unaffected.
func TestMain(m *testing.M) { os.Exit(testdb.Main(m)) }

// The lock IS the fix, so it is asserted rather than described in a comment:
// delete the TestMain above and this is the thing that goes red.
func TestTheFixtureLockIsHeldForThisBinary(t *testing.T) { testdb.AssertHeld(t) }
