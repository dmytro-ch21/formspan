package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
)

// orderedCategories fixes the print/JSON order — highest product relevance
// first, matching DisagreementCategory's own doc comment on why
// AbstentionDivergence is checked (and therefore reported) first.
var orderedCategories = []session.DisagreementCategory{
	session.DisagreementAbstentionDivergence,
	session.DisagreementCodeDiffers,
	session.DisagreementTargetDiffers,
}

// report accumulates one shadowreplay run's counts and every disagreement
// found, grouped by category — the ticket's own "broken down usefully...
// not just one aggregate number" requirement for the summary.
type report struct {
	Total  int
	Agree  int
	Errors int

	byCategory map[session.DisagreementCategory][]session.Disagreement
}

func newReport() *report {
	return &report{byCategory: map[session.DisagreementCategory][]session.Disagreement{}}
}

func (r *report) record(d session.Disagreement) {
	r.byCategory[d.Category] = append(r.byCategory[d.Category], d)
}

func (r *report) disagreeCount() int {
	n := 0
	for _, ds := range r.byCategory {
		n += len(ds)
	}
	return n
}

// print writes the human-readable report a strength coach (or the operator
// deciding whether to widen the rollout) reads directly — the summary
// numbers first, then up to examplesPerCategory concrete disagreements per
// category, per #903's own "a few concrete examples" requirement.
func (r *report) print(w io.Writer, examplesPerCategory int, name func(string) string) {
	disagree := r.disagreeCount()
	fmt.Fprintln(w, "VOLA shadow replay: Progress (v1) vs ProgressV2 (v2)")
	fmt.Fprintln(w, "=====================================================")
	fmt.Fprintf(w, "athlete/exercise pairs compared: %d\n", r.Total)
	if r.Errors > 0 {
		fmt.Fprintf(w, "pairs skipped on a read error:   %d\n", r.Errors)
	}
	fmt.Fprintf(w, "agreed:                          %d\n", r.Agree)
	fmt.Fprintf(w, "disagreed:                       %d\n", disagree)
	if r.Total > 0 {
		fmt.Fprintf(w, "disagreement rate:               %.1f%%\n", 100*float64(disagree)/float64(r.Total))
	}
	fmt.Fprintln(w)

	fmt.Fprintln(w, "by disagreement type:")
	for _, cat := range orderedCategories {
		fmt.Fprintf(w, "  %-24s %d\n", cat, len(r.byCategory[cat]))
	}
	fmt.Fprintln(w)

	for _, cat := range orderedCategories {
		ds := r.byCategory[cat]
		if len(ds) == 0 {
			continue
		}
		shown := examplesPerCategory
		if shown > len(ds) {
			shown = len(ds)
		}
		fmt.Fprintf(w, "--- %s (%d total, showing %d) ---\n", cat, len(ds), shown)
		for _, d := range ds[:shown] {
			fmt.Fprintf(w, "  athlete %s, exercise %s (%s)\n", d.UserID, d.ExerciseID, name(d.ExerciseID))
			fmt.Fprintf(w, "    %s\n", d.Detail)
			fmt.Fprintf(w, "    v1: code=%-24s target=%-14s reason=%q\n",
				d.V1.Code, targetString(d.V1), d.V1.Reason)
			fmt.Fprintf(w, "    v2: code=%-24s target=%-14s reason=%q\n",
				d.V2.Code, targetString(d.V2), d.V2.Reason)
		}
		fmt.Fprintln(w)
	}
}

func targetString(o session.EngineOutcome) string {
	switch {
	case o.TargetWeightKg != nil && o.TargetReps != nil:
		return fmt.Sprintf("%.2fkg x %d", *o.TargetWeightKg, *o.TargetReps)
	case o.TargetWeightKg != nil:
		return fmt.Sprintf("%.2fkg", *o.TargetWeightKg)
	case o.TargetReps != nil:
		return fmt.Sprintf("%d reps", *o.TargetReps)
	default:
		return "none"
	}
}

// reportJSON is writeJSON's wire shape — flattened out of every category's
// bucket into one list, since the category is already a field on each
// Disagreement and a consumer (a spreadsheet import, a coach's own script)
// should not have to know this tool's internal grouping to read it.
type reportJSON struct {
	TotalPairs    int                    `json:"total_pairs"`
	Agree         int                    `json:"agree"`
	Errors        int                    `json:"errors"`
	Disagreements []session.Disagreement `json:"disagreements"`
}

func (r *report) writeJSON(path string) error {
	all := make([]session.Disagreement, 0, r.disagreeCount())
	for _, cat := range orderedCategories {
		all = append(all, r.byCategory[cat]...)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(reportJSON{
		TotalPairs: r.Total, Agree: r.Agree, Errors: r.Errors,
		Disagreements: all,
	})
}

// exerciseNamer looks up an exercise's catalog name lazily, once per id —
// the report needs a human-readable label per disagreement, but the
// candidate population can repeat the same exercise across many athletes,
// so a bare Get-per-disagreement would re-fetch the same handful of rows
// over and over. A failed or missing lookup reads as "(unknown)" rather
// than failing the whole report — a stale/deleted exercise id must not stop
// the tool from reporting the disagreement itself.
func exerciseNamer(ctx context.Context, repo *exercise.PostgresRepository) func(string) string {
	cache := map[string]string{}
	return func(id string) string {
		if name, ok := cache[id]; ok {
			return name
		}
		ex, err := repo.Get(ctx, id)
		name := "(unknown)"
		if err == nil && ex != nil {
			name = ex.Name
		}
		cache[id] = name
		return name
	}
}
