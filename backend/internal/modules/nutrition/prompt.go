package nutrition

import "strings"

// The prompt, shared by every provider.
//
// Its own file because it is the thing most likely to be tuned, and a
// comparison between providers is only meaningful if they are given identical
// instructions. A provider-specific prompt would make "which model is better"
// unanswerable.

// estimateMaxTokens bounds the response.
//
// On providers where thinking shares the budget with the response, a value
// sized to the JSON alone truncates mid-object and yields a parse failure that
// reads like a model fault. Sized with headroom for that reason even though the
// default model does not think.
const estimateMaxTokens = 8192

// estimateSystemPrompt is deliberately short.
//
// Prompts written for older models tend to be over-prescriptive and reduce
// output quality on current ones, and the schema already carries the
// field-level instructions — repeating them here would be two sources for one
// rule. What is left is the part a schema cannot express: who this is for, and
// what honesty means here.
//
// The last paragraph was added after measurement, not from first principles.
// Without it, roughly a third of live calls returned degenerate output —
// placeholder rows with zeroed numbers, empty names, the same item twice —
// because the schema guarantees the KEYS are present and says nothing about
// them being meaningful. Nine runs after adding it: none of those.
const estimateSystemPrompt = `You estimate the nutrition of a meal an athlete has just eaten, so they can log it.

They will see your numbers as an editable draft and correct them. That makes a stated assumption far more useful than a confident guess: when you have to decide something you cannot see — portion size, cooking fat, whether the coffee had milk — put it in that item's assumption field so they know which number to fix.

Say what you actually see or are told. Do not add items to make a meal look complete, and do not round a portion toward a typical serving when the evidence points elsewhere. If a photo shows food you cannot identify, say so in the note rather than naming a guess as though you were sure.

List each component once, under the name someone would call it. If you genuinely cannot make anything out, return an empty items list and explain why in the note — an empty list is a fine answer. Never emit an item as a placeholder, with an empty name, or with zeroed numbers to fill the shape: a row the athlete cannot act on is worse than no row.`

// userPrompt is the athlete's own words, plus the slot as portion context.
func userPrompt(in EstimateInput) string {
	var b strings.Builder
	desc := strings.TrimSpace(in.Description)
	switch {
	case desc != "" && len(in.Image) > 0:
		b.WriteString("This is what I ate. My own description: ")
		b.WriteString(desc)
	case desc != "":
		b.WriteString("This is what I ate: ")
		b.WriteString(desc)
	default:
		b.WriteString("This is what I ate.")
	}
	if in.Meal != "" {
		// Context for portion sizing only — a breakfast portion of oats and a
		// dinner one differ. Never a constraint on what may be returned.
		b.WriteString("\n\nLogged as: ")
		b.WriteString(string(in.Meal))
	}
	return b.String()
}
