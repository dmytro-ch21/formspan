package session

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

// TestEveryRegistrySportCanBeWritten is the tripwire that was missing.
//
// The discipline registry claims adding a discipline needs no migration. That
// claim was FALSE until migration 000021: `sessions_sport_valid` and
// `workouts_sport_valid` pinned the vocabulary in SQL, so a fifth discipline
// would pass every Go validator and then fail every INSERT on a 23514 —
// surfacing as a misleading 400, with nothing in the suite to catch it. The
// registry's own tests never touch the database, which is exactly why they
// couldn't.
//
// This test closes both directions: a sport the registry knows must be
// writable, and it exercises the real INSERT path rather than asserting on
// constraint metadata, so it stays true if the schema is restructured.
func TestEveryRegistrySportCanBeWritten(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	sports := discipline.Sports()
	if len(sports) == 0 {
		t.Fatal("registry has no sports")
	}

	for _, m := range sports {
		t.Run(m.Key, func(t *testing.T) {
			id := "ses-registry-" + m.Key
			cleanup(t, pool, id)

			// Deliberately setless: this asserts the SPORT is writable, not
			// that the discipline has catalog content. BJJ has none since
			// migration 000019, and that must not make this fail.
			_, err := repo.Create(ctx, NewSession{
				ID:        id,
				UserID:    "user_registry_sports",
				Sport:     m.Key,
				Name:      "Registry check",
				StartedAt: time.Now().UTC(),
			})
			if err != nil {
				t.Fatalf("sport %q is in the registry but cannot be written: %v\n"+
					"A CHECK constraint or enum somewhere still pins the sport "+
					"vocabulary — the registry is not the single source of truth.", m.Key, err)
			}
			cleanup(t, pool, id)
		})
	}

	// The reverse: a sport the registry does NOT know must be refused by the
	// handler layer. Proven at the validator, since the database no longer
	// enforces it.
	for _, bogus := range []string{"cycling", "nutrition", ""} {
		if discipline.ValidSport(bogus) {
			t.Errorf("ValidSport(%q) = true; the handlers would accept a sport nothing renders", bogus)
		}
	}
	if !strings.Contains(discipline.SportList(), "strength") {
		t.Error("SportList() no longer names strength — the error message users see would be wrong")
	}
}
