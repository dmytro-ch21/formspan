package contest

import (
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
// Sized against the caps in the worst case they actually allow, which is NOT
// the ASCII one. MaxMatches (64) matches each carrying an 80-rune opponent and
// a 280-rune note is ~27 KB of ASCII — but those are RUNE caps, and a CJK
// payload at the same limits is 3 bytes per character before JSON escaping,
// so the true ceiling is ~100 KB. An earlier 64 KiB here would have refused a
// perfectly contract-valid entry as "invalid JSON body", which is the same
// bytes-versus-runes confusion `capRunes` exists to prevent, relocated to the
// body limit. 256 KiB covers the worst case with margin.
//
// It is the SECOND line of defence, not the first — the per-field caps in
// Validate are what bound any single column, since none of these columns has a
// length constraint in the database.
const maxBody = 256 << 10

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

// toInput converts and validates.
//
// The match request struct has no `position` field, so there is no way for a
// client's numbering to influence the stored order — the server assigns it from
// array order in Validate. Note the precise claim: a sent `position` is
// silently DROPPED rather than refused, because `decode` does not set
// `DisallowUnknownFields` (matching every other handler in this codebase). So
// this guarantees the server's numbering wins, not that a client is told its
// field was ignored.
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
	// apihttp.DecodeJSONBody (not the response-writing DecodeJSON/DecodeJSONError)
	// because this handler's status-code philosophy is deliberately different
	// from the shared helper's default: oversized and malformed both collapse
	// to one 400 below, rather than DecodeJSON's 413-vs-400 split — see the
	// comment on that below. DecodeJSONBody still buys the trailing-document
	// guard (N164/#541 found this call site used a bare Decode with no such
	// check — a second concatenated JSON document was silently ignored).
	if err := apihttp.DecodeJSONBody(http.MaxBytesReader(w, r.Body, maxBody), &req); err != nil {
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
