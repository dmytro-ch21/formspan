package curriculum

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

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	list, err := h.repo.List(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"curricula": list})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	c, err := h.repo.Get(r.Context(), claims.UserID, r.PathValue("curriculumID"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, c)
}

// itemRequest is the wire shape of one item.
//
// Criteria is flattened rather than nested, matching the column names 1:1 the
// way the rest of this API does. A nil target_scored means no criterion at all,
// which is what makes a curriculum able to be a plain reading list.
type itemRequest struct {
	TechniqueID    string   `json:"technique_id"`
	Notes          string   `json:"notes"`
	TargetScored   *int     `json:"target_scored"`
	TargetDefended *int     `json:"target_defended"`
	TargetSessions *int     `json:"target_sessions"`
	MinHitRate     *float64 `json:"min_hit_rate"`
}

func (i itemRequest) toDomain() NewItem {
	out := NewItem{TechniqueID: i.TechniqueID, Notes: i.Notes}
	// EITHER volume target makes this a criterion. Defence-only is the case
	// that justified adding the `defended` event: "not get caught in guard pull
	// N times" has no offensive half.
	if i.TargetScored != nil || i.TargetDefended != nil {
		out.Criteria = &Criteria{
			TargetScored:   i.TargetScored,
			TargetDefended: i.TargetDefended,
			TargetSessions: i.TargetSessions,
			MinHitRate:     i.MinHitRate,
		}
	}
	return out
}

type createRequest struct {
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Belt        *string       `json:"belt"`
	Visibility  string        `json:"visibility"`
	Items       []itemRequest `json:"items"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req createRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Name == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "name is required")
		return
	}
	// Default rather than reject. Private is the safe answer and the one an
	// athlete building their own list means; requiring it would make every
	// client send a field nobody thinks about.
	if req.Visibility == "" {
		req.Visibility = "private"
	}
	if !ValidVisibility(req.Visibility) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "visibility must be private or public")
		return
	}

	items := make([]NewItem, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, it.toDomain())
	}
	if err := ValidateItems(items); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"items must be unique techniques with positive targets, and at most 60 of them")
		return
	}

	c, err := h.repo.Create(r.Context(), claims.UserID, NewCurriculum{
		Name:        req.Name,
		Description: req.Description,
		Belt:        req.Belt,
		Visibility:  req.Visibility,
		Items:       items,
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, c)
}

type updateRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Belt        *string `json:"belt"`
	Visibility  *string `json:"visibility"`
	// Pointer to a slice so the three states stay distinct: absent leaves the
	// list alone, [] empties it, and a list replaces it. A plain slice collapses
	// the first two, which would make every metadata edit silently delete every
	// item.
	Items *[]itemRequest `json:"items"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req updateRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Name != nil && *req.Name == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "name cannot be empty")
		return
	}
	if req.Visibility != nil && !ValidVisibility(*req.Visibility) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "visibility must be private or public")
		return
	}

	in := Update{Name: req.Name, Description: req.Description, Belt: req.Belt, Visibility: req.Visibility}
	if req.Items != nil {
		items := make([]NewItem, 0, len(*req.Items))
		for _, it := range *req.Items {
			items = append(items, it.toDomain())
		}
		if err := ValidateItems(items); err != nil {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"items must be unique techniques with positive targets, and at most 60 of them")
			return
		}
		in.Items = items
	}

	c, err := h.repo.Update(r.Context(), claims.UserID, r.PathValue("curriculumID"), in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, c)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), claims.UserID, r.PathValue("curriculumID")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Enroll(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Enroll(r.Context(), claims.UserID, r.PathValue("curriculumID")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Archive(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Archive(r.Context(), claims.UserID, r.PathValue("curriculumID")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// decode reads a bounded JSON body, reporting the failure itself.
//
// Bounded because nothing else bounds it: a curriculum carries an item array,
// and an unbounded decode of an array is a memory exhaustion the auth check
// does not protect against — an authenticated user is still a stranger.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, MaxBody)).Decode(v); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, err.Error())
	case errors.Is(err, ErrForbidden):
		// 403 rather than 404, and only ever reached from a WRITE. The read
		// path returns ErrNotFound for anything the caller cannot see, so this
		// can only mean "you can see it and may not change it" — which leaks
		// nothing they did not already have.
		apihttp.WriteError(w, http.StatusForbidden, apihttp.CodeUnauthorized, err.Error())
	case errors.Is(err, ErrInUse):
		// 409, not 403: the caller is allowed to do this and the state says no.
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, err.Error())
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, err.Error())
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "curriculum", err)
	}
}
