package exercise

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// These are Postgres integration tests. They need TEST_DATABASE_URL to run
// (see docker-compose.yml for local dev, or backend/.env.example) and skip
// gracefully without it.

// Named fixtures rather than inline IDs: the catalog is generated from a
// spreadsheet now, so an exercise can be renamed by a content edit. One
// place to update beats hunting string literals through the file.
const (
	seedFixtureID  = "back-squat"
	mediaFixtureID = "bench-press"
)

func newTestRepo(t *testing.T) *PostgresRepository {
	t.Helper()

	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before any cleanup that still needs the pool open —
	// t.Cleanup runs LIFO, so this closes last.
	t.Cleanup(pool.Close)

	return NewPostgresRepository(pool)
}

// The seed content is the product here, so a malformed entry is a real
// defect. No database needed — this guards the JSON itself.
func TestSeedData_IsValid(t *testing.T) {
	exercises, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}
	if len(exercises) == 0 {
		t.Fatal("seed catalog is empty")
	}

	// Every load type a client can render should be exercised by the starter
	// set — otherwise the first exercise of a given type ships untested.
	seenLoadTypes := map[LoadType]bool{}
	for _, e := range exercises {
		seenLoadTypes[e.LoadType] = true
	}
	for _, lt := range []LoadType{
		LoadTypeWeightReps, LoadTypeReps, LoadTypeTime,
		LoadTypeDistance, LoadTypeDistanceTime,
	} {
		if !seenLoadTypes[lt] {
			t.Errorf("no seed exercise uses load_type %q", lt)
		}
	}
}

func TestValidate_RejectsBadContent(t *testing.T) {
	cases := []struct {
		name string
		in   []Exercise
	}{
		{"duplicate id", []Exercise{
			{ID: "a", Name: "A", Sport: "strength", MovementPattern: "squat", LoadType: LoadTypeReps},
			{ID: "a", Name: "B", Sport: "strength", MovementPattern: "hinge", LoadType: LoadTypeReps},
		}},
		{"unknown load type", []Exercise{
			{ID: "a", Name: "A", Sport: "strength", MovementPattern: "squat", LoadType: "sets_and_vibes"},
		}},
		{"missing movement pattern", []Exercise{
			{ID: "a", Name: "A", Sport: "strength", LoadType: LoadTypeReps},
		}},
		// The JSON is the authoring interface, so a typo has to fail loudly
		// here or it fails silently forever: "strenght" would seed a row no
		// ?sport=strength filter can ever return.
		{"misspelled sport", []Exercise{
			{ID: "a", Name: "A", Sport: "strenght", MovementPattern: "squat", LoadType: LoadTypeReps},
		}},
		// Worse than a bad sport: movement_pattern is what the cross-sport
		// rules reason over, so a typo breaks a future rule invisibly.
		{"unknown movement pattern", []Exercise{
			{ID: "a", Name: "A", Sport: "strength", MovementPattern: "squatting", LoadType: LoadTypeReps},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validate(tc.in); err == nil {
				t.Fatal("expected validation error, got nil")
			}
		})
	}
}

func TestPostgresRepository_SeedIsIdempotent(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	n1, err := Seed(ctx, repo)
	if err != nil {
		t.Fatalf("first seed: %v", err)
	}

	before, err := repo.Get(ctx, seedFixtureID)
	if err != nil {
		t.Fatalf("get after first seed: %v", err)
	}

	// Re-running the seed is a normal deploy step, so it must not duplicate
	// rows or reset timestamps.
	n2, err := Seed(ctx, repo)
	if err != nil {
		t.Fatalf("second seed: %v", err)
	}
	if n1 != n2 {
		t.Errorf("seed count changed between runs: %d then %d", n1, n2)
	}

	after, err := repo.Get(ctx, seedFixtureID)
	if err != nil {
		t.Fatalf("get after second seed: %v", err)
	}
	if !after.CreatedAt.Equal(before.CreatedAt) {
		t.Errorf("created_at changed on re-seed: %v then %v", before.CreatedAt, after.CreatedAt)
	}
	// Value-idempotent, not merely row-count idempotent: an unchanged row
	// must not be rewritten. Otherwise updated_at degrades into "time of
	// last deploy", and a client asking "what changed since X" gets the
	// whole catalog back every time the API is redeployed.
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Errorf("updated_at moved on a no-op re-seed: %v then %v", before.UpdatedAt, after.UpdatedAt)
	}

	// Count only the seeded IDs rather than the whole table, so this doesn't
	// break the first time another test inserts a non-catalog fixture — that
	// failure would read as a seeding bug rather than a test-isolation one.
	seeded, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}
	wanted := make(map[string]bool, len(seeded))
	for _, e := range seeded {
		wanted[e.ID] = true
	}

	all, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	found := map[string]int{}
	for _, e := range all {
		if wanted[e.ID] {
			found[e.ID]++
		}
	}
	if len(found) != n1 {
		t.Errorf("expected %d seeded exercises present, found %d", n1, len(found))
	}
	for id, count := range found {
		if count != 1 {
			t.Errorf("re-seeding duplicated %q: %d rows", id, count)
		}
	}
}

func TestPostgresRepository_ListFilters(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	if _, err := Seed(ctx, repo); err != nil {
		t.Fatalf("seed: %v", err)
	}

	bjj, err := repo.List(ctx, Filter{Sport: "bjj"})
	if err != nil {
		t.Fatalf("list by sport: %v", err)
	}
	if len(bjj) == 0 {
		t.Fatal("expected at least one bjj exercise")
	}
	for _, e := range bjj {
		if e.Sport != "bjj" {
			t.Errorf("sport filter leaked %q (%s)", e.Sport, e.ID)
		}
	}

	// Case-insensitive substring — a catalog search that only matched exact
	// case would be useless on a phone keyboard.
	found, err := repo.List(ctx, Filter{Query: "SQUAT"})
	if err != nil {
		t.Fatalf("list by query: %v", err)
	}
	if len(found) == 0 {
		t.Fatal(`expected "SQUAT" to match Barbell Back Squat case-insensitively`)
	}

	// LIKE metacharacters must be literal, not wildcards — an unescaped "%"
	// would turn a search box into a full-table scan.
	for _, meta := range []string{"%", "_", "\\"} {
		got, err := repo.List(ctx, Filter{Query: meta})
		if err != nil {
			t.Fatalf("list %q: %v", meta, err)
		}
		if len(got) != 0 {
			t.Errorf("%q was treated as a wildcard: matched %d rows, want 0", meta, len(got))
		}
	}

	none, err := repo.List(ctx, Filter{Query: "definitely-not-an-exercise"})
	if err != nil {
		t.Fatalf("list no match: %v", err)
	}
	if len(none) != 0 {
		t.Errorf("expected no matches, got %d", len(none))
	}
}

func TestPostgresRepository_GetNotFound(t *testing.T) {
	repo := newTestRepo(t)

	e, err := repo.Get(context.Background(), "no-such-exercise")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
	if e != nil {
		t.Errorf("expected nil exercise alongside error, got %+v", e)
	}
}

func TestPostgresRepository_Media(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	if _, err := Seed(ctx, repo); err != nil {
		t.Fatalf("seed: %v", err)
	}

	seeded, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}

	// Attach media to one exercise by re-running the writer with media on it,
	// rather than reaching past the repository into raw SQL — this exercises
	// the same path a real seed edit would take.
	width, height := 1200, 800
	withMedia := make([]Exercise, len(seeded))
	copy(withMedia, seeded)
	for i := range withMedia {
		withMedia[i].Media = nil
	}
	for i := range withMedia {
		if withMedia[i].ID != mediaFixtureID {
			continue
		}
		withMedia[i].Media = []Media{
			{Kind: MediaKindStart, StorageKey: "exercises/barbell-back-squat/start.webp",
				ContentType: "image/webp", Width: &width, Height: &height},
			{Kind: MediaKindEnd, StorageKey: "exercises/barbell-back-squat/end.webp",
				ContentType: "image/webp", Width: &width, Height: &height},
		}
	}
	if err := repo.UpsertAll(ctx, withMedia); err != nil {
		t.Fatalf("upsert with media: %v", err)
	}

	got, err := repo.Get(ctx, mediaFixtureID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.Media) != 2 {
		t.Fatalf("expected 2 media rows, got %d", len(got.Media))
	}
	// Semantic order, not alphabetical: "start" must precede "end", even
	// though 'e' < 's'.
	if got.Media[0].Kind != MediaKindStart || got.Media[1].Kind != MediaKindEnd {
		t.Errorf("media out of semantic order: got %q then %q", got.Media[0].Kind, got.Media[1].Kind)
	}
	if got.Media[0].StorageKey != "exercises/barbell-back-squat/start.webp" {
		t.Errorf("unexpected storage key %q", got.Media[0].StorageKey)
	}
	if got.Media[0].Width == nil || *got.Media[0].Width != 1200 {
		t.Error("intrinsic width did not round-trip; a client can't reserve layout space without it")
	}
	// The seam that cache busting hangs off, and the only place it can be
	// checked. `updated_at` is what the handler folds into the URL as `?v=`,
	// so if it stops being SELECTed here every Media comes back zero-valued,
	// the handler's zero-time branch quietly emits bare URLs, and a replaced
	// image never reaches a device that cached the old one. Nothing else
	// fails: it compiles, it returns 200, and the unit tests around
	// `mediaURL` all still pass because they construct their own timestamps.
	for _, m := range got.Media {
		if m.UpdatedAt.IsZero() {
			t.Errorf("media %q came back with no updated_at — its URL would carry no "+
				"?v=, so replacing the image could never reach a client", m.Kind)
		}
	}

	// A media change must mark the parent exercise stale. Without this a
	// client delta-syncing on exercises.updated_at would never learn that an
	// image was swapped, because the exercise row itself didn't change.
	afterMedia, err := repo.Get(ctx, mediaFixtureID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !afterMedia.UpdatedAt.After(afterMedia.CreatedAt) {
		t.Error("attaching media did not touch the parent exercise's updated_at")
	}

	// The JSON is authoritative for which assets exist, so removing media
	// from the source must remove the rows — otherwise a deleted image keeps
	// being served forever. Build the media-free variant explicitly rather
	// than assuming the seed has none: it does now, and an assumption like
	// that silently stops testing anything the moment content changes.
	stripped := make([]Exercise, len(seeded))
	copy(stripped, seeded)
	for i := range stripped {
		stripped[i].Media = nil
	}
	if err := repo.UpsertAll(ctx, stripped); err != nil {
		t.Fatalf("re-upsert without media: %v", err)
	}
	pruned, err := repo.Get(ctx, mediaFixtureID)
	if err != nil {
		t.Fatalf("get after prune: %v", err)
	}
	if len(pruned.Media) != 0 {
		t.Errorf("expected media pruned, still have %d", len(pruned.Media))
	}

	// Never null in JSON — a client shouldn't have to handle both [] and null
	// for "no media".
	if pruned.Media == nil {
		t.Error("Media should be an empty slice, not nil")
	}
}

func TestHandler_MediaURLAssembly(t *testing.T) {
	// Base URL joins cleanly regardless of trailing/leading slashes, and an
	// unset base leaves the URL empty rather than emitting a broken one.
	cases := []struct{ base, key, want string }{
		{"https://media.vola.app", "exercises/a/start.webp", "https://media.vola.app/exercises/a/start.webp"},
		{"https://media.vola.app/", "exercises/a/start.webp", "https://media.vola.app/exercises/a/start.webp"},
		{"https://media.vola.app", "/exercises/a/start.webp", "https://media.vola.app/exercises/a/start.webp"},
		{"", "exercises/a/start.webp", ""},
	}
	for _, tc := range cases {
		h := NewHandler(nil, tc.base)
		got := []Exercise{{Media: []Media{{StorageKey: tc.key}}}}
		h.withMediaURLs(got)
		if got[0].Media[0].URL != tc.want {
			t.Errorf("base %q + key %q = %q, want %q", tc.base, tc.key, got[0].Media[0].URL, tc.want)
		}
	}
}

// Every catalog entry should end up with something renderable: its own
// photos where they exist, the sport placeholder otherwise. The placeholder
// must stay *distinguishable* though — if it read as real content, the fact
// that most of the library has no photo of its own would be invisible, and
// an invisible gap is a permanent one.
func TestHandler_DefaultMediaFillsGapsButStaysLabelled(t *testing.T) {
	h := NewHandler(nil, "https://media.example")

	real := Media{Kind: MediaKindDemo, StorageKey: "exercises/back-squat/demo.webp"}
	got := []Exercise{
		{ID: "has-own", Sport: "strength", Media: []Media{real}},
		{ID: "no-media-strength", Sport: "strength", Media: []Media{}},
		{ID: "no-media-bjj", Sport: "bjj", Media: []Media{}},
		{ID: "no-media-unknown-sport", Sport: "swimming", Media: []Media{}},
	}
	h.withMediaURLs(got)

	if len(got[0].Media) != 1 || got[0].Media[0].IsDefault {
		t.Errorf("an exercise with its own media had it replaced: %+v", got[0].Media)
	}
	for _, i := range []int{1, 2} {
		if len(got[i].Media) == 0 {
			t.Fatalf("%s got no placeholder", got[i].ID)
		}
		for _, m := range got[i].Media {
			if !m.IsDefault {
				t.Errorf("%s: placeholder not marked is_default", got[i].ID)
			}
			if m.URL == "" {
				t.Errorf("%s: placeholder has no URL", got[i].ID)
			}
		}
	}
	// A sport with no placeholder must yield nothing, not a broken image.
	if len(got[3].Media) != 0 {
		t.Errorf("unknown sport got media from nowhere: %+v", got[3].Media)
	}

	// The shared map must not be mutated by URL assembly — otherwise the
	// second request would see keys already prefixed with the base URL.
	if defaultMedia["strength"][0].URL != "" {
		t.Errorf("URL assembly wrote through into the shared defaults: %q",
			defaultMedia["strength"][0].URL)
	}
}
