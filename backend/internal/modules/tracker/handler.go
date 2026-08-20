package tracker

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// The body cap. A tracker is a dozen short fields; anything larger is a client
// bug or an attempt, and neither deserves an unbounded read.
const maxBody = 8 << 10

// The widest window a single entries request may ask for.
//
// Bounded because the card reads one day and the trend (if one is ever built)
// reads a year, and an unbounded `from`/`to` is a way to ask the database for
// every row an athlete has ever written in one request.
const maxWindowDays = 400

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

func userIDFrom(w http.ResponseWriter, r *http.Request) (string, bool) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return "", false
	}
	return claims.UserID, true
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(into); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return false
	}
	return true
}

// List returns the athlete's trackers, provisioning the defaults first.
//
// Provisioning on a GET is a write on a read, which is worth being explicit
// about rather than hiding: it is idempotent, it is the only moment we know an
// athlete exists, and the alternative — a "set up my trackers" call the client
// has to remember to make — is a step that gets skipped and leaves Today empty.
// It is safe to repeat and safe to race; see EnsureDefaults.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	if err := h.repo.EnsureDefaults(r.Context(), userID, DefaultsFor(userID)); err != nil {
		writeError(w, r, err)
		return
	}
	trackers, err := h.repo.List(r.Context(), userID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"trackers": trackers})
}

// Create stores an athlete-authored tracker (N78) under a client-supplied id.
//
// `preset` is deliberately NOT read from the body. A caller who could name one
// would collide with the provisioning index and make somebody's water card
// unreachable; presets are ours to assign.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	var in New
	if !decode(w, r, &in) {
		return
	}
	in.Preset = ""
	if in.RenderStyle == "" {
		in.RenderStyle = RenderAuto
	}
	if err := in.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	t, err := h.repo.Create(r.Context(), userID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, t)
}

// Update applies a partial patch — the endpoint the phone's "change my target"
// screen calls with a body of exactly `{"target": 2500}`.
//
// Fields the body does not mention are not written. See the package doc for why
// that sentence is the point of this module.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	var p Patch
	if !decode(w, r, &p) {
		return
	}
	if p.IsEmpty() {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"no known field to update")
		return
	}
	if err := p.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	t, err := h.repo.Update(r.Context(), userID, r.PathValue("trackerID"), p)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, t)
}

// Archive is DELETE, and it archives rather than destroys.
//
// The verb is DELETE because that is what the client means and what a REST
// client expects; the effect is a timestamp, because a tracker you stop is not
// a tracker whose past disappears. N78 adds a genuinely destructive path with
// copy that says what it takes with it; there is deliberately none here.
func (h *Handler) Archive(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	if err := h.repo.Archive(r.Context(), userID, r.PathValue("trackerID")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListEntries returns a window of taps across every tracker.
//
// `from` and `to` are LOCAL calendar days supplied by the client, and default to
// nothing rather than to "today": the server does not know the athlete's
// timezone, so a server-side default would be wrong for most of the planet for
// part of every day. A caller that wants today says so.
func (h *Handler) ListEntries(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if !IsDate(from) || !IsDate(to) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"from and to are required, as YYYY-MM-DD")
		return
	}
	if from > to {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"from must not be after to")
		return
	}
	// String comparison above is sound only because IsDate guarantees a
	// fixed-width format; the span below needs real dates.
	f, _ := time.Parse("2006-01-02", from)
	t, _ := time.Parse("2006-01-02", to)
	if t.Sub(f) > maxWindowDays*24*time.Hour {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"window is too wide")
		return
	}
	entries, err := h.repo.Entries(r.Context(), userID, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// LogEntry records one tap under a client-supplied id.
//
// PUT, keyed on the entry id the phone generated: sending it twice is the same
// as sending it once, which is what makes a cup logged in a kitchen with no
// signal safe to retry when the signal comes back.
func (h *Handler) LogEntry(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	var in NewEntry
	if !decode(w, r, &in) {
		return
	}
	in.ID = r.PathValue("entryID")
	if in.LoggedAt.IsZero() {
		// A client that logged offline knows when it happened and says so. One
		// that does not is logging now, and now is a fact the server owns
		// better than a phone with a drifting clock — but the DAY still comes
		// from the client, because only the client knows the timezone.
		in.LoggedAt = time.Now().UTC()
	}
	if err := in.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	e, err := h.repo.LogEntry(r.Context(), userID, r.PathValue("trackerID"), in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, e)
}

// DeleteEntry removes one tap — the tap-a-filled-cup gesture.
func (h *Handler) DeleteEntry(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	err := h.repo.DeleteEntry(r.Context(), userID, r.PathValue("trackerID"), r.PathValue("entryID"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "no such tracker")
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"that id is already in use")
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "tracker", err)
	}
}
