package nutrition

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// Describe a meal, or photograph it, and get a DRAFT back.
//
// # A draft, never an entry
//
// Nothing here writes to nutrition_entries. The response populates the
// quick-add sheet with editable rows and the athlete confirms — the same
// posture as the weekly adjustment rule and the project's auditable-
// recommendations principle. A model that logs food without confirmation is a
// model whose mistakes are indistinguishable from the athlete's own history,
// and this module's whole design rests on a logged row being what the athlete
// said they ate.
//
// # Why portion confidence is a first-class field
//
// Naming a food from a photo is reliable; judging how MUCH of it is on the
// plate is not, and the two failure modes are nothing alike. "That is rice"
// wrong is obvious to the athlete; "that is 180g of rice" wrong by a factor of
// two is invisible and moves the day's remaining figure by 300 kcal. So the
// schema forces the model to say which it is, per item, and the client
// pre-focuses the quantity field when it says low.
//
// # Text first
//
// The text path covers most logging at a fraction of the cost — no image
// tokens at all — which is why it is not an afterthought bolted to the photo
// feature. It is the feature; the photo is the fallback for a meal you cannot
// describe.

// EstimateSource is which path produced a draft. Recorded on the usage row so
// the two quotas can be counted separately: a photo is the dearer path, though
// only just — ~1.1x a description on the shipped model, measured, against the
// ~50x an early version of this comment claimed. See quota.go for the numbers
// and for why the split is now a precaution rather than the cost control.
type EstimateSource string

const (
	// SourceText is a described meal: "two eggs, sourdough and butter".
	SourceText EstimateSource = "text"
	// SourcePhoto is an image, with or without accompanying text.
	SourcePhoto EstimateSource = "photo"
)

// PortionConfidence is how sure the model is about the QUANTITY — never about
// the identification. An item can be a confidently-named food at a wildly
// uncertain portion, and that is the common case for a photo.
type PortionConfidence string

const (
	ConfidenceHigh   PortionConfidence = "high"
	ConfidenceMedium PortionConfidence = "medium"
	ConfidenceLow    PortionConfidence = "low"
)

// Valid reports whether c is one of the three the schema allows.
func (c PortionConfidence) Valid() bool {
	switch c {
	case ConfidenceHigh, ConfidenceMedium, ConfidenceLow:
		return true
	}
	return false
}

var (
	// ErrNoInput is a request with neither text nor an image.
	ErrNoInput = errors.New("nutrition: describe the meal or attach a photo")
	// ErrQuotaExhausted is the per-athlete daily cap. Its own error rather than
	// a generic invalid-input, because the client's response is to say when the
	// cap resets rather than to change the request.
	ErrQuotaExhausted = errors.New("nutrition: daily estimate limit reached")
	// ErrEstimateRefused is the model declining. Distinct from a failure: the
	// request reached Claude and came back with nothing usable, so a retry of
	// the same input will not help.
	ErrEstimateRefused = errors.New("nutrition: could not read that as food")
	// ErrEstimateUnavailable is the upstream being unreachable or erroring.
	// Retryable, unlike a refusal.
	ErrEstimateUnavailable = errors.New("nutrition: estimation is unavailable")
	// ErrEstimateUnreachable is the provider never answering at all — a refused
	// connection, a DNS failure, a revoked key, an upstream 5xx.
	//
	// **It WRAPS ErrEstimateUnavailable rather than sitting beside it**, which
	// is what makes this change safe to add. Every existing `errors.Is(err,
	// ErrEstimateUnavailable)` — the handler's status mapping, anything a
	// future caller writes — keeps matching, so the failure mode of forgetting
	// this sentinel is "behaves as before", not "falls through to a 500".
	// A separate sentinel would have made the safe default the wrong one.
	//
	// What it changes is one thing: the handler does not METER a call that
	// carries it. Nothing was spent, so nothing is charged — see F16 (#367),
	// and `llm.ErrUnreachable` for which failures qualify and which
	// deliberately do not.
	ErrEstimateUnreachable = fmt.Errorf("%w: the provider never answered", ErrEstimateUnavailable)
	// ErrEstimateTimeout is OUR OWN deadline firing — the provider was still
	// thinking when `estimateTimeout` ran out and we stopped waiting.
	//
	// **It wraps ErrEstimateUnavailable and NOT ErrEstimateUnreachable**, and
	// that placement is the whole of its meaning rather than a detail. The
	// unreachable sentinel is the F16 exemption: nothing was spent, so nothing
	// is metered. A call we abandoned mid-flight is the opposite case — the
	// request reached the provider and the tokens are very likely already
	// bought — and `llm.ErrUnreachable`'s own doc comment says so explicitly of
	// cancelled and timed-out calls. So this one IS metered, exactly as an
	// unmapped upstream failure is, and the only thing it changes is the status
	// and the sentence the athlete reads.
	//
	// It exists because the two are indistinguishable to a client otherwise:
	// before this, a slow provider produced no HTTP response at all, and a
	// phone that receives no response has nothing to say except that it could
	// not reach us. See N92 (#433).
	ErrEstimateTimeout = fmt.Errorf("%w: no answer before our deadline", ErrEstimateUnavailable)
)

// MaxDescriptionRunes bounds the text path.
//
// A meal description is a sentence. This is not a safety limit — it is a cost
// one: the endpoint is the only place in this API where an unbounded input
// turns directly into somebody's money, and a caller pasting a novel would pay
// for it token by token.
const MaxDescriptionRunes = 600

// MaxImageBytes bounds the photo path, before base64 expansion.
//
// 5 MB is comfortably above what a phone camera produces after the client's
// own downscale and well below the API's own 32 MB request ceiling, leaving
// room for the ~33% base64 overhead and the surrounding JSON.
const MaxImageBytes = 5 << 20

// AllowedImageTypes is the set the vision API accepts. Checked against the
// DECODED bytes' sniffed type rather than a client-supplied header, since a
// content-type is a claim and a magic number is evidence.
var AllowedImageTypes = []string{"image/jpeg", "image/png", "image/gif", "image/webp"}

// EstimateInput is what the athlete supplies. Both fields may be present — a
// photo of a plate plus "the sauce is peanut" is the strongest input there is,
// because it pairs what the camera can see with what it cannot.
type EstimateInput struct {
	Description string
	// Image is raw bytes, already decoded from whatever transport carried them.
	// Nil for the text path.
	Image []byte
	// ImageMediaType is the sniffed type, not the declared one.
	ImageMediaType string
	// Meal is the slot the athlete is logging into, passed to the model only as
	// context for portion sizing — a breakfast portion of oats and a dinner one
	// differ. It never constrains what the model may return.
	Meal Meal
	// ReuseSaved allows this request to be answered from a food the athlete has
	// already saved instead of generating one. Set from the request by
	// `parseEstimateRequest`, which defaults it to TRUE — reuse is the point of
	// N114, and a client that says nothing gets it.
	//
	// **The zero value is therefore the opposite of the default, and that is
	// deliberate.** A value constructed in Go rather than parsed from a request
	// — a test fixture, a future internal caller — generates rather than
	// reuses. Generating when we could have reused costs an allowance slice;
	// reusing when we should not have puts a different food's numbers in
	// somebody's log. Only one of those is recoverable, so the zero value falls
	// to the recoverable side.
	//
	// The escape hatch exists because a saved food can be WRONG. Without it, an
	// athlete who saved a bad "Pork Shashlik" would get it back forever with no
	// way to ask for a fresh reading — the feature would have replaced one
	// complaint with a worse one.
	ReuseSaved bool
}

// Source reports which quota this input draws on.
func (in EstimateInput) Source() EstimateSource {
	if len(in.Image) > 0 {
		return SourcePhoto
	}
	return SourceText
}

// Validate checks the input before any token is spent.
func (in EstimateInput) Validate() error {
	desc := strings.TrimSpace(in.Description)
	if desc == "" && len(in.Image) == 0 {
		return ErrNoInput
	}
	if len([]rune(desc)) > MaxDescriptionRunes {
		return fmt.Errorf("%w: description is longer than %d characters", ErrInvalidInput, MaxDescriptionRunes)
	}
	if len(in.Image) > MaxImageBytes {
		return fmt.Errorf("%w: image is larger than %d bytes", ErrInvalidInput, MaxImageBytes)
	}
	if len(in.Image) > 0 {
		ok := false
		for _, t := range AllowedImageTypes {
			if in.ImageMediaType == t {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("%w: %q is not an image type this can read", ErrInvalidInput, in.ImageMediaType)
		}
	}
	if in.Meal != "" && !in.Meal.valid() {
		return fmt.Errorf("%w: unknown meal %q", ErrInvalidInput, in.Meal)
	}
	return nil
}

// EstimatedItem is one component of the meal, as the model read it.
//
// Deliberately shaped like the quick-add form rather than like a food: the
// athlete's next action is to correct these numbers, so the fields are the
// fields they will edit. It carries no id and no `source_food_id` — a draft
// has no provenance because nothing produced it but a guess.
type EstimatedItem struct {
	Name         string  `json:"name"`
	ServingLabel string  `json:"serving_label"`
	Servings     float64 `json:"servings"`

	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbG    float64 `json:"carb_g"`
	FatG     float64 `json:"fat_g"`
	// FibreG is a pointer for the same reason it is everywhere else in this
	// module: absent means the model did not state it, which is not zero.
	FibreG *float64 `json:"fibre_g"`

	// PortionConfidence is about the QUANTITY only — see the type's comment.
	PortionConfidence PortionConfidence `json:"portion_confidence"`
	// Assumption is the free-text thing the model had to decide in order to
	// answer at all: "assumed a medium egg", "assumed the bowl is 300ml". This
	// is what makes a wrong number correctable rather than merely wrong — the
	// athlete reads the assumption and knows which field to fix.
	Assumption string `json:"assumption"`
}

// Estimate is the whole draft.
type Estimate struct {
	Items []EstimatedItem `json:"items"`
	// Note is the model's message about the estimate as a whole, if any —
	// typically what it could not see. Empty is normal and not an error.
	Note string `json:"note"`
	// Model records which model produced this, so a later quality question can
	// be answered rather than guessed at.
	Model string `json:"model"`
	// Source is which path was used, echoed so the client need not infer it.
	Source EstimateSource `json:"source"`
	// Match is set when this draft was NOT generated — it came from a food the
	// athlete had already saved, and no model was called and no allowance
	// spent. Nil for every generated draft.
	//
	// The presence of this field is the whole discriminator, and it carries its
	// own explanation rather than a bare flag: see SavedMatch in savedmatch.go.
	Match *SavedMatch `json:"match,omitempty"`
}

// MaxEstimatedItems bounds a single draft.
//
// A meal is a handful of components. The cap exists because the number of rows
// is the number of fields the athlete has to check, and a twenty-row draft of
// a sandwich is slower to correct than typing it — at which point the feature
// has made logging worse.
const MaxEstimatedItems = 12

// ValidateEstimate checks what came back before it reaches a client.
//
// The model is constrained by a JSON schema, so the SHAPE is guaranteed. What
// is not guaranteed is that the values are sane — structured outputs enforce
// types, never ranges — so negatives, absurd magnitudes and an unrecognised
// confidence are all still possible and all still checked here.
func ValidateEstimate(e Estimate) error {
	if len(e.Items) == 0 {
		return fmt.Errorf("%w: nothing recognisable", ErrEstimateRefused)
	}
	if len(e.Items) > MaxEstimatedItems {
		return fmt.Errorf("%w: %d items is more than a meal", ErrInvalidInput, len(e.Items))
	}
	for i, it := range e.Items {
		if strings.TrimSpace(it.Name) == "" {
			return fmt.Errorf("%w: item %d has no name", ErrInvalidInput, i)
		}
		if !it.PortionConfidence.Valid() {
			return fmt.Errorf("%w: item %d has confidence %q", ErrInvalidInput, i, it.PortionConfidence)
		}
		for _, f := range []struct {
			name string
			v    float64
			max  float64
		}{
			{"kcal", it.Kcal, maxItemKcal},
			{"protein_g", it.ProteinG, maxItemGrams},
			{"carb_g", it.CarbG, maxItemGrams},
			{"fat_g", it.FatG, maxItemGrams},
			{"servings", it.Servings, maxItemServings},
		} {
			if err := sane(f.name, i, f.v, f.max); err != nil {
				return err
			}
		}
		if it.FibreG != nil {
			if err := sane("fibre_g", i, *it.FibreG, maxItemGrams); err != nil {
				return err
			}
		}
	}
	return nil
}

// The magnitudes above which a number is not food.
//
// These are ABSURDITY bounds, not correctness ones, and the distinction is why
// they are set so far above any real meal: a rail that fires on an ordinary
// case is an unevidenced second opinion about the athlete's dinner, and this
// module has already been bitten once by rails tuned too tight. Nothing here
// should ever fire on something somebody ate. What they catch is garbage —
// a misplaced decimal, a units confusion, or an infinity.
const (
	// Eight times a day's intake, in one item.
	maxItemKcal = 20000
	// Five kilograms of one macronutrient.
	maxItemGrams = 5000
	// A thousand of anything.
	maxItemServings = 1000
)

// sane rejects the values a JSON schema cannot.
//
// Structured outputs guarantee that a field is a number; they cannot express a
// range, so negatives, NaN, infinities and absurd magnitudes all arrive
// looking perfectly well-typed.
//
// The form is `!(v >= 0)` rather than `v < 0` because every comparison with
// NaN is false, so the second would wave NaN straight through — and Postgres
// numeric accepts 'NaN', so it would reach the column and poison every sum it
// takes part in. **`math.IsInf` is a separate check for the mirror reason:**
// `+Inf >= 0` is TRUE, so the NaN-safe form alone lets infinity past. That gap
// was real here until a test caught it.
func sane(field string, idx int, v, max float64) error {
	if math.IsInf(v, 0) {
		return fmt.Errorf("%w: item %d has %s = %v", ErrInvalidInput, idx, field, v)
	}
	if !(v >= 0) {
		return fmt.Errorf("%w: item %d has %s = %v", ErrInvalidInput, idx, field, v)
	}
	if v > max {
		return fmt.Errorf("%w: item %d has %s = %v, which is not food", ErrInvalidInput, idx, field, v)
	}
	return nil
}

// EstimateSchema is the JSON schema the model's output is constrained to.
//
// Structured outputs require `additionalProperties: false` and every field in
// `required`, and they do NOT support numeric `minimum`/`maximum` — which is
// exactly why `ValidateEstimate` above exists rather than being redundant with
// this. The schema buys the shape; the Go code buys the range.
//
// A map literal rather than a struct with tags, because the schema is data the
// API consumes and never something this package unmarshals into.
func EstimateSchema() map[string]any {
	item := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"name": map[string]any{
				"type": "string",
				"description": "What this component is, as an athlete would say it. 'Scrambled eggs', not 'Egg, whole, cooked, scrambled'. " +
					"Never empty and never a placeholder — if you cannot name it, leave it out of the list entirely and say so in the note.",
			},
			"serving_label": map[string]any{
				"type":        "string",
				"description": "How the quantity is counted: '1 slice', '100 g', '1 medium egg'. Human phrasing, not a unit code.",
			},
			"servings": map[string]any{
				"type":        "number",
				"description": "How many of serving_label. Two eggs with serving_label '1 medium egg' is 2.",
			},
			"kcal":      map[string]any{"type": "number", "description": "Calories for the whole quantity, not per serving."},
			"protein_g": map[string]any{"type": "number", "description": "Protein in grams for the whole quantity."},
			"carb_g":    map[string]any{"type": "number", "description": "Carbohydrate in grams for the whole quantity."},
			"fat_g":     map[string]any{"type": "number", "description": "Fat in grams for the whole quantity."},
			"fibre_g": map[string]any{
				"type": []any{"number", "null"},
				"description": "Fibre in grams for the whole quantity. State it for every item. " +
					"Zero is the correct answer for foods that contain none — meat, eggs, cheese, oil — and is not the same as declining to answer. " +
					"Use null only when you genuinely cannot say; the athlete sees null as a blank they have to fill in themselves.",
			},
			"portion_confidence": map[string]any{
				"type": "string",
				"enum": []any{"high", "medium", "low"},
				"description": "How sure you are about the QUANTITY, not about what the food is. A clearly identified food at an unclear portion is 'low'. " +
					"'high': the amount is stated or directly countable — 'two eggs', a labelled packet, three visible slices. " +
					"'medium': a recognisable item at an ordinary serving. " +
					"'low': the amount is genuinely unclear — a mixed dish, a restaurant plate with nothing for scale. " +
					"Do not claim 'high' because the food is obvious, and do not retreat to 'low' when the athlete has told you the amount.",
			},
			"assumption": map[string]any{
				"type": "string",
				"description": "The judgement you had to make to give a number at all — 'assumed a medium egg', 'assumed the bowl holds 300ml'. " +
					"Empty string if there was nothing to assume. This is what lets the athlete correct the right field.",
			},
		},
		"required": []any{
			"name", "serving_label", "servings",
			"kcal", "protein_g", "carb_g", "fat_g", "fibre_g",
			"portion_confidence", "assumption",
		},
		"additionalProperties": false,
	}

	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"items": map[string]any{
				"type":  "array",
				"items": item,
				"description": "One entry per component the athlete would correct separately, each appearing once. A sandwich is usually one item, not five. " +
					"May be empty when nothing could be identified — an empty list plus a note is a better answer than an invented row.",
			},
			"note": map[string]any{
				"type":        "string",
				"description": "Anything the athlete should know about this estimate as a whole — typically what you could not see. Empty string if there is nothing.",
			},
		},
		"required":             []any{"items", "note"},
		"additionalProperties": false,
	}
}
