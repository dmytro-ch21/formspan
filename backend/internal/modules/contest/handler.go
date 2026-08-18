package contest

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

// maxBody bounds one entry's payload.
//
// Sized against the caps rather than guessed: MaxMatches (64) matches each
// carrying an opponent (80) and a note (280) is roughly 25 KB of content, and
// 64 KiB leaves room for JSON overhead without accepting a body nothing valid
// could fill. It is the SECOND line of defence, not the first — the per-field
// caps in Validate are what bound any single column, since none of these
// columns has a length constraint in the database.
const maxBody = 64 << 10

// contestRequest is the wire shape. Separate from Input because the two have
// genuinely different jobs: this one mirrors the JSON exactly, Input is what
// the domain validates and normalises.
type contestRequest struct {
	Sport          string  `json:"sport"`
	Name           string  `json:"name"`
	Organisation   string  `json:"organisation"`
	HeldOn         *string `json:"held_on"`
	Format         string  `json:"format"`
	Gi             *bool   `json:"gi"`
	DivisionBelt   string  `json:"division_belt"`
	DivisionAge    string  `json:"division_age"`
	DivisionWeight string  `json:"division_weight"`
	Placement      *int    `json:"placement"`
	Entrants       *int    `json:"entrants"`
	Note           string  `json:"note"`
	Matches        []struct {
		Result      string  `json:"result"`
		Method      string  `json:"method"`
		TechniqueID *string `json:"technique_id"`
		Opponent    string  `json:"opponent"`
		Note        string  `json:"note"`
	} `json:"matches"`
}

// toInput converts and validates. Note the match request struct has no
// `position` field at all — a client cannot send one even by accident, which is
// a stronger statement of "the server numbers these" than ignoring a field
// would be.
func (req contestRequest) toInput() (Input, error) {
	in := Input{
		Sport:          req.Sport,
		Name:           req.Name,
		Organisation:   req.Organisation,
		HeldOn:         req.HeldOn,
		Format:         Format(req.Format),
		Gi:             req.Gi,
		DivisionBelt:   req.DivisionBelt,
		DivisionAge:    req.DivisionAge,
		DivisionWeight: req.DivisionWeight,
		Placement:      req.Placement,
		Entrants:       req.Entrants,
		Note:           req.Note,
		Matches:        make([]Match, 0, len(req.Matches)),
	}
	for _, m := range req.Matches {
		in.Matches = append(in.Matches, Match{
			Result:      Result(m.Result),
			Method:      Method(m.Method),
			TechniqueID: m.TechniqueID,
			Opponent:    m.Opponent,
			Note:        m.Note,
		})
	}
	if err := in.Validate(); err != nil {
		return Input{}, err
	}
	return in, nil
}

func decode(w http.ResponseWriter, r *http.Request) (Input, bool) {
	var req contestRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&req); err != nil {
		// A body over the limit lands here too, as a *http.MaxBytesError. Both
		// are the caller's problem and both are 400 — distinguishing them would
		// say how big the limit is, which is not something a client can act on.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return Input{}, false
	}
	in, err := req.toInput()
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return Input{}, false
	}
	return in, true
}

// List returns the caller's competitive record, newest first.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	list, err := h.repo.List(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// A named envelope rather than a bare array, matching `friend` and
	// `curriculum`: it leaves room to add a derived summary beside the list
	// later without that being a breaking change.
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"contests": list})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	c, err := h.repo.Get(r.Context(), claims.UserID, r.PathValue("contestID"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, c)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	in, ok := decode(w, r)
	if !ok {
		return
	}
	c, err := h.repo.Create(r.Context(), claims.UserID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, c)
}

// Update replaces the whole entry, matches included.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	in, ok := decode(w, r)
	if !ok {
		return
	}
	c, err := h.repo.Update(r.Context(), claims.UserID, r.PathValue("contestID"), in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, c)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), claims.UserID, r.PathValue("contestID")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "contest not found")
	case errors.Is(err, ErrInvalidInput):
		// The wrapped message, which names the field that was refused. Ours,
		// not the database's — translatePgError never passes a pgx string
		// through, so nothing here can leak SQL text to a client.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "contest", err)
	}
}
