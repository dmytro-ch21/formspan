// Package nutrition is what the athlete is trying to eat, and what they
// actually ate.
//
// # Three things, and they change on three different clocks
//
// A **target** is a decision that holds for weeks. An **entry** is one item
// eaten on one day. A **food** is a saved thing you eat repeatedly — including
// a recipe, which is a food whose numbers were summed from components.
//
// Keeping them separate is what makes history readable. A target is stored
// per-date rather than as a single mutable row, so a day logged in March is
// judged against March's target and not against whatever the athlete is eating
// to now. Every derived screen depends on that; a single `current_target`
// column would silently rewrite every past week the first time somebody
// adjusted their intake.
//
// # The rule this module exists to protect: a logged row owns its numbers
//
// An entry stores the kcal and macros it was logged with. `SourceFoodID` is
// provenance — it answers "log this again" — and NOTHING reads nutrition back
// through it. The same holds one level down: a recipe's items copy their
// components' numbers rather than referencing them.
//
// The tempting shape is a join. It is shorter, it compiles, and it passes every
// test, because the damage is invisible: correct a saved food from 180 to 210
// kcal and every entry you ever logged from it silently changes, along with
// every average and every trend an athlete was using to learn something. There
// is nothing left to compare against, so nothing goes red. It is the same
// reasoning that keeps `plans` free of a `completed` flag — a stored status is
// a status that keeps lying.
//
// The rule is therefore about QUERIES, not just columns: no SELECT that returns
// nutrition may reach nutrition_foods from nutrition_entries. It is pinned by
// an integration test that edits a food after logging it.
//
// It also buys the offline day screen: the phone renders a day with no join,
// which is what `exercise_cache.payload_json` already learned — a log you can
// write but not read is not offline support.
//
// # What this module deliberately does not do
//
// **It does not sum the day the client is editing.** The phone's outbox holds
// entries the server has never seen, so a server-side total is not stylistically
// wrong there but NUMERICALLY wrong, during the exact minute somebody is
// looking at it. `DayTotals` exists for read-only windows — a month you are
// reviewing, not the day you are eating.
//
// It DOES compute the target (see target.go), and that is a departure from the
// body module's "no computing" stance, argued there.
package nutrition

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrNotFound     = errors.New("nutrition: not found")
	ErrInvalidInput = errors.New("nutrition: invalid input")
)

// Meal is which sitting an entry belongs to.
//
// A closed vocabulary rather than free text, because the day screen groups on
// it and a typo'd slot would render as a fourth section nobody can merge.
//
// The client assigns it from the wall clock at log time and STORES it. It is
// never re-derived on read: a dinner logged at 23:00 is dinner, and a rule that
// recomputed from the timestamp would quietly move it to "snack" the moment
// anybody looked at it again.
type Meal string

const (
	MealBreakfast Meal = "breakfast"
	MealLunch     Meal = "lunch"
	MealDinner    Meal = "dinner"
	MealSnack     Meal = "snack"
)

// Meals is the source of truth for the vocabulary AND for display order, and
// it is served with the entries response so a client's picker cannot disagree
// with the validator.
//
// Order is the day's order, not alphabetical — sorting these gives
// breakfast, dinner, lunch, snack, which reads as a bug to every athlete who
// sees it.
var Meals = []Meal{MealBreakfast, MealLunch, MealDinner, MealSnack}

func (m Meal) valid() bool {
	for _, v := range Meals {
		if v == m {
			return true
		}
	}
	return false
}

// FoodKind separates a plain saved food from a recipe.
//
// One table and one kind field rather than two tables, because from the
// client's side logging either is the same action — pick a thing, scale it,
// copy its numbers — and the picker would otherwise have to merge two lists
// and keep them sorted together.
type FoodKind string

const (
	KindFood   FoodKind = "food"
	KindRecipe FoodKind = "recipe"
)

var FoodKinds = []FoodKind{KindFood, KindRecipe}

func (k FoodKind) valid() bool {
	for _, v := range FoodKinds {
		if v == k {
			return true
		}
	}
	return false
}

// Source records where a row came from.
//
// `user` and `seed` are all that phase one can produce. `usda` and `off` are
// declared now, unused, because they are the two integrations already decided
// on — and adding a value to a CHECK constraint later is a migration, while
// declaring it now costs nothing. `off` rows additionally have to stay
// separable from our own: Open Food Facts is ODbL, and its share-alike
// obligation must never reach data we authored.
//
// `ai` was added by migration 000062, on exactly the reasoning above: a
// migration was already being written, so declaring it then cost nothing.
type Source string

const (
	SourceUser Source = "user"
	SourceSeed Source = "seed"
	SourceUSDA Source = "usda"
	SourceOFF  Source = "off"
	// SourceAI is a food an AI drafted rather than one anybody measured.
	//
	// Its own value rather than folded into `user`, and N40 (#313) is the
	// argument. Put through a real photograph, the estimator invented one item
	// and DOUBLED a quantity — and it flagged the invention three separate
	// ways while flagging the miscount not at all. A model cannot reliably say
	// which of its own numbers to distrust, so an AI-drafted food must stay
	// permanently distinguishable from a measured one. Folded into `user`,
	// nothing downstream — including N27's kcal adjustments — could ever weight
	// them differently, and there would be no way to find them again to
	// re-verify when a better model lands.
	SourceAI Source = "ai"
)

var Sources = []Source{SourceUser, SourceSeed, SourceUSDA, SourceOFF, SourceAI}

func (s Source) valid() bool {
	for _, v := range Sources {
		if v == s {
			return true
		}
	}
	return false
}

// TargetSource says how a target got its numbers, so the UI can explain it.
//
// `derived` came from the wizard and carries a Basis; `manual` was typed and
// has none to show; `adjustment` is a weekly proposal the athlete accepted.
// Distinguishing the last two matters: an adjustment can be explained
// ("you were losing 0.3%/week against a 0.75% target"), a typed number cannot.
type TargetSource string

const (
	TargetDerived    TargetSource = "derived"
	TargetManual     TargetSource = "manual"
	TargetAdjustment TargetSource = "adjustment"
)

var TargetSources = []TargetSource{TargetDerived, TargetManual, TargetAdjustment}

func (s TargetSource) valid() bool {
	for _, v := range TargetSources {
		if v == s {
			return true
		}
	}
	return false
}

// Macros is what a quantity of food contains.
//
// **Kcal is authoritative and clients must not re-derive it from the macros.**
// Real labels do not reconcile against 4/4/9 — rounding, fibre, sugar alcohols
// and Atwater's own approximations put them 5–10% out routinely — so there is
// deliberately no constraint tying them together. A client that "fixes" the
// discrepancy by recomputing kcal is discarding the number printed on the
// packet in favour of an estimate.
//
// FibreG is a pointer and the others are not: zero fat is a real measurement,
// but a label that does not state fibre is not claiming zero, and averaging
// unstated as zero drags every fibre figure down.
// The five LABEL macros added by N52 are all pointers, for the reason FibreG
// already is and more sharply: **absence is a fact about what we know, never a
// fact about the food.** A zero says "this contains no sodium"; nil says
// "nobody told us". Two of them are nil most of the time by nature of the
// sources — see the notes on each — so collapsing nil to 0 would not be an edge
// case, it would be the common case, and it would put a claim in front of an
// athlete that no source ever made. Clients render `n/a`.
//
// **SodiumMG is MILLIGRAMS**, and the unit is in the field name because getting
// it wrong is a 1000x error that looks plausible. USDA reports sodium in mg and
// Open Food Facts reports it in GRAMS; the conversion happens at the OFF
// boundary, not here. Nothing downstream would catch a mistake — 0.536 where
// 536 belongs is in range, is a believable number, and no test written against
// one source would ever see the other's unit.
//
// **Salt is deliberately absent.** Open Food Facts returns it, and measured on
// two real products it is EXACTLY sodium x 2.5 (0.536 -> 1.34, 0.0428 -> 0.107).
// It is therefore derivable, and two stored numbers that can disagree is worse
// than one and a formula. Do not add a column for it.
type Macros struct {
	Kcal     float64  `json:"kcal"`
	ProteinG float64  `json:"protein_g"`
	CarbG    float64  `json:"carb_g"`
	FatG     float64  `json:"fat_g"`
	FibreG   *float64 `json:"fibre_g"`

	// SaturatedFatG and SugarG come from both sources.
	SaturatedFatG *float64 `json:"saturated_fat_g"`
	SugarG        *float64 `json:"sugar_g"`
	// AddedSugarG comes from Open Food Facts only — **USDA SR Legacy does not
	// carry it at all**, so this is nil for every seeded generic food and real
	// for scanned products. That asymmetry is expected, not a gap to fill.
	AddedSugarG *float64 `json:"added_sugar_g"`
	// SodiumMG is MILLIGRAMS. See the note above; this is the field the
	// conversion exists for.
	SodiumMG *float64 `json:"sodium_mg"`
	// CholesterolMG comes from USDA only in practice — Open Food Facts carried
	// it on NEITHER product tested — so a scanned product usually shows `n/a`
	// here. Correct, and written down because it looks like a bug.
	CholesterolMG *float64 `json:"cholesterol_mg"`
}

// bounds are sanity rails against a mis-keyed decimal, not nutritional limits.
// A 90,000 kcal entry is a typo; catching it here is what stops one bad row
// dragging a month of averages with it. Nothing here has an opinion about
// whether a real meal is sensible.
const (
	maxKcal   = 20000
	maxMacroG = 2000
	maxFibreG = 500
	// Milligram rails, matching the CHECKs in migration 000064. 100,000 mg is
	// 100 g of sodium, which no serving of food reaches — 100 g of pure salt is
	// about 39,000 mg.
	maxMilligrams = 100000
)

func (m Macros) validate(what string) error {
	for _, f := range []struct {
		name string
		v    float64
		max  float64
	}{
		{"kcal", m.Kcal, maxKcal},
		{"protein", m.ProteinG, maxMacroG},
		{"carbs", m.CarbG, maxMacroG},
		{"fat", m.FatG, maxMacroG},
	} {
		// NOT `< 0 || > max`: both are FALSE for NaN, so a NaN would pass
		// straight through into an average and poison it. Written as a
		// positive assertion, it fails closed. Postgres numeric accepts 'NaN',
		// so nothing downstream would catch it either.
		if !(f.v >= 0 && f.v < f.max) {
			return fmt.Errorf("%w: %s %s must be between 0 and %g", ErrInvalidInput, what, f.name, f.max)
		}
	}
	if m.FibreG != nil && !(*m.FibreG >= 0 && *m.FibreG < maxFibreG) {
		return fmt.Errorf("%w: %s fibre must be between 0 and %g", ErrInvalidInput, what, float64(maxFibreG))
	}
	// The label macros, same failing-closed form as above — a nil is "not
	// stated" and passes, a NaN does not.
	for _, f := range []struct {
		name string
		v    *float64
		max  float64
	}{
		{"saturated fat", m.SaturatedFatG, maxMacroG},
		{"sugar", m.SugarG, maxMacroG},
		{"added sugar", m.AddedSugarG, maxMacroG},
		{"sodium", m.SodiumMG, maxMilligrams},
		{"cholesterol", m.CholesterolMG, maxMilligrams},
	} {
		if f.v != nil && !(*f.v >= 0 && *f.v < f.max) {
			return fmt.Errorf("%w: %s %s must be between 0 and %g", ErrInvalidInput, what, f.name, f.max)
		}
	}
	// Deliberately NO check that added sugar <= total sugar. It is a real
	// invariant, but both numbers are rounded independently by the source, so a
	// product legitimately reporting 12.0 total and 12.04 added would be
	// REFUSED — rejecting real data to enforce an arithmetic tidiness nothing
	// downstream depends on. Same reasoning as the migration's comment.
	return nil
}

// Entry is one item eaten on one day.
//
// The ID is CLIENT-GENERATED, which is what makes the phone's outbox safe:
// creating an entry with no signal and pushing it later can never duplicate it,
// and a retried push is the same request twice. Same contract the session
// outbox and the activity envelope already rely on.
type Entry struct {
	ID     string `json:"id"`
	UserID string `json:"user_id"`
	// EatenOn is the LOCAL calendar day, as "YYYY-MM-DD". Never derived from a
	// UTC timestamp: west of Greenwich a 22:00 snack lands on tomorrow, and the
	// remaining figure is then wrong on two days at once.
	EatenOn string `json:"eaten_on"`
	Meal    Meal   `json:"meal"`

	Name string `json:"name"`
	// Servings is how many of ServingLabel were eaten — 1.5 × "100 g".
	// Multiples of a canonical serving rather than grams-as-primary, because a
	// gram keypad on every log is what makes these apps slow to use.
	Servings     float64 `json:"servings"`
	ServingLabel string  `json:"serving_label"`

	// Macros are ABSOLUTE for the quantity logged, already multiplied by
	// Servings. The server never scales and never converts a unit; that keeps
	// ServingLabel a descriptive string rather than something to parse.
	Macros

	// SourceFoodID is provenance only — see the package doc. Never read for
	// nutrition, and ON DELETE SET NULL so removing a favourite cannot touch
	// what an entry says you ate.
	SourceFoodID *string `json:"source_food_id"`

	Notes string `json:"notes"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (e *Entry) Validate() error {
	if !isUUID(e.ID) {
		return fmt.Errorf("%w: id must be a UUID, generated by the client", ErrInvalidInput)
	}
	if !isDate(e.EatenOn) {
		return fmt.Errorf("%w: eaten_on must be a date, as YYYY-MM-DD", ErrInvalidInput)
	}
	if !e.Meal.valid() {
		return fmt.Errorf("%w: meal must be one of %s", ErrInvalidInput, joinMeals())
	}
	if err := validateName(e.Name, "name"); err != nil {
		return err
	}
	if !(e.Servings > 0 && e.Servings < 10000) {
		return fmt.Errorf("%w: servings must be more than 0", ErrInvalidInput)
	}
	if err := validateLabel(e.ServingLabel, "serving_label"); err != nil {
		return err
	}
	if err := e.Macros.validate("entry"); err != nil {
		return err
	}
	if len(e.Notes) > 500 {
		return fmt.Errorf("%w: notes must be 500 characters or fewer", ErrInvalidInput)
	}
	if e.SourceFoodID != nil && !isUUID(*e.SourceFoodID) {
		return fmt.Errorf("%w: source_food_id must be a UUID", ErrInvalidInput)
	}
	return nil
}

// RecipeItem is one component of a recipe.
//
// Its numbers are copied, exactly like an entry's and for the same reason:
// correcting "chicken thigh" must not silently rewrite a recipe built last
// month. SourceFoodID is provenance, ON DELETE SET NULL.
type RecipeItem struct {
	Name         string  `json:"name"`
	Quantity     float64 `json:"quantity"`
	ServingLabel string  `json:"serving_label"`
	Macros
	SourceFoodID *string `json:"source_food_id"`
}

// Food is a saved thing you eat, or a recipe.
//
// Macros are PER ONE SERVING. For a recipe they are derived at write time from
// Items divided by YieldServings, and STORED rather than joined — the food
// picker lists dozens of rows and would otherwise fan out one query per recipe.
type Food struct {
	ID     string   `json:"id"`
	UserID string   `json:"user_id"`
	Kind   FoodKind `json:"kind"`

	Name  string `json:"name"`
	Brand string `json:"brand"`

	// ServingLabel is what one serving IS, as the athlete would say it:
	// "100 g", "1 scoop (30 g)", "1 egg".
	ServingLabel string `json:"serving_label"`
	// ServingGrams is nullable on purpose. An egg has no honest gram weight,
	// and inventing one would make every gram-based total quietly fictional.
	ServingGrams *float64 `json:"serving_grams"`

	Macros

	// YieldServings is set for a recipe and nil for a food — "this makes 6
	// portions". The database enforces the biconditional; it is repeated in
	// Validate because a CHECK violation cannot say which half is missing.
	YieldServings *float64     `json:"yield_servings"`
	Items         []RecipeItem `json:"items"`

	Source     Source  `json:"source"`
	ExternalID *string `json:"external_id"`
	Barcode    *string `json:"barcode"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

const maxRecipeItems = 100

func (f *Food) Validate() error {
	if !isUUID(f.ID) {
		return fmt.Errorf("%w: id must be a UUID, generated by the client", ErrInvalidInput)
	}
	if !f.Kind.valid() {
		return fmt.Errorf("%w: kind must be food or recipe", ErrInvalidInput)
	}
	if err := validateName(f.Name, "name"); err != nil {
		return err
	}
	if len(f.Brand) > 80 {
		return fmt.Errorf("%w: brand must be 80 characters or fewer", ErrInvalidInput)
	}
	if err := validateLabel(f.ServingLabel, "serving_label"); err != nil {
		return err
	}
	if f.ServingGrams != nil && !(*f.ServingGrams > 0 && *f.ServingGrams < 100000) {
		return fmt.Errorf("%w: serving_grams must be more than 0, or absent when the serving has no honest weight", ErrInvalidInput)
	}
	if err := f.Macros.validate("food"); err != nil {
		return err
	}
	if !f.Source.valid() {
		return fmt.Errorf("%w: unknown source %q", ErrInvalidInput, f.Source)
	}
	if (f.Kind == KindRecipe) != (f.YieldServings != nil) {
		return fmt.Errorf("%w: a recipe needs yield_servings (how many portions it makes) and a food must not have one", ErrInvalidInput)
	}
	if f.YieldServings != nil && !(*f.YieldServings > 0 && *f.YieldServings < 1000) {
		return fmt.Errorf("%w: yield_servings must be more than 0", ErrInvalidInput)
	}
	if f.Kind == KindFood && len(f.Items) > 0 {
		return fmt.Errorf("%w: only a recipe can have items", ErrInvalidInput)
	}
	if len(f.Items) > maxRecipeItems {
		return fmt.Errorf("%w: a recipe can have at most %d items", ErrInvalidInput, maxRecipeItems)
	}
	for i := range f.Items {
		it := &f.Items[i]
		if err := validateName(it.Name, fmt.Sprintf("item %d name", i+1)); err != nil {
			return err
		}
		if !(it.Quantity > 0 && it.Quantity < 10000) {
			return fmt.Errorf("%w: item %d quantity must be more than 0", ErrInvalidInput, i+1)
		}
		if err := validateLabel(it.ServingLabel, fmt.Sprintf("item %d serving_label", i+1)); err != nil {
			return err
		}
		if err := it.Macros.validate(fmt.Sprintf("item %d", i+1)); err != nil {
			return err
		}
		if it.SourceFoodID != nil && !isUUID(*it.SourceFoodID) {
			return fmt.Errorf("%w: item %d source_food_id must be a UUID", ErrInvalidInput, i+1)
		}
	}
	return nil
}

// PerServing sums a recipe's items and divides by its yield.
//
// Called at WRITE time, and the result is stored on the parent row. It is a
// method rather than a SQL expression so the arithmetic is unit-testable
// without a database, and so there is exactly one place that decides what a
// portion of a recipe contains.
//
// Fibre is summed only if at least one item states it — otherwise the recipe
// reports "not stated" rather than a total assembled from silence.
func (f *Food) PerServing() Macros {
	if f.Kind != KindRecipe || f.YieldServings == nil || *f.YieldServings <= 0 {
		return f.Macros
	}
	var total Macros
	var fibre float64
	anyFibre := false
	for _, it := range f.Items {
		total.Kcal += it.Kcal * it.Quantity
		total.ProteinG += it.ProteinG * it.Quantity
		total.CarbG += it.CarbG * it.Quantity
		total.FatG += it.FatG * it.Quantity
		if it.FibreG != nil {
			fibre += *it.FibreG * it.Quantity
			anyFibre = true
		}
	}
	y := *f.YieldServings
	out := Macros{
		Kcal:     total.Kcal / y,
		ProteinG: total.ProteinG / y,
		CarbG:    total.CarbG / y,
		FatG:     total.FatG / y,
	}
	if anyFibre {
		per := fibre / y
		out.FibreG = &per
	}
	return out
}

// Target is what the athlete is eating to, from a date onward.
//
// The date IS the identity — PK (user_id, effective_on) — so "set my target
// from today" is an idempotent upsert, and "what was I eating to in March" is
// the newest row on or before that day.
type Target struct {
	UserID      string `json:"user_id"`
	EffectiveOn string `json:"effective_on"`

	Kcal     int  `json:"kcal"`
	ProteinG int  `json:"protein_g"`
	CarbG    int  `json:"carb_g"`
	FatG     int  `json:"fat_g"`
	FibreG   *int `json:"fibre_g"`

	Source TargetSource `json:"source"`
	// Basis is the arithmetic that produced this target, FROZEN at the moment
	// it was accepted.
	//
	// Not recomputed on read, and that is the whole point: weight, height and
	// the live phase all move, so a "live" explanation is a confident lie about
	// a past decision. Nil for a manually typed target, which has no arithmetic
	// to show.
	Basis *Basis `json:"basis,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Bounds on a stored target. The floor is deliberately well below anything the
// derivation would ever propose (target.go clamps far above it) — this is the
// rail against a mis-keyed number, not a second opinion about what is safe.
const (
	minTargetKcal = 800
	maxTargetKcal = 8000
)

func (t *Target) Validate() error {
	if !isDate(t.EffectiveOn) {
		return fmt.Errorf("%w: effective_on must be a date, as YYYY-MM-DD", ErrInvalidInput)
	}
	if t.Kcal < minTargetKcal || t.Kcal > maxTargetKcal {
		return fmt.Errorf("%w: kcal must be between %d and %d", ErrInvalidInput, minTargetKcal, maxTargetKcal)
	}
	for _, f := range []struct {
		name string
		v    int
		max  int
	}{
		{"protein", t.ProteinG, 500},
		{"carbs", t.CarbG, 1200},
		{"fat", t.FatG, 400},
	} {
		if f.v < 0 || f.v > f.max {
			return fmt.Errorf("%w: %s must be between 0 and %d g", ErrInvalidInput, f.name, f.max)
		}
	}
	if t.FibreG != nil && (*t.FibreG < 0 || *t.FibreG > 120) {
		return fmt.Errorf("%w: fibre must be between 0 and 120 g", ErrInvalidInput)
	}
	if !t.Source.valid() {
		return fmt.Errorf("%w: unknown target source %q", ErrInvalidInput, t.Source)
	}
	return nil
}

// DayTotals is one day's summed intake against the target that was live that
// day.
//
// For READ-ONLY windows only — a month being reviewed on web. Never for the day
// the client is currently editing: the phone holds entries the server has not
// seen, so this figure is wrong there in the one minute it matters. See the
// package doc.
type DayTotals struct {
	EatenOn string `json:"eaten_on"`
	Entries int    `json:"entries"`
	Macros
	// TargetKcal is the target live on that day, or nil if none was set yet.
	// Sent per-day rather than as a weekly figure the client divides, so that
	// training-day calorie cycling stays a server change later rather than a
	// client rewrite.
	TargetKcal     *int `json:"target_kcal"`
	TargetProteinG *int `json:"target_protein_g"`
}

func validateName(v, what string) error {
	n := strings.TrimSpace(v)
	if n == "" || len([]rune(n)) > 120 {
		return fmt.Errorf("%w: %s must be between 1 and 120 characters", ErrInvalidInput, what)
	}
	return nil
}

func validateLabel(v, what string) error {
	n := strings.TrimSpace(v)
	if n == "" || len([]rune(n)) > 40 {
		return fmt.Errorf("%w: %s must be between 1 and 40 characters", ErrInvalidInput, what)
	}
	return nil
}

func joinMeals() string {
	out := make([]string, len(Meals))
	for i, m := range Meals {
		out[i] = string(m)
	}
	return strings.Join(out, ", ")
}

// isDate accepts exactly "YYYY-MM-DD" and rejects anything Go would otherwise
// coerce. Fixed width is what makes string comparison a sound date ordering,
// which the range queries rely on — hence the strictness. Same helper the body
// module carries, for the same reason.
func isDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

// isUUID checks the shape only, not the version.
//
// It exists because the ID is the idempotency key for an offline push: a client
// that sent a sequence number or a slug would create rows that collide across
// devices, and the failure would look like somebody else's lunch appearing in
// your log. Rejecting the shape early turns that into a 400 the client author
// sees on the first request.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
				return false
			}
		}
	}
	return true
}

// Repository is the storage port.
//
// SaveEntry and SaveFood are upserts keyed on a client-generated ID rather than
// create/update pairs, which is what makes a re-sent offline write idempotent.
// Both are scoped to the caller INSIDE the conflict clause — see postgres.go;
// that predicate is the whole security property.
type Repository interface {
	ListEntries(ctx context.Context, userID, from, to string, limit int) ([]Entry, error)
	SaveEntry(ctx context.Context, e Entry) (Entry, error)
	// DeleteEntry is idempotent: deleting an absent row is not an error. An
	// outbox retrying a delete that already landed would otherwise record a
	// permanent failure for a row that is correctly gone.
	DeleteEntry(ctx context.Context, userID, id string) error
	DayTotals(ctx context.Context, userID, from, to string) ([]DayTotals, error)

	ListFoods(ctx context.Context, userID, q string, limit int) ([]Food, error)
	GetFood(ctx context.Context, userID, id string) (Food, error)
	SaveFood(ctx context.Context, f Food) (Food, error)
	DeleteFood(ctx context.Context, userID, id string) error

	// ListTargets returns the rows in [from,to] PLUS the one live at `from`.
	// Without that carry-in row a target set three months ago makes a week-long
	// window return nothing, and the client honestly reports "no target" for a
	// week the athlete was eating to one.
	ListTargets(ctx context.Context, userID, from, to string) ([]Target, error)
	// TargetOn has no route yet: the clients read a window through ListTargets
	// and resolve the live one themselves. It exists because the weekly
	// adjustment rule (N24) needs exactly one target for exactly one day, and
	// because DayTotals' lateral join is the same question in SQL — keeping the
	// two able to disagree would be the drift this module keeps guarding
	// against. Covered by its own test.
	TargetOn(ctx context.Context, userID, on string) (Target, error)
	SaveTarget(ctx context.Context, t Target) (Target, error)
	DeleteTarget(ctx context.Context, userID, on string) error

	// TargetInputs gathers everything the pure derivation needs in one query.
	// Named so the cross-module dependency is legible: nutrition reads
	// profiles, body_checkins and body_phases directly by SQL, which is the
	// shape sessioncard already uses — a module never imports a sibling.
	TargetInputs(ctx context.Context, userID, on string) (Inputs, error)

	// AdjustmentInputs gathers the fortnight of evidence the weekly adjustment
	// rule judges: the live target and when it took effect, the live phase,
	// every weigh-in in the window, how many days cleared the logging bar, and
	// the resting floor.
	AdjustmentInputs(ctx context.Context, userID, on string) (AdjustmentInputs, error)
}
