package classplan

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// maxBody caps a request at roughly what maxBlocks of legal input can weigh —
// matching sequence.maxBody. Without it a client can stream an arbitrary
// body into json.Decode before any validation runs, since the block-count
// cap is only checked once the whole thing is already in memory.
const maxBody = 256 << 10

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	list, err := h.repo.List(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"class_plans": list})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	p, err := h.repo.Get(r.Context(), r.PathValue("classPlanID"), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, p)
}

// blockBody is the wire shape of one block.
//
// Separate from NewBlock rather than reusing it, so the JSON contract and
// the domain input can differ without one silently redefining the other —
// matching sequence's stepBody/NewStep split. The library projections
// (technique_name, technique_position) simply have nowhere to be sent here;
// a client that sends them is ignored rather than trusted.
type blockBody struct {
	Type            string  `json:"type"`
	DurationMinutes int     `json:"duration_minutes"`
	TechniqueID     *string `json:"technique_id"`
	FreeText        *string `json:"free_text"`
	Notes           string  `json:"notes"`
}

func toNewBlocks(in []blockBody) []NewBlock {
	// nil in, nil out — the caller distinguishes "field absent" from "empty
	// list", and flattening that here would make PATCH unable to clear a
	// plan's blocks. (Go's json.Unmarshal already gives a plain slice field
	// this property: an absent key leaves it nil, a present `[]` makes it
	// non-nil-and-empty — no raw-map trick needed here, unlike
	// StartPositionID's null/absent split on sequence.)
	if in == nil {
		return nil
	}
	out := make([]NewBlock, 0, len(in))
	for _, b := range in {
		out = append(out, NewBlock{
			Type:            b.Type,
			DurationMinutes: b.DurationMinutes,
			TechniqueID:     nilIfEmpty(b.TechniqueID),
			FreeText:        nilIfEmpty(b.FreeText),
			Notes:           b.Notes,
		})
	}
	return out
}

// nilIfEmpty collapses a client-sent empty string to nil, so a caller
// sending an empty technique_id alongside a real free_text reads as "not
// set" to BOTH validation layers, not just one of them. Without this,
// ValidateBlocks treats a non-nil empty string as unset (techSet/freeSet
// already check for a nonempty value) while insertBlocks would still write
// it as a non-NULL empty column value — which the Postgres CHECK sees as
// "set", so the exact input the Go validator was supposed to wave through
// instead dies on a constraint violation with no field named, defeating
// the entire reason that validator exists (classplan.go's comment on
// Validate). Normalising at the wire boundary means every layer downstream
// agrees about what "set" means.
func nilIfEmpty(s *string) *string {
	if s != nil && *s == "" {
		return nil
	}
	return s
}

type createBody struct {
	// Optional. Supplied by the phone so an offline capture's sync retry is
	// idempotent; omitted by web, where the server picks.
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Blocks      []blockBody `json:"blocks"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var body createBody
	if !decode(w, r, &body) {
		return
	}
	in := NewClassPlan{
		ID:          body.ID,
		Name:        body.Name,
		Description: body.Description,
		Blocks:      toNewBlocks(body.Blocks),
	}
	if err := in.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	p, err := h.repo.Create(r.Context(), claims.UserID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, p)
}

type updateBody struct {
	Name        *string     `json:"name"`
	Description *string     `json:"description"`
	Blocks      []blockBody `json:"blocks"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var body updateBody
	if !decode(w, r, &body) {
		return
	}
	in := ClassPlanUpdate{
		Name:        body.Name,
		Description: body.Description,
		Blocks:      toNewBlocks(body.Blocks),
	}
	if err := in.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	p, err := h.repo.Update(r.Context(), r.PathValue("classPlanID"), claims.UserID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, p)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), r.PathValue("classPlanID"), claims.UserID); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		// DISTINGUISHED, because they are different things — matching
		// sequence.readBody. Mapping every read failure to 413 would tell a
		// client whose connection dropped mid-body that its request was too
		// large, which sends them looking in the wrong place entirely.
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			apihttp.WriteError(w, http.StatusRequestEntityTooLarge, apihttp.CodeInvalidInput,
				"request body too large")
			return nil, false
		}
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"could not read request body")
		return nil, false
	}
	return raw, true
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	raw, ok := readBody(w, r)
	if !ok {
		return false
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "malformed JSON body")
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, err.Error())
	case errors.Is(err, ErrAlreadyExists):
		// A client-supplied id that belongs to somebody else. 409 rather
		// than 403: the caller is allowed to create class plans, the id is
		// taken.
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, err.Error())
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "classplan", err)
	}
}
