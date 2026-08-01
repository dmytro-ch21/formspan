package health

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Gated on TEST_DATABASE_URL and skips without it, like every other
// integration test here. Point it at a database that is *not* DATABASE_URL —
// this one truncates.
func newTestRepo(t *testing.T) *PostgresRepository {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before anything else that needs the pool, because t.Cleanup
	// runs LIFO — see the note in CLAUDE.md.
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `TRUNCATE health_events`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	return NewPostgresRepository(pool)
}

func strp(s string) *string { return &s }
func intp(i int) *int       { return &i }

func TestPostgresRepository_RecordAndList(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	events := []Event{
		{
			Source: SourceAPI, Kind: KindServerError,
			UserID: strp("user_a"), Method: strp("GET"), Path: strp("/v1/sessions"),
			Status: intp(500), DurationMS: intp(12),
			ErrorCode: "internal", RequestID: "req1", TraceID: "trace1",
		},
		{
			Source: SourceAPI, Kind: KindSlowRequest,
			Method: strp("GET"), Path: strp("/v1/exercises"),
			Status: intp(200), DurationMS: intp(3400),
		},
		{
			Source: SourceClient, Kind: KindSyncBlocked,
			UserID: strp("user_b"), Message: "server refused this session",
			Details: map[string]any{"session_id": "abc", "attempts": float64(4)},
		},
	}
	for _, e := range events {
		if err := repo.Record(ctx, e); err != nil {
			t.Fatalf("record: %v", err)
		}
	}

	all, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("expected 3 events, got %d", len(all))
	}

	// Newest first — the health screen is read top-down when something is
	// actively wrong, so ordering is functional, not cosmetic.
	if all[0].Kind != KindSyncBlocked {
		t.Errorf("expected newest first, got %q", all[0].Kind)
	}

	// JSONB round-trips. Client reports put their entity id here rather than
	// growing a column per event kind, so losing it would make those rows
	// unactionable — you'd know a sync was blocked but not for what.
	if got := all[0].Details["session_id"]; got != "abc" {
		t.Errorf("details did not round-trip: %#v", all[0].Details)
	}

	// A nil user is preserved as nil rather than becoming "". An
	// unauthenticated failure genuinely has no user, and an empty string would
	// be a claim about a user whose id happens to be blank.
	slow := all[1]
	if slow.UserID != nil {
		t.Errorf("expected no user on the unauthenticated event, got %q", *slow.UserID)
	}
	if slow.Status == nil || *slow.Status != 200 {
		t.Error("status did not round-trip")
	}
}

func TestPostgresRepository_Filters(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	for _, e := range []Event{
		{Source: SourceAPI, Kind: KindServerError, UserID: strp("user_a"), Status: intp(500)},
		{Source: SourceClient, Kind: KindSyncBlocked, UserID: strp("user_b")},
		{Source: SourceClient, Kind: KindClientError, UserID: strp("user_b")},
	} {
		if err := repo.Record(ctx, e); err != nil {
			t.Fatalf("record: %v", err)
		}
	}

	byUser, err := repo.List(ctx, Filter{UserID: "user_b"})
	if err != nil {
		t.Fatalf("list by user: %v", err)
	}
	if len(byUser) != 2 {
		t.Errorf("expected 2 events for user_b, got %d", len(byUser))
	}

	byKind, err := repo.List(ctx, Filter{Kind: KindServerError})
	if err != nil {
		t.Fatalf("list by kind: %v", err)
	}
	if len(byKind) != 1 {
		t.Errorf("expected 1 server_error, got %d", len(byKind))
	}

	// An empty filter must mean "everything", not "nothing" — the `$1 = '' OR`
	// construction is what makes one query serve every combination, and
	// getting it backwards would silently return an empty health screen on a
	// system that is on fire.
	all, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if len(all) != 3 {
		t.Errorf("empty filter should return everything, got %d", len(all))
	}
}

func TestPostgresRepository_Summarise(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	for _, e := range []Event{
		{Source: SourceAPI, Kind: KindServerError, UserID: strp("user_a")},
		{Source: SourceAPI, Kind: KindServerError, UserID: strp("user_a")},
		{Source: SourceAPI, Kind: KindSlowRequest, Path: strp("/v1/exercises"), DurationMS: intp(3400)},
		{Source: SourceAPI, Kind: KindSlowRequest, Path: strp("/v1/exercises"), DurationMS: intp(9100)},
		{Source: SourceClient, Kind: KindSyncBlocked, UserID: strp("user_b")},
	} {
		if err := repo.Record(ctx, e); err != nil {
			t.Fatalf("record: %v", err)
		}
	}

	s, err := repo.Summarise(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("summarise: %v", err)
	}
	if s.Total != 5 {
		t.Errorf("total = %d, want 5", s.Total)
	}
	if s.ByKind["server_error"] != 2 || s.ByKind["slow_request"] != 2 {
		t.Errorf("by_kind wrong: %#v", s.ByKind)
	}

	// Distinct *people*, not events. Two rows from one athlete on a bad
	// connection is a very different morning from two athletes hitting the
	// same broken endpoint, and a raw count cannot tell them apart — which is
	// the whole reason this field exists rather than reusing Total.
	if s.AffectedUsers != 2 {
		t.Errorf("affected_users = %d, want 2 (user_a and user_b, not 5 events)", s.AffectedUsers)
	}

	// Worst observed latency per route, so a slow endpoint gets named rather
	// than merely counted.
	if s.SlowestPathsMS["/v1/exercises"] != 9100 {
		t.Errorf("slowest path should report the max, got %#v", s.SlowestPathsMS)
	}

	// A window that excludes everything must report zero, not everything — the
	// bug that would make the screen permanently alarming.
	empty, err := repo.Summarise(ctx, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("summarise future: %v", err)
	}
	if empty.Total != 0 || empty.AffectedUsers != 0 {
		t.Errorf("future window should be empty, got %#v", empty)
	}
}

func TestNewEventValidate(t *testing.T) {
	long := make([]byte, MaxMessageLen+1)
	for i := range long {
		long[i] = 'x'
	}

	cases := []struct {
		name string
		ev   NewEvent
		ok   bool
	}{
		{"client error", NewEvent{Kind: KindClientError, Message: "local write failed"}, true},
		{"sync blocked", NewEvent{Kind: KindSyncBlocked}, true},
		// The important one. A client claiming server_error would put a row in
		// the operator's face that the server never observed and cannot
		// corroborate — and the value of this table is that measured and
		// claimed are distinguishable at a glance.
		{"cannot claim a server error", NewEvent{Kind: KindServerError}, false},
		{"cannot claim a slow request", NewEvent{Kind: KindSlowRequest}, false},
		{"unknown kind", NewEvent{Kind: Kind("whatever")}, false},
		{"oversized message", NewEvent{Kind: KindClientError, Message: string(long)}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.ev.Validate()
			if c.ok && err != nil {
				t.Errorf("expected valid, got %v", err)
			}
			if !c.ok && err == nil {
				t.Error("expected rejection")
			}
		})
	}
}

// Prune must delete the tail and ONLY the tail.
//
// A sign flip in `time.Now().Add(-retention)` deletes everything instead —
// silently, from the deploy path, with the row count in the log looking like
// success. Nothing pinned "rows newer than the cutoff survive" until now.
func TestPostgresRepository_Prune_KeepsRecentDropsOld(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	// Either side of the boundary by a day, so this doesn't hinge on clock
	// precision. Written with raw SQL rather than Record() because the whole
	// point is to place a row in the past, which Record deliberately can't.
	now := time.Now()
	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO health_events (occurred_at, source, kind, error_code, message, request_id, trace_id)
		VALUES ($1, 'api', 'server_error', 'internal', 'old', 'r_old', 't'),
		       ($2, 'api', 'server_error', 'internal', 'new', 'r_new', 't')`,
		now.Add(-retention-24*time.Hour), now.Add(-retention+24*time.Hour)); err != nil {
		t.Fatalf("insert: %v", err)
	}

	n, err := repo.Prune(ctx)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly 1 row pruned, got %d", n)
	}

	var left []string
	rows, err := repo.pool.Query(ctx, `SELECT request_id FROM health_events`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		left = append(left, id)
	}
	if len(left) != 1 || left[0] != "r_new" {
		t.Fatalf("expected only the in-retention row to survive, got %v", left)
	}
}
