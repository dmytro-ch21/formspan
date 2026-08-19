package workout

import (
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// maxItems bounds a workout's length. No real session comes close, so
// anything longer is a mistake or an attempt to make the database work for
// nothing — each item is a statement in a batch.
const maxItems = 200

// maxNameLen bounds a template's name — the same 120 the session module uses,
// because the two names are edited by the same people for the same reasons and
// a template named longer than a session could name is an arbitrary surprise.
const maxNameLen = 120

// writeErr maps domain errors to the API's error contract in one place, so
// every handler below reports the same situation the same way.
func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "workout not found")
	case errors.Is(err, ErrForbidden):
		apihttp.WriteError(w, http.StatusForbidden, apihttp.CodeForbidden, "not your workout")
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, "workout id already in use")
	case errors.Is(err, ErrSportMismatch):
		// The message is safe to surface: it names an exercise and a sport
		// the caller already sent, not anything internal.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "workout", err)
	}
}

// ScopeFilter turns the ?scope= parameter into the two booleans the filter
// carries, reporting whether it was a value we accept.
//
// Extracted from the handler because it is the whole of a compatibility promise
// and none of it was reachable by a test: `List` reads claims before anything
// else, and `auth`'s context key is unexported, so a handler-level test cannot
// get far enough to observe the decision without widening that package.
//
// **`shared` is still accepted, and deliberately so.** The concept is called
// Public Workout Plans now and `public` is the name to use, but an installed
// mobile build sends whatever it shipped with and updates on the App Store's
// schedule, not ours. Rejecting the old word would give every not-yet-updated
// phone a 400 and an empty Workouts tab — a rename presenting as an outage.
// Costs one branch; delete it once the field has turned over, and the test
// named for that promise is what will object.
//
// Unknown values are rejected rather than ignored: an unrecognised ?scope= used
// to fall through to "everything visible", so a typo looked like it worked.
func ScopeFilter(scope string) (mine, public, ok bool) {
	switch scope {
	case "":
		return true, true, true
	case "mine":
		return true, false, true
	case "public", "shared":
		return false, true, true
	default:
		return false, false, false
	}
}

// List returns workouts the caller can see. ?scope=mine|public narrows;
// omitted means both.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	q := r.URL.Query()

	mine, public, ok := ScopeFilter(q.Get("scope"))
	if !ok {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"scope must be mine or public")
		return
	}
	if s := q.Get("sport"); s != "" && !ValidSport(Sport(s)) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: "+discipline.SportList())
		return
	}
	if g := q.Get("goal"); g != "" && !ValidGoal(Goal(g)) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"goal must be one of: general, powerlifting, hypertrophy, endurance")
		return
	}

	f := Filter{
		Sport:  Sport(q.Get("sport")),
		Goal:   Goal(q.Get("goal")),
		Mine:   mine,
		Public: public,
	}

	workouts, err := h.repo.List(r.Context(), claims.UserID, f)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"workouts": workouts})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	wk, err := h.repo.Get(r.Context(), claims.UserID, r.PathValue("workoutID"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, wk)
}

type createRequest struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Sport      Sport      `json:"sport"`
	Goal       *Goal      `json:"goal"`
	Notes      string     `json:"notes"`
	Visibility Visibility `json:"visibility"`
	Items      []Item     `json:"items"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if len(req.Items) > maxItems {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "too many items")
		return
	}
	// Trimmed and capped on the SAME rules as Rename.
	//
	// It was neither before, which made the endpoint's own argument false of
	// the data: a review pointed out that `POST` happily stored "   " and a
	// 5000-rune name (the column is plain TEXT with no CHECK), so the "renders
	// as a gap in the list with nothing to tap" harm that Rename refuses was
	// fully reachable through create — and a template created with a 5000-rune
	// name could never be renamed to anything comparable.
	req.Name = strings.TrimSpace(req.Name)
	if req.ID == "" || req.Name == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "id and name are required")
		return
	}
	if utf8.RuneCountInString(req.Name) > maxNameLen {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "name is too long")
		return
	}
	if !ValidSport(req.Sport) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: "+discipline.SportList())
		return
	}
	if req.Goal != nil && !ValidGoal(*req.Goal) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"goal must be one of: general, powerlifting, hypertrophy, endurance")
		return
	}
	if req.Visibility == "" {
		// Default private: sharing should be a deliberate act, never the
		// consequence of omitting a field.
		req.Visibility = VisibilityPrivate
	}
	if req.Visibility != VisibilityPrivate && req.Visibility != VisibilityPublic {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"visibility must be private or public")
		return
	}

	wk, err := h.repo.Create(r.Context(), NewWorkout{
		ID:          req.ID,
		OwnerUserID: claims.UserID, // never from the body
		Name:        req.Name,
		Sport:       req.Sport,
		Goal:        req.Goal,
		Notes:       req.Notes,
		Visibility:  req.Visibility,
		Items:       req.Items,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, wk)
}

type replaceItemsRequest struct {
	Items []Item `json:"items"`
}

// ReplaceItems swaps a workout's whole ordered contents — the natural shape
// for "add an exercise" and "reorder" alike, since both send the new list.
func (h *Handler) ReplaceItems(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req replaceItemsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if len(req.Items) > maxItems {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "too many items")
		return
	}
	for _, it := range req.Items {
		if it.ExerciseID == "" {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"every item needs an exercise_id")
			return
		}
	}

	wk, err := h.repo.ReplaceItems(r.Context(), claims.UserID, r.PathValue("workoutID"), req.Items)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, wk)
}

type renameRequest struct {
	Name string `json:"name"`
}

// Rename changes a template's name.
//
// Its own verb rather than a field on `PUT /items`, because renaming and
// re-ordering happen at different moments: folding them together would make
// correcting a typo require sending the whole item list back, and a client
// that got that list slightly wrong would silently rewrite the workout.
func (h *Handler) Rename(w http.ResponseWriter, r *http.Request) {
	var req renameRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	name := strings.TrimSpace(req.Name)
	// Refused rather than stored: a blank name renders as a gap in the template
	// list with nothing to identify or tap, and every plan pointing at it loses
	// its label too.
	if name == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "name is required")
		return
	}
	// Runes, not bytes — `len()` counts bytes, which would cap a Portuguese or
	// Japanese name at a third of the published limit, in a product whose
	// domain vocabulary is exactly those languages. Same constant and same
	// reasoning as the session module's rename.
	if utf8.RuneCountInString(name) > maxNameLen {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "name is too long")
		return
	}

	// Read at the point of use and CHECKED, unlike the `claims, _ :=` its
	// siblings here open with.
	//
	// It is not the auth boundary — `RequireAuth` is, and it makes this branch
	// unreachable in production. It is a backstop against the route being wired
	// without that middleware, which `claims, _ :=` turns into a nil dereference
	// and a 500 rather than a 401. It also makes the handler testable: the rune
	// cap above is the property most likely to regress and had no coverage at
	// all, because a test could not get past a nil-claims panic to prove that a
	// 120-rune multibyte name is ACCEPTED — and accepting it is what a
	// byte-counting `len()` would break, not the refusal of 121.
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "missing bearer token")
		return
	}

	wk, err := h.repo.Rename(r.Context(), claims.UserID, r.PathValue("workoutID"), name)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, wk)
}

// Copy duplicates a workout the caller can read into one they own.
//
// No body: the only inputs are the id and the caller. 404 for anything not
// visible, the same answer Get gives — "you may not copy that" would confirm an
// id belongs to somebody.
func (h *Handler) Copy(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	wk, err := h.repo.Copy(r.Context(), claims.UserID, r.PathValue("workoutID"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, wk)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), claims.UserID, r.PathValue("workoutID")); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
