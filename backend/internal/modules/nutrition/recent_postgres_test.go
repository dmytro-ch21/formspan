package nutrition

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// N194 on a real database: the query's own scoping and bounds, and its index.

// ownEntry writes an entry for `user` through the real repository.
func ownEntry(t *testing.T, repo *PostgresRepository, id, user, on string, meal Meal, name string, kcal float64) {
	t.Helper()
	e := Entry{
		ID: id, UserID: user, EatenOn: on, Meal: meal, Name: name,
		Servings: 1, ServingLabel: "1 bowl",
		Macros: Macros{Kcal: kcal, ProteinG: 10, CarbG: 40, FatG: 8},
	}
	if _, err := repo.SaveEntry(ctx(), e); err != nil {
		t.Fatalf("save %s: %v", name, err)
	}
}

func dbRecentHandler(repo *PostgresRepository) *EstimateHandler {
	h := NewEstimateHandler(&fakeEstimator{out: goodEstimate()}, &memUsage{}, nil, repo)
	h.now = func() time.Time { return time.Date(2026, 9, 14, 15, 0, 0, 0, time.UTC) }
	return h
}

// THE AUTHORIZATION PROPERTY, end to end. Another athlete logged exactly what
// this one is pointing at; it must never come back — and, as a control, the
// same request from its owner does resolve it, so the empty answer is the
// scoping and not a lookup that never worked.
func TestARecentReferenceNeverResolvesToAnotherAthletesLog(t *testing.T) {
	repo := repoFor(t, uid, other)
	ownEntry(t, repo, "a1a1a1a1-0000-4000-8000-000000000001", other, "2026-09-13", MealBreakfast, "Zanzibar granola", 480)
	ownEntry(t, repo, "a1a1a1a1-0000-4000-8000-000000000002", uid, "2026-09-13", MealBreakfast, "Toast", 210)
	h := dbRecentHandler(repo)
	body := `{"description":"zanzibar granola again","today":"2026-09-14"}`

	w := callAs(t, h, uid, body)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if r := decodeEstimate(t, w.Body.Bytes()).Estimate.Recent; r == nil || len(r.Candidates) != 0 {
		t.Fatalf("another athlete's entry resolved for this one: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "Zanzibar") {
		t.Fatalf("another athlete's food name is in the response: %s", w.Body.String())
	}

	w = callAs(t, h, other, body)
	if r := decodeEstimate(t, w.Body.Bytes()).Estimate.Recent; r == nil || len(r.Candidates) != 1 {
		t.Fatalf("the control failed — the owner's own entry did not resolve, so the empty answer above proves nothing: %s", w.Body.String())
	}
}

// Decision 1, on the query that runs: today and the thirteen days before it,
// nothing older and nothing after.
func TestTheRecentWindowHoldsOnTheRealQuery(t *testing.T) {
	repo := repoFor(t, uid)
	for i, on := range []string{"2026-08-31", "2026-09-01", "2026-09-14", "2026-09-15"} {
		// Distinct calories, so no two rows are the same thing to offer.
		ownEntry(t, repo, "b2b2b2b2-0000-4000-8000-00000000000"+string(rune('1'+i)), uid, on, MealSnack, "Kefir", float64(100+i))
	}
	w := callAs(t, dbRecentHandler(repo), uid, `{"description":"kefir again","today":"2026-09-14"}`)
	r := decodeEstimate(t, w.Body.Bytes()).Estimate.Recent
	if r == nil {
		t.Fatalf("no resolution: %s", w.Body.String())
	}
	var got []string
	for _, c := range r.Candidates {
		got = append(got, c.EatenOn)
	}
	if want := []string{"2026-09-14", "2026-09-01"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("resolved %v, want %v — the window is fourteen days ending today", got, want)
	}
	if r.Window.From != "2026-09-01" || r.Window.To != "2026-09-14" {
		t.Fatalf("window %+v", r.Window)
	}
}

// The recent read is served by an index on (user_id, eaten_on) — the one
// migration 000059 created for exactly this shape of read, which is why N194
// needs no migration. Asserted on the Index Cond, for the reason N114's index
// test gives: an index leading on user_id can appear in a plan while the date
// range is re-checked row by row as a Filter.
func TestTheRecentReadUsesTheEntriesIndex(t *testing.T) {
	repo := repoFor(t, uid)
	ownEntry(t, repo, "c3c3c3c3-0000-4000-8000-000000000001", uid, "2026-09-13", MealLunch, "Soup", 300)

	tx, err := repo.pool.Begin(ctx())
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx()) }()
	if _, err := tx.Exec(ctx(), `SET LOCAL enable_seqscan = off`); err != nil {
		t.Fatalf("disable seqscan: %v", err)
	}
	var plan string
	if err := tx.QueryRow(ctx(), `EXPLAIN (FORMAT JSON) `+listEntriesSQL,
		uid, "2026-09-01", "2026-09-14", recentEntryLimit).Scan(&plan); err != nil {
		t.Fatalf("explain: %v", err)
	}
	if !strings.Contains(plan, "Node Type") {
		t.Fatalf("the plan carries no nodes, so this test measured nothing: %s", plan)
	}
	i := strings.Index(plan, `"Index Cond"`)
	if i < 0 {
		t.Fatalf("no Index Cond — the recent read is not using an index at all.\nplan: %s", plan)
	}
	cond := plan[i:]
	if j := strings.Index(cond, "\n"); j >= 0 {
		cond = cond[:j]
	}
	if !strings.Contains(cond, "user_id") || !strings.Contains(cond, "eaten_on") {
		t.Fatalf("the Index Cond does not carry both the athlete and the date range: %s\nplan: %s", cond, plan)
	}
}
