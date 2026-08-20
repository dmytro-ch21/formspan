package nutrition

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/energy"
)

// Window and page caps.
//
// Both exist because apihttp.Stack buffers every response to ETag and gzip it,
// so an unbounded range is a memory cost that scales with how long somebody has
// been training. The entries window is a month because that is the longest span
// any client screen asks for at once; the days roll-up is a year because it is
// already aggregated to one row per day.
const (
	maxEntryWindowDays = 31
	maxDayWindowDays   = 366
	maxEntries         = 2000
	defaultFoodLimit   = 50
	maxFoodLimit       = 200
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

func reason(err error) string {
	const marker = "nutrition: invalid input: "
	if i := strings.LastIndex(err.Error(), marker); i >= 0 {
		return err.Error()[i+len(marker):]
	}
	return "invalid input"
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		// Also the answer for a UUID belonging to somebody else. A 403 there
		// would confirm the row exists to anybody enumerating ids, which is the
		// oracle this codebase's cross-user bugs kept handing out.
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "not found")
	case errors.Is(err, ErrInvalidInput):
		// Cut at the marker rather than trimming a prefix: the repository wraps
		// with its own context first, so the string does not START with the
		// sentinel and trimming would return the whole chain to the caller.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, reason(err))
	default:
		apihttp.WriteInternal(w, r, "nutrition", err)
	}
}

func callerID(w http.ResponseWriter, r *http.Request) (string, bool) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok || claims.UserID == "" {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return "", false
	}
	return claims.UserID, true
}

// window parses and bounds a from/to pair.
//
// Both required rather than defaulted: a client that forgets one would
// otherwise silently receive a different span than it rendered, and "all of it"
// is never what a screen wants.
func window(w http.ResponseWriter, r *http.Request, maxDays int) (string, string, bool) {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if !isDate(from) || !isDate(to) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"from and to are required, as YYYY-MM-DD")
		return "", "", false
	}
	if to < from {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "to cannot be before from")
		return "", "", false
	}
	if daysBetween(from, to) >= maxDays {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"that range is longer than "+strconv.Itoa(maxDays)+" days")
		return "", "", false
	}
	return from, to, true
}

// ---------------------------------------------------------------- entries

// entryBody is the wire shape, separate from Entry BY TYPE rather than by
// remembering to overwrite fields.
//
// user_id, created_at and updated_at are unsettable because they are not here
// to be set — a client that sends them is ignored rather than trusted. body's
// handler makes the same argument: an overwrite you have to remember is one you
// eventually forget.
type entryBody struct {
	EatenOn      string   `json:"eaten_on"`
	Meal         Meal     `json:"meal"`
	Name         string   `json:"name"`
	Servings     float64  `json:"servings"`
	ServingLabel string   `json:"serving_label"`
	Kcal         float64  `json:"kcal"`
	ProteinG     float64  `json:"protein_g"`
	CarbG        float64  `json:"carb_g"`
	FatG         float64  `json:"fat_g"`
	FibreG       *float64 `json:"fibre_g"`
	SourceFoodID *string  `json:"source_food_id"`
	Notes        string   `json:"notes"`
}

func (h *Handler) ListEntries(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	from, to, ok := window(w, r, maxEntryWindowDays)
	if !ok {
		return
	}
	entries, err := h.repo.ListEntries(r.Context(), userID, from, to, maxEntries)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// `meals` rides along so a client's picker renders from the server's
	// vocabulary and display order rather than a hardcoded copy that can drift.
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"entries": entries, "meals": Meals})
}

func (h *Handler) SaveEntry(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	var in entryBody
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	e := Entry{
		ID: r.PathValue("id"), UserID: userID,
		EatenOn: in.EatenOn, Meal: in.Meal, Name: strings.TrimSpace(in.Name),
		Servings: in.Servings, ServingLabel: strings.TrimSpace(in.ServingLabel),
		Macros:       Macros{Kcal: in.Kcal, ProteinG: in.ProteinG, CarbG: in.CarbG, FatG: in.FatG, FibreG: in.FibreG},
		SourceFoodID: in.SourceFoodID, Notes: in.Notes,
	}
	if err := e.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	saved, err := h.repo.SaveEntry(r.Context(), e)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, saved)
}

// DeleteEntry is 204 whether or not the row was there.
//
// An outbox retrying a delete that already landed would otherwise record a
// permanent failure for a row that is correctly gone, and it would sit on the
// athlete's sync screen forever. It is also the non-oracle answer.
func (h *Handler) DeleteEntry(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	if err := h.repo.DeleteEntry(r.Context(), userID, r.PathValue("id")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Days(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	from, to, ok := window(w, r, maxDayWindowDays)
	if !ok {
		return
	}
	days, err := h.repo.DayTotals(r.Context(), userID, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"days": days})
}

// ------------------------------------------------------------------ foods

type recipeItemBody struct {
	Name         string   `json:"name"`
	Quantity     float64  `json:"quantity"`
	ServingLabel string   `json:"serving_label"`
	Kcal         float64  `json:"kcal"`
	ProteinG     float64  `json:"protein_g"`
	CarbG        float64  `json:"carb_g"`
	FatG         float64  `json:"fat_g"`
	FibreG       *float64 `json:"fibre_g"`
	SourceFoodID *string  `json:"source_food_id"`
}

type foodBody struct {
	Kind          FoodKind         `json:"kind"`
	Name          string           `json:"name"`
	Brand         string           `json:"brand"`
	ServingLabel  string           `json:"serving_label"`
	ServingGrams  *float64         `json:"serving_grams"`
	Kcal          float64          `json:"kcal"`
	ProteinG      float64          `json:"protein_g"`
	CarbG         float64          `json:"carb_g"`
	FatG          float64          `json:"fat_g"`
	FibreG        *float64         `json:"fibre_g"`
	YieldServings *float64         `json:"yield_servings"`
	Items         []recipeItemBody `json:"items"`
	Barcode       *string          `json:"barcode"`
}

func (h *Handler) ListFoods(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	q := r.URL.Query().Get("q")
	if len(q) > 100 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "q is too long")
		return
	}
	limit := defaultFoodLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxFoodLimit {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"limit must be between 1 and "+strconv.Itoa(maxFoodLimit))
			return
		}
		limit = n
	}
	foods, err := h.repo.ListFoods(r.Context(), userID, q, limit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"foods": foods})
}

func (h *Handler) SaveFood(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	var in foodBody
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	items := make([]RecipeItem, 0, len(in.Items))
	for _, it := range in.Items {
		items = append(items, RecipeItem{
			Name: strings.TrimSpace(it.Name), Quantity: it.Quantity,
			ServingLabel: strings.TrimSpace(it.ServingLabel),
			Macros:       Macros{Kcal: it.Kcal, ProteinG: it.ProteinG, CarbG: it.CarbG, FatG: it.FatG, FibreG: it.FibreG},
			SourceFoodID: it.SourceFoodID,
		})
	}
	f := Food{
		ID: r.PathValue("id"), UserID: userID, Kind: in.Kind,
		Name: strings.TrimSpace(in.Name), Brand: strings.TrimSpace(in.Brand),
		ServingLabel: strings.TrimSpace(in.ServingLabel), ServingGrams: in.ServingGrams,
		Macros:        Macros{Kcal: in.Kcal, ProteinG: in.ProteinG, CarbG: in.CarbG, FatG: in.FatG, FibreG: in.FibreG},
		YieldServings: in.YieldServings, Items: items,
		// Source is NOT taken from the client. Everything a client writes is
		// its own; `usda` and `off` are set by the importers that fetch them,
		// and letting a client claim a provenance would make the ODbL
		// separation the `off` value exists for meaningless.
		Source:  SourceUser,
		Barcode: in.Barcode,
	}
	if f.Kind == "" {
		f.Kind = KindFood
	}
	if err := f.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	saved, err := h.repo.SaveFood(r.Context(), f)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, saved)
}

func (h *Handler) DeleteFood(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	if err := h.repo.DeleteFood(r.Context(), userID, r.PathValue("id")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------- targets

type targetBody struct {
	Kcal     int          `json:"kcal"`
	ProteinG int          `json:"protein_g"`
	CarbG    int          `json:"carb_g"`
	FatG     int          `json:"fat_g"`
	FibreG   *int         `json:"fibre_g"`
	Source   TargetSource `json:"source"`
	Basis    *Basis       `json:"basis"`
}

func (h *Handler) ListTargets(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	from, to, ok := window(w, r, maxDayWindowDays)
	if !ok {
		return
	}
	targets, err := h.repo.ListTargets(r.Context(), userID, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"targets": targets})
}

func (h *Handler) SaveTarget(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	var in targetBody
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	t := Target{
		UserID: userID, EffectiveOn: r.PathValue("date"),
		Kcal: in.Kcal, ProteinG: in.ProteinG, CarbG: in.CarbG, FatG: in.FatG, FibreG: in.FibreG,
		Source: in.Source, Basis: in.Basis,
	}
	if t.Source == "" {
		t.Source = TargetManual
	}
	if err := t.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	saved, err := h.repo.SaveTarget(r.Context(), t)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, saved)
}

func (h *Handler) DeleteTarget(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	// Validated here rather than left to Postgres: a malformed date raises
	// 22007 (invalid_datetime_format), which `translate` does not map, so it
	// would surface as a 500 for what is plainly a bad request. The PUT path
	// gets this for free via Target.Validate; DELETE has no body to validate.
	on := r.PathValue("date")
	if !isDate(on) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"date must be a date, as YYYY-MM-DD")
		return
	}
	if err := h.repo.DeleteTarget(r.Context(), userID, on); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Adjustment proposes a change to the live target, or says why it will not.
//
// **Never an error and never a write.** A withheld proposal is 200 with
// `adjustment: null` and `blocked_by` naming what is missing, because for most
// athletes on most days that is the correct answer rather than a failure. The
// client's job is to say what would unblock it — log more days, weigh in more
// often, wait out the fortnight — not to retry.
//
// Accepting is an ordinary `PUT /v1/nutrition/targets/{date}` with
// `source: "adjustment"`, using the date and macros in the proposal. Declining
// is sending nothing: no dismissal is stored, because it would be stale the
// moment the next check-in landed and the cooldown is already derivable from
// target history.
func (h *Handler) Adjustment(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	on := r.URL.Query().Get("on")
	if on == "" {
		on = time.Now().UTC().Format("2006-01-02")
	}
	if !isDate(on) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "on must be a date, as YYYY-MM-DD")
		return
	}

	in, err := h.repo.AdjustmentInputs(r.Context(), userID, on)
	if err != nil {
		writeError(w, r, err)
		return
	}

	adjustment, blocked := ProposeAdjustment(in)
	if blocked == nil {
		// An empty array, never null — same rule as `missing` below.
		blocked = []string{}
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"adjustment": adjustment,
		"blocked_by": blocked,
	})
}

// Suggested derives a target and RETURNS IT WITHOUT STORING IT.
//
// A proposal, not a decision: the athlete accepts it with a PUT, which is what
// makes the number arguable rather than imposed. Same posture the weekly
// adjustment rule will take.
//
// An incomplete profile is a 200 with a null suggestion and the field names,
// NOT a 400. The request was fine; the profile is missing something, and the
// client's fix is a form rather than a retry — the same shape body uses for a
// check-in with no bodyweight.
func (h *Handler) Suggested(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	on := r.URL.Query().Get("on")
	if on == "" {
		// UTC, matching how every other date in this app is resolved
		// server-side. A client that cares about its own calendar day sends
		// `on` explicitly — and the mobile client always does, because its
		// local day is the one entries are filed under.
		on = time.Now().UTC().Format("2006-01-02")
	}
	if !isDate(on) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "on must be a date, as YYYY-MM-DD")
		return
	}
	// Validated BEFORE the read, so a nonsense parameter still costs one cheap
	// 400 rather than three queries. An ABSENT parameter is not an error — it
	// is the normal case now, and means "use whatever this athlete has stored".
	asked := r.URL.Query().Get("activity")
	if asked != "" && !Activity(asked).valid() {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"activity must be sedentary, light or active")
		return
	}

	in, err := h.repo.TargetInputs(r.Context(), userID, on)
	if err != nil {
		writeError(w, r, err)
		return
	}

	// The parameter wins, then the stored choice, then the default — and
	// `chosen` records which of those it was. See ResolveActivity.
	activity, chosen := ResolveActivity(asked, in.ActivityLevel)

	p := energy.Profile{
		WeightKG: in.WeightKG, HeightCM: in.HeightCM,
		DateOfBirth: in.DateOfBirth, Sex: in.Sex,
	}
	suggestion, missing := Suggest(in, activity,
		func() (float64, bool) { return energy.RestingPerDay(p) },
		string(energy.PrecisionOf(p)))

	if missing == nil {
		// An empty array, never null. Every list in this API is a list; a
		// client writing `body.missing.length` should not have to know which
		// endpoints hand back null instead.
		missing = []string{}
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"suggestion": suggestion,
		"missing":    missing,
		"activities": Activities,
		// The level this derivation actually ran at, and whether the athlete
		// chose it.
		//
		// **Top level rather than inside `suggestion`, and that placement is
		// the point.** `basis.activity` already carries it, but `basis` is null
		// for an incomplete profile — and an athlete who cannot be given a
		// number yet still has an activity level to display and change. Reading
		// it off the basis would leave the pills unrenderable in exactly the
		// state where the rest of the screen is asking them to go and fix
		// something.
		//
		// It also makes the two halves inseparable: the pill and the number now
		// come out of ONE response, so they cannot disagree the way they did
		// when each client tracked the level in its own component state.
		"activity":        activity,
		"activity_chosen": chosen,
	})
}
