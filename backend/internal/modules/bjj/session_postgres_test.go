package bjj

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
// composite owner foreign key doing authorization, and tag replacement
// converging on retry. Neither is observable from the domain types.

func newSessionTestRepo(t *testing.T) (*PostgresRepository, *pgxpool.Pool) {
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
	repo, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bjj-detail", "user_bjj_detail"
	seedSession(t, pool, id, user)

	gi := true
	rounds, mins, rpe := 5, 6, 8
	tech := "closed-guard-armbar"

	in := SessionDetail{
		SessionID:    id,
		Kind:         KindRolling,
		Gi:           &gi,
		Rounds:       &rounds,
		RoundMinutes: &mins,
		SessionRPE:   &rpe,
		Academy:      "Test Academy",
		Note:         "felt sharp",
		Tags: []Tag{
			{Category: CategorySweep, Event: EventScored, Position: "Half Guard", Count: 2},
			{Category: CategorySubmission, Event: EventConceded, Position: "Mount", Count: 1},
		},
	}

	saved, err := repo.PutDetail(ctx, user, in)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if saved.Kind != KindRolling || len(saved.Tags) != 2 {
		t.Fatalf("put returned kind=%q tags=%d, want rolling/2", saved.Kind, len(saved.Tags))
	}
	if got := saved.RollingMinutes(); got != 30 {
		t.Fatalf("RollingMinutes = %d, want 30", got)
	}

	got, err := repo.GetDetail(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Academy != "Test Academy" || got.Note != "felt sharp" {
		t.Fatalf("get returned %+v", got)
	}
	if len(got.Tags) != 2 {
		t.Fatalf("get returned %d tags, want 2", len(got.Tags))
	}
	// Order is insertion order, so the chips re-render as they were entered.
	if got.Tags[0].Category != CategorySweep || got.Tags[0].Count != 2 {
		t.Fatalf("first tag = %+v", got.Tags[0])
	}
	if got.Tags[1].Event != EventConceded {
		t.Fatalf("second tag event = %q, want conceded", got.Tags[1].Event)
	}
	// An untagged event is the fast path and must round-trip as absent
	// rather than as an empty string.
	if got.Tags[0].TechniqueID != nil {
		t.Fatalf("expected no technique id, got %q", *got.Tags[0].TechniqueID)
	}
	_ = tech
}

// N119/#508: the free-text label on an unresolved tag must round-trip
// exactly, technique_id null throughout — a mutation-relevant guard, since
// the failure this ticket exists to fix is exactly a phrase getting lost
// somewhere between the athlete saying it and the row that is supposed to
// hold it.
func TestPutAndGetDetailPreservesAnUnmatchedTagLabel(t *testing.T) {
	repo, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bjj-label", "user_bjj_label"
	seedSession(t, pool, id, user)

	in := SessionDetail{
		SessionID: id,
		Kind:      KindRolling,
		Tags: []Tag{
			// The exact shape "Keep as said" produces: category/event from
			// the phrase, no technique, the phrase itself preserved.
			{Category: CategorySubmission, Event: EventScored, Count: 1, Label: "pool guards"},
			// An ordinary matched tag alongside it, so the test also proves
			// the two shapes coexist without one corrupting the other.
			{Category: CategorySweep, Event: EventScored, Count: 1},
		},
	}

	if _, err := repo.PutDetail(ctx, user, in); err != nil {
		t.Fatalf("put: %v", err)
	}

	got, err := repo.GetDetail(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.Tags) != 2 {
		t.Fatalf("got %d tags, want 2", len(got.Tags))
	}
	if got.Tags[0].Label != "pool guards" {
		t.Fatalf("label = %q, want %q — a mangled dictation must survive the round trip verbatim", got.Tags[0].Label, "pool guards")
	}
	if got.Tags[0].TechniqueID != nil {
		t.Fatalf("an unmatched tag must not have grown a technique id: %+v", got.Tags[0])
	}
	// The ordinary tag must not have picked up a label from its neighbour —
	// insertion is per-row, but a copy/paste of the wrong variable in the
	// batch would show up exactly this way.
	if got.Tags[1].Label != "" {
		t.Fatalf("an ordinary matched tag must not carry a label, got %q", got.Tags[1].Label)
	}
}

// The reason PutDetail replaces rather than merges: the client re-sends the
// desired state, so a retry after a half-failed push has to converge instead
// of stacking a second copy of every chip.
func TestPutDetailReplacesTagsRatherThanAppending(t *testing.T) {
	repo, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bjj-replace", "user_bjj_replace"
	seedSession(t, pool, id, user)

	base := SessionDetail{SessionID: id, Kind: KindDrilling}
	base.Tags = []Tag{
		{Category: CategorySweep, Event: EventDrilled, Count: 1},
		{Category: CategoryPass, Event: EventDrilled, Count: 1},
	}
	if _, err := repo.PutDetail(ctx, user, base); err != nil {
		t.Fatalf("first put: %v", err)
	}

	// The same reflection, re-sent — exactly what the outbox does on retry.
	again, err := repo.PutDetail(ctx, user, base)
	if err != nil {
		t.Fatalf("second put: %v", err)
	}
	if len(again.Tags) != 2 {
		t.Fatalf("after re-put got %d tags, want 2 — tags are appending, not replacing", len(again.Tags))
	}

	// And a genuine edit removes what is no longer there.
	base.Tags = []Tag{{Category: CategorySweep, Event: EventScored, Count: 3}}
	edited, err := repo.PutDetail(ctx, user, base)
	if err != nil {
		t.Fatalf("edit put: %v", err)
	}
	if len(edited.Tags) != 1 || edited.Tags[0].Event != EventScored || edited.Tags[0].Count != 3 {
		t.Fatalf("edit did not replace: %+v", edited.Tags)
	}
}

// The insert path: no detail row exists yet, so both the explicit ownership
// SELECT and the composite owner FK are in play. See
// TestExistingDetailCannotBeOverwrittenByAnotherUser for the update path,
// where the FK drops out and the guarding moves elsewhere.
func TestDetailCannotBeWrittenToSomebodyElsesSession(t *testing.T) {
	repo, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-bjj-owner", "user_bjj_owner", "user_bjj_attacker"
	seedSession(t, pool, id, owner)

	_, err := repo.PutDetail(ctx, attacker, SessionDetail{SessionID: id, Kind: KindRolling})
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
	repo, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, owner, other = "ses-bjj-read", "user_bjj_read_owner", "user_bjj_read_other"
	seedSession(t, pool, id, owner)

	if _, err := repo.PutDetail(ctx, owner, SessionDetail{SessionID: id, Kind: KindClass}); err != nil {
		t.Fatalf("seed detail: %v", err)
	}
	if _, err := repo.GetDetail(ctx, other, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-user read gave %v, want ErrNotFound", err)
	}
}

func TestDetailForUnknownSessionIsNotFound(t *testing.T) {
	repo, _ := newSessionTestRepo(t)
	ctx := context.Background()

	_, err := repo.PutDetail(ctx, "user_bjj_ghost",
		SessionDetail{SessionID: "ses-does-not-exist", Kind: KindRolling})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("put against a missing session gave %v, want ErrNotFound", err)
	}
}

// Deleting the session must take its reflection with it — the FK says
// CASCADE, and an orphaned detail row would be evidence attached to nothing.
func TestDeletingTheSessionCascadesToDetailAndTags(t *testing.T) {
	repo, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bjj-cascade", "user_bjj_cascade"
	seedSession(t, pool, id, user)

	if _, err := repo.PutDetail(ctx, user, SessionDetail{
		SessionID: id,
		Kind:      KindRolling,
		Tags:      []Tag{{Category: CategorySweep, Event: EventScored, Count: 1}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	var tags int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM bjj_session_tags WHERE session_id = $1`, id).Scan(&tags); err != nil {
		t.Fatalf("count tags: %v", err)
	}
	if tags != 0 {
		t.Fatalf("%d tag rows survived the session delete", tags)
	}
	if _, err := repo.GetDetail(ctx, user, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("detail survived the session delete: %v", err)
	}
}

// The update path, which the composite owner foreign key does not protect.
//
// Postgres skips the referential-integrity check on ON CONFLICT DO UPDATE
// when no referencing column changes, and the upsert rewrites only payload
// columns. So once a detail row exists, the FK stops being a boundary and
// the `WHERE bjj_session_details.user_id` predicate is the whole guard.
//
// The attacker sends NO tags on purpose: a tag insert would hit the tag
// table's own owner FK and fail there, so a test written with tags passes
// whether or not the detail upsert is guarded at all. That masking is the
// reason this case was missing.
func TestExistingDetailCannotBeOverwrittenByAnotherUser(t *testing.T) {
	repo, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-bjj-upd", "user_bjj_owner_upd", "user_bjj_attacker_upd"
	seedSession(t, pool, id, owner)

	if _, err := repo.PutDetail(ctx, owner, SessionDetail{
		SessionID: id, Kind: KindRolling, Note: "mine",
	}); err != nil {
		t.Fatalf("owner put: %v", err)
	}

	_, err := repo.PutDetail(ctx, attacker, SessionDetail{
		SessionID: id, Kind: KindClass, Note: "PWNED",
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("attacker overwrote an existing detail row: err = %v", err)
	}

	got, err := repo.GetDetail(ctx, owner, id)
	if err != nil {
		t.Fatalf("owner get: %v", err)
	}
	if got.Note != "mine" || got.Kind != KindRolling {
		t.Fatalf("owner's reflection was modified: note=%q kind=%q", got.Note, got.Kind)
	}
}

// A BJJ reflection must not attach to a session of another sport. Nothing in
// the schema prevents it — the owner FK only checks (id, user_id) — so this
// covers the explicit sport read in PutDetail. Without it a strength session
// silently grows a tag stream that every deferred BJJ feature would read as
// mat evidence.
func TestDetailCannotAttachToAnotherSportsSession(t *testing.T) {
	repo, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bjj-sport", "user_bjj_sport"
	seedSessionSport(t, pool, id, user, "strength")

	if _, err := repo.PutDetail(ctx, user, SessionDetail{
		SessionID: id, Kind: KindRolling,
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attached a BJJ reflection to a strength session: err = %v", err)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM bjj_session_details WHERE session_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d detail rows written against a strength session", n)
	}
}

// The upsert's WHERE predicate, exercised directly against the database.
//
// This one is deliberately not routed through PutDetail. The ownership SELECT
// added above returns ErrNotFound before the upsert is ever reached, so no
// call through the repository can reach the predicate — which means no
// repository-level test can tell whether it is still there. Review found
// exactly that: the whole suite stayed green with the line deleted.
//
// Two independent guards is the right number here, but a guard nothing
// exercises is a guard that gets deleted as dead weight in six months. So
// this issues the same statement the repository issues, as an attacker,
// and asserts the database refuses it on its own.
func TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel(t *testing.T) {
	_, pool := newSessionTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-bjj-sql", "user_bjj_sql_owner", "user_bjj_sql_attacker"
	seedSession(t, pool, id, owner)

	if _, err := pool.Exec(ctx, `
		INSERT INTO bjj_session_details (session_id, user_id, kind, note)
		VALUES ($1, $2, 'rolling', 'mine')`, id, owner); err != nil {
		t.Fatalf("seed detail: %v", err)
	}

	// The statement from PutDetail, minus the Go-level guards. Note the
	// attacker's user_id is NOT in the SET list — that is what stops the
	// foreign key from re-checking, and why this predicate has to exist.
	tag, err := pool.Exec(ctx, `
		INSERT INTO bjj_session_details (session_id, user_id, kind, note)
		VALUES ($1, $2, 'class', 'PWNED')
		ON CONFLICT (session_id) DO UPDATE SET
			kind = excluded.kind,
			note = excluded.note
		WHERE bjj_session_details.user_id = $2`, id, attacker)
	if err != nil {
		t.Fatalf("upsert errored rather than matching no rows: %v", err)
	}
	if n := tag.RowsAffected(); n != 0 {
		t.Fatalf("cross-user upsert touched %d row(s); the WHERE predicate is gone", n)
	}

	var note, kind string
	if err := pool.QueryRow(ctx,
		`SELECT note, kind FROM bjj_session_details WHERE session_id = $1`,
		id).Scan(&note, &kind); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if note != "mine" || kind != "rolling" {
		t.Fatalf("owner's row was modified: note=%q kind=%q", note, kind)
	}
}
