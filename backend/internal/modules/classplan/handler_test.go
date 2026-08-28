package classplan

import "testing"

// TestNilIfEmptyNormalisesWireBoundary pins the fix for the gap both
// backend-reviewer and ac-verifier independently flagged on N439's review:
// a client sending `"technique_id": ""` alongside a real `free_text` used to
// pass ValidateBlocks (which already treats a non-nil empty string as
// unset) and then die on the Postgres CHECK with a generic, field-less 400,
// defeating the reason the Go validator exists at all. toNewBlocks now
// normalises both pointers at the wire boundary so every downstream layer
// agrees about what "set" means.
func TestNilIfEmptyNormalisesWireBoundary(t *testing.T) {
	empty := ""
	real := "x"

	if got := nilIfEmpty(&empty); got != nil {
		t.Fatalf("nilIfEmpty(&\"\") = %v, want nil", got)
	}
	if got := nilIfEmpty(nil); got != nil {
		t.Fatalf("nilIfEmpty(nil) = %v, want nil", got)
	}
	if got := nilIfEmpty(&real); got == nil || *got != "x" {
		t.Fatalf("nilIfEmpty(&\"x\") = %v, want a pointer to \"x\"", got)
	}

	// The full shape the reviewers flagged: technique_id sent as "" alongside
	// a real free_text must now validate as a clean free-text block, not
	// trip the XOR by looking like both are set.
	blocks := toNewBlocks([]blockBody{{
		Type:            BlockTypeTechniqueDrill,
		DurationMinutes: 10,
		TechniqueID:     &empty,
		FreeText:        &real,
	}})
	if err := ValidateBlocks(blocks); err != nil {
		t.Fatalf("ValidateBlocks() = %v, want nil (empty-string technique_id must not count as set)", err)
	}
	if blocks[0].TechniqueID != nil {
		t.Fatalf("TechniqueID = %v, want nil after normalisation", blocks[0].TechniqueID)
	}

	// The mirror case: free_text sent as "" alongside a real technique_id.
	blocks2 := toNewBlocks([]blockBody{{
		Type:            BlockTypeTechniqueDrill,
		DurationMinutes: 10,
		TechniqueID:     &real,
		FreeText:        &empty,
	}})
	if err := ValidateBlocks(blocks2); err != nil {
		t.Fatalf("ValidateBlocks() = %v, want nil (empty-string free_text must not count as set)", err)
	}
	if blocks2[0].FreeText != nil {
		t.Fatalf("FreeText = %v, want nil after normalisation", blocks2[0].FreeText)
	}
}
