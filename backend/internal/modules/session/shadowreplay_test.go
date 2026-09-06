package session

import (
	"testing"
	"time"
)

// These pin CompareEngines' own definition of "disagree" — see
// shadowreplay.go's doc comment for why that definition lives in this
// package rather than in cmd/shadowreplay. No database is needed: Progress
// and ProgressV2 are both pure, so CompareEngines is too.

func TestCompareEngines_AgreesWhenBothEnginesReachTheSamePrescription(t *testing.T) {
	day := 24 * time.Hour

	v1In := progIn("hypertrophy",
		sess(2*day, testNow, set(8, 100, ptrInt(2), nil), set(8, 100, ptrInt(2), nil)))
	v2In := progIn("hypertrophy",
		finishedSess(2*day, testNow, set(8, 100, ptrInt(2), nil), set(8, 100, ptrInt(2), nil)))

	d, disagree := CompareEngines("user_a", "bench-press", v1In, v2In, testNow)
	if disagree {
		t.Fatalf("identical straight-set history should agree, got disagreement: %+v", d)
	}
}

func TestCompareEngines_NoHistoryOnEitherSideAgrees(t *testing.T) {
	v1In := progIn("hypertrophy")
	v2In := progIn("hypertrophy")

	d, disagree := CompareEngines("user_a", "bench-press", v1In, v2In, testNow)
	if disagree {
		t.Fatalf("no history on either side should agree (both SuggestNoHistory), got: %+v", d)
	}
}

// AbstentionDivergence: v1's anyEffortRecorded/allSetsHadReserve only ever
// look at the sets that DID carry effort, so a working set with none simply
// doesn't veto — v1 reads reserve from the other set and progresses. v2's
// effortCoverage instead requires effort on EVERY straight cohort set, so
// the same history is genuinely ambiguous to it and it abstains — the exact
// "item 4" behavior progression_v2.go's own doc comment describes.
func TestCompareEngines_AbstentionDivergence_V2AbstainsWhereV1Progresses(t *testing.T) {
	day := 24 * time.Hour

	sets := []Set{
		set(10, 100, ptrInt(2), nil), // effort recorded, top of a 6-10 range
		set(10, 100, nil, nil),       // same weight/reps, no effort at all
	}
	v1In := progIn("hypertrophy", sess(2*day, testNow, sets...))
	v2In := progIn("hypertrophy", finishedSess(2*day, testNow, sets...))

	d, disagree := CompareEngines("user_a", "bench-press", v1In, v2In, testNow)
	if !disagree {
		t.Fatalf("partial effort coverage should abstain under v2 while v1 progresses; got agreement")
	}
	if d.Category != DisagreementAbstentionDivergence {
		t.Fatalf("category = %q, want %q", d.Category, DisagreementAbstentionDivergence)
	}
	if d.V1.TargetWeightKg == nil {
		t.Errorf("v1 should have progressed with a real target, got none (code %s)", d.V1.Code)
	}
	if d.V2.Code != SuggestAbstain {
		t.Errorf("v2 code = %s, want %s", d.V2.Code, SuggestAbstain)
	}
	if d.V2.TargetWeightKg != nil {
		t.Errorf("v2 abstaining must carry no target, got %v", *d.V2.TargetWeightKg)
	}
	if d.Detail == "" {
		t.Errorf("Detail should explain the disagreement in prose a coach can read")
	}
}

// CodeDiffers: v1's workingSetsWithWeight folds a BACKOFF set's lower rep
// count into the same rep-range gate a straight working set uses, so one
// weak backoff set can hold the whole session under the range's top and
// v1 reads it as "reps not finished yet". v2's straightWorkingSetsWithWeight
// excludes the backoff set entirely (item 2), so the straight sets alone
// clear the range and v2 adds load — same history, a different Code, and
// both sides still produce a real number (this is not abstention).
func TestCompareEngines_CodeDiffers_BackoffSetPullsV1BelowTheRange(t *testing.T) {
	day := 24 * time.Hour

	straight1 := set(10, 100, ptrInt(2), nil)
	straight2 := set(10, 100, ptrInt(2), nil)
	backoff := set(6, 90, nil, nil)
	backoff.SetType = SetTypeBackoff

	v1In := progIn("hypertrophy", sess(2*day, testNow, straight1, straight2, backoff))
	v2In := progIn("hypertrophy", finishedSess(2*day, testNow, straight1, straight2, backoff))

	d, disagree := CompareEngines("user_a", "bench-press", v1In, v2In, testNow)
	if !disagree {
		t.Fatalf("a backoff set diluting v1's rep-range gate should disagree with v2; got agreement")
	}
	if d.Category != DisagreementCodeDiffers {
		t.Fatalf("category = %q, want %q (v1=%s v2=%s)", d.Category, DisagreementCodeDiffers, d.V1.Code, d.V2.Code)
	}
	if d.V1.Code == d.V2.Code {
		t.Fatalf("codes should differ, both read %s", d.V1.Code)
	}
	if d.V1.TargetWeightKg == nil || d.V2.TargetWeightKg == nil {
		t.Fatalf("both engines should still produce a real target here — this is not abstention: v1=%v v2=%v",
			d.V1.TargetWeightKg, d.V2.TargetWeightKg)
	}
	if d.V2.Code != ProgressAddLoad {
		t.Errorf("v2, seeing only the two straight sets at the top of the range, should add load; got %s", d.V2.Code)
	}
}

// TargetDiffers: same Code (both add load), but v2's item-8 equipment
// increment (N494/#864) overrides the pattern-based guess v1 always uses, so
// the two engines can agree on the DIRECTION of the prescription and still
// disagree on the number.
func TestCompareEngines_TargetDiffers_EquipmentIncrementChangesTheNumberNotTheCode(t *testing.T) {
	day := 24 * time.Hour

	topSet := set(10, 100, ptrInt(2), nil) // top of the 6-10 hypertrophy range, reserve to spare

	v1In := progIn("hypertrophy", sess(2*day, testNow, topSet))
	v2In := progIn("hypertrophy", finishedSess(2*day, testNow, topSet))
	increment := 10.0
	v2In.Protocol = &ResolvedProtocol{EquipmentIncrementKg: &increment}

	d, disagree := CompareEngines("user_a", "bench-press", v1In, v2In, testNow)
	if !disagree {
		t.Fatalf("a configured equipment increment should change the loaded number; got agreement")
	}
	if d.Category != DisagreementTargetDiffers {
		t.Fatalf("category = %q, want %q (v1=%s@%v v2=%s@%v)", d.Category, DisagreementTargetDiffers,
			d.V1.Code, d.V1.TargetWeightKg, d.V2.Code, d.V2.TargetWeightKg)
	}
	if d.V1.Code != d.V2.Code {
		t.Fatalf("this case should share a Code (%s vs %s) and differ only on the number", d.V1.Code, d.V2.Code)
	}
	if d.V1.TargetWeightKg == nil || d.V2.TargetWeightKg == nil {
		t.Fatalf("both should have a real target: v1=%v v2=%v", d.V1.TargetWeightKg, d.V2.TargetWeightKg)
	}
	if *d.V1.TargetWeightKg == *d.V2.TargetWeightKg {
		t.Fatalf("expected the equipment increment to change the target weight, both read %v", *d.V1.TargetWeightKg)
	}
}

func TestSameWeightPtr(t *testing.T) {
	a, b := 100.0, 100.0+disagreementWeightEpsilonKg/2
	if !sameWeightPtr(&a, &b) {
		t.Errorf("weights within epsilon should read as the same")
	}
	c := 100.0 + 1.25 // a real plate increment away
	if sameWeightPtr(&a, &c) {
		t.Errorf("a real 1.25kg difference must not read as the same")
	}
	if !sameWeightPtr(nil, nil) {
		t.Errorf("nil, nil should be the same (both abstaining on weight)")
	}
	if sameWeightPtr(&a, nil) || sameWeightPtr(nil, &a) {
		t.Errorf("one nil, one present must never read as the same")
	}
}

func TestSameIntPtr(t *testing.T) {
	a, b, c := 8, 8, 9
	if !sameIntPtr(&a, &b) {
		t.Errorf("equal ints should be the same")
	}
	if sameIntPtr(&a, &c) {
		t.Errorf("different ints must not read as the same")
	}
	if !sameIntPtr(nil, nil) {
		t.Errorf("nil, nil should be the same")
	}
	if sameIntPtr(&a, nil) {
		t.Errorf("one nil, one present must never read as the same")
	}
}
