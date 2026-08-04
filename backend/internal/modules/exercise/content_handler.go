package exercise

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
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
	IsUnilateral          *bool     `json:"is_unilateral"`
	Instructions          *string   `json:"instructions"`
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
	authored, err := h.repo.AdminAuthored(r.Context())
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

func (h *ContentHandler) write(
	w http.ResponseWriter, r *http.Request, e Exercise,
	store func(context.Context, Exercise) (Exercise, error),
) {
	if err := ValidateForWrite(e); err != nil {
		// The message names the offending value and the legal set. This is
		// content authoring, and "invalid input" alone means opening the source
		// to find out which of eleven fields was wrong.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	}

	out, err := store(r.Context(), e)
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

// explainNotFound tells "no such id" apart from "that one is seeded".
//
// A bare 404 at an id the console is literally displaying reads as a bug, and
// the fix for the second case is completely different: seeded content is
// changed in the JSON and deployed, because an edit here would be reverted by
// the next re-seed.
func (h *ContentHandler) explainNotFound(w http.ResponseWriter, r *http.Request, id string) {
	source, err := h.repo.Source(r.Context(), id)
	if err == nil && source != "admin" {
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"that exercise comes from the seeded catalog, so a deploy owns it — "+
				"edit exercises.json and re-deploy, or an edit here is reverted on the next release")
		return
	}
	apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "exercise not found")
}

func decodeExercise(w http.ResponseWriter, r *http.Request) (exerciseRequest, bool) {
	var body exerciseRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxContentBody)).Decode(&body); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "malformed request body")
		return exerciseRequest{}, false
	}
	return body, true
}
