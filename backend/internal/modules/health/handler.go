package health

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// maxReportBytes bounds the body. Raised from 8KB with the batch form: a full
// batch of MaxBatch events, each with a 500-char message and a small details
// object, does not fit in 8KB, and a client whose whole job is to report
// trouble must not have its report rejected for being a batch.
const maxReportBytes = 64 << 10

// MaxBatch bounds how many events one call may carry.
//
// The client's buffer is a fixed-size ring well under this, so in normal
// operation the bound never binds — it is here so a misbehaving client cannot
// use one request to write an unbounded number of rows.
const MaxBatch = 50

type Handler struct {
	repo Repository
}

var errNullBody = errors.New("health: body is null")

// decodeReports accepts either a single report object or `{"events": [...]}`.
//
// Discriminated on the first non-space byte rather than by trying one shape and
// falling back to the other: a failed decode can leave a half-consumed reader,
// and "try, fail, retry differently" is how a malformed body silently becomes
// an empty batch instead of a 400.
func decodeReports(raw []byte) ([]NewEvent, error) {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if len(trimmed) == 0 {
		return nil, nil
	}
	// A literal `null` is rejected here rather than left to decode into a
	// zero-valued report that `Validate` happens to refuse for having no kind.
	// The outcome is the same 400 either way — but one is a decision and the
	// other is an accident, and an accident stops holding the moment somebody
	// gives `Kind` a default. Found by a test written from a review note.
	if bytes.Equal(bytes.TrimRight(trimmed, " \t\r\n"), []byte("null")) {
		return nil, errNullBody
	}
	if trimmed[0] == '[' {
		var list []NewEvent
		if err := json.Unmarshal(trimmed, &list); err != nil {
			return nil, err
		}
		return list, nil
	}
	var batch struct {
		Events []NewEvent `json:"events"`
	}
	if err := json.Unmarshal(trimmed, &batch); err == nil && batch.Events != nil {
		return batch.Events, nil
	}
	var one NewEvent
	if err := json.Unmarshal(trimmed, &one); err != nil {
		return nil, err
	}
	return []NewEvent{one}, nil
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

	// Read once, then decide the shape. The body can be a single report — the
	// form this endpoint shipped with and the one a deployed build still sends
	// — or a batch. Both stay supported deliberately: a client that reports its
	// own trouble is exactly the client least able to be upgraded first.
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxReportBytes))
	if err != nil {
		// Told apart from malformed JSON on purpose. `MaxBytesReader` fails the
		// read, and the old code conflated the two — so a client author sending
		// a valid but large batch got "invalid JSON body" and had nothing to go
		// on. That is now the likelier trip of the two, since a batch of 50 is
		// a much bigger body than a single report ever was.
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			apihttp.WriteError(w, http.StatusRequestEntityTooLarge, apihttp.CodeInvalidInput,
				"that report is too large")
			return
		}
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	reports, err := decodeReports(raw)
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if len(reports) == 0 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "no events")
		return
	}
	if len(reports) > MaxBatch {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"at most "+strconv.Itoa(MaxBatch)+" events per request")
		return
	}
	for i := range reports {
		if err := reports[i].Validate(); err != nil {
			// The whole batch is refused rather than the good half kept.
			// Partial acceptance would need a per-event result the client
			// cannot act on anyway — it never retries — and "202 with some of
			// it dropped" is the silent-loss shape this endpoint exists to
			// end.
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"kind must be client_error or sync_blocked, and message must be under "+
					strconv.Itoa(MaxMessageLen)+" characters")
			return
		}
	}

	userID := claims.UserID
	requestID := httplog.RequestIDFromContext(r.Context())
	traceID := httplog.TraceIDFromContext(r.Context())
	events := make([]Event, 0, len(reports))
	for _, req := range reports {
		events = append(events, Event{
			Source:    SourceClient,
			Kind:      req.Kind,
			UserID:    &userID,
			ErrorCode: req.ErrorCode,
			Message:   req.Message,
			Details:   req.Details,
			// Every event in a batch shares the batch's request and trace ids.
			// That is correct rather than lossy: they were reported together,
			// by one device, in one call, and the trace is what joins them to
			// the server-side line for that call.
			RequestID: requestID,
			TraceID:   traceID,
		})
	}
	// One statement, atomically. A loop of single inserts that failed partway
	// would commit a prefix and return 500 — and since the client never
	// retries, the events it then counts as `lost_events` would include ones
	// that were in fact stored. A reporter that misreports its own loss is the
	// failure this endpoint exists to end. Found in review.
	if err := h.repo.RecordBatch(r.Context(), events); err != nil {
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

// recordRejectionsOn are the routes where a 4xx is worth a durable row.
//
// **The general rule below is right and this is the exception that proves it.**
// A 404 for a deleted session is noise. A refused AI request is not: it costs
// the athlete an answer they asked for, it is the one place a rejection can be
// invisible to the phone as well (see `apihttp.DrainRequestBody` — an upload
// past 256 KiB used to lose its status on the wire), and it is rare enough that
// recording every one adds a handful of rows a day rather than a flood.
//
// **Why this is not a nice-to-have.** N92 (#433) was reported three times and
// diagnosed twice from the wrong evidence, because a rejected estimate left no
// trace anywhere that outlives an afternoon: `health_events` skipped it as a
// 4xx, and Railway's request log retains minutes, not days. Two sessions read
// "the failing attempt is not in `health_events`" as *the request never
// arrived* — a sound-looking inference from a log that was never going to
// contain it. This closes that gap, so the next occurrence is one query away.
var recordRejectionsOn = map[string]bool{
	"/v1/nutrition/estimate": true,
	"/v1/exercises/identify": true,
	"/v1/bjj/reflect/draft":  true,
}

// Observe is called once per request, after it completes.
//
// Deliberately selective: 5xx, slow requests, and a rejection on one of the few
// routes listed above. Recording every request would put a database write on
// the hot path of every call, and the healthy case — nearly all of them — is
// exactly the case with nothing to say. 4xx are otherwise left out: they are
// overwhelmingly ordinary (a 404 for a deleted session, a 401 for an expired
// token), and filling the operator's screen with routine client mistakes is how
// a health page becomes something nobody opens.
//
// **A rejection is recorded as `client_error` with `source: api`**, which needs
// no migration — the kind already exists and the CHECK constraint does not tie
// the two columns together. The `status` column carries which 4xx it was, which
// is the whole question an operator has: a 429 is a spent allowance, a 401 is a
// credential, a 400 is the upload itself.
func (rec *Recorder) Observe(ctx context.Context, o httplog.Observation) {
	var kind Kind
	switch {
	case o.Status >= 500:
		kind = KindServerError
	case o.Status >= 400 && recordRejectionsOn[o.Path]:
		// Checked BEFORE the slow branch, not after. A refused request that
		// also happened to be slow is a rejection first — filing it as
		// `slow_request` would put the interesting row under the kind an
		// operator filters out when hunting latency.
		kind = KindClientError
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
