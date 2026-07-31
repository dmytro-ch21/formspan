package health

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

// defaultWindow is how far back the health screen looks by default. A day is
// the span an operator actually asks about — "is something wrong *now*" — and
// a longer default would bury a fresh incident under last week's noise.
const defaultWindow = 24 * time.Hour

// maxWindow bounds `?hours=`, so nobody can turn the summary into a full-table
// aggregate by accident.
const maxWindow = 30 * 24 * time.Hour

// Report accepts a problem the client hit that the server cannot observe.
//
// Authenticated and self-attributed: the user id comes from the verified token,
// never from the body. A client that could name the user in a report could file
// noise against someone else — or, worse, could not be trusted when it reports
// its own trouble, which is the entire value of the endpoint.
func (h *Handler) Report(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "not signed in")
		return
	}

	var req NewEvent
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if err := req.Validate(); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"kind must be client_error or sync_blocked, and message must be under "+
				strconv.Itoa(MaxMessageLen)+" characters")
		return
	}

	userID := claims.UserID
	ev := Event{
		Source:    SourceClient,
		Kind:      req.Kind,
		UserID:    &userID,
		ErrorCode: req.ErrorCode,
		Message:   req.Message,
		Details:   req.Details,
		RequestID: httplog.RequestIDFromContext(r.Context()),
		TraceID:   httplog.TraceIDFromContext(r.Context()),
	}
	if err := h.repo.Record(r.Context(), ev); err != nil {
		apihttp.WriteInternal(w, r, "health", err)
		return
	}

	// 202 rather than 201: the client is telling us something, not creating a
	// resource it will ever read back. Nothing here is addressable.
	w.WriteHeader(http.StatusAccepted)
}

// AdminList serves the health screen: a summary plus the events behind it.
//
// Both in one response deliberately. The summary alone invites "12 errors" with
// no way to see them, and the list alone makes an operator count. The screen
// asks one question, so it makes one request.
func (h *Handler) AdminList(w http.ResponseWriter, r *http.Request) {
	window := defaultWindow
	if raw := r.URL.Query().Get("hours"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"hours must be a positive integer")
			return
		}
		// Clamped *before* multiplying: time.Duration is int64 nanoseconds, so
		// a large hour count overflows to negative, sails past a `> maxWindow`
		// check, and puts `since` in the future — producing an all-quiet
		// screen that reads as healthy.
		if maxHours := int(maxWindow / time.Hour); n > maxHours {
			n = maxHours
		}
		window = time.Duration(n) * time.Hour
	}
	since := time.Now().Add(-window)

	// Validated against the enum: an unknown kind would otherwise return 200
	// with zero events beside a fully-populated summary — a screen that
	// contradicts itself and reads as "nothing wrong".
	kind := Kind(r.URL.Query().Get("kind"))
	switch kind {
	case "", KindServerError, KindSlowRequest, KindClientError, KindSyncBlocked:
	default:
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"unknown kind")
		return
	}

	f := Filter{
		Kind:   kind,
		UserID: r.URL.Query().Get("user_id"),
		Since:  since,
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"limit must be a positive integer")
			return
		}
		f.Limit = n
	}

	events, err := h.repo.List(r.Context(), f)
	if err != nil {
		apihttp.WriteInternal(w, r, "health", err)
		return
	}
	summary, err := h.repo.Summarise(r.Context(), since)
	if err != nil {
		apihttp.WriteInternal(w, r, "health", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"summary": summary,
		"events":  events,
	})
}

// Recorder adapts the repository to what the request middleware needs, so
// `httplog` stays free of any database dependency — it is a logging package,
// and a logging package that imports a repository is a logging package nobody
// can use anywhere else.
type Recorder struct {
	repo Repository
	// slowerThan is the latency past which a *successful* request is still
	// worth a row.
	slowerThan time.Duration

	events  chan Event
	dropped atomic.Int64
	logger  *slog.Logger
}

// queueDepth bounds how many unwritten events are held in memory.
//
// Small on purpose. This buffer exists to decouple the request from the write,
// not to survive a long outage: if the database is unavailable, a deeper queue
// only postpones the same loss while holding more memory during the incident.
const queueDepth = 256

// writeTimeout bounds one insert. Generous, because nothing is waiting on it
// any more.
const writeTimeout = 5 * time.Second

// NewRecorder starts the writer goroutine that drains recorded events.
//
// It runs for the life of the process, which is the same lifetime as the pool
// it writes through — there is no shutdown path to hook, and a killed process
// loses at most a few unwritten events either way.
func NewRecorder(repo Repository, slowerThan time.Duration, logger *slog.Logger) *Recorder {
	rec := &Recorder{
		repo:       repo,
		slowerThan: slowerThan,
		events:     make(chan Event, queueDepth),
		logger:     logger,
	}
	go rec.run()
	return rec
}

func (rec *Recorder) run() {
	for e := range rec.events {
		ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
		if err := rec.repo.Record(ctx, e); err != nil {
			// Nothing to do but say so. Observability failing must not become
			// an outage of its own.
			rec.logger.Error("health: could not record event", "err", err, "kind", e.Kind)
		}
		cancel()
	}
}

// Observe is called once per request, after it completes.
//
// Deliberately selective: only 5xx and slow requests are stored. Recording
// every request would put a database write on the hot path of every call, and
// the healthy case — nearly all of them — is exactly the case with nothing to
// say. 4xx are left out too: they are overwhelmingly ordinary (a 404 for a
// deleted session, a 401 for an expired token), and filling the operator's
// screen with routine client mistakes is how a health page becomes something
// nobody opens.
func (rec *Recorder) Observe(ctx context.Context, o httplog.Observation) {
	var kind Kind
	switch {
	case o.Status >= 500:
		kind = KindServerError
	case rec.slowerThan > 0 && o.Duration >= rec.slowerThan:
		kind = KindSlowRequest
	default:
		return
	}

	ms := int(o.Duration.Milliseconds())
	ev := Event{
		Source:     SourceAPI,
		Kind:       kind,
		Method:     &o.Method,
		Path:       &o.Path,
		Status:     &o.Status,
		DurationMS: &ms,
		RequestID:  o.RequestID,
		TraceID:    o.TraceID,
	}
	if o.UserID != "" {
		id := o.UserID
		ev.UserID = &id
	}

	// Handed to a writer goroutine rather than inserted here.
	//
	// This looked safe to do inline — the request has been served by the time
	// `Observe` runs — and it is not. `net/http` buffers the response and only
	// flushes once the entire middleware chain returns, so a slow insert here
	// delays the client's first byte by exactly its own duration. That is
	// worst precisely when it matters most: during an incident where the
	// database is struggling, every 5xx would then queue behind an INSERT into
	// that same struggling database, adding seconds to a response that already
	// failed. The feature would amplify the outage it exists to observe.
	//
	// Dropped rather than blocked when the queue is full, deliberately. Under
	// a storm the choice is between losing some observability and slowing
	// every request, and a health system that degrades the service it watches
	// has inverted its own purpose. The drop is counted so the gap is visible
	// rather than silent.
	select {
	case rec.events <- ev:
	default:
		if n := rec.dropped.Add(1); n == 1 || n%100 == 0 {
			httplog.FromContext(ctx).Warn(
				"health: event queue full, dropping", "dropped_total", n)
		}
	}
}
