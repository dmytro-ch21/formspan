package exercise

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Identifying a machine from a photograph, as a DRAFT the athlete confirms.
//
// # Why this is a shortlist problem and not a recognition problem
//
// The obvious reading of N7 — "train something on our library" — is impossible
// here and the numbers say so plainly: 8 images across 504 exercises. There is
// no training set, there never will be one from this catalog, and a model asked
// to name a machine from an open vocabulary will answer with something that
// sounds like gym equipment whether or not it is in our catalog.
//
// So the question asked of the model is narrowed until it is answerable: here
// are ~200 exercises this gym's machine equipment supports, which of them is
// the photograph. A closed set is what makes a wrong answer *checkable*, and
// checkability is the whole design. See `ValidateIdentification`.
//
// # A draft, never a selection
//
// Same rule as N26's food estimate: this returns candidates an athlete taps,
// never an exercise it starts logging against. That is not caution for its own
// sake — it is the only mitigation available for the failure mode that matters.

// ErrIdentifyRefused means the model declined or could not tell.
//
// Distinct from unavailable, and the distinction is the one a client acts on: a
// refusal is a real answer about this photograph and will be the same answer
// next time, so nothing should retry it. A photo of a locker room is a refusal.
var ErrIdentifyRefused = errors.New("exercise: could not tell what machine that is")

// ErrIdentifyUnavailable is the upstream being unreachable, erroring, or
// unconfigured.
var ErrIdentifyUnavailable = errors.New("exercise: machine identification is unavailable")

// ErrIdentifyUnreachable is the provider never answering at all — a refused
// connection, a DNS failure, a revoked key, an upstream 5xx.
//
// **It WRAPS ErrIdentifyUnavailable**, so every existing check keeps matching
// and forgetting it somewhere degrades to today's behaviour rather than to a
// 500. Same shape as nutrition's and bjj's.
//
// This route was NOT in F16's original scope — the issue says "the identify
// route uses an in-memory limiter, so it recovers on restart", which was true
// when it was filed and stopped being true with N48. `identify_usage` is a
// Postgres table with the same rolling 24-hour window as the other two, so an
// outage burned this allowance exactly as hard. The in-memory limiter is still
// there and still in memory; it is the second, tighter gate that the quota
// backs up, not the one doing the locking out.
var ErrIdentifyUnreachable = fmt.Errorf("%w: the provider never answered", ErrIdentifyUnavailable)

// MaxIdentifyImageBytes bounds the photo before base64 expansion.
//
// Matches nutrition's bound deliberately. A gym photo and a plate photo come
// off the same camera, and two different limits would be two numbers to explain
// to the same client.
const MaxIdentifyImageBytes = 5 << 20

// AllowedIdentifyImageTypes is what the vision endpoint accepts, checked
// against the SNIFFED type rather than the declared one.
var AllowedIdentifyImageTypes = []string{"image/jpeg", "image/png", "image/gif", "image/webp"}

// MaxCandidates is how many exercises come back.
//
// More than one ON PURPOSE, and this is the load-bearing product decision in
// the whole feature rather than a UI detail.
//
// The failure that costs an athlete something here is not "no answer" — it is a
// confident wrong answer, and N40 measured exactly how that goes: the first
// real photograph through the food estimator invented an item AND doubled a
// quantity, and only the invention came back flagged. The miscount was flagged
// not at all, because nothing downstream could see it. A single-candidate
// response has the same shape: nothing in Go can tell a correct
// `seated-cable-row` from a plausible wrong one.
//
// A ranked shortlist converts that unfixable problem into a fixable one. The
// athlete is standing in front of the machine and is a perfect oracle; asking
// them to pick from four costs one tap and makes a near-miss harmless, where a
// single confident answer makes it invisible.
const MaxCandidates = 4

// Candidate is one exercise the model believes the photograph shows.
type Candidate struct {
	ExerciseID string `json:"exercise_id"`
	Name       string `json:"name"`
	// Confidence is the model's own, 0..1, and it is REPORTED rather than acted
	// on. Nothing in this package thresholds it.
	//
	// It is not calibrated to "am I right" — it cannot be, since the model has
	// never seen this catalog. At best it means "how clearly can I see a
	// machine in this image", which is worth showing to a human deciding
	// whether to retake the photo and worthless as a gate.
	Confidence float64 `json:"confidence"`
}

// Identification is the draft.
type Identification struct {
	// Equipment is the machine family the model reports seeing. Cross-checked
	// against the candidates — see ValidateIdentification.
	Equipment string `json:"equipment"`
	// Candidates is ranked, most likely first, and may be empty.
	Candidates []Candidate `json:"candidates"`
	// Model is the id the provider reports having used.
	Model string `json:"model"`
}

// IdentifyInput is one request.
type IdentifyInput struct {
	// Image is raw bytes, already decoded from whatever transport carried them.
	Image []byte
	// ImageMediaType is the SNIFFED type, not the declared one.
	ImageMediaType string
}

// Validate checks the input before any token is spent.
func (in IdentifyInput) Validate() error {
	if len(in.Image) == 0 {
		return fmt.Errorf("%w: a photo is required", ErrInvalidInput)
	}
	if len(in.Image) > MaxIdentifyImageBytes {
		return fmt.Errorf("%w: image is larger than %d bytes", ErrInvalidInput, MaxIdentifyImageBytes)
	}
	for _, t := range AllowedIdentifyImageTypes {
		if in.ImageMediaType == t {
			return nil
		}
	}
	return fmt.Errorf("%w: %q is not an image type this can read", ErrInvalidInput, in.ImageMediaType)
}

// MachineEquipment is the equipment families a photograph of a GYM MACHINE can
// plausibly be.
//
// This is the filter that makes the shortlist tractable: it takes the catalog
// from 762 exercises to roughly 200. The exclusions are the interesting half
// and each is deliberate:
//
//   - `bodyweight` (186), `mobility-area` (69), `floor-space` — there is no
//     machine to photograph. Including them is how "a photo of an empty gym
//     floor" acquires a confident answer.
//   - `dumbbells`, `kettlebell`, `barbell`, `free-weights`, `medicine-ball`,
//     `resistance-band` — real objects, but a rack of dumbbells does not tell
//     you WHICH exercise, and the whole value here is resolving a machine an
//     athlete cannot name. Someone holding a dumbbell already knows.
//   - `suspension-trainer`, `battle-ropes`, `jump-rope`, `plyo-box`, `sandbag`
//     — the same, and rare enough that a wrong hit costs more than the miss.
//
// What stays is what a person genuinely cannot identify by looking: selectorized
// stacks, plate-loaded rigs, cable machines and cardio equipment, which is
// precisely the case N7 was filed for.
var MachineEquipment = []string{
	"cable-stack",
	"selectorized",
	"plate-loaded-machine",
	"smith-machine",
	"landmine-attachment",
	"weighted-sled",
	"treadmill",
	"elliptical",
	"rower",
	"upright-bike",
	"recumbent-bike",
	"indoor-cycle",
	"stair-climber",
	"stepmill",
	"skierg",
	"arc-trainer",
}

// IsMachineEquipment reports whether q is one of the families above.
func IsMachineEquipment(q string) bool {
	for _, m := range MachineEquipment {
		if m == q {
			return true
		}
	}
	return false
}

// Shortlist is the candidate set handed to the model: every catalog exercise
// performed on machine equipment, sorted by id.
//
// **Sorted deliberately, and not for tidiness.** The prompt is the largest part
// of each request and the cheapest thing to cache; a set whose order wanders
// between calls is a different prompt every time and caches nothing. Sorting by
// id also makes the eventual diff of "what changed in the shortlist" readable
// when the catalog moves.
//
// Only PUBLISHED rows. A draft is content the console is still writing, and
// offering one as a candidate produces a tap onto something an athlete is not
// meant to see yet. `NormalizeStatus` is what makes an empty status read as
// published, so a seeded row that predates the column is not silently excluded.
func Shortlist(all []Exercise) []Exercise {
	out := make([]Exercise, 0, 256)
	for _, e := range all {
		if NormalizeStatus(e.Status) != StatusPublished {
			continue
		}
		for _, q := range e.Equipment {
			if IsMachineEquipment(q) {
				out = append(out, e)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ValidateIdentification is the guard, and it is where this feature's honesty
// lives. Nothing below is cosmetic.
//
// It runs against the SHORTLIST that was sent, not against the whole catalog,
// because those are different questions: "is this a real exercise" and "is this
// one of the ones I offered". Only the second one detects a model answering
// from its own memory of gym equipment instead of from the list.
func ValidateIdentification(id Identification, shortlist []Exercise) (Identification, error) {
	byID := make(map[string]Exercise, len(shortlist))
	for _, e := range shortlist {
		byID[e.ID] = e
	}

	kept := make([]Candidate, 0, len(id.Candidates))
	seen := map[string]bool{}
	for _, c := range id.Candidates {
		e, ok := byID[strings.TrimSpace(c.ExerciseID)]
		if !ok {
			// DROPPED, not repaired and not passed through. An id that is not
			// on the list is the model naming equipment from the world rather
			// than from the catalog, and there is no honest way to map it onto
			// a real row — a fuzzy match here would turn "I invented this" into
			// "here is a confident neighbour", which is strictly worse than
			// saying nothing.
			continue
		}
		if seen[e.ID] {
			// Structured outputs do not enforce uniqueness across array items,
			// so the same id can arrive twice and would render as two taps that
			// do the same thing.
			continue
		}
		seen[e.ID] = true
		// The NAME is taken from the catalog, never from the response. A model
		// that returns a valid id with a wrong name would otherwise put a label
		// on screen that no other part of the app agrees with.
		kept = append(kept, Candidate{
			ExerciseID: e.ID,
			Name:       e.Name,
			Confidence: clampConfidence(c.Confidence),
		})
		// NOT capped here. The cap is applied LAST, after the coherence filter
		// below, because capping first discards by RANK what the filter would
		// then remove by CORRECTNESS — a good fifth candidate lost while four
		// incoherent ones ahead of it are dropped anyway, leaving fewer answers
		// than the model actually got right. Found by review of the first
		// version, which capped here.
	}

	if len(kept) == 0 {
		// Everything was invented, or the model genuinely could not tell. Those
		// are the same answer to a client and neither is an error worth
		// retrying.
		return Identification{}, fmt.Errorf("%w: nothing in the catalog matched", ErrIdentifyRefused)
	}

	// The COHERENCE check, and the one worth having beyond "is this id real".
	//
	// N40's lesson was that the dangerous failure is the one nothing flags: its
	// invented item was caught three ways while a doubled quantity was caught
	// not at all, because no downstream check could see it. The equivalent here
	// is a model that reports "treadmill" and returns cable rows — each half
	// individually well-formed, the pair incoherent, and nothing in an
	// id-existence check can see it.
	eq := strings.TrimSpace(id.Equipment)
	if eq == "" {
		// **Candidates with no equipment named is itself incoherent**, and the
		// first version let it straight through — it only ran the check when
		// `eq != ""`, so an empty string skipped the guard entirely.
		//
		// That was not merely a thin spot. The published contract said
		// `equipment` is "guaranteed to be used by at least one candidate",
		// which was FALSE on exactly this path, and the schema invites it: the
		// field's own description offers an empty string for "none visible".
		// A model that names no equipment while naming four exercises has
		// contradicted the prompt, which tells it that candidates must use the
		// equipment it reports.
		//
		// Refusing rather than deriving the family from the candidates: that
		// would be the server inventing the half the model declined to give,
		// which is the same move as fuzzy-matching an invented id.
		//
		// **DELETING THIS BRANCH WILL NOT FAIL THE SUITE, AND IT IS STILL
		// LOAD-BEARING.** Measured: with `eq == ""` no candidate can match it,
		// so the filter below refuses anyway and every assertion about the
		// OUTCOME still passes. What changes is what the refusal SAYS — the
		// filter's message is "every candidate is other equipment", which is a
		// misleading description of a response that named no equipment at all,
		// and the operator reading it would go looking for the wrong bug.
		//
		// So this branch exists for its message rather than its outcome, and
		// the test pins it by asserting the message. Recorded here because a
		// surviving mutation reads as dead code, and the next person to notice
		// one here will be tempted to delete it.
		return Identification{}, fmt.Errorf(
			"%w: %d candidates but no equipment named", ErrIdentifyRefused, len(kept))
	}

	// EVERY candidate must use the reported equipment, not merely one of them.
	//
	// The first version asked whether ANY candidate agreed, which let a
	// treadmill answer carry two cable-machine candidates through on the
	// strength of a third that matched. That is weaker than the prompt, which
	// tells the model its candidates must all use the equipment it reports — and
	// a guard looser than its own instruction cannot detect the instruction
	// being ignored, which is the only reason it exists.
	//
	// Non-matching candidates are DROPPED rather than failing the whole answer,
	// so a mostly-right response still helps: the athlete gets the coherent
	// candidates instead of nothing. If that empties the list, the two halves
	// disagreed completely and it becomes a refusal.
	coherent := kept[:0:0]
	for _, c := range kept {
		for _, q := range byID[c.ExerciseID].Equipment {
			if q == eq {
				coherent = append(coherent, c)
				break
			}
		}
	}
	if len(coherent) == 0 {
		return Identification{}, fmt.Errorf(
			"%w: reported %q but every candidate is other equipment", ErrIdentifyRefused, eq)
	}

	if len(coherent) > MaxCandidates {
		coherent = coherent[:MaxCandidates]
	}
	id.Equipment = eq
	id.Candidates = coherent
	return id, nil
}

// clampConfidence keeps a reported score inside 0..1.
//
// Not a validation failure: the score is advisory, and rejecting an otherwise
// good identification because a model said 1.2 would throw away the useful part
// of the answer over the decorative part.
func clampConfidence(f float64) float64 {
	switch {
	case f < 0:
		return 0
	case f > 1:
		return 1
	default:
		return f
	}
}
