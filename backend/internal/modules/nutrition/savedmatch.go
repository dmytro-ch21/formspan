package nutrition

import (
	"context"
	"strings"
	"time"
)

// Reusing a food the athlete has already saved, instead of generating it again.
//
// # The failure this exists to end
//
// N114, reported from a device: *"I entered Pork Shashlik 3 times and every
// time it would generate a new item — it wasn't stored."* Three generations for
// one food, three slices of a 25-a-day allowance, and three sets of numbers
// that need not agree with each other. The same dish could be 480 kcal on
// Monday and 610 on Wednesday, and nothing on the screen would say why.
//
// # Why the rule is EXACT and not fuzzy
//
// The ticket is explicit that "fuzzy matching that silently substitutes a
// different food is worse than generating again", and it is right: a
// regeneration costs an allowance slice, a wrong substitution puts numbers in
// the athlete's log that belong to a different meal and says nothing. The
// asymmetry is total — one is a cost, the other is a corruption — so the rule
// is the most conservative one that still answers the report:
//
//	NormalizeFoodName(description) == NormalizeFoodName(saved.Name)
//
// and nothing else. That is what makes it explainable in the sense the ticket
// asks for: a reviewer can say "Pork Shashlik" matched because it normalises to
// exactly `pork shashlik`, and "Pork Shashlik (spicy)" did not because it
// normalises to `pork shashlik (spicy)`, which no saved row equals. There is no
// similarity threshold to argue about and no ranking to be surprised by.
//
// Deliberately NOT normalised away, each because erasing it would merge two
// foods an athlete keeps apart:
//
//   - punctuation and brackets — `(spicy)`, `- no sauce`, `2%` are the athlete's
//     own way of distinguishing variants, and they are usually the ONLY thing
//     distinguishing them;
//   - digits — `Skyr 0%` and `Skyr 10%` are different foods;
//   - plurals and stemming — an English rule applied to a multilingual food
//     list produces confident nonsense.
//
// What IS normalised is only what nobody means to type: case, surrounding
// whitespace, and runs of internal whitespace. Those three are the ways the
// SAME string gets typed twice, which is the whole population this feature
// serves.
//
// # Why this is decided on the SERVER
//
// The phone could match against its own SQLite copy before ever making the
// call, and that would additionally work offline. It deliberately does not.
// Two implementations of one matching rule is two rules, and this repo has paid
// twice (W2, W4) for two figures on one screen computed under two rules. One
// rule, one place, and the client renders what it is told.

// MatchRule names the rule that produced a reuse.
//
// A field on the wire rather than prose, so a client can say WHY without
// parsing a sentence and a future second rule cannot be mistaken for this one.
// Only one value exists on purpose — see the type's package comment.
type MatchRule string

// MatchExactName is normalised-equal names: the whole description, lowercased,
// trimmed, internal whitespace collapsed, equal to a saved food's name under the
// same treatment.
const MatchExactName MatchRule = "exact_name"

// SavedMatch explains a reuse, and is the ONLY thing that distinguishes a
// reused draft from a generated one on the wire.
//
// Its presence is the discriminator rather than a boolean beside it: a
// `reused: true` with no `match` object would be a claim a client could render
// and nobody could check, and the ticket asks for the opposite — an athlete who
// can tell which they got, and a reviewer who can say why.
type SavedMatch struct {
	// FoodID is the saved row this draft came from. The client logs the entry
	// with it as `source_food_id`, which is what makes the reuse show up in the
	// quick-add recents afterwards.
	FoodID string `json:"food_id"`
	// Name is the STORED name, verbatim — not the athlete's query and not a
	// normalised form. It is what the athlete will see, so it has to be the
	// string they saved.
	Name string `json:"name"`
	// Rule is which rule fired.
	Rule MatchRule `json:"rule"`
	// Normalized is the string both sides were compared as. Carried so the
	// match is checkable from the response alone: an athlete or a reviewer
	// looking at a surprising match can see exactly what was compared.
	Normalized string `json:"normalized"`
	// FoodSource is how the SAVED row was itself produced — `ai` for one drafted
	// from an earlier estimate, `user` for one typed by hand. Different things
	// to trust, so they must stay tellable apart; see Source's own comment.
	FoodSource Source `json:"food_source"`
	// SavedAt is when the stored row last changed, so the screen can say how old
	// the numbers being reused are.
	SavedAt time.Time `json:"saved_at"`
}

// SavedFoodFinder looks a food up by its normalised name.
//
// A separate port from Repository, holding exactly one method, because
// EstimateHandler must not gain the ability to write the food log. It is the
// same argument that keeps EstimateHandler off the nutrition Handler in the
// first place: the estimate path holds an API key and a spend meter, and the
// less of the food log it can reach, the smaller that blast radius is.
type SavedFoodFinder interface {
	// FindFoodByNormalizedName returns the caller's saved food whose name
	// normalises to `normalized`, or ErrNotFound.
	//
	// Scoped to userID INSIDE the query, never filtered afterwards — an athlete
	// must not be able to discover, or reuse, another athlete's food by naming
	// it.
	FindFoodByNormalizedName(ctx context.Context, userID, normalized string) (Food, error)
}

// NormalizeFoodName is the one normalisation both sides of a match go through.
//
// Lowercase, trim, and collapse runs of internal whitespace. Nothing else — see
// the package comment above for what is deliberately left alone and why.
//
// **The SQL expression in migration 000074 must stay identical to this.** They
// are two spellings of one rule, and a rule spelled twice is a rule that can
// disagree with itself; `TestTheSQLNormalisationAgreesWithTheGoOne` compares
// them against the same vectors on a real database rather than trusting that
// they look alike.
func NormalizeFoodName(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

// MaxMatchableRunes bounds what will even be looked up.
//
// A saved food's name is at most 120 runes (the column's CHECK), so a longer
// description cannot equal one and asking is pure cost. It also stops a
// 600-rune description — the endpoint's own limit — being turned into an index
// probe on every call.
const MaxMatchableRunes = 120

// Matchable reports whether this input is one a reuse can be attempted for, and
// returns the normalised form to look up.
//
// Four refusals, each of which would otherwise produce a confidently wrong
// answer:
//
//   - **The caller asked for a fresh reading.** `reuse=false` is how an athlete
//     escapes a saved food whose numbers are wrong; honouring it is what stops
//     this feature becoming a trap they cannot get out of.
//   - **A photo never matches.** The athlete is asking what is on this plate;
//     answering with a food they saved last month because the caption happened
//     to repeat its name would substitute a different meal, which is the exact
//     thing the exact-match rule exists to avoid. A description accompanying a
//     photo is context for the picture, not a name to look up.
//   - **An empty description** has nothing to compare.
//   - **A description longer than a name can be** cannot equal one.
func (in EstimateInput) Matchable() (string, bool) {
	if !in.ReuseSaved {
		return "", false
	}
	if len(in.Image) > 0 {
		return "", false
	}
	norm := NormalizeFoodName(in.Description)
	if norm == "" || len([]rune(norm)) > MaxMatchableRunes {
		return "", false
	}
	return norm, true
}

// DraftFromSavedFood turns a stored food into the same draft shape a generation
// produces, so the client renders ONE screen rather than two.
//
// Quantity is one serving, and that is a statement rather than a default: the
// athlete defined what a serving of this food is when they saved it, so one of
// them is the only quantity this function can honestly propose. They change it
// on the next screen exactly as they would correct a generated one.
//
// Three fields carry the difference from a generated draft:
//
//   - PortionConfidence is `high`, because the quantity is the athlete's own
//     serving definition rather than a model's reading of a plate. This is the
//     "different confidence" the ticket asks for, in the field that already
//     means it.
//   - Assumption is empty. There was no judgement to make — nothing was
//     estimated — and putting a sentence here would invent one.
//   - Model is empty, because no model produced this. A model name on a row
//     nothing generated is a provenance claim that is simply false.
//
// A recipe reuses its PER-SERVING numbers, which the repository already stores
// on the parent row for exactly this kind of read.
func DraftFromSavedFood(f Food, in EstimateInput, normalized string) Estimate {
	per := f.PerServing()
	return Estimate{
		Items: []EstimatedItem{{
			Name:         f.Name,
			ServingLabel: f.ServingLabel,
			Servings:     1,
			Kcal:         per.Kcal,
			ProteinG:     per.ProteinG,
			CarbG:        per.CarbG,
			FatG:         per.FatG,
			FibreG:       per.FibreG,

			PortionConfidence: ConfidenceHigh,
			Assumption:        "",
		}},
		// Empty rather than a sentence about reuse. `Note` is the MODEL's
		// message about an estimate, and this draft has no model behind it —
		// the client renders the reuse from Match, which is data it can check.
		Note: "",
		// Deliberately NOT stamped with a model. See above.
		Model:  "",
		Source: in.Source(),
		Match: &SavedMatch{
			FoodID:     f.ID,
			Name:       f.Name,
			Rule:       MatchExactName,
			Normalized: normalized,
			FoodSource: f.Source,
			SavedAt:    f.UpdatedAt,
		},
	}
}
