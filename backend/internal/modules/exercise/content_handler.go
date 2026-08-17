package exercise

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

// maxContentBody bounds the write. An exercise with full instructions is a few
// KB; 64 KB leaves room without accepting an upload.
const maxContentBody = 64 << 10

// ContentHandler is the admin console's write access to the exercise catalog.
//
// Wired under RequireAdmin, which is the real boundary — the console's own
// allowlist check is defence in depth for the UI.
type ContentHandler struct {
	repo ContentRepository
}

// NewContentHandler takes the INTERFACE, not *PostgresRepository. The technique
// module learned this the expensive way: taking the concrete type is why that
// handler layer had no tests and shipped three defects.
func NewContentHandler(repo ContentRepository) *ContentHandler {
	return &ContentHandler{repo: repo}
}

// exerciseRequest is the admin-writable surface.
//
// `id`, `source` and `media` are absent on purpose. The id is DERIVED from the
// name at creation and immutable after — it is a foreign key in workout items
// and logged sets, so it outlives every other field here. `source` is the
// server's. `media` lives in its own table and has no upload path; leaving it
// out of the request is what guarantees an edit cannot clear it.
//
// Every field is a POINTER so absent can be told from empty. PATCH is a partial
// update — which is what the method means — and the technique module's first
// version decoded into plain values, so a console form posting one edited field
// silently wiped the rest. `is_unilateral` is the one that would bite hardest
// here: a plain bool cannot distinguish "not sent" from "false".
type exerciseRequest struct {
	Name                  *string   `json:"name"`
	Sport                 *string   `json:"sport"`
	MovementPattern       *string   `json:"movement_pattern"`
	MovementPatternDetail *string   `json:"movement_pattern_detail"`
	PrimaryMuscles        *[]string `json:"primary_muscles"`
	SecondaryMuscles      *[]string `json:"secondary_muscles"`
	Equipment             *[]string `json:"equipment"`
	LoadType              *string   `json:"load_type"`
	// Absent leaves the stored value alone, which is what makes a PATCH that
	// never mentions it safe. Present and wrong is a 400 rather than a silent
	// fallback to "total": the seeder normalises an unknown value because a
	// typo must not fail a whole deploy, but an API write has one author who
	// can be told, and coercing here would reinstate the halving bug through
	// a spelling mistake.
	LoadMode *string `json:"load_mode"`
	// How many implements of the logged weight move — the tonnage factor since
	// migration 000057. Absent leaves the stored value alone; present and
	// outside {1,2} is a 400, for the same reason a bad load_mode is.
	Implements   *int    `json:"implements"`
	IsUnilateral *bool   `json:"is_unilateral"`
	Instructions *string `json:"instructions"`
}

// applyTo overlays the present fields onto a base — the zero Exercise for a
// create, the stored row for an update. Absent leaves the base alone; present
// wins even when it is empty, so clearing a field is expressible.
func (b exerciseRequest) applyTo(base Exercise) Exercise {
	if b.Name != nil {
		base.Name = *b.Name
	}
	if b.Sport != nil {
		base.Sport = *b.Sport
	}
	if b.MovementPattern != nil {
		base.MovementPattern = *b.MovementPattern
	}
	if b.MovementPatternDetail != nil {
		base.MovementPatternDetail = *b.MovementPatternDetail
	}
	if b.LoadType != nil {
		base.LoadType = LoadType(*b.LoadType)
	}
	if b.Implements != nil {
		base.Implements = *b.Implements
	}
	if b.LoadMode != nil {
		// Raw, NOT normalised — validation downstream is what turns a bad
		// value into a 400. Normalising here would swallow it.
		base.LoadMode = *b.LoadMode
	}
	if b.IsUnilateral != nil {
		base.IsUnilateral = *b.IsUnilateral
	}
	if b.Instructions != nil {
		base.Instructions = *b.Instructions
	}
	if b.PrimaryMuscles != nil {
		base.PrimaryMuscles = *b.PrimaryMuscles
	}
	if b.SecondaryMuscles != nil {
		base.SecondaryMuscles = *b.SecondaryMuscles
	}
	if b.Equipment != nil {
		base.Equipment = *b.Equipment
	}
	base.PrimaryMuscles = nonNil(base.PrimaryMuscles)
	base.SecondaryMuscles = nonNil(base.SecondaryMuscles)
	base.Equipment = nonNil(base.Equipment)
	// A CREATE that never mentions load_mode lands here with the zero value,
	// because the base is a zero Exercise. Default it to the column's own
	// default so the common case needs no field, while an UPDATE is untouched
	// — its base is the stored row, which is NOT NULL and therefore never "".
	if base.LoadMode == "" {
		base.LoadMode = LoadModeTotal
	}
	// Same reasoning: a create that never mentions it lands on a zero Exercise
	// and should take the column's own default, while an update's base is the
	// stored row and is never zero.
	if base.Implements == 0 {
		base.Implements = 1
	}
	return base
}

// Vocabularies serves the closed sets a client must pick from.
//
// Derived from the same maps the seeder validates against rather than restated
// in the console, so the editor's dropdowns and the validator can never
// disagree — the failure that would otherwise follow is an exercise filed under
// a movement pattern no cross-sport rule matches, which renders fine and is
// silently invisible to every rule forever.
func (h *ContentHandler) Vocabularies(w http.ResponseWriter, r *http.Request) {
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		// The registry's own list, in its display order. `discipline` is the
		// one place a discipline is declared, so a hardcoded copy here would be
		// a second list to forget.
		"sports":            discipline.SportKeys(),
		"movement_patterns": sortedKeys(validMovementPatterns),
		"load_types":        loadTypeNames(),
	})
}

// List serves the exercises the console owns.
//
// Deliberately NOT the whole catalog — the console can only edit
// admin-authored rows, so listing all 504 would offer 504 rows of which a
// handful are actionable. See the technique module's List for the full
// reasoning; it is identical.
func (h *ContentHandler) List(w http.ResponseWriter, r *http.Request) {
	// `?q=` searches the WHOLE catalog; without it the list is what the console
	// authored. Same split as the technique list, for the same reason: 504 full
	// rows is payload to render a list, and search is how the rest are reached
	// now that every row is editable.
	var (
		authored []Exercise
		err      error
	)
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		// Bounded like the public search, and it matters MORE here now.
		//
		// The old search bound the whole string as one parameter, so length
		// was merely wasteful. The new one binds at least one parameter per
		// word, so input length amplifies into parameter count — and Postgres
		// refuses a statement over 65,535 of them, which a few hundred KB of
		// query string reaches. Behind RequireAdmin, so this is tidiness
		// rather than a hole; the asymmetry with the public handler was an
		// oversight, not a decision.
		if len(q) > maxQueryLen {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"search term is too long")
			return
		}
		authored, err = h.repo.SearchAll(r.Context(), q)
	} else {
		authored, err = h.repo.AdminAuthored(r.Context())
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "exercise", err)
		return
	}
	// `[]`, never `null`. Guaranteed here rather than in the repository so the
	// property belongs to the endpoint and holds for every implementer — the
	// technique module's version of this test could not see its own property
	// until the guard moved up here.
	if authored == nil {
		authored = []Exercise{}
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"exercises": authored})
}

func (h *ContentHandler) Create(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeExercise(w, r)
	if !ok {
		return
	}
	if body.Name == nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"name is required — the id is derived from it")
		return
	}
	id := Slug(*body.Name)
	if id == "" {
		// A name of only punctuation or emoji slugs to nothing, and an empty id
		// would fail the NOT NULL far from the cause.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"name must contain letters or digits — the id is derived from it")
		return
	}
	e := body.applyTo(Exercise{})
	e.ID = id
	h.write(w, r, e, h.repo.CreateExercise)
}

func (h *ContentHandler) Update(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeExercise(w, r)
	if !ok {
		return
	}
	// From the path, never the body. Renaming an exercise must not move its id:
	// the old one is already a foreign key in workout items and logged sets, so
	// a move would either orphan them or silently repoint them at different
	// content.
	id := r.PathValue("exerciseID")

	// Read-modify-write, so an absent field keeps its stored value. Not atomic
	// against a concurrent edit of the same exercise — acceptable for a
	// single-operator console.
	current, err := h.repo.GetExercise(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		h.explainNotFound(w, r, id)
		return
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "exercise", err)
		return
	}
	next := body.applyTo(current)
	next.ID = id
	h.write(w, r, next, h.repo.UpdateExercise)
}

// actorOf reads the caller's id from the request's own claims — never from the
// body or a header. RequireAdmin has already run, so they are there.
func actorOf(r *http.Request) string {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if claims == nil {
		// Unreachable behind RequireAdmin. Recorded rather than guessed: a
		// revision attributed to a plausible-looking actor is worse than one
		// that admits it does not know.
		return "unknown"
	}
	return claims.UserID
}

// Publish is a separate verb, not a field on PATCH — an eighteen-field
// read-modify-write must not be able to change visibility by accident.
func (h *ContentHandler) Publish(w http.ResponseWriter, r *http.Request) {
	out, err := h.repo.Publish(r.Context(), r.PathValue("exerciseID"), actorOf(r))
	if errors.Is(err, ErrNotFound) {
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound,
			"no draft exercise with that id — it may already be published")
		return
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "exercise", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"exercise": out})
}

// Revisions serves an exercise's history, newest first.
func (h *ContentHandler) Revisions(w http.ResponseWriter, r *http.Request) {
	out, err := h.repo.Revisions(r.Context(), r.PathValue("exerciseID"))
	if err != nil {
		apihttp.WriteInternal(w, r, "exercise", err)
		return
	}
	// `[]`, never null. Empty is the NORMAL case — 504 seeded rows have no
	// history until someone edits one.
	if out == nil {
		out = []Revision{}
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"revisions": out})
}

// Restore rolls an exercise back to an earlier revision, as a new revision.
func (h *ContentHandler) Restore(w http.ResponseWriter, r *http.Request) {
	revision, err := strconv.Atoi(r.PathValue("revision"))
	if err != nil || revision < 1 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"revision must be a positive whole number")
		return
	}
	out, err := h.repo.Restore(r.Context(), r.PathValue("exerciseID"), revision, actorOf(r))
	if errors.Is(err, ErrNotFound) {
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound,
			"no such exercise or revision")
		return
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "exercise", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"exercise": out})
}

func (h *ContentHandler) write(
	w http.ResponseWriter, r *http.Request, e Exercise,
	store func(context.Context, Exercise, string) (Exercise, error),
) {
	// A BACKSTOP. The real check is on the request field in `decodeExercise`,
	// which sees what the client sent rather than what the merge produced;
	// this one catches an Exercise assembled some other way.
	//
	// Neither is in `ValidateForWrite`, and that is the design of this field
	// rather than an omission. That function is shared with
	// `cmd/exportcontent`, whose validate step asks "would this seed?" — and an
	// unrecognised load_mode WOULD seed, as `total`, because
	// `NormalizeLoadMode` fails it closed so one bad row cannot break a deploy.
	// A strict shared validator therefore fails an export over something that
	// would have worked; two of that command's tests proved it.
	//
	// An API write is the opposite case: exactly one author, waiting for a
	// response, and coercing `per_sied` to `total` for them is the
	// dumbbell-halving bug arriving through a spelling mistake — invisible
	// until somebody notices their tonnage is out by half.
	if e.LoadMode != LoadModeTotal && e.LoadMode != LoadModePerSide {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			fmt.Sprintf("unknown load_mode %q — one of: %s, %s",
				e.LoadMode, LoadModeTotal, LoadModePerSide))
		return
	}
	if err := ValidateForWrite(e); err != nil {
		// The message names the offending value and the legal set. This is
		// content authoring, and "invalid input" alone means opening the source
		// to find out which of eleven fields was wrong.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	}

	out, err := store(r.Context(), e, actorOf(r))
	switch {
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"an exercise with that name already exists — ids are derived from the name")
		return
	case errors.Is(err, ErrInvalidInput):
		// A conduit from the repository straight to the client, and safe only
		// because nothing there wraps ErrInvalidInput today. If a pg-error
		// mapping is ever added (technique's does, for its ruleset foreign key),
		// the message it carries must stay prose — never the driver's text.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	case errors.Is(err, ErrNotFound):
		h.explainNotFound(w, r, e.ID)
		return
	case err != nil:
		apihttp.WriteInternal(w, r, "exercise", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"exercise": out})
}

// explainNotFound is a plain 404 now.
//
// It used to tell "no such id" apart from "that one is seeded" and return a
// 409 for the second, because the console refused to edit a seeded row. Since
// the spreadsheet was retired the console edits any row and the write takes
// ownership of it, so the only way to reach here is an id that does not exist.
// Kept as a function rather than inlined: both call sites read better naming
// the case, and step 2's whole point is that there is now only one.
func (h *ContentHandler) explainNotFound(w http.ResponseWriter, r *http.Request, _ string) {
	apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "exercise not found")
}

func decodeExercise(w http.ResponseWriter, r *http.Request) (exerciseRequest, bool) {
	var body exerciseRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxContentBody)).Decode(&body); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "malformed request body")
		return exerciseRequest{}, false
	}
	// Judged on what the CLIENT sent, before any merge — which is the whole
	// point, and the reason this is not down in `write()` with the other
	// validation.
	//
	// A merged value has already been through `applyTo`, whose tail rewrites ""
	// to `total` so a create need not mention the field. Validating after that
	// therefore cannot see the one wrong value most likely to be sent by
	// accident: an explicit `"load_mode": ""`, which a client with an empty
	// placeholder option or a `?? ''` produces without trying. It would flip a
	// per_side row to total on a PATCH and answer 200 — the halving bug, past a
	// check written to stop exactly that.
	//
	// Absent stays absent: nil means "leave it alone", and only a value the
	// client actually chose is judged.
	if body.Implements != nil && *body.Implements != 1 && *body.Implements != 2 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			fmt.Sprintf("implements must be 1 or 2, got %d", *body.Implements))
		return exerciseRequest{}, false
	}
	if body.LoadMode != nil && *body.LoadMode != LoadModeTotal && *body.LoadMode != LoadModePerSide {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			fmt.Sprintf("unknown load_mode %q — one of: %s, %s",
				*body.LoadMode, LoadModeTotal, LoadModePerSide))
		return exerciseRequest{}, false
	}
	return body, true
}
