package bjj

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// SessionHandler serves the BJJ half of a session.
//
// Separate from Handler (rank and promotions) because they are separate
// nouns that happen to share a discipline — one is who you are, the other is
// what you did on Tuesday.
type SessionHandler struct {
	repo SessionRepository
}

func NewSessionHandler(repo SessionRepository) *SessionHandler {
	return &SessionHandler{repo: repo}
}

type tagRequest struct {
	Category    string  `json:"category"`
	Event       string  `json:"event"`
	Position    string  `json:"position"`
	TechniqueID *string `json:"technique_id"`
	Count       *int    `json:"count"`
}

type sessionDetailRequest struct {
	Kind         string       `json:"kind"`
	Gi           *bool        `json:"gi"`
	Rounds       *int         `json:"rounds"`
	RoundMinutes *int         `json:"round_minutes"`
	SessionRPE   *int         `json:"session_rpe"`
	Academy      string       `json:"academy"`
	Note         string       `json:"note"`
	BodyNote     string       `json:"body_note"`
	Tags         []tagRequest `json:"tags"`
}

func (req sessionDetailRequest) toDetail(sessionID string) SessionDetail {
	d := SessionDetail{
		SessionID:    sessionID,
		Kind:         Kind(req.Kind),
		Gi:           req.Gi,
		Rounds:       req.Rounds,
		RoundMinutes: req.RoundMinutes,
		SessionRPE:   req.SessionRPE,
		Academy:      req.Academy,
		Note:         req.Note,
		BodyNote:     req.BodyNote,
		Tags:         make([]Tag, 0, len(req.Tags)),
	}
	for _, t := range req.Tags {
		// Count defaults to 1 rather than being required. A chip tapped once
		// is the overwhelmingly common case, and making the client send it
		// every time is a field that exists only to be 1.
		count := 1
		if t.Count != nil {
			count = *t.Count
		}
		d.Tags = append(d.Tags, Tag{
			Category:    Category(t.Category),
			Event:       Event(t.Event),
			Position:    t.Position,
			TechniqueID: t.TechniqueID,
			Count:       count,
		})
	}
	return d
}

// PutDetail stores the reflection for a session the caller already created.
//
// PUT rather than POST, and an upsert rather than an insert, because this is
// the same shape as replacing a session's sets: the client holds the desired
// state and re-sends it, so a retry after a failed push converges instead of
// duplicating. That is what lets the mobile outbox treat a BJJ reflection
// exactly like a set list — retryable, idempotent, no reconciliation.
func (h *SessionHandler) PutDetail(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req sessionDetailRequest
	// Bounded before decoding, not after. MaxTags rejects an oversized tag
	// list, but only once the decoder has already materialised the whole
	// array in memory — which is the wrong order for a limit whose job is to
	// stop a caller from making the server allocate. 256 KiB is far past a
	// full MaxTags reflection with long notes.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	d := req.toDetail(r.PathValue("sessionID"))
	if err := d.Validate(); err != nil {
		writeSessionError(w, r, err)
		return
	}

	saved, err := h.repo.PutDetail(r.Context(), claims.UserID, d)
	if err != nil {
		writeSessionError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"detail": saved})
}

func (h *SessionHandler) GetDetail(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	d, err := h.repo.GetDetail(r.Context(), claims.UserID, r.PathValue("sessionID"))
	if err != nil {
		writeSessionError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"detail": d})
}

func writeSessionError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		// Covers both "no such session" and "not yours" — see the owner FK
		// note in the repository.
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "session not found")
	case errors.Is(err, ErrInvalidInput):
		// Names the vocabulary rather than just refusing. The client renders
		// pickers over exactly these values, so a rejection means the two have
		// drifted and the message should say how.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"kind must be one of class, drilling, positional, rolling; "+
				"tag category one of submission, sweep, pass, escape, takedown, control; "+
				"tag event one of drilled, attempted, scored, conceded; "+
				"session_rpe 1-10; rounds, round_minutes and tag count at least 1")
	default:
		apihttp.WriteInternal(w, r, "bjj", err)
	}
}

// ProficiencyHandler serves the technique funnel, read across every session.
//
// Its own handler rather than a method on SessionHandler because it takes a
// different repository interface: this is a cross-session aggregate, not an
// operation on one session, and keeping the interfaces narrow is what lets
// each be faked in a test without stubbing the other.
type ProficiencyHandler struct {
	repo ProficiencyRepository
}

func NewProficiencyHandler(repo ProficiencyRepository) *ProficiencyHandler {
	return &ProficiencyHandler{repo: repo}
}

// List is self-scoped (RequireAuth): the caller's own evidence, never anyone
// else's. There is no path parameter to scope it by and deliberately so —
// this data is one athlete's training record.
func (h *ProficiencyHandler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	rows, err := h.repo.ListProficiency(r.Context(), claims.UserID)
	if err != nil {
		apihttp.WriteInternal(w, r, "bjj", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"techniques": rows,
		// Folded from the same rows the client is being shown, so the headline
		// numbers cannot disagree with the list under them.
		"summary": SummariseProficiency(rows),
	})
}
