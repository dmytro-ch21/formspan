package exercise

import (
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

	"strings"
	"testing"
	"time"
)

// The property this whole mechanism exists for: replacing the bytes at a
// storage key must produce a different URL.
//
// Storage keys are stable by design — an exercise's thumbnail is
// `.../thumbnail.webp` for as long as the exercise exists — so without a
// version the URL is byte-identical before and after a swap, and every cache
// in the path is entitled to keep serving the old picture. Cloudflare's edge
// does, and `expo-image`'s disk cache on the phone never revalidates at all,
// so a device that loaded the old image keeps it until the app is deleted.
//
// A test rather than a comment because the failure is invisible: the code
// still compiles, the request still 200s, and the only symptom is a stale
// photograph on someone else's phone.
func TestMediaURLChangesWhenTheAssetDoes(t *testing.T) {
	const base = "https://cdn.example.com"
	const key = "exercises/barbell-back-squat/thumbnail.webp"

	before := time.Date(2026, 7, 29, 18, 14, 20, 0, time.UTC)
	after := before.Add(24 * time.Hour)

	if got, want := mediaURL(base, key, before), mediaURL(base, key, after); got == want {
		t.Fatalf("same URL for two different updated_at values (%q) — cache busting is a no-op", got)
	}

	// And the converse, which is equally load-bearing: an unchanged asset must
	// keep an identical URL, or every read would miss every cache and the CDN
	// would be pointless.
	if a, b := mediaURL(base, key, before), mediaURL(base, key, before); a != b {
		t.Errorf("unchanged asset produced two URLs: %q vs %q", a, b)
	}
}

func TestMediaURLShape(t *testing.T) {
	const base = "https://cdn.example.com"
	at := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	stamp := "?v=" + "1785499200" // at.Unix()

	cases := []struct {
		name string
		key  string
		at   time.Time
		want string
	}{
		{
			name: "versioned by unix seconds",
			key:  "exercises/squat/thumb.webp",
			at:   at,
			want: base + "/exercises/squat/thumb.webp" + stamp,
		},
		{
			// Defensive rather than load-bearing — no seed key currently starts
			// with a slash. Kept because a double slash is a *different*
			// (missing) object to R2, not a tidier spelling of the same one.
			name: "leading slash on the key is not doubled",
			key:  "/exercises/squat/thumb.webp",
			at:   at,
			want: base + "/exercises/squat/thumb.webp" + stamp,
		},
		{
			// `?v=0` would look like a version and behave like a constant —
			// worse than none, because it invites the reader to trust it.
			name: "zero time emits no parameter",
			key:  "exercises/squat/thumb.webp",
			at:   time.Time{},
			want: base + "/exercises/squat/thumb.webp",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mediaURL(base, c.key, c.at); got != c.want {
				t.Errorf("mediaURL() = %q, want %q", got, c.want)
			}
		})
	}
}

// The sport placeholders have no `exercise_media` row, so nothing bumps an
// `updated_at` for them and they would be the one set of assets that can never
// be replaced — a hole in exactly the mechanism this file adds.
func TestDefaultMediaIsVersionedToo(t *testing.T) {
	for _, sport := range []string{"strength", "bjj", "running"} {
		media := DefaultMediaFor(sport)
		if len(media) == 0 {
			t.Fatalf("%s: expected placeholder media", sport)
		}
		for _, m := range media {
			if m.UpdatedAt.IsZero() {
				t.Errorf("%s/%s: placeholder has no revision, so swapping the file "+
					"in the bucket could never reach a client", sport, m.Kind)
			}
			if !m.IsDefault {
				t.Errorf("%s/%s: placeholder not marked IsDefault", sport, m.Kind)
			}
		}
	}
}

// DefaultMediaFor hands out a copy specifically so the handler can write URLs
// into it. Stamping the revision must not have turned that copy into a shared
// reference — one request's assembled URL leaking into the package-level map
// would then be served to every later request, with whatever base URL that
// first request happened to use.
func TestDefaultMediaForDoesNotAliasTheSharedMap(t *testing.T) {
	first := DefaultMediaFor("strength")
	first[0].URL = "https://mutated.example.com/leaked.webp"

	second := DefaultMediaFor("strength")
	if strings.Contains(second[0].URL, "mutated") {
		t.Fatalf("mutation leaked into the shared defaults: %q", second[0].URL)
	}
}

// The seam between "the repository read a timestamp" and "the response carries
// a versioned URL" — the part with no coverage until now, and the reason this
// test exists rather than another `mediaURL` case.
//
// `mediaURL` is thoroughly pinned above, but nothing asserted that the handler
// actually *feeds* it an `UpdatedAt`. So dropping `updated_at` from the SELECT
// in `attachMedia` would leave every Media zero-valued, the zero-time branch
// would quietly emit bare URLs, and every existing test would still pass —
// compiles, 200s, stale photograph. Exactly the failure the file's own comments
// warn about, one refactor away.
func TestWithMediaURLsVersionsWhatTheRepositoryReturns(t *testing.T) {
	const base = "https://cdn.example.com"
	// A nil repo is fine: withMediaURLs never touches it.
	h := NewHandler(nil, base)

	at := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	exercises := []Exercise{{
		ID:    "barbell-back-squat",
		Sport: "strength",
		Media: []Media{{
			Kind:       MediaKindThumbnail,
			StorageKey: "exercises/barbell-back-squat/thumbnail.webp",
			UpdatedAt:  at,
		}},
	}}

	h.withMediaURLs(exercises)

	got := exercises[0].Media[0].URL
	if !strings.Contains(got, "?v=") {
		t.Fatalf("assembled URL carries no version: %q — a replaced image would "+
			"never reach a client that has already cached this one", got)
	}
	if want := base + "/exercises/barbell-back-squat/thumbnail.webp?v=1785499200"; got != want {
		t.Errorf("URL = %q, want %q", got, want)
	}
}

// The placeholder path goes through the same assembly, and has its own way to
// lose the version: `DefaultMediaFor` has to stamp the revision onto the copy
// it returns, or `_defaults/` assets emit bare URLs while real ones don't.
func TestWithMediaURLsVersionsPlaceholders(t *testing.T) {
	h := NewHandler(nil, "https://cdn.example.com")
	exercises := []Exercise{{ID: "some-lift", Sport: "strength"}} // no media of its own

	h.withMediaURLs(exercises)

	if len(exercises[0].Media) == 0 {
		t.Fatal("expected the sport placeholder to be substituted")
	}
	for _, m := range exercises[0].Media {
		if !strings.Contains(m.URL, "?v=") {
			t.Errorf("placeholder %s URL carries no version: %q", m.Kind, m.URL)
		}
	}
}

// Local dev and CI run with no media origin. The response shape must not
// change between environments — only the URLs go empty, which clients already
// treat as "no image" — and emphatically no stray `?v=` on an empty string.
func TestWithMediaURLsWithoutAnOriginLeavesURLsEmpty(t *testing.T) {
	h := NewHandler(nil, "")
	exercises := []Exercise{{
		ID:    "x",
		Sport: "strength",
		Media: []Media{{Kind: MediaKindThumbnail, StorageKey: "a.webp", UpdatedAt: time.Now()}},
	}}

	h.withMediaURLs(exercises)

	if got := exercises[0].Media[0].URL; got != "" {
		t.Errorf("URL = %q, want empty when no media origin is configured", got)
	}
}

// Storage keys are interpolated into a URL that already has a query string, so
// two characters would break it silently: `?` truncates the path, and `#` makes
// everything after it a fragment the server never sees — which turns cache
// busting off for that one asset with nothing reporting it.
func TestSeedRejectsStorageKeysThatWouldBreakTheURL(t *testing.T) {
	base := Exercise{
		ID: "x", Name: "X", Sport: "strength",
		MovementPattern: "squat", LoadType: LoadTypeWeightReps,
	}

	for _, key := range []string{
		"exercises/x/thumb?.webp",
		"exercises/x/thumb#1.webp",
		"exercises/x/Thumb.webp", // uppercase: R2 keys are case-sensitive
		"exercises/x/thumb .webp",
	} {
		t.Run(key, func(t *testing.T) {
			e := base
			e.Media = []Media{{Kind: MediaKindThumbnail, StorageKey: key}}
			if err := validate([]Exercise{e}); err == nil {
				t.Errorf("validate() accepted storage_key %q", key)
			}
		})
	}

	// And the shape every real key uses still passes.
	e := base
	e.Media = []Media{{Kind: MediaKindThumbnail, StorageKey: "exercises/_defaults/strength-thumbnail.webp"}}
	if err := validate([]Exercise{e}); err != nil {
		t.Errorf("validate() rejected a legitimate key: %v", err)
	}
}

// TestDefaultMediaCoversEverySport closes the one remaining place where adding
// a discipline fails SILENTLY.
//
// defaultMedia is keyed by sport string. A new sport added to the registry but
// not here makes DefaultMediaFor return nil, the handler skip media entirely,
// and every exercise in that discipline render with no image and no error —
// nothing logs, nothing 500s, and the gap is invisible until someone opens the
// app. Every other discipline list is now derived from the registry; this one
// can't be (the values are asset paths that have to exist in the bucket), so
// it gets a test instead.
func TestDefaultMediaCoversEverySport(t *testing.T) {
	for _, m := range discipline.Sports() {
		if got := DefaultMediaFor(m.Key); len(got) == 0 {
			t.Errorf("sport %q is in the registry but has no defaultMedia entry — "+
				"its exercises would render with no image and no error. Add "+
				"_defaults/%s.webp to the bucket and an entry to defaultMedia.",
				m.Key, m.Key)
		}
	}
	// The reverse: an entry for a sport nobody knows is dead weight, and more
	// importantly a sign the registry and this map have drifted.
	for key := range defaultMedia {
		if !discipline.ValidSport(key) {
			t.Errorf("defaultMedia has %q, which is not a registry sport", key)
		}
	}
}
