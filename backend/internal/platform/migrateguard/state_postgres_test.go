package migrateguard

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// These run against a real Postgres, in their own schema, and skip without
// TEST_DATABASE_URL — the module convention.
//
// Own schema rather than own database because ReadState's query is
// unqualified, so search_path is enough to isolate it, and because the point
// of the read-only assertion below is that nothing is left behind anywhere.
func stateFixture(t *testing.T) string {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()

	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })

	const schema = "migrateguard_test"
	if _, err := admin.Exec(ctx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
			t.Errorf("cleanup: drop schema: %v", err)
		}
	})

	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("TEST_DATABASE_URL is not a URL: %v", err)
	}
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	return u.String()
}

func TestReadState_MissingTableIsNotAnError(t *testing.T) {
	dsn := stateFixture(t)

	got, err := ReadState(context.Background(), dsn)
	if err != nil {
		t.Fatalf("ReadState on a never-migrated database: %v", err)
	}
	if got.Applied {
		t.Fatalf("got %+v, want a never-migrated database", got)
	}
}

// `migrate status` has to be the command somebody points at a deployed
// database mid-incident. golang-migrate would CREATE schema_migrations just by
// being opened; this must not.
func TestReadState_LeavesNothingBehind(t *testing.T) {
	dsn := stateFixture(t)
	ctx := context.Background()

	if _, err := ReadState(ctx, dsn); err != nil {
		t.Fatal(err)
	}

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()

	var n int
	if err := conn.QueryRow(ctx,
		"SELECT count(*) FROM information_schema.tables WHERE table_schema = 'migrateguard_test'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("ReadState created %d table(s); it must be read-only", n)
	}
}

func TestReadState_ReadsVersionAndDirty(t *testing.T) {
	dsn := stateFixture(t)
	ctx := context.Background()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, "CREATE TABLE schema_migrations (version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL)"); err != nil {
		t.Fatal(err)
	}

	// An empty table is golang-migrate's state after a full `down`, and is
	// indistinguishable from never-migrated.
	got, err := ReadState(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if got.Applied {
		t.Fatalf("empty schema_migrations: got %+v, want not applied", got)
	}

	if _, err := conn.Exec(ctx, "INSERT INTO schema_migrations (version, dirty) VALUES (71, false)"); err != nil {
		t.Fatal(err)
	}
	got, err = ReadState(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Applied || got.Version != 71 || got.Dirty {
		t.Fatalf("got %+v, want {Applied:true Version:71 Dirty:false}", got)
	}

	if _, err := conn.Exec(ctx, "UPDATE schema_migrations SET dirty = true"); err != nil {
		t.Fatal(err)
	}
	got, err = ReadState(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Dirty {
		t.Fatalf("got %+v, want Dirty true", got)
	}
}
