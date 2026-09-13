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

// F66 (#1200). N565's daily stuck-row reports share the `sync_blocked` kind,
// and the "Sync blocked" figure has to keep meaning a device gave up pushing.
// The reports get their own figure instead, built from each athlete's latest
// report.
func TestPostgresRepository_SummariseSplitsStuckRowReports(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	record := func(events ...Event) {
		t.Helper()
		for _, e := range events {
			if err := repo.Record(ctx, e); err != nil {
				t.Fatalf("record: %v", err)
			}
		}
	}
	// Moves every row recorded so far into the past, so the next ones are newer.
	age := func(d time.Duration) {
		t.Helper()
		if _, err := repo.pool.Exec(ctx,
			`UPDATE health_events SET occurred_at = occurred_at - make_interval(secs => $1)`,
			d.Seconds()); err != nil {
			t.Fatalf("age rows: %v", err)
		}
	}
	report := func(user, entity, state, code string, rows any) Event {
		details := map[string]any{"reason": "stuck_" + state, "code": code, "rows": rows}
		if entity != "" {
			details["entity"] = entity
		}
		return Event{
			Source: SourceClient, Kind: KindSyncBlocked, UserID: strp(user),
			Message: "stuck rows: " + entity + " " + state + " " + code, Details: details,
		}
	}

	// athlete_a's report from yesterday. Its workout group has since cleared,
	// so it must not be listed, and its food count has since changed.
	record(
		report("athlete_a", "food", "refused", "invalid_input", 4.0),
		report("athlete_a", "workout", "blocked", "unknown", 2.0),
	)
	age(20 * time.Hour)

	// The first half of athlete_b's latest pass, 30 seconds before the second
	// half: a pass with more than ten groups reaches the server as several
	// requests, and both halves belong to the same report.
	record(report("athlete_b", "food", "refused", "invalid_input", 1.0))
	age(30 * time.Second)

	record(
		// A real give-up. This is the one event "Sync blocked" should count.
		Event{
			Source: SourceClient, Kind: KindSyncBlocked, UserID: strp("athlete_a"),
			Message: "server refused this session", Details: map[string]any{"session_id": "abc"},
		},
		Event{Source: SourceAPI, Kind: KindServerError, UserID: strp("athlete_e")},
		report("athlete_a", "food", "refused", "invalid_input", 3.0),
		report("athlete_b", "session", "blocked", "no_http_code", 5.0),
		// The same group again inside one pass. Counted once, not twice.
		report("athlete_b", "session", "blocked", "no_http_code", 5.0),
		// A client-written row count that is not a number: counts as zero rather
		// than failing the whole summary.
		report("athlete_d", "food", "refused", "invalid_input", "lots"),
		// Nor does one too large for the total's bigint.
		report("athlete_f", "food", "refused", "invalid_input", 1e30),
		// No entity: the athlete counts, the group is not listed.
		report("athlete_c", "", "refused", "invalid_input", 7.0),
	)

	s, err := repo.Summarise(ctx, time.Now().Add(-48*time.Hour))
	if err != nil {
		t.Fatalf("summarise: %v", err)
	}

	if got := s.ByKind["sync_blocked"]; got != 1 {
		t.Errorf("by_kind.sync_blocked = %d, want 1: only the give-up, never a daily report", got)
	}
	if s.StuckRowReports != 9 {
		t.Errorf("stuck_row_reports = %d, want 9", s.StuckRowReports)
	}
	if s.Total != 11 {
		t.Errorf("total = %d, want 11: reports still count as events", s.Total)
	}
	sum := s.StuckRowReports
	for _, n := range s.ByKind {
		sum += n
	}
	if sum != s.Total {
		t.Errorf("by_kind plus stuck_row_reports = %d, total = %d; they must add up", sum, s.Total)
	}
	if s.StuckRowAthletes != 5 {
		t.Errorf("stuck_row_athletes = %d, want 5 (a, b, c, d, f)", s.StuckRowAthletes)
	}

	want := []StuckRowGroup{
		{Entity: "food", State: "refused", Code: "invalid_input", Athletes: 4, Rows: 4},
		{Entity: "session", State: "blocked", Code: "no_http_code", Athletes: 1, Rows: 5},
	}
	if len(s.StuckRows) != len(want) {
		t.Fatalf("stuck_rows = %#v, want %#v", s.StuckRows, want)
	}
	for i := range want {
		if s.StuckRows[i] != want[i] {
			t.Errorf("stuck_rows[%d] = %#v, want %#v", i, s.StuckRows[i], want[i])
		}
	}

	// An empty window still lists `[]`, not `null`, so the screen has one
	// shape to read.
	empty, err := repo.Summarise(ctx, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("summarise future: %v", err)
	}
	if empty.StuckRows == nil || len(empty.StuckRows) != 0 || empty.StuckRowAthletes != 0 {
		t.Errorf("future window should have no stuck rows, got %#v", empty)
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
