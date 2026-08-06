package technique

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"net/http"
	"strconv"
	"strings"

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

// List serves what the console authored, or — with `?q=` — searches the lot.
//
// The default is deliberately NOT the whole catalog, but the reason changed:
// every row is editable now, so it is no longer "the rest would 409 when
// clicked", it is simply that 542 full rows is ~570 KB of prose to render a
// list. The authored set is also runtime state rather than a property of the
// seed — it rises as the console writes, gains any seeded row someone edits
// (the write takes ownership), and drains on `exportcontent -adopt`.
//
// The authored branch is unbounded, like the export's read of the same set:
// it grows by hand, one technique at a time, and a console that silently
// truncated its own content would be worse than a slow one. The search branch
// IS capped — see maxConsoleSearch.
func (h *ContentHandler) List(w http.ResponseWriter, r *http.Request) {
	// `?q=` searches the WHOLE catalog; without it the list is what the console
	// authored. Two behaviours behind one endpoint on purpose: the authored set
	// is the useful default (it is what you were just working on, and it is
	// what `-adopt` drains), while search is how you reach the other 450 now
	// that they are editable. Returning all 542 by default would be ~570 KB of
	// prose to render a list.
	var (
		authored []Technique
		err      error
	)
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		authored, err = h.repo.SearchAll(r.Context(), q)
	} else {
		authored, err = h.repo.AdminAuthored(r.Context())
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	// `[]`, never `null`. A nil slice marshals to null and a console mapping
	// over it throws where an empty state should render — and "nothing authored
	// yet" is the first thing a new operator sees, plus the state every
	// environment returns to after `-adopt` drains the set.
	//
	// Guaranteed HERE rather than in the repository. It was true there, but the
	// test asserting it could not see it: review changed `out := []Technique{}`
	// to `var out []Technique` in the Postgres implementation and the whole
	// suite stayed green, because the fake independently hardcoded the same
	// thing. Now the property belongs to the endpoint and holds for every
	// implementer.
	if authored == nil {
		authored = []Technique{}
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

// actorOf reads the caller's id from the request's own claims.
//
// Never from the body or a header. The audit trail's whole value is that the
// actor cannot be chosen by the thing being audited — and RequireAdmin has
// already run, so the claims are there.
func actorOf(r *http.Request) string {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if claims == nil {
		// Unreachable behind RequireAdmin. Recorded rather than defaulted to
		// something plausible: a revision attributed to a guessed actor is
		// worse than one that admits it does not know.
		return "unknown"
	}
	return claims.UserID
}

// Revisions serves a technique's history, newest first.
func (h *ContentHandler) Revisions(w http.ResponseWriter, r *http.Request) {
	out, err := h.repo.Revisions(r.Context(), r.PathValue("techniqueID"))
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	// `[]`, never null — a console mapping over it would throw where an empty
	// state should render, and empty is the NORMAL case: the 542 seeded rows
	// have no history until someone edits one.
	if out == nil {
		out = []Revision{}
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"revisions": out})
}

// Restore rolls a technique back to an earlier revision, as a new revision.
func (h *ContentHandler) Restore(w http.ResponseWriter, r *http.Request) {
	revision, err := strconv.Atoi(r.PathValue("revision"))
	if err != nil || revision < 1 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"revision must be a positive whole number")
		return
	}
	out, err := h.repo.Restore(r.Context(), r.PathValue("techniqueID"), revision, actorOf(r))
	if errors.Is(err, ErrNotFound) {
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound,
			"no such technique or revision")
		return
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"technique": out})
}

// Publish is a separate verb, not a field on PATCH.
//
// A status you can PATCH is a status a partial update can change by accident:
// the edit path is read-modify-write over eighteen fields, and "visible to
// athletes" does not belong in the same request as fixing a typo. Its own route
// means the console has to mean it.
func (h *ContentHandler) Publish(w http.ResponseWriter, r *http.Request) {
	out, err := h.repo.Publish(r.Context(), r.PathValue("techniqueID"), actorOf(r))
	if errors.Is(err, ErrNotFound) {
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound,
			"no draft technique with that id — it may already be published")
		return
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"technique": out})
}

func (h *ContentHandler) write(
	w http.ResponseWriter, r *http.Request, t Technique,
	store func(context.Context, Technique, string) (Technique, error),
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

	out, err := store(r.Context(), t, actorOf(r))
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

// explainNotFound is a plain 404 now.
//
// It used to tell "no such id" apart from "that one is seeded" and return a
// 409 for the second, because the console refused to edit a seeded row. Since
// the spreadsheet was retired the console edits any row and the write takes
// ownership of it, so the only way to reach here is an id that does not exist.
// Kept as a function rather than inlined: both call sites read better naming
// the case, and step 2's whole point is that there is now only one.
func (h *ContentHandler) explainNotFound(w http.ResponseWriter, r *http.Request, _ string) {
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
