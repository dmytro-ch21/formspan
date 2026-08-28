package tracker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

const (
	userA = "tr_test_user_a"
	userB = "tr_test_user_b"
)

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
	// Registered FIRST so it runs LAST under LIFO — a defer here would close
	// the pool before the row cleanup below could use it.
	t.Cleanup(pool.Close)
	t.Cleanup(func() {
		ctx := context.Background()
		// FK order: entries reference trackers.
		// LIKE rather than a two-element list: the restore-path test gives every
		// subtest its own athlete (see there), so the set of user ids this
		// package writes is no longer enumerable. The prefix is test-only.
		_, _ = pool.Exec(ctx, `DELETE FROM tracker_entries WHERE user_id LIKE 'tr_test_user_%'`)
		_, _ = pool.Exec(ctx, `DELETE FROM daily_trackers WHERE user_id LIKE 'tr_test_user_%'`)
	})
	return NewPostgresRepository(pool), pool
}

func fixture() New {
	return New{
		ID:          "tr_fx_full",
		Name:        "Water",
		Icon:        "💧",
		ColorKey:    "water",
		Unit:        "ml",
		Increment:   250,
		Target:      ptr(2000.0),
		RenderStyle: RenderGlyphs,
		SortOrder:   10,
		// NON-EMPTY on purpose. Every field here has to differ from its zero
		// value or the restore-path test below cannot see it being blanked: if
		// the fixture's count_noun were "" and a patch on `name` wiped the
		// column, before and after would both be "" and the assertion would pass
		// on exactly the bug it exists to catch. That is the same shape as the
		// `exercise.updateWithin` blanking this whole module is built around.
		CountNoun: "cup",
	}
}

func mustCreate(t *testing.T, repo *PostgresRepository, userID string, in New) *Tracker {
	t.Helper()
	got, err := repo.Create(context.Background(), userID, in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return got
}

// ---------------------------------------------------------------------------
// The restore-path test. This is the reason the module exists in this shape.
//
// One subtest per patch field, enumerated by reflection so a field added later
// is covered without anybody remembering to add it. Each patches exactly one
// field and asserts every OTHER field came back unchanged.
//
// `exercise.updateWithin` blanked authored data three times (migrations 000052,
// 000057, 000061) and the suite never noticed, because there was no test that
// looked at the columns the write did not mean to touch. This looks at all of
// them, every time.
// ---------------------------------------------------------------------------

// oneOf returns a patch setting only the named field, to a value that differs
// from the fixture — a patch that writes the value already there would pass
// whether or not the column was in the statement.
func oneOf(t *testing.T, field string) Patch {
	t.Helper()
	var p Patch
	switch field {
	case "Name":
		p.Name = Of("Renamed")
	case "Icon":
		p.Icon = Of("🥤")
	case "ColorKey":
		p.ColorKey = Of("coffee")
	case "Unit":
		p.Unit = Of("cup")
	case "Increment":
		p.Increment = Of(500.0)
	case "Target":
		p.Target = Of(3000.0)
	case "RenderStyle":
		p.RenderStyle = Of(RenderBar)
	case "SortOrder":
		p.SortOrder = Of(99)
	case "CountNoun":
		// Differs from fixture()'s "cup", and is the word the whole column
		// exists for: no table over units could have produced it.
		p.CountNoun = Of("serving")
	case "CutoffMinutes":
		// fixture() leaves this unset (nil), so any value differs from it.
		p.CutoffMinutes = Of(960)
	default:
		// Reached the moment somebody adds a Patch field, which is exactly when
		// this test must be extended rather than silently skipping it.
		t.Fatalf("oneOf has no case for Patch.%s — add one, with a value that "+
			"differs from fixture(), or this field's restore path is untested", field)
	}
	return p
}

func TestUpdateLeavesUnmentionedFieldsAlone(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	pt := reflect.TypeOf(Patch{})
	for i := 0; i < pt.NumField(); i++ {
		field := pt.Field(i).Name
		t.Run(field, func(t *testing.T) {
			// **One athlete per subtest**, which is not tidiness: this test
			// creates one tracker per Patch field under a single account, and
			// N78's MaxLiveTrackers cap refuses the ninth. Sharing `userA` made
			// the whole test fail the moment the ninth patch field was added —
			// so the number of fields this module has would silently be bounded
			// by a product limit. Isolating the athlete keeps the two
			// independent, and it is better isolation regardless.
			user := userA + "_" + strings.ToLower(field)
			in := fixture()
			in.ID = "tr_fx_" + field
			before := mustCreate(t, repo, user, in)

			after, err := repo.Update(ctx, user, in.ID, oneOf(t, field))
			if err != nil {
				t.Fatalf("update %s: %v", field, err)
			}

			// The patched field must actually have moved — otherwise this test
			// passes by writing nothing, which is the apparatus failing rather
			// than the code being right.
			if sameField(t, before, after, field) {
				t.Fatalf("patching %s did not change it (still %v) — the column is "+
					"missing from the SET clause, or oneOf picked the existing value",
					field, fieldValue(t, after, field))
			}

			// And nothing else may have moved.
			for j := 0; j < pt.NumField(); j++ {
				other := pt.Field(j).Name
				if other == field {
					continue
				}
				if !sameField(t, before, after, other) {
					t.Errorf("patching %s also changed %s: %v -> %v.\n"+
						"An unmentioned field reached the SET clause. This is the "+
						"exercise.updateWithin bug, in a new module.",
						field, other, fieldValue(t, before, other), fieldValue(t, after, other))
				}
			}
			// The immutable columns too — a patch must not be able to move
			// ownership or reassign a preset.
			if after.UserID != before.UserID || after.Preset != before.Preset || after.ID != before.ID {
				t.Errorf("patching %s changed identity or ownership", field)
			}
			if !after.CreatedAt.Equal(before.CreatedAt) {
				t.Errorf("patching %s moved created_at", field)
			}
		})
	}
}

func fieldValue(t *testing.T, tr *Tracker, name string) any {
	t.Helper()
	v := reflect.ValueOf(*tr).FieldByName(name)
	if !v.IsValid() {
		t.Fatalf("Tracker has no field %s", name)
	}
	if v.Kind() == reflect.Ptr {
		if v.IsNil() {
			return nil
		}
		return v.Elem().Interface()
	}
	return v.Interface()
}

func sameField(t *testing.T, a, b *Tracker, name string) bool {
	t.Helper()
	return reflect.DeepEqual(fieldValue(t, a, name), fieldValue(t, b, name))
}

// Clearing a target is a real edit, and it is the one an athlete makes when
// they want a count rather than a goal (N77). It must be expressible, and it
// must not look like "leave it alone".
func TestUpdateCanClearTheTargetAndCanLeaveItAlone(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_fx_target_null"
	mustCreate(t, repo, userA, in)

	cleared, err := repo.Update(ctx, userA, in.ID, Patch{Target: Null[float64]()})
	if err != nil {
		t.Fatalf("clear target: %v", err)
	}
	if cleared.Target != nil {
		t.Fatalf("an explicit null did not clear the target: %v", *cleared.Target)
	}

	// And a later patch that does not mention target must not reinstate one.
	renamed, err := repo.Update(ctx, userA, in.ID, Patch{Name: Of("Coffee")})
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.Target != nil {
		t.Fatalf("a rename resurrected the target: %v", *renamed.Target)
	}
	if renamed.Name != "Coffee" {
		t.Fatalf("rename did not apply: %q", renamed.Name)
	}
}

func TestUpdateRefusesAPatchThatNamesNothing(t *testing.T) {
	repo, _ := newTestRepo(t)
	in := fixture()
	in.ID = "tr_fx_empty_patch"
	mustCreate(t, repo, userA, in)
	if _, err := repo.Update(context.Background(), userA, in.ID, Patch{}); err == nil {
		t.Fatal("an empty patch was accepted — it would issue an UPDATE with no SET")
	}
}

// ---------------------------------------------------------------------------
// Ownership. Ids are client-generated, so every one of these is an IDOR if the
// user_id predicate is dropped.
// ---------------------------------------------------------------------------

func TestAnotherAthletesTrackerIsInvisible(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_fx_owned_by_a"
	mustCreate(t, repo, userA, in)

	if _, err := repo.Update(ctx, userB, in.ID, Patch{Name: Of("Stolen")}); err != ErrNotFound {
		t.Fatalf("userB updated userA's tracker: err = %v", err)
	}
	if err := repo.Archive(ctx, userB, in.ID); err != ErrNotFound {
		t.Fatalf("userB archived userA's tracker: err = %v", err)
	}
	list, err := repo.List(ctx, userB)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, tr := range list {
		if tr.ID == in.ID {
			t.Fatal("userA's tracker appeared in userB's list")
		}
	}
	// Creating with a taken id must report a conflict, never hand the row over.
	other := fixture()
	other.ID = in.ID
	got, err := repo.Create(ctx, userB, other)
	if err != ErrAlreadyExists {
		t.Fatalf("re-creating another athlete's id: got (%v, %v), want ErrAlreadyExists", got, err)
	}
}

func TestCreateIsIdempotentForTheOwner(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_fx_idempotent"
	first := mustCreate(t, repo, userA, in)

	// A retry after a lost response. Must return the original, not fail.
	second, err := repo.Create(ctx, userA, in)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if second.ID != first.ID || !second.CreatedAt.Equal(first.CreatedAt) {
		t.Fatal("a retried create did not return the original row")
	}
	list, _ := repo.List(ctx, userA)
	n := 0
	for _, tr := range list {
		if tr.ID == in.ID {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("got %d rows for one id, want 1", n)
	}
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

func TestEnsureDefaultsIsIdempotentAndSurvivesArchiving(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	defaults := DefaultsFor(userA)
	if len(defaults) == 0 {
		t.Fatal("no default presets — Today would be empty for every athlete")
	}
	for i := 0; i < 3; i++ {
		if err := repo.EnsureDefaults(ctx, userA, defaults); err != nil {
			t.Fatalf("provision pass %d: %v", i, err)
		}
	}
	list, err := repo.List(ctx, userA)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	water := 0
	for _, tr := range list {
		if tr.Preset == "water" {
			water++
		}
	}
	if water != 1 {
		t.Fatalf("three provisioning passes produced %d water trackers, want 1", water)
	}

	// An athlete who edits the target must keep that edit across the next
	// provisioning pass — otherwise every list call silently resets it.
	id := PresetID(userA, "water")
	if _, err := repo.Update(ctx, userA, id, Patch{Target: Of(3000.0)}); err != nil {
		t.Fatalf("edit target: %v", err)
	}
	if err := repo.EnsureDefaults(ctx, userA, defaults); err != nil {
		t.Fatalf("re-provision: %v", err)
	}
	after, err := repo.getOwned(ctx, userA, id)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if after.Target == nil || *after.Target != 3000 {
		t.Fatalf("provisioning overwrote an edited target: %v", after.Target)
	}

	// And archiving must stick: a tracker the athlete put away does not come
	// back on the next list.
	if err := repo.Archive(ctx, userA, id); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if err := repo.EnsureDefaults(ctx, userA, defaults); err != nil {
		t.Fatalf("provision after archive: %v", err)
	}
	list, _ = repo.List(ctx, userA)
	for _, tr := range list {
		if tr.ID == id {
			t.Fatal("an archived tracker was re-provisioned — the athlete cannot get rid of it")
		}
	}
}

// provisionPreset provisions ONE named preset through the real provisioning
// path, regardless of whether it is a default.
//
// Coffee ships `Default: false` — it is unreachable until N78 lands the create
// path — so `DefaultsFor` deliberately does not return it. Testing it through
// this helper rather than through `DefaultsFor` is the point: **the preset has
// to be exercised on the path it will actually take when N78 turns it on**, not
// on a shortcut that would stop resembling it. The only thing borrowed from
// provisioning is the derived id, which is what `DefaultsFor` itself does.
func provisionPreset(t *testing.T, repo *PostgresRepository, userID, key string) *Tracker {
	t.Helper()
	ctx := context.Background()
	var in New
	found := false
	for _, p := range Presets() {
		if p.Key == key {
			in, found = p.Fields, true
		}
	}
	if !found {
		t.Fatalf("no preset %q — this test is asserting against a preset that does not exist", key)
	}
	in.ID = PresetID(userID, key)
	if err := repo.EnsureDefaults(ctx, userID, []New{in}); err != nil {
		t.Fatalf("provision %q: %v", key, err)
	}
	list, err := repo.List(ctx, userID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for i := range list {
		if list[i].Preset == key {
			return &list[i]
		}
	}
	t.Fatalf("preset %q did not survive provisioning", key)
	return nil
}

// Coffee is NOT provisioned, and that is a decision rather than an oversight.
//
// Pinned by a test so flipping it goes red and the next session has to read the
// reasoning on `Preset.Default` before shipping the change. The argument for
// turning it on is good — an unreachable preset performs none of N77's own
// steps to test — and it is outweighed by there being **no way to remove the
// card**: archiving is unwired until N78, and coffee is not neutral to count at
// somebody who has given it up.
func TestCoffeeIsNotProvisionedWhileArchivingIsUnwired(t *testing.T) {
	for _, p := range Presets() {
		if p.Key == "coffee" && p.Default {
			t.Fatal("coffee is a default again — an athlete cannot remove it until N78 " +
				"wires archiving. See the note on Preset.Default before changing this.")
		}
	}
	// The apparatus: a loop over an empty or renamed set would pass in silence.
	if len(Presets()) < 2 {
		t.Fatalf("%d preset(s) — this test cannot distinguish anything", len(Presets()))
	}
}

// N77's whole backend surface, end to end: coffee provisions as a count with no
// ceiling, and the nil target survives the round trip.
//
// **A `nil` in the preset literal is not the claim.** The claim is that NULL
// comes back out of Postgres as a nil pointer and reaches the client as JSON
// `null` — because a zero read back as `0` would render "0 of 0 cups" at an
// athlete who asked for no ceiling, which is what a nullable column exists to
// prevent. The whole path is checked here rather than the literal, since the
// literal is the one part that cannot be wrong in an interesting way.
func TestCoffeeProvisionsAsACountWithNoCeiling(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	coffee := provisionPreset(t, repo, userA, "coffee")
	if coffee.Target != nil {
		t.Fatalf("coffee provisioned with target %v, want nil — a ceiling is the "+
			"athlete's to set, and 'more is better' is the wrong reading of a coffee count",
			*coffee.Target)
	}
	// And it reaches the CLIENT as null, which is the half the pointer check
	// above does not cover. Asserted rather than asserted-in-a-comment: the
	// claim recorded next to a test should be the claim the test measures.
	wire, err := json.Marshal(coffee)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(wire), `"target":null`) {
		t.Fatalf("coffee serialises without a null target — the client would read a "+
			"missing ceiling as zero and render \"0 of 0 cups\".\n  %s", wire)
	}
	if coffee.ID != PresetID(userA, "coffee") {
		t.Fatalf("coffee id %q is not derived — two devices would each believe a "+
			"different id is the coffee tracker", coffee.ID)
	}
	if coffee.Unit != "cup" || coffee.Increment != 1 {
		t.Fatalf("coffee counts in %q at %v a tap, want one cup", coffee.Unit, coffee.Increment)
	}
	// `auto`, not `glyphs`: with no target the row is sized by what was logged,
	// so a fifteen-cup day has to be free to become a bar rather than an
	// uncountable row of fifteen identical glyphs.
	if coffee.RenderStyle != RenderAuto {
		t.Fatalf("coffee render_style = %q, want %q", coffee.RenderStyle, RenderAuto)
	}

	// And the athlete can set a ceiling and take it away again — the three-state
	// patch field, exercised on the row this ticket ships rather than in the
	// abstract. `Null` and "absent" are different wire shapes and only one of
	// them clears a target.
	if _, err := repo.Update(ctx, userA, coffee.ID, Patch{Target: Of(3.0)}); err != nil {
		t.Fatalf("set a ceiling: %v", err)
	}
	withCeiling, err := repo.getOwned(ctx, userA, coffee.ID)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if withCeiling.Target == nil || *withCeiling.Target != 3 {
		t.Fatalf("ceiling did not stick: %v", withCeiling.Target)
	}
	// An unrelated patch must not disturb it — the partial-write guarantee.
	if _, err := repo.Update(ctx, userA, coffee.ID, Patch{SortOrder: Of(25)}); err != nil {
		t.Fatalf("unrelated patch: %v", err)
	}
	stillThere, _ := repo.getOwned(ctx, userA, coffee.ID)
	if stillThere.Target == nil || *stillThere.Target != 3 {
		t.Fatalf("a patch that never mentioned target changed it to %v", stillThere.Target)
	}
	if _, err := repo.Update(ctx, userA, coffee.ID, Patch{Target: Null[float64]()}); err != nil {
		t.Fatalf("clear the ceiling: %v", err)
	}
	cleared, _ := repo.getOwned(ctx, userA, coffee.ID)
	if cleared.Target != nil {
		t.Fatalf("clearing the ceiling left %v — an athlete who removes a limit "+
			"must not keep being shown one", *cleared.Target)
	}
}

// EVERY preset provisions exactly once and coexists with the others — a sweep
// over all of them, not just the defaults.
//
// **All of them, deliberately.** The interesting property is several presets
// living side by side under one athlete: the `(user_id, preset)` partial unique
// index has to hold them apart, and each has to survive a repeat pass. Scoping
// this to defaults would make it a one-row test today and would silently stop
// covering coffee the moment it left the default set — which is exactly what
// just happened.
func TestEveryPresetProvisionsExactlyOnceAndCoexists(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	all := Presets()
	if len(all) < 2 {
		// The apparatus: with one preset this test would pass without ever
		// exercising the thing it is about, which is several coexisting.
		t.Fatalf("%d preset(s) — this test cannot observe coexistence", len(all))
	}
	// Twice, to prove the repeat pass is a no-op rather than a second row.
	for pass := 0; pass < 2; pass++ {
		for _, p := range all {
			in := p.Fields
			in.ID = PresetID(userA, p.Key)
			if err := repo.EnsureDefaults(ctx, userA, []New{in}); err != nil {
				t.Fatalf("provision %q pass %d: %v", p.Key, pass, err)
			}
		}
	}
	list, err := repo.List(ctx, userA)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	seen := map[string]int{}
	for _, tr := range list {
		if tr.Preset != "" {
			seen[tr.Preset]++
		}
	}
	for _, p := range all {
		if seen[p.Key] != 1 {
			t.Fatalf("preset %q provisioned %d times, want exactly 1", p.Key, seen[p.Key])
		}
	}
	if len(seen) != len(all) {
		t.Fatalf("%d distinct presets on the athlete, want %d — two presets collided "+
			"on one row", len(seen), len(all))
	}
}

func TestArchiveKeepsTheHistory(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_fx_archive_history"
	mustCreate(t, repo, userA, in)
	if _, err := repo.LogEntry(ctx, userA, in.ID, NewEntry{
		ID: "tr_e_hist", LoggedOn: "2026-08-20", LoggedAt: time.Now().UTC(), Amount: 250,
	}); err != nil {
		t.Fatalf("log: %v", err)
	}
	if err := repo.Archive(ctx, userA, in.ID); err != nil {
		t.Fatalf("archive: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM tracker_entries WHERE tracker_id = $1`, in.ID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("archiving destroyed %d entries — archive must not delete", 1-n)
	}
	// Twice is not an error.
	if err := repo.Archive(ctx, userA, in.ID); err != nil {
		t.Fatalf("second archive: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

func TestLogEntryIsIdempotentAndDayIsWhatTheClientSaid(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_fx_entries"
	mustCreate(t, repo, userA, in)

	// 23:58 local on the 20th, west of Greenwich, is 06:58 UTC on the 21st.
	// The day the athlete means is the one they sent, and deriving it from the
	// timestamp server-side would file this glass of water under tomorrow.
	loggedAt := time.Date(2026, 8, 21, 6, 58, 0, 0, time.UTC)
	tap := NewEntry{ID: "tr_e_midnight", LoggedOn: "2026-08-20", LoggedAt: loggedAt, Amount: 250}

	first, err := repo.LogEntry(ctx, userA, in.ID, tap)
	if err != nil {
		t.Fatalf("log: %v", err)
	}
	if first.LoggedOn != "2026-08-20" {
		t.Fatalf("logged_on = %q, want the day the client said (2026-08-20). "+
			"A UTC-derived day puts a 23:58 glass on tomorrow.", first.LoggedOn)
	}

	second, err := repo.LogEntry(ctx, userA, in.ID, tap)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !second.CreatedAt.Equal(first.CreatedAt) {
		t.Fatal("a retried tap created a second row — the cup would count twice")
	}
	entries, err := repo.Entries(ctx, userA, "2026-08-20", "2026-08-20")
	if err != nil {
		t.Fatalf("entries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries after two identical taps, want 1", len(entries))
	}

	// The next day starts empty.
	next, err := repo.Entries(ctx, userA, "2026-08-21", "2026-08-21")
	if err != nil {
		t.Fatalf("entries: %v", err)
	}
	if len(next) != 0 {
		t.Fatalf("the following day already has %d entries", len(next))
	}
}

func TestCrossingTheTargetIsNotAnEndState(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture() // target 2000 ml, increment 250 => eight cups
	in.ID = "tr_fx_over"
	mustCreate(t, repo, userA, in)

	for i := 0; i < 10; i++ {
		_, err := repo.LogEntry(ctx, userA, in.ID, NewEntry{
			ID:       "tr_e_over_" + string(rune('a'+i)),
			LoggedOn: "2026-08-20",
			LoggedAt: time.Date(2026, 8, 20, 8+i, 0, 0, 0, time.UTC),
			Amount:   250,
		})
		if err != nil {
			t.Fatalf("cup %d of 10 was refused: %v — the server must not cap a log at the target", i+1, err)
		}
	}
	entries, _ := repo.Entries(ctx, userA, "2026-08-20", "2026-08-20")
	if len(entries) != 10 {
		t.Fatalf("got %d of 10 cups stored", len(entries))
	}
}

func TestEntriesAndDeletesAreOwnerScoped(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_fx_owned_entries"
	mustCreate(t, repo, userA, in)
	if _, err := repo.LogEntry(ctx, userA, in.ID, NewEntry{
		ID: "tr_e_owned", LoggedOn: "2026-08-20", LoggedAt: time.Now().UTC(), Amount: 250,
	}); err != nil {
		t.Fatalf("log: %v", err)
	}

	// userB cannot log against userA's tracker even knowing its id.
	if _, err := repo.LogEntry(ctx, userB, in.ID, NewEntry{
		ID: "tr_e_intruder", LoggedOn: "2026-08-20", LoggedAt: time.Now().UTC(), Amount: 250,
	}); err != ErrNotFound {
		t.Fatalf("userB logged against userA's tracker: %v", err)
	}
	// Nor delete userA's entry.
	if err := repo.DeleteEntry(ctx, userB, in.ID, "tr_e_owned"); err != nil {
		t.Fatalf("delete should be silent, got %v", err)
	}
	entries, _ := repo.Entries(ctx, userA, "2026-08-20", "2026-08-20")
	if len(entries) != 1 {
		t.Fatalf("userB's delete removed userA's entry (%d left)", len(entries))
	}
	// And userB sees nothing.
	theirs, _ := repo.Entries(ctx, userB, "2026-08-20", "2026-08-20")
	if len(theirs) != 0 {
		t.Fatalf("userB can read %d of userA's entries", len(theirs))
	}
}

func TestDeleteEntryIsIdempotent(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_fx_delete"
	mustCreate(t, repo, userA, in)
	if _, err := repo.LogEntry(ctx, userA, in.ID, NewEntry{
		ID: "tr_e_del", LoggedOn: "2026-08-20", LoggedAt: time.Now().UTC(), Amount: 250,
	}); err != nil {
		t.Fatalf("log: %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := repo.DeleteEntry(ctx, userA, in.ID, "tr_e_del"); err != nil {
			t.Fatalf("delete pass %d: %v — a retried correction must not fail", i, err)
		}
	}
	entries, _ := repo.Entries(ctx, userA, "2026-08-20", "2026-08-20")
	if len(entries) != 0 {
		t.Fatalf("%d entries survived the delete", len(entries))
	}
}

func TestPresetsAreValid(t *testing.T) {
	if err := validatePresets(); err != nil {
		t.Fatal(err)
	}
}

func TestPresetIDIsStableAndPerAthlete(t *testing.T) {
	a := PresetID(userA, "water")
	if a != PresetID(userA, "water") {
		t.Fatal("PresetID is not deterministic — two devices would provision two water cards")
	}
	if a == PresetID(userB, "water") {
		t.Fatal("two athletes share a preset id")
	}
	if a == PresetID(userA, "coffee") {
		t.Fatal("two presets share an id for one athlete")
	}
}

// ---------------------------------------------------------------------------
// The derived preset id is COMPUTABLE by anybody who knows the athlete's Clerk
// user id, which is not a secret. So it is a namespace somebody can squat, and
// the consequence was severe: a row planted on another athlete's derived water
// id collides on the PRIMARY KEY, which the `(user_id, preset)` arbiter does
// not cover — so provisioning raised 23505, `List` returned 409, and there is
// no delete path to ever free the id. Every subsequent GET /v1/trackers, for
// the life of the account.
//
// Found by review, not by this suite. Two independent guards, because either
// alone leaves a hole: the create path refuses the namespace, and provisioning
// tolerates a taken id rather than failing the whole list.
// ---------------------------------------------------------------------------

func TestClientsCannotClaimTheDerivedPresetNamespace(t *testing.T) {
	repo, _ := newTestRepo(t)

	in := fixture()
	in.ID = PresetID(userA, "water") // userB, having computed userA's id
	_, err := repo.Create(context.Background(), userB, in)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("creating a tracker on a derived preset id: got %v, want ErrInvalidInput.\n"+
			"The `t_` namespace is ours to assign; a client that can claim one can "+
			"permanently brick another athlete's tracker list.", err)
	}

	// And an ordinary id is still fine — otherwise this guard could pass by
	// refusing everything, which would break N78 before it starts.
	ok := fixture()
	ok.ID = "9f1c2b3d-4e5f-6071-8293-a4b5c6d7e8f9"
	if _, err := repo.Create(context.Background(), userB, ok); err != nil {
		t.Fatalf("an ordinary client id was refused: %v", err)
	}
}

func TestProvisioningSurvivesASquattedID(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	// Planted directly, so this holds even if the guard above is ever weakened
	// or bypassed by a path that does not go through Create.
	squatted := PresetID(userA, "water")
	if _, err := pool.Exec(ctx, `
		INSERT INTO daily_trackers (id, user_id, preset, name, color_key, increment)
		VALUES ($1, $2, '', 'Squatter', 'water', 1)`, squatted, userB); err != nil {
		t.Fatalf("plant: %v", err)
	}

	// The whole point: userA's list must still WORK. They lose the water card,
	// because the id is taken and nothing can free it — but a Today missing one
	// card is recoverable and a permanent 409 is not.
	if err := repo.EnsureDefaults(ctx, userA, DefaultsFor(userA)); err != nil {
		t.Fatalf("provisioning failed because another athlete holds the id: %v.\n"+
			"That is a permanent 409 on every GET /v1/trackers for this athlete.", err)
	}
	if _, err := repo.List(ctx, userA); err != nil {
		t.Fatalf("list: %v", err)
	}
}
