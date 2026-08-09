package score

import "testing"

// twenty returns a history of loads 100..2000, newest-first, as a stand-in for
// six weeks of ordinary training.
func twenty() []float64 {
	h := make([]float64, 0, 20)
	for i := 20; i >= 1; i-- {
		h = append(h, float64(i*100))
	}
	return h
}

// THE PROPERTY THE WHOLE DESIGN EXISTS FOR: a score that can disappoint.
// A four-components-of-25 build lands 70–90 for everything; a percentile puts
// half of all sessions below 50 by construction.
func TestAnEasySessionScoresLow(t *testing.T) {
	h := twenty()
	got, ok := Of(150, h, BasisEffort) // beats only the 100
	if !ok {
		t.Fatal("refused with a full window")
	}
	if got.Value >= 50 {
		t.Fatalf("a session near the bottom scored %d — the score cannot disappoint", got.Value)
	}

	// And the median session sits near the middle rather than near the top.
	mid, _ := Median(h)
	half, _ := Of(mid, h, BasisEffort)
	if half.Value < 40 || half.Value > 60 {
		t.Fatalf("the median session scored %d, want ~50", half.Value)
	}
}

func TestBeatingEverythingIsOneHundredAndBeatingNothingIsZero(t *testing.T) {
	h := twenty()
	if got, _ := Of(9999, h, BasisEffort); got.Value != 100 {
		t.Fatalf("hardest session scored %d, want 100", got.Value)
	}
	if got, _ := Of(1, h, BasisEffort); got.Value != 0 {
		t.Fatalf("lightest session scored %d, want 0", got.Value)
	}
}

// Repeating a workout exactly is completely ordinary. Under a strict
// "must beat it" rule the second identical session scores lower than the
// first for no reason an athlete could accept — so ties count as half.
func TestRepeatingASessionIsNotPunished(t *testing.T) {
	h := make([]float64, 20)
	for i := range h {
		h[i] = 500 // twenty identical sessions
	}
	got, ok := Of(500, h, BasisEffort)
	if !ok {
		t.Fatal("refused")
	}
	if got.Value != 50 {
		t.Fatalf("an exact repeat scored %d, want 50 (mid-rank)", got.Value)
	}
}

// NO SCORE BELOW THE THRESHOLD. A percentile against three sessions is noise
// wearing a number, and printing it would be worse than omitting it.
func TestTooLittleHistoryRefusesRatherThanGuessing(t *testing.T) {
	for n := 0; n < MinHistory; n++ {
		h := make([]float64, n)
		for i := range h {
			h[i] = 500
		}
		if got, ok := Of(900, h, BasisEffort); ok {
			t.Fatalf("scored %d from only %d prior sessions", got.Value, n)
		}
	}
	// Exactly at the threshold it starts working.
	h := make([]float64, MinHistory)
	for i := range h {
		h[i] = 500
	}
	if _, ok := Of(900, h, BasisEffort); !ok {
		t.Fatalf("refused at exactly MinHistory=%d", MinHistory)
	}
}

// The window is NEWEST-first and capped, so a season of progress moves the
// baseline with the athlete rather than scoring this year against last year.
func TestOnlyTheRecentWindowCounts(t *testing.T) {
	// 20 recent hard sessions, then 40 ancient easy ones.
	h := make([]float64, 0, 60)
	for i := 0; i < 20; i++ {
		h = append(h, 2000)
	}
	for i := 0; i < 40; i++ {
		h = append(h, 10)
	}
	got, ok := Of(1000, h, BasisEffort)
	if !ok {
		t.Fatal("refused")
	}
	if got.Compared != Window {
		t.Fatalf("compared against %d, want the %d-session window", got.Compared, Window)
	}
	// Against the recent hard block a 1000 is weak. If the ancient easy
	// sessions leaked in it would look strong instead.
	if got.Value != 0 {
		t.Fatalf("scored %d — old sessions outside the window are being counted", got.Value)
	}
}

// What multiplying actually buys, stated as the code now claims it rather than
// as I first wrote it.
//
// The first version of this test asserted that three easy hours must score
// BELOW one hard hour. That is false: 3 × 180 and 9 × 60 are both 540, exactly
// equal, and the equivalence is the model rather than a bug. The real property
// is the contrast with an additive load, where duration swamps effort.
func TestMultiplyingStopsDurationSwampingEffort(t *testing.T) {
	hardHour := Load(9, 60)
	threeEasyHours := Load(3, 180)

	// Commensurate, by design.
	if hardHour != threeEasyHours {
		t.Fatalf("sRPE should make these equal: %.0f vs %.0f", hardHour, threeEasyHours)
	}

	// The additive shape this rules out: three easy hours would outrank a
	// brutal hour nearly threefold.
	additiveEasy, additiveHard := 3.0+180.0, 9.0+60.0
	if additiveEasy <= additiveHard {
		t.Fatal("fixture wrong — the additive contrast should favour the stroll")
	}

	// And at equal duration, effort is the whole difference.
	if Load(3, 60) >= hardHour {
		t.Fatal("at the same duration a light session must score below a hard one")
	}

	if Load(0, 60) != 0 || Load(8, 0) != 0 {
		t.Fatal("a missing term must produce no load rather than a partial one")
	}
}

// The basis rides along, because a number whose meaning changed silently is
// worse than no number.
func TestBasisIsReported(t *testing.T) {
	h := twenty()
	if got, _ := Of(900, h, BasisVolume); got.Basis != BasisVolume {
		t.Fatalf("basis %q, want volume", got.Basis)
	}
	if got, _ := Of(900, h, BasisEffort); got.Basis != BasisEffort {
		t.Fatalf("basis %q, want effort", got.Basis)
	}
}

func TestMedianHandlesBothParities(t *testing.T) {
	if m, _ := Median([]float64{300, 100, 200}); m != 200 {
		t.Fatalf("odd-length median %.0f, want 200", m)
	}
	if m, _ := Median([]float64{400, 100, 300, 200}); m != 250 {
		t.Fatalf("even-length median %.0f, want 250", m)
	}
	if _, ok := Median(nil); ok {
		t.Fatal("median of nothing should not report ok")
	}
	// Median must not reorder the caller's slice — Of() reads it afterwards.
	h := []float64{300, 100, 200}
	Median(h)
	if h[0] != 300 {
		t.Fatalf("Median sorted the caller's slice in place: %v", h)
	}
}
