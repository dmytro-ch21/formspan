// Command shadowreplay is VOLA's offline, read-only validation tool for
// N515/#903 (part of #867, phase 5 of #753). #753's own validation plan
// names "historical shadow replay comparing v1 and v2" as a required step
// BEFORE any opt-in pilot: this runs Progress (v1, progression.go) and
// ProgressV2 (v2, progression_v2.go — the engine behind the
// `new_recommendation_engine` flag) side by side over the SAME real,
// finished historical session data, and reports where they disagree.
//
// # This never touches an athlete
//
// This is a one-off `go run`, exactly like cmd/seed and cmd/exportcontent —
// there is no new HTTP route, no change to any existing handler, and no
// wire-contract change. It reads through session.Repository's existing
// methods (ShadowReplayCandidates, RecentEfforts, RecentEffortsV2) and
// prints a report; it never calls RecordDecisions, never calls Finish or
// ReplaceSets, and never writes a row anywhere. v2's own output
// (ProgressV2's Plan) is visible only in THIS tool's own report — printed to
// stdout or a local JSON file the operator chose — never served to a client.
// See docs/decisions/history.md's N515 entry for the explicit confirmation
// and a real run's numbers against this environment's own dev Postgres.
//
// The actual "what counts as a disagreement" logic lives in
// internal/modules/session/shadowreplay.go (CompareEngines) — this file is
// the thin orchestrator: connect, enumerate candidates, batch the history
// reads per athlete (the same batching Handler.Suggestions already does,
// for the same reason — one request per exercise would be an N+1 against a
// database this tool has no special access to), and format the report.
//
// # Known scope limits — read before treating a number here as final
//
// Goal and UnitSystem are per-REQUEST client inputs in the real API
// (Handler.Suggestions reads them from query params), not stored history —
// there is nothing in session_sets or sessions to recover which goal or
// unit system a past request actually used. This tool therefore evaluates
// every candidate under the general goal (repRangeForGoal's default, when
// no goal string matches) and metric units, which is also exactly what an
// unmodified API client sees when it omits both query parameters. Similarly,
// v2's per-workout-item Protocol (N494/#864's four-level priority order) is
// left nil for every candidate: resolving it for real would require joining
// back to whichever workout/program item the historical session actually
// used, which is a bigger reconstruction than this ticket's own scope (a
// disagreement report, not a full historical protocol resolver). Both
// choices mean this replay evaluates the CORE engine difference the ticket
// exists to validate — coherent cohorts, straight-sets-only, finished-only
// history, required effort, effort-conflict detection, and default
// (non-configured) equipment rounding — and will under-report disagreements
// that stem purely from a per-item protocol override or a non-general goal.
// The written rollout plan (docs/decisions/history.md's N515 entry) reads
// this report as a floor, not a ceiling.
//
// USAGE
//
//	go run ./cmd/shadowreplay                       # human-readable report to stdout
//	go run ./cmd/shadowreplay -json report.json     # also write the full disagreement list as JSON
//	go run ./cmd/shadowreplay -limit 500            # cap candidates, for a quick smoke run
//	go run ./cmd/shadowreplay -examples 20          # more example disagreements per category
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

func main() {
	logger := httplog.For("shadowreplay")

	var (
		limit = flag.Int("limit", 0,
			"cap the number of (athlete, exercise) pairs replayed; 0 means no cap")
		examples = flag.Int("examples", 8,
			"how many example disagreements to print per category")
		jsonOut = flag.String("json", "",
			"optional path to write the full disagreement list as JSON")
	)
	flag.Parse()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		logger.Error("shadowreplay: DATABASE_URL must be set (see backend/.env.example)")
		os.Exit(1)
	}
	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		logger.Error("shadowreplay: database connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	repo := session.NewPostgresRepository(pool)
	exRepo := exercise.NewPostgresRepository(pool)

	rep, err := run(ctx, repo, *limit, logger)
	if err != nil {
		logger.Error("shadowreplay: run", "err", err)
		os.Exit(1)
	}

	rep.print(os.Stdout, *examples, exerciseNamer(ctx, exRepo))

	if *jsonOut != "" {
		if err := rep.writeJSON(*jsonOut); err != nil {
			logger.Error("shadowreplay: write json", "path", *jsonOut, "err", err)
			os.Exit(1)
		}
		logger.Info("shadowreplay: wrote full disagreement list", "path", *jsonOut)
	}
}

// run is the whole replay, factored out of main so it takes a
// session.Repository interface rather than a concrete *PostgresRepository —
// no test in this package needs it today (there is nothing to unit-test here
// beyond what shadowreplay_test.go already pins in the session package
// itself), but it is the natural seam if that ever changes, and it keeps
// main itself down to flag parsing and I/O.
func run(ctx context.Context, repo session.Repository, limit int, logger *slog.Logger) (*report, error) {
	candidates, err := repo.ShadowReplayCandidates(ctx)
	if err != nil {
		return nil, err
	}
	if limit > 0 && len(candidates) > limit {
		candidates = candidates[:limit]
	}
	logger.Info("shadowreplay: candidates", "count", len(candidates))

	// Grouped by athlete so each athlete's history is fetched in exactly two
	// queries (one RecentEfforts, one RecentEffortsV2) regardless of how many
	// exercises they trained — the same batching Handler.Suggestions already
	// relies on, for the same reason: one call per exercise would be an N+1
	// this tool has no special database access to absorb.
	byUser := map[string][]string{}
	// order preserves first-seen athlete order, purely so a run's console
	// output and log lines are stable across two runs against the same
	// database rather than shuffled by Go's map iteration.
	var order []string
	for _, c := range candidates {
		if _, ok := byUser[c.UserID]; !ok {
			order = append(order, c.UserID)
		}
		byUser[c.UserID] = append(byUser[c.UserID], c.ExerciseID)
	}

	now := time.Now().UTC()
	rep := newReport()

	for _, userID := range order {
		exerciseIDs := byUser[userID]

		v1Efforts, err := repo.RecentEfforts(ctx, userID, exerciseIDs)
		if err != nil {
			logger.Error("shadowreplay: recent efforts v1", "user", userID, "err", err)
			rep.Errors += len(exerciseIDs)
			continue
		}
		v2Efforts, err := repo.RecentEffortsV2(ctx, userID, exerciseIDs)
		if err != nil {
			logger.Error("shadowreplay: recent efforts v2", "user", userID, "err", err)
			rep.Errors += len(exerciseIDs)
			continue
		}

		for _, exerciseID := range exerciseIDs {
			rep.Total++
			v1In := v1Efforts[exerciseID]
			v2In := v2Efforts[exerciseID]
			if d, disagree := session.CompareEngines(userID, exerciseID, v1In, v2In, now); disagree {
				rep.record(d)
			} else {
				rep.Agree++
			}
		}
	}

	return rep, nil
}
