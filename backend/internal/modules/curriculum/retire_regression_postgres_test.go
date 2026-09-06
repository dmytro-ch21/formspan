package curriculum

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
)

// F23/#523: retiring a technique from the library was silently voiding every
// athlete's evidence for it and dropping it from every roadmap, with no error
// anywhere. This file is the regression coverage — see docs/decisions/
// history.md for the full trace and migration 000095 for the schema fix.
//
// It lives in `curriculum`, not `technique`, because the bug is cross-module
// by nature (a technique referenced from BOTH curriculum_items and
// bjj_session_tags) and `curriculum` already imports `technique`; the reverse
// import does not exist and must not be introduced just for this test.

// TestDeletingAReferencedTechniqueIsNowRefused is the literal, mutation-
// testable half of this ticket's acceptance criteria: "the two foreign keys
// stop disagreeing" and "must fail against main today".
//
// Deliberately uses NOTHING from this PR's Go changes — no technique.Status*
// constant, no Retire/Reactivate method. Every symbol here (seedTechnique,
// logEvidence, the raw INSERT/DELETE) already exists on `main`, so this test
// compiles and runs against `main` unmodified — and there it FAILS, not with
// a build error, on the exact line that expects the DELETE to be refused:
// against main's schema (bjj_session_tags.technique_id ON DELETE SET NULL,
// curriculum_items.technique_id ON DELETE CASCADE) the DELETE below SUCCEEDS,
// silently nulling the tag and cascading away the item — which is the bug.
//
// MUTATION CHECK (performed by hand, per CLAUDE.md's "verify a check can
// fail" — recorded in the PR description / history entry rather than
// automated, since it means literally reverting a migration): revert
// 000095's two `ALTER TABLE ... ADD CONSTRAINT ... ON DELETE RESTRICT`
// statements back to their original SET NULL / CASCADE and re-run this test
// against a database migrated with that reverted file. `pool.Exec` at step 3
// then returns nil instead of a foreign-key-violation error, `wantErr` below
// goes unmet, and the test fails — red, on the same assertion, for the same
// reason main fails it.
func TestDeletingAReferencedTechniqueIsNowRefused(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	const (
		techID = "test-f23-delete-refused"
		userID = "test-f23-delete-refused-user"
	)
	seedTechnique(t, pool, techID) // published by the column default, like every seeded row
	cleanupUser(t, pool, userID)

	targetScored := 1
	curr, err := NewPostgresRepository(pool).Create(ctx, userID, "UTC", NewCurriculum{
		Name:       "F23 Regression Roadmap",
		Visibility: "private",
		Items: []NewItem{{
			TechniqueID: techID,
			Criteria:    &Criteria{TargetScored: &targetScored},
		}},
	})
	if err != nil {
		t.Fatalf("create curriculum: %v", err)
	}

	// The athlete's evidence: a real session, a real tag, both real rows in
	// the tables the bug silently corrupts.
	logEvidence(t, pool, userID, techID, 0, map[string]int{"scored": 1})

	// THE ASSERTION. A technique referenced by a curriculum item and a session
	// tag must refuse a hard DELETE outright — no SET NULL, no CASCADE, just a
	// foreign-key violation the operator has to act on. This is what "the two
	// foreign keys stop disagreeing" means in practice: both now say RESTRICT.
	_, delErr := pool.Exec(ctx, `DELETE FROM techniques WHERE id = $1`, techID)
	var pgErr *pgconn.PgError
	if delErr == nil {
		t.Fatal("DELETE FROM techniques succeeded for a technique with real " +
			"references — this is the F23/#523 bug: the delete should have " +
			"been refused, and instead it silently orphaned an athlete's " +
			"evidence and/or dropped a roadmap item")
	}
	if !errors.As(delErr, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("delete error = %v, want a 23503 foreign_key_violation", delErr)
	}

	// Nothing moved. The failed statement changed no rows — verified rather
	// than assumed, because "the delete errored" and "nothing was corrupted
	// on the way to erroring" are different claims.
	var techniqueIDBack *string
	if err := pool.QueryRow(ctx, `
		SELECT technique_id FROM bjj_session_tags
		WHERE user_id = $1 AND technique_id = $2`, userID, techID).Scan(&techniqueIDBack); err != nil {
		t.Fatalf("re-read session tag: %v", err)
	}
	if techniqueIDBack == nil || *techniqueIDBack != techID {
		t.Error("the athlete's session tag no longer names the technique — " +
			"evidence was decoupled even though the delete was refused")
	}
	var itemCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM curriculum_items
		WHERE curriculum_id = $1 AND technique_id = $2`, curr.ID, techID).Scan(&itemCount); err != nil {
		t.Fatalf("re-read curriculum item: %v", err)
	}
	if itemCount != 1 {
		t.Errorf("curriculum item count = %d, want 1 — the roadmap item vanished "+
			"even though the delete was refused", itemCount)
	}
}

// TestRetiringATechniqueThroughTheAdminConsolePreservesEvidenceAndRoadmap is
// the AC bullet "the admin /content retire path is covered" — an HTTP-
// handler-level exercise of the actual trigger the ticket names, not a bare
// repository call. It follows the ticket's own "Steps to test" verbatim:
// seed a technique, enrol in a curriculum that references it, log a session
// tagging it, confirm the roadmap counts it, retire it through /content, then
// read the roadmap and the session back.
func TestRetiringATechniqueThroughTheAdminConsolePreservesEvidenceAndRoadmap(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	const (
		techID = "test-f23-retire-roundtrip"
		userID = "test-f23-retire-roundtrip-user"
	)
	seedTechnique(t, pool, techID)
	cleanupUser(t, pool, userID)

	curriculumRepo := NewPostgresRepository(pool)
	targetScored := 1
	curr, err := curriculumRepo.Create(ctx, userID, "UTC", NewCurriculum{
		Name:       "F23 Retire Roundtrip",
		Visibility: "private",
		Items: []NewItem{{
			TechniqueID: techID,
			Criteria:    &Criteria{TargetScored: &targetScored},
		}},
	})
	if err != nil {
		t.Fatalf("create curriculum: %v", err)
	}
	if err := curriculumRepo.Enroll(ctx, userID, curr.ID, "UTC"); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	// Since enrolling started "now", the evidence must too — the mastery
	// window is measured from started_on, exactly like postgres_test.go's own
	// mastery tests.
	logEvidence(t, pool, userID, techID, 0, map[string]int{"scored": 1})

	// Step 2 of the ticket: confirm the roadmap counts it, BEFORE retiring.
	before, err := curriculumRepo.Get(ctx, userID, curr.ID, "UTC")
	if err != nil {
		t.Fatalf("get before retire: %v", err)
	}
	item := findItem(t, before, techID)
	if item.Progress == nil || !item.Progress.Mastered {
		t.Fatalf("before retiring: item progress = %+v, want mastered (1 of 1 scored)", item.Progress)
	}
	if item.Name == "" {
		t.Fatal("before retiring: item.Name is empty — the library join is not resolving")
	}

	// Step 3 of the ticket, THROUGH THE REAL ADMIN HANDLER — this is "the
	// admin console is the trigger" coverage, not a call to RetireTechnique
	// in isolation. No DELETE anywhere in this path.
	techniqueHandler := technique.NewContentHandler(technique.NewPostgresRepository(pool))
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/techniques/"+techID+"/retire", nil)
	req.SetPathValue("techniqueID", techID)
	rec := httptest.NewRecorder()
	techniqueHandler.Retire(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /admin/techniques/%s/retire = %d, want 200 (body: %s)", techID, rec.Code, rec.Body.String())
	}

	// Step 4 of the ticket: read the roadmap and the session back.
	after, err := curriculumRepo.Get(ctx, userID, curr.ID, "UTC")
	if err != nil {
		t.Fatalf("get after retire: %v", err)
	}
	afterItem := findItem(t, after, techID)
	if afterItem.Name == "" {
		t.Error("after retiring: the item's technique name is gone — the roadmap " +
			"can no longer say what to practise, exactly like a CASCADE delete would do")
	}
	if afterItem.Progress == nil || !afterItem.Progress.Mastered {
		t.Errorf("after retiring: item progress = %+v, want STILL mastered — "+
			"the athlete's evidence must not stop counting because the catalog "+
			"entry was retired", afterItem.Progress)
	}

	var techniqueIDBack *string
	if err := pool.QueryRow(ctx, `
		SELECT technique_id FROM bjj_session_tags
		WHERE user_id = $1 AND technique_id = $2`, userID, techID).Scan(&techniqueIDBack); err != nil {
		t.Fatalf("re-read session tag after retire: %v", err)
	}
	if techniqueIDBack == nil || *techniqueIDBack != techID {
		t.Error("after retiring: the session tag no longer names the technique — " +
			"evidence was silently decoupled")
	}

	// The retired technique must still resolve through the public detail
	// read — a curriculum item or a session tag may link to it, and 404ing it
	// would be the exact "history develops a hole" failure this ticket is
	// about, one screen further along.
	publicTechnique, err := technique.NewPostgresRepository(pool).Get(ctx, techID)
	if err != nil {
		t.Fatalf("public Get of a retired-but-referenced technique: %v", err)
	}
	if publicTechnique.Status != technique.StatusRetired {
		t.Errorf("public Get status = %q, want %q", publicTechnique.Status, technique.StatusRetired)
	}
}

func findItem(t *testing.T, c *Curriculum, techniqueID string) Item {
	t.Helper()
	for _, it := range c.Items {
		if it.TechniqueID == techniqueID {
			return it
		}
	}
	t.Fatalf("curriculum %s has no item for technique %s — it vanished", c.ID, techniqueID)
	return Item{}
}
