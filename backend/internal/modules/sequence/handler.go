package sequence

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

// maxBody caps a request at roughly what MaxSteps of legal input can weigh.
// Without it a client can stream an arbitrary body into json.Decode before any
// validation runs — the validation cap is on steps, which is only checked after
// the whole thing is in memory.
const maxBody = 256 << 10

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	list, err := h.repo.List(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"sequences": list})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	s, err := h.repo.Get(r.Context(), r.PathValue("sequenceID"), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, s)
}

// stepBody is the wire shape of one step.
//
// Separate from NewStep rather than reusing it, so the JSON contract and the
// domain input can differ without one silently redefining the other — and so
// the library's own fields (name, position, category) simply have nowhere to
// be sent. A client that sends them is ignored rather than trusted.
type stepBody struct {
	TechniqueID      string  `json:"technique_id"`
	EndsAtPositionID *string `json:"ends_at_position_id"`
	Notes            string  `json:"notes"`
}

func toNewSteps(in []stepBody) []NewStep {
	// nil in, nil out — the caller distinguishes "field absent" from "empty
	// list", and flattening that here would make PATCH unable to clear a chain.
	if in == nil {
		return nil
	}
	out := make([]NewStep, 0, len(in))
	for _, s := range in {
		out = append(out, NewStep{
			TechniqueID:      s.TechniqueID,
			EndsAtPositionID: s.EndsAtPositionID,
			Notes:            s.Notes,
		})
	}
	return out
}

type createBody struct {
	Name            string     `json:"name"`
	Description     string     `json:"description"`
	StartPositionID *string    `json:"start_position_id"`
	Steps           []stepBody `json:"steps"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var body createBody
	if !decode(w, r, &body) {
		return
	}
	in := NewSequence{
		Name:            body.Name,
		Description:     body.Description,
		StartPositionID: body.StartPositionID,
		Steps:           toNewSteps(body.Steps),
	}
	if err := in.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	s, err := h.repo.Create(r.Context(), claims.UserID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, s)
}

// updateBody uses pointers so an ABSENT field and an explicitly null one are
// different requests. `start_position_id: null` clears the start; omitting the
// key leaves it. A plain string could not tell those apart, which is what
// SetStartPosition exists to carry into the repository.
type updateBody struct {
	Name            *string    `json:"name"`
	Description     *string    `json:"description"`
	StartPositionID *string    `json:"start_position_id"`
	Steps           []stepBody `json:"steps"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	// Decoded into a map first, purely to learn which keys were PRESENT.
	// json.Unmarshal into a *string cannot distinguish `"x": null` from a
	// missing "x" — both leave the pointer nil — and that distinction is the
	// difference between clearing the start position and leaving it alone.
	raw, ok := readBody(w, r)
	if !ok {
		return
	}
	var present map[string]json.RawMessage
	if err := json.Unmarshal(raw, &present); err != nil {
		badJSON(w)
		return
	}
	var body updateBody
	if err := json.Unmarshal(raw, &body); err != nil {
		badJSON(w)
		return
	}

	_, setStart := present["start_position_id"]
	in := Update{
		Name:             body.Name,
		Description:      body.Description,
		SetStartPosition: setStart,
		StartPositionID:  body.StartPositionID,
		Steps:            toNewSteps(body.Steps),
	}
	if err := in.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	s, err := h.repo.Update(r.Context(), r.PathValue("sequenceID"), claims.UserID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, s)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), r.PathValue("sequenceID"), claims.UserID); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		// DISTINGUISHED, because they are different things. This mapped every
		// read failure to 413, so a client whose connection dropped mid-body
		// was told its request was too large — an error message that sends
		// somebody looking in the wrong place entirely.
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
		badJSON(w)
		return false
	}
	return true
}

func badJSON(w http.ResponseWriter) {
	apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "malformed JSON body")
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, err.Error())
	case errors.Is(err, ErrForbidden):
		// 403 rather than 404, and only ever reached from a WRITE — see the
		// declaration. The read path returns ErrNotFound for anything the
		// caller cannot see, so this can only mean "you can see it and may not
		// change it", which leaks nothing they did not already have.
		apihttp.WriteError(w, http.StatusForbidden, apihttp.CodeForbidden, err.Error())
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "sequence", err)
	}
}
