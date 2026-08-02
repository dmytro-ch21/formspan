package bjj

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct {
	repo Repository
	// now is injectable so time-at-belt is testable without waiting a year.
	now func() time.Time
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo, now: time.Now}
}

// GetStanding returns the current rank and the whole promotion history.
//
// One endpoint rather than a rank endpoint and a history endpoint, because
// the rank is DERIVED from the history — two endpoints would either compute
// it twice or let a client render a rank that disagrees with the list right
// beneath it.
func (h *Handler) GetStanding(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	promotions, err := h.repo.ListPromotions(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, StandingFrom(promotions, h.now()))
}

// AdminGetStanding is the same derivation as GetStanding, over a path userID
// rather than the caller's own claims. Wired under RequireAdmin in main.go —
// the admin console shows an athlete's rank beside them, but never edits it.
func (h *Handler) AdminGetStanding(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userID")
	promotions, err := h.repo.ListPromotions(r.Context(), userID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, StandingFrom(promotions, h.now()))
}

type promotionRequest struct {
	Belt       string  `json:"belt"`
	Stripes    int     `json:"stripes"`
	Degree     int     `json:"degree"`
	PromotedOn *string `json:"promoted_on"`
	Academy    string  `json:"academy"`
	Instructor string  `json:"instructor"`
	Note       string  `json:"note"`
}

func (req promotionRequest) toPromotion(userID, id string) (Promotion, error) {
	rank := Rank{Belt: Belt(req.Belt), Stripes: req.Stripes, Degree: req.Degree}
	if err := rank.Validate(); err != nil {
		return Promotion{}, err
	}
	return Promotion{
		ID:         id,
		UserID:     userID,
		Rank:       rank,
		PromotedOn: req.PromotedOn,
		Academy:    req.Academy,
		Instructor: req.Instructor,
		Note:       req.Note,
	}, nil
}

func (h *Handler) CreatePromotion(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req promotionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	// Empty id: Postgres mints it via the column default. See the migration
	// for why this one is server-side while sessions and workouts are not.
	p, err := req.toPromotion(claims.UserID, "")
	if err != nil {
		writeError(w, r, err)
		return
	}

	created, err := h.repo.CreatePromotion(r.Context(), p)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, created)
}

func (h *Handler) UpdatePromotion(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	id := r.PathValue("promotionID")

	var req promotionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	p, err := req.toPromotion(claims.UserID, id)
	if err != nil {
		writeError(w, r, err)
		return
	}

	updated, err := h.repo.UpdatePromotion(r.Context(), p)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, updated)
}

func (h *Handler) DeletePromotion(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.DeletePromotion(r.Context(), claims.UserID, r.PathValue("promotionID")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "promotion not found")
	case errors.Is(err, ErrInvalidInput):
		// Names what is acceptable rather than just refusing. The client
		// renders a picker over exactly the rank values, so a rank rejection
		// here means the two have drifted and the message should say how.
		// `promoted_on` shares this same sentinel (see parseDate) precisely
		// because it is also invalid input, not a server fault — so the
		// message has to cover it too, or a bad date reads as a bad rank.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"belt must be one of white, blue, purple, brown, black; stripes 0-4; degree 0-6 and only on black; promoted_on must be YYYY-MM-DD or omitted")
	default:
		// Never the raw error: it is a database message, and the conventions
		// forbid leaking one to a client.
		apihttp.WriteInternal(w, r, "bjj", err)
	}
}
