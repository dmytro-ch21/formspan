package plan

import (
	"context"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

// TestEveryRegistrySportCanBePlanned extends the tripwire that migration
// 000021 introduced for sessions and workouts.
//
// That migration dropped `sessions_sport_valid` and `workouts_sport_valid`
// because a CHECK listing the values IS the per-discipline migration cost the
// registry exists to remove — a fifth discipline would pass every Go validator
// and then fail every INSERT on a 23514, surfacing as a misleading 400.
//
// `plans` reintroduced exactly that constraint in its first draft, and the
// existing tripwire (`session/registry_sports_test.go`) could not catch it
// because it only writes sessions and workouts. It would have stayed green
// while every plan insert for a new discipline failed. So the tripwire needs
// to cover every table that stores a sport, and this is the plan half.
func TestEveryRegistrySportCanBePlanned(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "plan_registry_sports"
	cleanupPlans(t, pool, user)

	sports := discipline.Sports()
	if len(sports) == 0 {
		t.Fatal("registry has no sports")
	}

	for _, m := range sports {
		t.Run(m.Key, func(t *testing.T) {
			// No workout: this asserts the SPORT is plannable, not that the
			// discipline has templates. BJJ has no catalog content since
			// migration 000019, and that must not make this fail.
			_, err := repo.Create(ctx, user, NewPlan{
				ID:    "plan-registry-" + m.Key,
				Day:   "2026-08-04",
				Sport: m.Key,
			})
			if err != nil {
				t.Fatalf("sport %q is in the registry but cannot be planned: %v\n"+
					"A CHECK constraint or enum somewhere still pins the sport "+
					"vocabulary — the registry is not the single source of truth.", m.Key, err)
			}
		})
	}
}

// The reverse direction: a sport the registry does not know must be refused,
// and since the database no longer enforces it, the handler's validator is the
// only thing standing there.
func TestUnknownSportIsRefusedByTheValidator(t *testing.T) {
	if validSport("quidditch") {
		t.Error("validSport accepted a sport the registry does not know")
	}
	// And a module that is not a sport — nutrition can be enabled, but
	// "plan a nutrition session for Tuesday" has no session behind it.
	for _, m := range discipline.All() {
		if !m.IsSport && validSport(m.Key) {
			t.Errorf("validSport accepted %q, which is not a sport", m.Key)
		}
	}
	for _, m := range discipline.Sports() {
		if !validSport(m.Key) {
			t.Errorf("validSport refused %q, which the registry lists as a sport", m.Key)
		}
	}
}
