package energy

import (
	"math"
	"testing"
	"time"
)

func f(v float64) *float64 { return &v }
func s(v string) *string   { return &v }

// The reference athlete from the design: 80 kg, 180 cm, 30, male.
// Mifflin–St Jeor = 10(80) + 6.25(180) − 5(30) + 5 = 1780 kcal/day.
//
// THE BIRTHDAY IS COMPUTED, NOT LITERAL, and that is the whole point. A fixed
// "1996-01-01" made this athlete 30 only until 2027-01-01, after which Mifflin
// drops 1780 → 1775 and the assertion fails — a CI outage scheduled for a
// specific future date, on every branch at once, for a reason nobody would
// look for. Review caught it. Thirty years and a day ago is always thirty.
func reference() Profile {
	born := time.Now().UTC().AddDate(-30, 0, -1)
	return Profile{
		WeightKG:    f(80),
		HeightCM:    f(180),
		DateOfBirth: s(born.Format("2006-01-02")),
		Sex:         s("male"),
	}
}

// %g, not %.1f. With one decimal place a drift of 0.0035 prints as
// "got 1.2, want 1.2 (±0.0)" — a failure message indistinguishable from a
// pass, which is the worst possible thing to hand somebody debugging on the
// morning it starts failing.
func near(t *testing.T, got, want, tol float64, what string) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Fatalf("%s: got %g, want %g (±%g)", what, got, want, tol)
	}
}

func TestRestingRateMatchesMifflinStJeor(t *testing.T) {
	// 1780 / 1440 = 1.236 kcal/min. Pinned because every other number in this
	// package is a multiple of it — if this drifts, everything drifts with it.
	near(t, restingKcalPerMinute(reference()), 1780.0/1440.0, 0.001, "resting kcal/min")
}

// The headline claim from the design doc, kept honest by a test: an hour of
// ordinary lifting is ~185 kcal, not the 400–600 a smartwatch would report.
func TestAnHourOfLiftingIsAboutOneEightyFive(t *testing.T) {
	kcal, ok := Estimate(reference(), StrengthBlocks(60, 18, true, false))
	if !ok {
		t.Fatal("estimate refused for a complete profile")
	}
	near(t, kcal, 185, 3, "60 min strength")

	// And the mistake this package exists to avoid, priced out: the same hour
	// read GROSS at a vigorous MET is 480 kcal — squarely in the 400–600 band
	// the package doc cites, and 2.6× what the honest model says.
	//
	// The constant here is the VIGOROUS one because that is what the claim is
	// about; an earlier version said "vigorous" in the comment and computed
	// the general 3.5, which tested something real while documenting something
	// else.
	inflated := METStrengthHeavy * 1.2 * 80 * 1.0 // ≈ vigorous MET × kg × hours
	if inflated < 400 || inflated > 600 {
		t.Fatalf("fixture drifted: %.0f is outside the 400–600 band the doc cites", inflated)
	}
	if kcal > inflated/2 {
		t.Fatalf("net (%.0f) should be far below the inflated figure (%.0f)", kcal, inflated)
	}
}

// Net, not gross: subtracting resting is worth ~40% on a low-MET activity, so
// a regression here would inflate every strength number in the app.
func TestNetNotGross(t *testing.T) {
	p := reference()
	rest := restingKcalPerMinute(p)
	kcal, _ := Estimate(p, []Block{{MET: 3.5, Minutes: 60}})
	near(t, kcal, (3.5-1)*rest*60, 0.01, "net")

	grossIfWrong := 3.5 * rest * 60
	if kcal >= grossIfWrong {
		t.Fatalf("estimate is gross (%.0f), not net (%.0f)", kcal, grossIfWrong)
	}
}

// A MET at or below resting must contribute nothing rather than a negative —
// sitting still does not subtract from what a session cost.
func TestRestingOrBelowContributesNothing(t *testing.T) {
	kcal, ok := Estimate(reference(), []Block{{MET: 1.0, Minutes: 60}, {MET: 0.5, Minutes: 30}})
	if !ok {
		t.Fatal("refused")
	}
	if kcal != 0 {
		t.Fatalf("want 0 for at-or-below-resting blocks, got %.2f", kcal)
	}
}

// NO BODYWEIGHT, NO NUMBER. The whole point: a 55 kg and a 105 kg athlete
// doing identical work differ by nearly half, so there is no honest default
// and the card must ask rather than assume.
func TestNoBodyweightRefusesRatherThanGuessing(t *testing.T) {
	for _, p := range []Profile{
		{HeightCM: f(180), DateOfBirth: s("1996-01-01"), Sex: s("male")}, // nil weight
		{WeightKG: f(0)},
		{WeightKG: f(-5)},
	} {
		if kcal, ok := Estimate(p, StrengthBlocks(60, 18, true, false)); ok || kcal != 0 {
			t.Fatalf("estimated %.0f kcal without a bodyweight", kcal)
		}
		if got := PrecisionOf(p); got != PrecisionNone {
			t.Fatalf("precision %q, want none", got)
		}
	}
}

// Weight alone still works, at lower quality, and says so.
func TestWeightOnlyIsCoarseNotRefused(t *testing.T) {
	p := Profile{WeightKG: f(80)}
	kcal, ok := Estimate(p, StrengthBlocks(60, 18, true, false))
	if !ok || kcal <= 0 {
		t.Fatalf("weight-only should still estimate, got %.0f ok=%v", kcal, ok)
	}
	if got := PrecisionOf(p); got != PrecisionCoarse {
		t.Fatalf("precision %q, want coarse", got)
	}
	if got := PrecisionOf(reference()); got != PrecisionEstimated {
		t.Fatalf("full profile precision %q, want estimated", got)
	}
	// And the fallback baseline really is the higher one — which is why it is
	// the fallback and not the default.
	if restingKcalPerMinute(p) <= restingKcalPerMinute(reference()) {
		t.Fatal("the generic baseline should exceed this athlete's own resting rate")
	}
}

// Sex changes the resting rate by 166 kcal/day in Mifflin–St Jeor, and an
// unmodelled value must not silently take the male branch.
func TestSexIsHonouredAndUnknownTakesTheMidpoint(t *testing.T) {
	male, female := reference(), reference()
	female.Sex = s("female")
	other := reference()
	other.Sex = s("nonbinary")

	m, w, o := restingKcalPerMinute(male), restingKcalPerMinute(female), restingKcalPerMinute(other)
	near(t, (m-w)*1440, 166, 0.5, "male − female kcal/day")
	if !(o < m && o > w) {
		t.Fatalf("unknown sex %.3f must sit between male %.3f and female %.3f", o, m, w)
	}
}

// The mat split is the reason BJJ is worth modelling at all: rolling is 10.3
// and everything else is 5.3, and the app knows which is which.
func TestMatSplitsRollingFromDrilling(t *testing.T) {
	blocks := MatBlocks(90, 8, 6) // 48 min rolling, 42 min not
	if len(blocks) != 2 {
		t.Fatalf("want two blocks, got %+v", blocks)
	}
	if blocks[0].MET != METMatLive || blocks[0].Minutes != 48 {
		t.Fatalf("rolling block wrong: %+v", blocks[0])
	}
	if blocks[1].MET != METMatPractice || blocks[1].Minutes != 42 {
		t.Fatalf("practice block wrong: %+v", blocks[1])
	}

	kcal, _ := Estimate(reference(), blocks)
	near(t, kcal, 770, 15, "90 min BJJ with 48 rolling")

	// A flat practice MET over the whole session would understate it badly —
	// that error is what the split exists to prevent.
	flat, _ := Estimate(reference(), []Block{{MET: METMatPractice, Minutes: 90}})
	if kcal <= flat*1.4 {
		t.Fatalf("split (%.0f) should be well above a flat drilling session (%.0f)", kcal, flat)
	}
}

// Rounds × length longer than the session is a data error; trust the smaller
// number rather than inventing mat time.
func TestRollingCannotExceedTheSession(t *testing.T) {
	blocks := MatBlocks(30, 10, 6) // claims 60 min rolling in a 30 min session
	total := 0.0
	for _, b := range blocks {
		total += b.Minutes
		if b.MET == METMatLive && b.Minutes > 30 {
			t.Fatalf("rolling %.0f exceeds the session", b.Minutes)
		}
	}
	if total != 30 {
		t.Fatalf("blocks total %.0f, want the session's 30", total)
	}
}

// Which strength MET applies, in the order a coach would read it.
func TestStrengthMETSelection(t *testing.T) {
	cases := []struct {
		name          string
		minutes       float64
		sets          int
		loaded, heavy bool
		want          float64
	}{
		{"bodyweight only", 40, 20, false, false, METBodyweight},
		{"heavy compounds win over density", 60, 40, true, true, METStrengthHeavy},
		{"dense circuit", 40, 24, true, false, METStrengthDense},
		{"ordinary session defaults low", 60, 18, true, false, METStrengthGeneral},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := StrengthBlocks(c.minutes, c.sets, c.loaded, c.heavy)
			if len(got) != 1 || got[0].MET != c.want {
				t.Fatalf("got %+v, want MET %.1f", got, c.want)
			}
		})
	}
}

// A zero-length session is not an error, it is zero.
func TestZeroDurationIsZero(t *testing.T) {
	kcal, ok := Estimate(reference(), StrengthBlocks(0, 0, true, false))
	if !ok || kcal != 0 {
		t.Fatalf("got %.2f ok=%v", kcal, ok)
	}
}

// Negative minutes must contribute NOTHING, not subtract. Review deleted the
// `b.Minutes <= 0` guard and the suite stayed green, because the only zero-ish
// case tested was minutes=0, which passes trivially through a multiplication.
func TestNegativeMinutesCannotSubtractCalories(t *testing.T) {
	base, _ := Estimate(reference(), []Block{{MET: 5, Minutes: 60}})
	got, ok := Estimate(reference(), []Block{{MET: 5, Minutes: 60}, {MET: 5, Minutes: -10}})
	if !ok {
		t.Fatal("refused")
	}
	if got != base {
		t.Fatalf("a negative block changed the total: %.2f vs %.2f", got, base)
	}
}

// Negative rounds must not INVENT practice time. MatBlocks defended against
// rolling exceeding the session but not against it going negative, so
// MatBlocks(90, -2, 6) priced 102 minutes inside a 90-minute session.
func TestNegativeRoundsCannotInventMatTime(t *testing.T) {
	blocks := MatBlocks(90, -2, 6)
	total := 0.0
	for _, b := range blocks {
		if b.Minutes < 0 {
			t.Fatalf("negative block: %+v", b)
		}
		total += b.Minutes
	}
	if total > 90 {
		t.Fatalf("priced %.0f minutes in a 90 minute session", total)
	}
}

// A NaN bodyweight must be refused. `<= 0` is FALSE for NaN, so the guard let
// one through and produced a NaN estimate; nothing between Postgres (whose
// numeric accepts 'NaN') and here would have caught it.
func TestNaNWeightIsRefused(t *testing.T) {
	nan := math.NaN()
	p := Profile{WeightKG: &nan}
	if kcal, ok := Estimate(p, StrengthBlocks(60, 18, true, false)); ok || kcal != 0 {
		t.Fatalf("NaN weight produced %.2f ok=%v", kcal, ok)
	}
	if got := PrecisionOf(p); got != PrecisionNone {
		t.Fatalf("precision %q, want none", got)
	}
}

// The density boundary is "a working set every two minutes OR FASTER", so
// exactly 0.5 must be dense. Review flipped >= to > and the suite stayed green
// because only 0.6 and 0.3 were tested.
func TestDensityBoundaryIsInclusive(t *testing.T) {
	if got := StrengthBlocks(40, 20, true, false); got[0].MET != METStrengthDense {
		t.Fatalf("exactly one set per two minutes should be dense, got MET %.1f", got[0].MET)
	}
}
