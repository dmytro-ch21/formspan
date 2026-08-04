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
	// source tells a seeded technique from an admin one, so a refusal can
	// explain itself.
	source func(ctx context.Context, id string) (string, error)
}

func NewContentHandler(repo *PostgresRepository) *ContentHandler {
	return &ContentHandler{repo: repo, source: repo.Source}
}

// techniqueRequest is the admin-writable surface.
//
// `id` and `source` are absent on purpose. The id is DERIVED from the name at
// creation and immutable after — it is a foreign key in athletes' training
// records, so it outlives every other field here and cannot be a client's to
// choose or change. `source` is the server's.
type techniqueRequest struct {
	Name            string   `json:"name"`
	Aliases         []string `json:"aliases"`
	Category        string   `json:"category"`
	Position        string   `json:"position"`
	PositionDetail  string   `json:"position_detail"`
	GiNoGi          string   `json:"gi_no_gi"`
	TypicalBelt     string   `json:"typical_belt"`
	Description     string   `json:"description"`
	SetupFrom       []string `json:"setup_from"`
	CommonCounters  []string `json:"common_counters"`
	WhenToUse       string   `json:"when_to_use"`
	CommonNextMoves []string `json:"common_next_moves"`
	VideoReference  string   `json:"video_reference"`
	SourceNotes     string   `json:"source_notes"`
	IBJJFRulesetID  string   `json:"ibjjf_ruleset_id"`
	Function        string   `json:"function"`
	ToPosition      string   `json:"to_position"`
}

func (b techniqueRequest) toTechnique(id string) Technique {
	return Technique{
		ID: id, Name: b.Name, Aliases: nonNil(b.Aliases), Category: b.Category,
		Position: b.Position, PositionDetail: b.PositionDetail, GiNoGi: b.GiNoGi,
		TypicalBelt: b.TypicalBelt, Description: b.Description,
		SetupFrom: nonNil(b.SetupFrom), CommonCounters: nonNil(b.CommonCounters),
		WhenToUse: b.WhenToUse, CommonNextMoves: nonNil(b.CommonNextMoves),
		VideoReference: b.VideoReference, SourceNotes: b.SourceNotes,
		IBJJFRulesetID: b.IBJJFRulesetID, Function: b.Function, ToPosition: b.ToPosition,
	}
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

func (h *ContentHandler) Create(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeTechnique(w, r)
	if !ok {
		return
	}
	id := Slug(body.Name)
	if id == "" {
		// A name of only punctuation or emoji slugs to nothing, and an empty
		// id would fail the NOT NULL far from the cause.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"name must contain letters or digits — the id is derived from it")
		return
	}
	h.write(w, r, body.toTechnique(id), h.repo.CreateTechnique)
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
	h.write(w, r, body.toTechnique(id), h.repo.UpdateTechnique)
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
	source, err := h.source(r.Context(), id)
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
