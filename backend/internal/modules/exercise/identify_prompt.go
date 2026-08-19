package exercise

import (
	"strings"
)

// The prompt and schema for machine identification.
//
// Kept beside the domain rather than in `internal/platform/llm`, deliberately
// and for the reason N36's package comment gives: the transport owns the call,
// the feature owns the prompt, the schema, the parse and the validation. A
// prompt in the transport is one feature's rules leaking into another's.

// identifySystemPrompt is the instruction.
//
// Three things in it are load-bearing and should not be softened by anyone
// tuning this later:
//
//  1. **"Only ids from the list."** This is the whole shortlist design. Without
//     it the model answers from its own knowledge of gyms, which produces
//     confident ids that do not exist here.
//  2. **"Return an empty list rather than guessing."** A model given a closed
//     set and no matching option will otherwise pick the nearest member, and
//     the nearest member of 200 machine exercises is always *something*. An
//     empty answer has to be made explicitly acceptable or it never happens.
//  3. **Ranked, several.** Asking for one answer invites overcommitment;
//     asking for a ranked few lets the model express genuine ambiguity between
//     a lat pulldown and a high row instead of hiding it.
const identifySystemPrompt = `You identify gym equipment in a photograph.

You are given a numbered list of exercises, each with an id, a name and the equipment it uses. The list is the ONLY vocabulary you may answer with.

Rules:
- Return exercise ids ONLY from the provided list, copied exactly. Never invent an id, never modify one, and never answer with equipment that is not on the list.
- Rank your answers most likely first, at most 4.
- If the photograph does not clearly show a machine from the list — it is a person, a room, a free weight, food, a screen, or simply unclear — return an EMPTY candidates array. An empty answer is correct and expected. Do not pick the closest option to avoid returning nothing.
- Set "equipment" to the equipment family you actually see, using the exact spelling from the list. If you return candidates, they must use that equipment.
- "confidence" is how clearly you can see and identify the machine, from 0 to 1. It is not a promise that you are right.

Judge only what is visible. Do not infer a machine from a gym logo, a sign, a floor plan or text in the image.`

// identifyUserPrompt renders the shortlist.
//
// Format chosen for token cost rather than looks: one line per exercise, id
// first because that is the only field the model must reproduce verbatim. At
// ~200 exercises this is roughly 3-4K tokens, which is the bulk of each call
// and the reason the shortlist is sorted — a stable prefix is a cacheable one.
//
// The equipment is included per row because the coherence check in
// `ValidateIdentification` compares the model's reported equipment against the
// candidates' real equipment; the model cannot satisfy that check without
// seeing which family each exercise belongs to.
func identifyUserPrompt(shortlist []Exercise) string {
	var b strings.Builder
	b.Grow(len(shortlist) * 64)
	b.WriteString("Exercises available in this gym:\n")
	for _, e := range shortlist {
		b.WriteString(e.ID)
		b.WriteString(" | ")
		b.WriteString(e.Name)
		b.WriteString(" | ")
		b.WriteString(strings.Join(e.Equipment, ","))
		b.WriteByte('\n')
	}
	b.WriteString("\nWhich of these does the photograph show?")
	return b.String()
}

// IdentifySchema is the JSON schema the response must satisfy.
//
// Both providers demand `additionalProperties: false` everywhere and every
// property listed in `required`, which is why one schema serves both — see the
// note on `llm.Request.Schema`. `required` here does NOT mean "must be
// non-empty": `candidates` is required to be PRESENT and is explicitly allowed
// to be an empty array, which is the refusal path the prompt asks for.
func IdentifySchema() map[string]any {
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"equipment", "candidates"},
		"properties": map[string]any{
			"equipment": map[string]any{
				"type":        "string",
				"description": "The equipment family visible, spelled exactly as in the list. Empty string if none.",
			},
			"candidates": map[string]any{
				"type": "array",
				// Capped at the schema level as well as in Go. The Go cap is
				// what is enforced; this one saves tokens on a model that would
				// otherwise pad the list toward some remembered maximum.
				"maxItems":    MaxCandidates,
				"description": "Ranked, most likely first. Empty when nothing on the list matches.",
				"items": map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"required":             []string{"exercise_id", "confidence"},
					"properties": map[string]any{
						"exercise_id": map[string]any{
							"type":        "string",
							"description": "An id copied exactly from the list.",
						},
						"confidence": map[string]any{
							"type":    "number",
							"minimum": 0,
							"maximum": 1,
						},
					},
				},
			},
		},
	}
}
