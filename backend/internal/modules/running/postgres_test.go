package running

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// These exercise the properties that only exist in the database: the
// composite owner foreign key doing authorization, and route/split
// replacement converging on retry. Neither is observable from the domain
// types alone. Mirrors bjj/session_postgres_test.go's structure and
// intent — see that file's comments for the fuller argument behind each
// case; these are restated here rather than imported because the two
// packages must each stand alone.

func newTestRepo(t *testing.T) (*PostgresRepository, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	pool, err := database.NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered first so it closes LAST under LIFO cleanup — every other
	// t.Cleanup below still needs the pool open. See CLAUDE.md.
	t.Cleanup(pool.Close)
	return NewPostgresRepository(pool), pool
}

// seedSession writes a real `sessions` row, because the whole point of the
// owner FK is that it references one.
func seedSession(t *testing.T, pool *pgxpool.Pool, id, userID string) {
	t.Helper()
	seedSessionSport(t, pool, id, userID, sportKey)
}

func seedSessionSport(t *testing.T, pool *pgxpool.Pool, id, userID, sport string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, name, started_at)
		VALUES ($1, $2, $4, 'Test session', $3)`,
		id, userID, time.Now().UTC(), sport)
	if err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})
}

func TestPutAndGetDetail(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-running-detail", "user_running_detail"
	seedSession(t, pool, id, user)

	recordedAt := time.Date(2026, 8, 1, 7, 0, 0, 0, time.UTC)
	in := SessionDetail{
		SessionID:       id,
		Source:          SourcePhoneGPS,
		DistanceM:       ptr(5000.0),
		DurationSeconds: ptr(1500),
		ElevationGainM:  ptr(42.5),
		AvgPaceSecPerKm: ptr(300.0),
		RoutePoints: []RoutePoint{
			{Lat: 40.7128, Lng: -74.0060, RecordedAt: recordedAt},
			{Lat: 40.7130, Lng: -74.0062, ElevationM: ptr(12.5), RecordedAt: recordedAt.Add(10 * time.Second)},
		},
		Splits: []Split{
			{DistanceM: 1000, DurationSeconds: 300},
			{DistanceM: 1000, DurationSeconds: 305},
		},
	}

	saved, err := repo.PutDetail(ctx, user, in)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if saved.Source != SourcePhoneGPS || len(saved.RoutePoints) != 2 || len(saved.Splits) != 2 {
		t.Fatalf("put returned source=%q points=%d splits=%d, want phone_gps/2/2",
			saved.Source, len(saved.RoutePoints), len(saved.Splits))
	}

	got, err := repo.GetDetail(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.DistanceM == nil || *got.DistanceM != 5000.0 {
		t.Fatalf("get returned distance_m=%v, want 5000", got.DistanceM)
	}
	if got.DurationSeconds == nil || *got.DurationSeconds != 1500 {
		t.Fatalf("get returned duration_seconds=%v, want 1500", got.DurationSeconds)
	}
	// Order is insertion order, so the track re-renders as it was recorded.
	if len(got.RoutePoints) != 2 || got.RoutePoints[0].Lat != 40.7128 {
		t.Fatalf("route points = %+v", got.RoutePoints)
	}
	if got.RoutePoints[0].ElevationM != nil {
		t.Fatalf("expected first point's elevation unrecorded, got %v", *got.RoutePoints[0].ElevationM)
	}
	if got.RoutePoints[1].ElevationM == nil || *got.RoutePoints[1].ElevationM != 12.5 {
		t.Fatalf("second point elevation = %v, want 12.5", got.RoutePoints[1].ElevationM)
	}
	if !got.RoutePoints[0].RecordedAt.Equal(recordedAt) {
		t.Fatalf("first point recorded_at = %v, want %v", got.RoutePoints[0].RecordedAt, recordedAt)
	}
	if len(got.Splits) != 2 || got.Splits[1].DurationSeconds != 305 {
		t.Fatalf("splits = %+v", got.Splits)
	}
}

func TestGetDetailForSessionWithNoDetailIsNotFound(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-running-none", "user_running_none"
	seedSession(t, pool, id, user)

	if _, err := repo.GetDetail(ctx, user, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get with no detail row gave %v, want ErrNotFound", err)
	}
}

// The reason PutDetail replaces rather than merges: the client re-sends the
// desired state, so a retry after a half-failed push has to converge instead
// of duplicating or stacking route points.
func TestPutDetailReplacesRouteAndSplitsRatherThanAppending(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-running-replace", "user_running_replace"
	seedSession(t, pool, id, user)

	base := SessionDetail{
		SessionID: id,
		Source:    SourceManual,
		Splits:    []Split{{DistanceM: 1000, DurationSeconds: 300}},
	}
	if _, err := repo.PutDetail(ctx, user, base); err != nil {
		t.Fatalf("first put: %v", err)
	}

	// The same detail, re-sent — exactly what the outbox does on retry.
	again, err := repo.PutDetail(ctx, user, base)
	if err != nil {
		t.Fatalf("second put: %v", err)
	}
	if len(again.Splits) != 1 {
		t.Fatalf("after re-put got %d splits, want 1 — splits are appending, not replacing", len(again.Splits))
	}

	// And a genuine edit removes what is no longer there.
	base.Splits = []Split{
		{DistanceM: 1000, DurationSeconds: 300},
		{DistanceM: 1000, DurationSeconds: 310},
	}
	edited, err := repo.PutDetail(ctx, user, base)
	if err != nil {
		t.Fatalf("edit put: %v", err)
	}
	if len(edited.Splits) != 2 {
		t.Fatalf("edit did not replace: %+v", edited.Splits)
	}
}

// The insert path: no detail row exists yet, so both the explicit ownership
// SELECT and the composite owner FK are in play.
func TestDetailCannotBeWrittenToSomebodyElsesSession(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-running-owner", "user_running_owner", "user_running_attacker"
	seedSession(t, pool, id, owner)

	_, err := repo.PutDetail(ctx, attacker, SessionDetail{SessionID: id, Source: SourceManual})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("writing to another user's session gave %v, want ErrNotFound", err)
	}

	// And the owner's own session is untouched by the attempt.
	if _, err := repo.GetDetail(ctx, owner, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attacker's failed write left a detail row behind: %v", err)
	}
}

// Same non-disclosure for reads: "not yours" and "doesn't exist" must be
// indistinguishable, or the endpoint confirms which session ids are real.
func TestGetDetailIsNotFoundForAnotherUser(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, other = "ses-running-read", "user_running_read_owner", "user_running_read_other"
	seedSession(t, pool, id, owner)

	if _, err := repo.PutDetail(ctx, owner, SessionDetail{SessionID: id, Source: SourceManual}); err != nil {
		t.Fatalf("seed detail: %v", err)
	}
	if _, err := repo.GetDetail(ctx, other, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-user read gave %v, want ErrNotFound", err)
	}
}

func TestDetailForUnknownSessionIsNotFound(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	_, err := repo.PutDetail(ctx, "user_running_ghost",
		SessionDetail{SessionID: "ses-does-not-exist", Source: SourceManual})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("put against a missing session gave %v, want ErrNotFound", err)
	}
}

// Deleting the session must take its detail with it — the FK says CASCADE,
// and an orphaned detail row would be a run attached to nothing.
func TestDeletingTheSessionCascadesToDetail(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-running-cascade", "user_running_cascade"
	seedSession(t, pool, id, user)

	if _, err := repo.PutDetail(ctx, user, SessionDetail{
		SessionID: id, Source: SourcePhoneGPS,
		RoutePoints: []RoutePoint{{Lat: 1, Lng: 1, RecordedAt: time.Now().UTC()}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM running_session_detail WHERE session_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d detail rows survived the session delete", n)
	}
}

// The update path, which the composite owner foreign key does not protect —
// see the WHERE-clause comment on PutDetail for why.
func TestExistingDetailCannotBeOverwrittenByAnotherUser(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-running-upd", "user_running_owner_upd", "user_running_attacker_upd"
	seedSession(t, pool, id, owner)

	if _, err := repo.PutDetail(ctx, owner, SessionDetail{
		SessionID: id, Source: SourceManual, DistanceM: ptr(1000.0),
	}); err != nil {
		t.Fatalf("owner put: %v", err)
	}

	_, err := repo.PutDetail(ctx, attacker, SessionDetail{
		SessionID: id, Source: SourceManual, DistanceM: ptr(999999.0),
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("attacker overwrote an existing detail row: err = %v", err)
	}

	got, err := repo.GetDetail(ctx, owner, id)
	if err != nil {
		t.Fatalf("owner get: %v", err)
	}
	if got.DistanceM == nil || *got.DistanceM != 1000.0 {
		t.Fatalf("owner's detail was modified: distance_m=%v", got.DistanceM)
	}
}

// A running detail must not attach to a session of another sport. Nothing in
// the schema prevents it by itself — the owner FK only checks (id,
// user_id) — so this covers the explicit sport read in PutDetail.
func TestDetailCannotAttachToAnotherSportsSession(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-running-sport", "user_running_sport"
	seedSessionSport(t, pool, id, user, "strength")

	if _, err := repo.PutDetail(ctx, user, SessionDetail{
		SessionID: id, Source: SourceManual,
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attached a running detail to a strength session: err = %v", err)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM running_session_detail WHERE session_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d detail rows written against a strength session", n)
	}
}

// The upsert's WHERE predicate, exercised directly against the database.
//
// The ownership SELECT added in PutDetail returns ErrNotFound before the
// upsert is ever reached, so no call through the repository can tell whether
// the predicate itself is still there — the whole suite would stay green
// with it deleted. This issues the same statement PutDetail issues, as an
// attacker, and asserts the database refuses it on its own. Mirrors bjj's
// TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel exactly.
func TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel(t *testing.T) {
	_, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-running-sql", "user_running_sql_owner", "user_running_sql_attacker"
	seedSession(t, pool, id, owner)

	if _, err := pool.Exec(ctx, `
		INSERT INTO running_session_detail (session_id, user_id, source, distance_m)
		VALUES ($1, $2, 'manual', 1000)`, id, owner); err != nil {
		t.Fatalf("seed detail: %v", err)
	}

	// The statement from PutDetail, minus the Go-level guards. Note the
	// attacker's user_id is NOT in the SET list — that is what stops the
	// foreign key from re-checking, and why this predicate has to exist.
	tag, err := pool.Exec(ctx, `
		INSERT INTO running_session_detail (session_id, user_id, source, distance_m)
		VALUES ($1, $2, 'manual', 999999)
		ON CONFLICT (session_id) DO UPDATE SET
			source = excluded.source,
			distance_m = excluded.distance_m
		WHERE running_session_detail.user_id = $2`, id, attacker)
	if err != nil {
		t.Fatalf("upsert errored rather than matching no rows: %v", err)
	}
	if n := tag.RowsAffected(); n != 0 {
		t.Fatalf("cross-user upsert touched %d row(s); the WHERE predicate is gone", n)
	}

	var distanceM float64
	if err := pool.QueryRow(ctx,
		`SELECT distance_m FROM running_session_detail WHERE session_id = $1`,
		id).Scan(&distanceM); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if distanceM != 1000 {
		t.Fatalf("owner's row was modified: distance_m=%v", distanceM)
	}
}
