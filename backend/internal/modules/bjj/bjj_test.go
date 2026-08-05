package bjj

import (
	"strings"
	"testing"
	"time"
)

func date(s string) *string { return &s }

var now = time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

func promo(b Belt, stripes, degree int, on *string) Promotion {
	return Promotion{Rank: Rank{Belt: b, Stripes: stripes, Degree: degree}, PromotedOn: on}
}

// The whole design of this module is "current rank is derived, not stored".
// These are the tests that make that claim true rather than aspirational.

func TestCurrentRankIsTheHighest_NotTheMostRecentlyDated(t *testing.T) {
	// Entered out of order, which is what actually happens when someone sits
	// down to backfill their history: the blue belt goes in last because it
	// was the one they had to look up. Ordering by date would work here, but
	// ordering by *entry* would not, and neither survives a missing date.
	s := StandingFrom([]Promotion{
		promo(Purple, 2, 0, date("2024-03-01")),
		promo(White, 4, 0, date("2020-01-01")),
		promo(Blue, 0, 0, date("2021-06-01")),
	}, now)

	if s.Current == nil || s.Current.Belt != Purple || s.Current.Stripes != 2 {
		t.Fatalf("want purple/2, got %+v", s.Current)
	}
}

func TestUndatedPromotionsStillEstablishRank(t *testing.T) {
	// The case that kills a date-ordered design. Someone genuinely does not
	// remember when they got their blue belt; refusing the promotion to
	// protect the metadata would lose the fact itself.
	s := StandingFrom([]Promotion{
		promo(White, 0, 0, date("2020-01-01")),
		promo(Brown, 0, 0, nil),
	}, now)

	if s.Current == nil || s.Current.Belt != Brown {
		t.Fatalf("want brown, got %+v", s.Current)
	}
	if s.TimeAtCurrentDays != nil {
		t.Errorf("undated promotion must not report a time at belt, got %v", *s.TimeAtCurrentDays)
	}
}

func TestAStripedLowerBeltNeverOutranksTheNextBelt(t *testing.T) {
	// white/4 vs blue/0 is the exact pair a naive score (belt + stripes)
	// gets wrong, and it is not a rare edge: every athlete passes through it.
	s := StandingFrom([]Promotion{
		promo(White, 4, 0, nil),
		promo(Blue, 0, 0, nil),
	}, now)

	if s.Current == nil || s.Current.Belt != Blue {
		t.Fatalf("want blue, got %+v", s.Current)
	}
}

func TestBlackBeltDegreesOutrankPlainBlack(t *testing.T) {
	s := StandingFrom([]Promotion{
		promo(Black, 0, 0, nil),
		promo(Black, 0, 2, nil),
	}, now)

	if s.Current == nil || s.Current.Degree != 2 {
		t.Fatalf("want 2nd degree, got %+v", s.Current)
	}
}

func TestNoPromotionsMeansNoBelt(t *testing.T) {
	// Not "white". A new account has no rank, and defaulting to white would
	// put a belt on someone who has never trained.
	s := StandingFrom(nil, now)
	if s.Current != nil {
		t.Fatalf("want no rank, got %+v", s.Current)
	}
	if s.Promotions == nil {
		t.Error("promotions should marshal as [], not null")
	}
}

func TestUnknownBeltIsSkipped_NotSortedAsZero(t *testing.T) {
	// A row written by a newer build — coral, say. Treating it as rank 0
	// would let a real white belt outrank it and quietly display the wrong
	// belt; acting as though the row is absent is the honest degradation.
	s := StandingFrom([]Promotion{
		promo(Belt("coral"), 0, 0, nil),
		promo(White, 0, 0, nil),
	}, now)

	if s.Current == nil || s.Current.Belt != White {
		t.Fatalf("want white (coral skipped), got %+v", s.Current)
	}
}

func TestTimeAtBelt(t *testing.T) {
	s := StandingFrom([]Promotion{promo(Blue, 0, 0, date("2025-08-01"))}, now)
	if s.TimeAtCurrentDays == nil {
		t.Fatal("want a time at belt")
	}
	if *s.TimeAtCurrentDays != 365 {
		t.Errorf("want 365 days, got %d", *s.TimeAtCurrentDays)
	}
}

func TestFutureDatedPromotionReportsNoTime(t *testing.T) {
	// Someone's typo. A negative time-at-belt on screen is worse than none.
	s := StandingFrom([]Promotion{promo(Blue, 0, 0, date("2027-01-01"))}, now)
	if s.TimeAtCurrentDays != nil {
		t.Errorf("want no time at belt, got %d", *s.TimeAtCurrentDays)
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name string
		rank Rank
		ok   bool
	}{
		{"plain white", Rank{Belt: White}, true},
		{"four stripes", Rank{Belt: Brown, Stripes: 4}, true},
		{"black with degree", Rank{Belt: Black, Degree: 6}, true},
		{"unknown belt", Rank{Belt: "chartreuse"}, false},
		{"five stripes", Rank{Belt: White, Stripes: 5}, false},
		{"negative stripes", Rank{Belt: White, Stripes: -1}, false},
		{"seventh degree", Rank{Belt: Black, Degree: 7}, false},
		// A degree on a coloured belt is refused rather than zeroed: the
		// client sent something it believed, and silently dropping a field is
		// how a UI ends up showing a value the server never stored.
		{"degree on purple", Rank{Belt: Purple, Degree: 1}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := c.rank.Validate(); (err == nil) != c.ok {
				t.Errorf("Validate() = %v, want ok=%v", err, c.ok)
			}
		})
	}
}

func TestTagCountIsBoundedAtBothEnds(t *testing.T) {
	// The upper bound is not tidiness. SUM(count) feeds a ::int narrowing in
	// the proficiency query, so two rows near math.MaxInt32 on one technique
	// make that endpoint fail with "integer out of range" — and the data is
	// durable, so it stays broken for that athlete until the sessions are
	// deleted.
	base := Tag{Category: CategorySubmission, Event: EventScored, Position: "Guard"}
	for _, tc := range []struct {
		count int
		ok    bool
	}{
		{0, false},
		{1, true},
		{maxTagCount, true},
		{maxTagCount + 1, false},
		{1 << 30, false},
	} {
		tag := base
		tag.Count = tc.count
		err := tag.Validate()
		if tc.ok && err != nil {
			t.Errorf("count %d rejected: %v", tc.count, err)
		}
		if !tc.ok && err == nil {
			t.Errorf("count %d accepted", tc.count)
		}
	}
}

// The live vocabulary is a 2x2 of who initiated an exchange and whether it
// landed. `defended` was the missing cell for a long time, which meant a
// defensive success was the one outcome nothing could record — and the gap was
// invisible because every OTHER combination worked.
//
// Asserting the shape rather than the list: a test that just spelled the five
// values out would go green if someone deleted `defended` and updated it.
func TestLiveEventsCoverBothInitiatorsAndBothOutcomes(t *testing.T) {
	live := map[string]struct{ theirs, landed bool }{
		"scored":    {theirs: false, landed: true},
		"attempted": {theirs: false, landed: false},
		"conceded":  {theirs: true, landed: true},
		"defended":  {theirs: true, landed: false},
	}

	seen := map[[2]bool]string{}
	for _, e := range Events() {
		cell, ok := live[string(e)]
		if !ok {
			continue // `drilled` is practice, not an exchange.
		}
		key := [2]bool{cell.theirs, cell.landed}
		if prev, dup := seen[key]; dup {
			t.Fatalf("%q and %q describe the same cell of the 2x2", prev, e)
		}
		seen[key] = string(e)
	}

	if len(seen) != 4 {
		t.Fatalf("the 2x2 has %d of 4 cells filled: %v — a missing cell is an "+
			"outcome the schema cannot record at all", len(seen), seen)
	}
}

func TestDefendedIsAcceptedAsAnEvent(t *testing.T) {
	if !Event("defended").Valid() {
		t.Fatal("defended must be a valid event; a roadmap's defensive criterion counts it")
	}
	if Event("stopped").Valid() {
		t.Fatal("Valid() accepts anything, so it is not validating")
	}
}

// The 400 message spells the vocabularies out for a client whose picker has
// drifted. It used to spell them out LITERALLY, and went stale the moment one
// grew — telling a rejected client there were four events when there were
// five. A message about drift that can itself drift is worse than none.
func TestInvalidInputMessageNamesEveryEventItAccepts(t *testing.T) {
	msg := invalidInputMessage()
	for _, e := range Events() {
		if !strings.Contains(msg, string(e)) {
			t.Errorf("the invalid-input message does not mention %q", e)
		}
	}
	for _, k := range Kinds() {
		if !strings.Contains(msg, string(k)) {
			t.Errorf("the invalid-input message does not mention kind %q", k)
		}
	}
	for _, c := range Categories() {
		if !strings.Contains(msg, string(c)) {
			t.Errorf("the invalid-input message does not mention category %q", c)
		}
	}
}
