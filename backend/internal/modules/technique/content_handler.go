package technique

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
)

// maxContentBody bounds the write. A technique with full prose is a few KB;
// 64 KB leaves room without accepting an upload.
const maxContentBody = 64 << 10

// ContentHandler is the admin console's write access to the catalog.
//
// Wired under RequireAdmin, which is the real boundary — the console's own
// allowlist check is defence in depth for the UI.
type ContentHandler struct {
	repo ContentRepository
}

// NewContentHandler takes the INTERFACE, not *PostgresRepository. Taking the
// concrete type is why this layer had no tests, and three defects shipped in
// it — a full-replace PATCH, zero-valued timestamps, and an unbounded name.
func NewContentHandler(repo ContentRepository) *ContentHandler {
	return &ContentHandler{repo: repo}
}

// techniqueRequest is the admin-writable surface.
//
// `id` and `source` are absent on purpose. The id is DERIVED from the name at
// creation and immutable after — it is a foreign key in athletes' training
// records, so it outlives every other field here and cannot be a client's to
// choose or change. `source` is the server's.
//
// Every field is a POINTER so absent can be told from empty. PATCH is a partial
// update — which is what the method means and what the contract promises, since
// only four fields are `required` — and the first version of this decoded into
// plain strings, so a console form posting just the edited field silently wiped
// the other fourteen. Omitting `description` erased the prose.
type techniqueRequest struct {
	Name            *string   `json:"name"`
	Aliases         *[]string `json:"aliases"`
	Category        *string   `json:"category"`
	Position        *string   `json:"position"`
	PositionDetail  *string   `json:"position_detail"`
	GiNoGi          *string   `json:"gi_no_gi"`
	TypicalBelt     *string   `json:"typical_belt"`
	Description     *string   `json:"description"`
	SetupFrom       *[]string `json:"setup_from"`
	CommonCounters  *[]string `json:"common_counters"`
	WhenToUse       *string   `json:"when_to_use"`
	CommonNextMoves *[]string `json:"common_next_moves"`
	VideoReference  *string   `json:"video_reference"`
	SourceNotes     *string   `json:"source_notes"`
	IBJJFRulesetID  *string   `json:"ibjjf_ruleset_id"`
	Function        *string   `json:"function"`
	ToPosition      *string   `json:"to_position"`
}

// applyTo overlays the present fields onto a base — the zero Technique for a
// create, the stored row for an update. Absent leaves the base alone; present
// wins even when it is empty, so clearing a field is expressible.
func (b techniqueRequest) applyTo(base Technique) Technique {
	set := func(dst *string, src *string) {
		if src != nil {
			*dst = *src
		}
	}
	setList := func(dst *[]string, src *[]string) {
		if src != nil {
			*dst = nonNil(*src)
		}
	}
	set(&base.Name, b.Name)
	set(&base.Category, b.Category)
	set(&base.Position, b.Position)
	set(&base.PositionDetail, b.PositionDetail)
	set(&base.GiNoGi, b.GiNoGi)
	set(&base.TypicalBelt, b.TypicalBelt)
	set(&base.Description, b.Description)
	set(&base.WhenToUse, b.WhenToUse)
	set(&base.VideoReference, b.VideoReference)
	set(&base.SourceNotes, b.SourceNotes)
	set(&base.IBJJFRulesetID, b.IBJJFRulesetID)
	set(&base.Function, b.Function)
	set(&base.ToPosition, b.ToPosition)
	setList(&base.Aliases, b.Aliases)
	setList(&base.SetupFrom, b.SetupFrom)
	setList(&base.CommonCounters, b.CommonCounters)
	setList(&base.CommonNextMoves, b.CommonNextMoves)
	base.Aliases = nonNil(base.Aliases)
	base.SetupFrom = nonNil(base.SetupFrom)
	base.CommonCounters = nonNil(base.CommonCounters)
	base.CommonNextMoves = nonNil(base.CommonNextMoves)
	return base
}

// nonNil keeps a nil slice out of a NOT NULL text[] column.
func nonNil(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

// Positions serves the vocabulary a client must pick from.
//
// Derived from the catalog rather than a constant, so the editor's dropdown and
// the validator can never disagree — the failure that would otherwise follow is
// a technique filed under a position no filter matches, which renders fine and
// returns nothing forever.
func (h *ContentHandler) Positions(w http.ResponseWriter, r *http.Request) {
	known, err := h.repo.KnownPositions(r.Context())
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"positions": known})
}

// List serves the techniques the console owns.
//
// Deliberately NOT the whole catalog. The console can only edit admin-authored
// rows — UpdateTechnique refuses a seeded one, because the JSON owns those and
// an edit here is reverted by the next deploy — so listing all 466 would offer
// 466 rows of which 16 are actionable. The screen says where the rest live
// instead.
//
// Unbounded, like the export's read of the same set: this grows by hand, one
// technique at a time, and a console that silently truncated its own content
// would be worse than a slow one.
func (h *ContentHandler) List(w http.ResponseWriter, r *http.Request) {
	authored, err := h.repo.AdminAuthored(r.Context())
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"techniques": authored})
}

func (h *ContentHandler) Create(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeTechnique(w, r)
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
		// A name of only punctuation or emoji slugs to nothing, and an empty
		// id would fail the NOT NULL far from the cause.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"name must contain letters or digits — the id is derived from it")
		return
	}
	t := body.applyTo(Technique{})
	t.ID = id
	h.write(w, r, t, h.repo.CreateTechnique)
}

func (h *ContentHandler) Update(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeTechnique(w, r)
	if !ok {
		return
	}
	// From the path, never the body. Renaming a technique must not move its
	// id: the old one is already a foreign key in training records, so a move
	// would either orphan them or silently repoint them at different content.
	id := r.PathValue("techniqueID")

	// Read-modify-write, so an absent field keeps its stored value. Not atomic
	// against a concurrent edit of the same technique — acceptable for a
	// single-operator console, and the alternative (a partial UPDATE built from
	// present keys) trades that for dynamic SQL over eighteen columns.
	current, err := h.repo.GetTechnique(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		h.explainNotFound(w, r, id)
		return
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	next := body.applyTo(current)
	next.ID = id
	h.write(w, r, next, h.repo.UpdateTechnique)
}

func (h *ContentHandler) write(
	w http.ResponseWriter, r *http.Request, t Technique,
	store func(context.Context, Technique) (Technique, error),
) {
	known, err := h.repo.KnownPositions(r.Context())
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	if err := ValidateForWrite(t, known); err != nil {
		// The message names the offending value and the legal set. This is
		// content authoring, and "invalid input" alone means opening the
		// source to find out which of eighteen fields was wrong.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	}

	out, err := store(r.Context(), t)
	switch {
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"a technique with that name already exists — ids are derived from the name")
		return
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	case errors.Is(err, ErrNotFound):
		h.explainNotFound(w, r, t.ID)
		return
	case err != nil:
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"technique": out})
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
			"that technique comes from the seeded library, so a deploy owns it — "+
				"edit techniques.json and re-deploy, or an edit here is reverted on the next release")
		return
	}
	apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "technique not found")
}

func decodeTechnique(w http.ResponseWriter, r *http.Request) (techniqueRequest, bool) {
	var body techniqueRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxContentBody)).Decode(&body); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "malformed request body")
		return techniqueRequest{}, false
	}
	return body, true
}
