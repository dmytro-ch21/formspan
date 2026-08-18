package technique

import (
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
)

type Handler struct {
	repo Repository
	// roundMap is the teaching diagram, loaded once at construction rather than
	// per request: it is embedded content that cannot change while the process
	// runs. Passed in rather than loaded here so a bad map fails the process at
	// boot — see cmd/api — instead of being discovered by the first client to
	// open the glossary.
	roundMap *RoundMap
}

func NewHandler(repo Repository, roundMap *RoundMap) *Handler {
	return &Handler{repo: repo, roundMap: roundMap}
}

// maxQueryLen bounds ?q= — no technique name comes close, so anything longer
// is a mistake or an attempt to make the database work for nothing.
const maxQueryLen = 100

// List returns the library, optionally filtered by ?position=, ?category=,
// ?gi= and ?q=. Authenticated but not user-scoped: reference content is the
// same for everyone.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if len(q.Get("q")) > maxQueryLen {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "q is too long")
		return
	}
	if gi := q.Get("gi"); gi != "" && gi != "Gi Only" && gi != "No-Gi Only" && gi != "Both" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			`gi must be one of: "Gi Only", "No-Gi Only", "Both"`)
		return
	}

	techniques, err := h.repo.List(r.Context(), Filter{
		Position: q.Get("position"),
		Category: q.Get("category"),
		GiNoGi:   q.Get("gi"),
		Query:    q.Get("q"),
	})
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"techniques": techniques})
}

// Rulesets is its own endpoint rather than being embedded in every list
// response. There are 25 and they change with the IBJJF rulebook, not with the
// library — so a client fetches them once, caches them, and turns each
// summary's ibjjf_ruleset_id into a legality badge locally.
func (h *Handler) Rulesets(w http.ResponseWriter, r *http.Request) {
	rulesets, err := h.repo.Rulesets(r.Context())
	if err != nil {
		apihttp.WriteInternal(w, r, "technique: rulesets", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"rulesets": rulesets})
}

// Positions returns the whole glossary — eleven entries, so the same
// fetch-once-and-keep treatment as Rulesets. Clients resolve "techniques from
// here" locally against the library they already hold, which is why there is no
// filter parameter and no per-position technique endpoint.
//
// It carries `round_map` too: the teaching diagram whose nodes are these
// positions. One response rather than two because the map is meaningless
// without the glossary it points into, and two endpoints means two caches that
// can hold different versions of the same vocabulary — a node naming a position
// the client's cached glossary does not have would render as a dead box.
func (h *Handler) Positions(w http.ResponseWriter, r *http.Request) {
	positions, err := h.repo.Positions(r.Context())
	if err != nil {
		apihttp.WriteInternal(w, r, "technique: positions", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"positions": positions,
		"round_map": h.roundMap,
	})
}

func (h *Handler) GetPosition(w http.ResponseWriter, r *http.Request) {
	p, err := h.repo.GetPosition(r.Context(), r.PathValue("positionID"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "position not found")
			return
		}
		apihttp.WriteInternal(w, r, "technique: position", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, p)
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	t, err := h.repo.Get(r.Context(), r.PathValue("techniqueID"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "technique not found")
			return
		}
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, t)
}
