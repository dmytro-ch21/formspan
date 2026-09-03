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

// N465: healthkit_uuid round-trips through PutDetail/GetDetail like every
// other field, and re-saving the SAME session (an outbox retry, or the
// import flow re-syncing after a partial push) with the SAME uuid must
// converge rather than tripping the unique index — the ordinary upsert case,
// not the collision this file tests separately below.
func TestPutAndGetDetailWithHealthKitUUID(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-running-hk", "user_running_hk"
	seedSession(t, pool, id, user)

	uuid := "6D0D0F5F-8B4A-4E2D-9B1A-3C7E9F1A2B3C"
	in := SessionDetail{
		SessionID:     id,
		Source:        SourceHealthKit,
		DistanceM:     ptr(5000.0),
		HealthKitUUID: ptr(uuid),
	}

	if _, err := repo.PutDetail(ctx, user, in); err != nil {
		t.Fatalf("put: %v", err)
	}
	// Retry with the identical uuid, same session — must converge, not
	// refuse, since this is exactly what a re-sent outbox row looks like.
	saved, err := repo.PutDetail(ctx, user, in)
	if err != nil {
		t.Fatalf("retry put: %v", err)
	}
	if saved.HealthKitUUID == nil || *saved.HealthKitUUID != uuid {
		t.Fatalf("put returned healthkit_uuid=%v, want %q", saved.HealthKitUUID, uuid)
	}

	got, err := repo.GetDetail(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.HealthKitUUID == nil || *got.HealthKitUUID != uuid {
		t.Fatalf("get returned healthkit_uuid=%v, want %q", got.HealthKitUUID, uuid)
	}
}

// The per-user unique index is the backstop against a SECOND session
// claiming a HealthKit workout a first session already holds — the scenario
// the mobile app's own local ledger cannot prevent (a reinstall, or a second
// device). Exercised at the repository level, unlike
// TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel above, because
// this constraint IS reachable through the ordinary PutDetail call: nothing
// about ownership or ON CONFLICT(session_id) intercepts it first.
func TestHealthKitUUIDIsUniquePerUser(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const firstID, secondID, user = "ses-running-hk-dup-1", "ses-running-hk-dup-2", "user_running_hk_dup"
	seedSession(t, pool, firstID, user)
	seedSession(t, pool, secondID, user)

	uuid := "AAAAAAAA-1111-2222-3333-444444444444"
	if _, err := repo.PutDetail(ctx, user, SessionDetail{
		SessionID: firstID, Source: SourceHealthKit, HealthKitUUID: ptr(uuid),
	}); err != nil {
		t.Fatalf("first put: %v", err)
	}

	_, err := repo.PutDetail(ctx, user, SessionDetail{
		SessionID: secondID, Source: SourceHealthKit, HealthKitUUID: ptr(uuid),
	})
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second session claiming the same healthkit_uuid gave %v, want ErrAlreadyExists", err)
	}

	// The second session's detail row must not have been left half-written —
	// GetDetail on it should still answer ErrNotFound, the same "no detail
	// yet" state as before the refused write, since the whole statement rolls
	// back inside PutDetail's own transaction.
	if _, err := repo.GetDetail(ctx, user, secondID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second session's detail after a refused write: %v, want ErrNotFound", err)
	}

	// And the FIRST session's row — the one that legitimately owns this
	// uuid — must be completely unchanged by the refused write. The refused
	// INSERT never touches this row at all, but that is exactly the kind of
	// fact worth asserting rather than assuming: a future rewrite of this
	// statement into something that DOES touch existing rows on conflict
	// (an ON CONFLICT clause keyed on healthkit_uuid, say) would silently
	// reintroduce a cross-session overwrite with no test noticing.
	original, err := repo.GetDetail(ctx, user, firstID)
	if err != nil {
		t.Fatalf("original session's detail after a refused write on a different session: %v", err)
	}
	if original.HealthKitUUID == nil || *original.HealthKitUUID != uuid {
		t.Fatalf("original session's healthkit_uuid = %v, want %q — the refused write altered it", original.HealthKitUUID, uuid)
	}

	// A DIFFERENT user importing the identical HealthKit uuid (two athletes
	// on the same shared library workout is not realistic, but the index is
	// scoped per-user rather than global, and this is what proves that scope
	// rather than assuming it) must succeed.
	const otherUser, otherSession = "user_running_hk_dup_other", "ses-running-hk-dup-other"
	seedSession(t, pool, otherSession, otherUser)
	if _, err := repo.PutDetail(ctx, otherUser, SessionDetail{
		SessionID: otherSession, Source: SourceHealthKit, HealthKitUUID: ptr(uuid),
	}); err != nil {
		t.Fatalf("a different user's identical healthkit_uuid was refused: %v", err)
	}
}

// L12/#778: DistanceRecords is otherwise pure logic (see
// distance_records_test.go) — what only the database can prove is that the
// fetch itself is scoped correctly: the caller's own running sessions only,
// no other user's, no other sport's, joined against the real `sessions`
// table rather than an assumption about its shape.
func TestDistanceRecords(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_running_distance_records"

	// A slower 5k.
	const slowID = "ses-distance-records-slow"
	seedSession(t, pool, slowID, user)
	if _, err := repo.PutDetail(ctx, user, SessionDetail{
		SessionID: slowID, Source: SourcePhoneGPS,
		Splits: []Split{
			{DistanceM: 1000, DurationSeconds: 300},
			{DistanceM: 1000, DurationSeconds: 300},
			{DistanceM: 1000, DurationSeconds: 300},
			{DistanceM: 1000, DurationSeconds: 300},
			{DistanceM: 1000, DurationSeconds: 300},
		},
	}); err != nil {
		t.Fatalf("seed slow run: %v", err)
	}

	// A faster 5k — should win.
	const fastID = "ses-distance-records-fast"
	seedSession(t, pool, fastID, user)
	if _, err := repo.PutDetail(ctx, user, SessionDetail{
		SessionID: fastID, Source: SourcePhoneGPS,
		Splits: []Split{
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
		},
	}); err != nil {
		t.Fatalf("seed fast run: %v", err)
	}

	// A strength session cannot carry a running detail row through
	// PutDetail — it refuses a non-running session, see
	// TestDetailCannotAttachToAnotherSportsSession — so a decoy detail row
	// has to be written directly, bypassing the repository entirely, the
	// same way TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel
	// bypasses it to reach the SQL layer's own guarantee. Its splits are an
	// absurdly fast 5k (5 seconds flat) so that IF the query's own
	// `s.sport = $2` filter were ever dropped, this decoy would not merely
	// slip into the list unnoticed — it would WIN, and the assertions below
	// on the winning session/value would fail loudly. Verified directly:
	// removing that filter from the query made this exact test fail on
	// `winning session = "ses-distance-records-strength", want …-fast`.
	const strengthID = "ses-distance-records-strength"
	seedSessionSport(t, pool, strengthID, user, "strength")
	if _, err := pool.Exec(ctx, `
		INSERT INTO running_session_detail (session_id, user_id, splits, source)
		VALUES ($1, $2, $3, 'manual')`,
		strengthID, user,
		`[{"distance_m":1000,"duration_seconds":1},{"distance_m":1000,"duration_seconds":1},`+
			`{"distance_m":1000,"duration_seconds":1},{"distance_m":1000,"duration_seconds":1},`+
			`{"distance_m":1000,"duration_seconds":1}]`); err != nil {
		t.Fatalf("seed decoy detail row on a strength session: %v", err)
	}

	got, err := repo.DistanceRecords(ctx, user)
	if err != nil {
		t.Fatalf("distance records: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d records, want 1 (5k only): %+v", len(got), got)
	}
	r := got[0]
	if r.Standard.Key != "5k" {
		t.Fatalf("record standard = %q, want 5k", r.Standard.Key)
	}
	if r.SessionID != fastID {
		t.Fatalf("winning session = %q, want the faster run %q", r.SessionID, fastID)
	}
	if r.ValueSeconds != 1200 {
		t.Fatalf("value_seconds = %v, want 1200 (20:00 5k)", r.ValueSeconds)
	}

	// Another user's identical splits must not leak into this user's list —
	// the same non-disclosure stance every other query in this package
	// takes.
	const otherUser2, otherSession2 = "user_running_distance_records_other", "ses-distance-records-other-user"
	seedSession(t, pool, otherSession2, otherUser2)
	if _, err := repo.PutDetail(ctx, otherUser2, SessionDetail{
		SessionID: otherSession2, Source: SourceManual,
		Splits: []Split{{DistanceM: 5000, DurationSeconds: 900}},
	}); err != nil {
		t.Fatalf("seed other user's run: %v", err)
	}
	stillGot, err := repo.DistanceRecords(ctx, user)
	if err != nil {
		t.Fatalf("distance records after seeding another user: %v", err)
	}
	if len(stillGot) != 1 || stillGot[0].SessionID != fastID {
		t.Fatalf("another user's run leaked into this user's records: %+v", stillGot)
	}
}

func TestDistanceRecordsForUserWithNoRunsIsEmpty(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	got, err := repo.DistanceRecords(ctx, "user_running_distance_records_none")
	if err != nil {
		t.Fatalf("distance records: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %d records for a user with no runs, want 0", len(got))
	}
}
