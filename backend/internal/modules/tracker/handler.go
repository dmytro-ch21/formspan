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

// The exact query values that switch a request onto its non-default behaviour.
//
// Literal `"true"`, not "anything truthy": `?archived=0` and `?purge=false` must
// mean what they say, and a lenient parse turns a typo into a destroyed tracker.
// A missing parameter is the safe answer in both cases.
const explicitYes = "true"

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
	// `?archived=true` reads the other list — the trackers this athlete stopped.
	//
	// Deliberately does NOT provision: EnsureDefaults on a request for archived
	// rows would hand somebody a water card they never asked to see while they
	// are looking at the ones they turned off.
	if r.URL.Query().Get("archived") == explicitYes {
		trackers, err := h.repo.ListArchived(r.Context(), userID)
		if err != nil {
			writeError(w, r, err)
			return
		}
		apihttp.WriteJSON(w, http.StatusOK, map[string]any{"trackers": trackers})
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
// a tracker whose past disappears.
//
// **`?purge=true` is the destructive path**, and the shape is chosen so the two
// cannot be confused by accident in either direction:
//
//   - The DEFAULT is the safe one. A caller that forgets the parameter, sends
//     it empty, or misspells it archives — the outcome that loses nothing.
//   - The destructive one has to be spelled out in the URL, so it is visible in
//     a log and in a proxy's access line rather than hidden in a body.
//   - It is not a second route, because two routes onto one resource's removal
//     is how a client ends up calling the wrong one; and it is not a field in
//     the PATCH body, because archiving is a lifecycle transition rather than a
//     field, and folding it into the partial-write path would put "delete
//     everything I logged" one typo away from "change my target".
//
// N76 shipped this endpoint archiving only and said the destructive path was
// N78's. This is it.
func (h *Handler) Archive(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	id := r.PathValue("trackerID")
	var err error
	if r.URL.Query().Get("purge") == explicitYes {
		err = h.repo.Destroy(r.Context(), userID, id)
	} else {
		err = h.repo.Archive(r.Context(), userID, id)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListPresets is the catalogue of trackers an athlete can turn on.
//
// **This endpoint is what makes a `Default: false` preset reachable.** N77's
// coffee ships off — an unremovable daily coffee counter handed to somebody who
// just quit is not a neutral thing for a nutrition app to do — so without a
// catalogue it is code that reaches nobody. The create screen renders this
// above the blank form: "Coffee" is one tap, and everything else is typed.
//
// It lists ONLY the non-default ones. A preset an athlete is given
// automatically is not something to offer them; it is already on their Today,
// or they archived it and it lives on the archived screen with a Restore.
//
// No `taken` flag, deliberately. The client already holds the athlete's
// trackers (it renders them) and can tell; computing it here would mean a
// second query on a request that is otherwise a compiled constant, and it would
// go stale between this response and the tap anyway. `AddPreset` is idempotent,
// so a tap on one they already have is harmless.
func (h *Handler) ListPresets(w http.ResponseWriter, r *http.Request) {
	if _, ok := userIDFrom(w, r); !ok {
		return
	}
	type wire struct {
		Preset      string   `json:"preset"`
		Name        string   `json:"name"`
		Icon        string   `json:"icon"`
		ColorKey    string   `json:"color_key"`
		Unit        string   `json:"unit"`
		Increment   float64  `json:"increment"`
		Target      *float64 `json:"target"`
		RenderStyle string   `json:"render_style"`
		CountNoun   string   `json:"count_noun"`
	}
	// Shaped explicitly rather than returning `Preset` — that struct carries
	// `Default`, which is a provisioning decision and none of a client's
	// business, and a `New` whose `ID` is empty here and would read as a bug.
	out := []wire{}
	for _, p := range NonDefaultPresets() {
		f := p.Fields
		out = append(out, wire{
			Preset: p.Key, Name: f.Name, Icon: f.Icon, ColorKey: f.ColorKey,
			Unit: f.Unit, Increment: f.Increment, Target: f.Target,
			RenderStyle: f.RenderStyle, CountNoun: f.CountNoun,
		})
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"presets": out})
}

// AddPreset turns one on, by key.
//
// The body is empty and the key is a path segment, because there is nothing for
// a client to supply: every field comes from the compiled preset, and the id is
// derived from the athlete's own user id. That is what lets this mint an id in
// the `t_` namespace that `POST /v1/trackers` refuses — the namespace guard is
// about a client CHOOSING an id, and here nobody does.
//
// An unknown key is 404 rather than 400: the client asked for a preset that
// does not exist, which is the same shape as asking for a tracker that does
// not exist.
func (h *Handler) AddPreset(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	key := r.PathValue("presetKey")
	p, found := PresetByKey(key)
	if !found || p.Default {
		// A DEFAULT preset is refused too, and not for tidiness: it is
		// provisioned by List already, so "adding" it is either a no-op or a
		// confusing second route onto the same row. Restoring an archived one is
		// the archived screen's job, which is where an athlete would look.
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "no such tracker preset")
		return
	}
	in := p.Fields
	in.ID = PresetID(userID, p.Key)
	t, err := h.repo.AddPreset(r.Context(), userID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, t)
}

// Restore puts an archived tracker back, with its history.
//
// POST rather than PATCH because it is not a field write — see Archive. It
// answers 204 on a tracker that was already live, so a retry after a lost
// response is not an error.
func (h *Handler) Restore(w http.ResponseWriter, r *http.Request) {
	userID, ok := userIDFrom(w, r)
	if !ok {
		return
	}
	if err := h.repo.Restore(r.Context(), userID, r.PathValue("trackerID")); err != nil {
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
	// `maxWindowDays` counts DATES, and both ends are inclusive — so the widest
	// legal span is one day less than the cap. Written out because `> cap*24h`
	// reads correct and quietly admits 401.
	if t.Sub(f) > (maxWindowDays-1)*24*time.Hour {
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
// **An ARCHIVED tracker still accepts taps, deliberately.** A phone that logged
// a cup in a dead spot may push it long after the athlete archived the tracker
// on another device, and refusing it would drop a real event for a tidiness
// rule. The entry stays reachable through the entries window; only the card
// stops being listed.
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
	case errors.Is(err, ErrTooMany):
		// 409 with `already_exists`: the codes are a closed set (see
		// docs/architecture/api-conventions.md) and this is a conflict with
		// state the athlete already has, not a malformed request. The MESSAGE
		// carries the number, and messages are not part of the contract — a
		// client must branch on the status, never on this text.
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, err.Error())
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "tracker", err)
	}
}
