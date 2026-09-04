package biometric

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// parseTimestamp reads an RFC3339 timestamp, matching every other timestamp
// in this API — see docs/architecture/api-conventions.md.
func parseTimestamp(s string) (time.Time, error) {
	return time.Parse(time.RFC3339, s)
}

// Handler serves the biometric module's HTTP surface.
type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

type sampleRequest struct {
	ID             string  `json:"id"`
	MetricType     string  `json:"metric_type"`
	Source         string  `json:"source"`
	SourcePlatform string  `json:"source_platform"`
	Value          float64 `json:"value"`
	Unit           string  `json:"unit"`
	MeasuredAt     string  `json:"measured_at"`
	PeriodEnd      *string `json:"period_end"`
}

func (req sampleRequest) toSample() (Sample, error) {
	measuredAt, err := parseTimestamp(req.MeasuredAt)
	if err != nil {
		return Sample{}, err
	}
	s := Sample{
		ID:             req.ID,
		MetricType:     MetricType(req.MetricType),
		Source:         Source(req.Source),
		SourcePlatform: SourcePlatform(req.SourcePlatform),
		Value:          req.Value,
		Unit:           req.Unit,
		MeasuredAt:     measuredAt,
	}
	if req.PeriodEnd != nil {
		end, err := parseTimestamp(*req.PeriodEnd)
		if err != nil {
			return Sample{}, err
		}
		s.PeriodEnd = &end
	}
	return s, nil
}

type putSamplesRequest struct {
	Samples []sampleRequest `json:"samples"`
}

// maxSamplesBody bounds the request body before the decoder materialises it
// in memory. MaxSamplesPerRequest rows at roughly 200 bytes of JSON each
// (id, four enum-ish strings, a value, a unit, two timestamps) is well under
// 4 MiB; matching running's stance, this is comfortable headroom rather than
// a tight fit.
const maxSamplesBody = 4 << 20

// PutSamples stores a batch of raw readings the caller already read from the
// health store, idempotently — see Repository.PutSamples.
func (h *Handler) PutSamples(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req putSamplesRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSamplesBody)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if len(req.Samples) == 0 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "samples must not be empty")
		return
	}
	if len(req.Samples) > MaxSamplesPerRequest {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"samples must not exceed "+strconv.Itoa(MaxSamplesPerRequest)+" per request")
		return
	}

	samples := make([]Sample, 0, len(req.Samples))
	for _, sr := range req.Samples {
		s, err := sr.toSample()
		if err != nil {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"measured_at and period_end must be RFC3339")
			return
		}
		if err := s.Validate(); err != nil {
			writeError(w, r, err)
			return
		}
		samples = append(samples, s)
	}

	saved, err := h.repo.PutSamples(r.Context(), claims.UserID, samples)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"samples": saved})
}

// maxListRangeDays bounds a ListSamples query window — 400 days is generous
// headroom over a year-over-year comparison (the widest realistic ask) while
// still refusing an unbounded "give me everything" scan of a table with no
// row cap of its own.
const maxListRangeDays = 400

// ListSamples serves the caller's own samples of one metric type in a time
// range.
func (h *Handler) ListSamples(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	metricType := MetricType(r.URL.Query().Get("metric_type"))
	if !metricType.Valid() {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"metric_type must be one of "+join(MetricTypes()))
		return
	}
	from, err := parseTimestamp(r.URL.Query().Get("from"))
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "from must be RFC3339")
		return
	}
	to, err := parseTimestamp(r.URL.Query().Get("to"))
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "to must be RFC3339")
		return
	}
	if to.Before(from) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "to must not be before from")
		return
	}
	if to.Sub(from) > maxListRangeDays*24*time.Hour {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"the range between from and to must not exceed "+strconv.Itoa(maxListRangeDays)+" days")
		return
	}

	samples, err := h.repo.ListSamples(r.Context(), claims.UserID, metricType, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"samples": samples})
}

// minHRMaxBPM/maxHRMaxBPM bound a caller-supplied HRmax to what a human
// heart can physiologically do — not a precision check, the same "range,
// not shape" stance running's coordinate bounds take, just enough to refuse
// an obviously wrong unit (e.g. HRmax sent in some other scale entirely)
// before it corrupts every zone this session's TRIMP is built from.
const (
	minHRMaxBPM = 100.0
	maxHRMaxBPM = 250.0
)

type computeMetricsRequest struct {
	HRMaxBPM float64 `json:"hr_max_bpm"`
	// HRMaxSource is required alongside hr_max_bpm — design doc §3: "which
	// HRmax produced a given session's zones belongs in session_metrics
	// alongside hr_source." 'estimated' (220 − age) or 'observed' (the
	// athlete's own recorded maximum) only — see HRMaxSource's doc comment.
	HRMaxSource string `json:"hr_max_source"`
	// HRSource is the caller's claim about how it gathered the samples
	// behind this computation (design doc §2) — 'workout' or 'window' only;
	// 'none' is never a legal claim to make (Repository.ComputeSessionMetrics
	// derives that itself from an empty result, and a caller claiming "no
	// evidence" while asking for metrics to be computed is a contradiction,
	// not a valid request).
	HRSource string `json:"hr_source"`
}

// ComputeMetrics (re)computes and stores session_metrics for a session the
// caller already owns, from whatever heart_rate samples fall in its window.
func (h *Handler) ComputeMetrics(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req computeMetricsRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if req.HRMaxBPM < minHRMaxBPM || req.HRMaxBPM > maxHRMaxBPM {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"hr_max_bpm must be between 100 and 250")
		return
	}
	hrMaxSource := HRMaxSource(req.HRMaxSource)
	if !hrMaxSource.Valid() {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"hr_max_source must be one of "+join(HRMaxSources()))
		return
	}
	hrSource := HRSource(req.HRSource)
	if hrSource != HRSourceWorkout && hrSource != HRSourceWindow {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"hr_source must be one of workout, window")
		return
	}

	m, err := h.repo.ComputeSessionMetrics(
		r.Context(), claims.UserID, r.PathValue("sessionID"), req.HRMaxBPM, hrMaxSource, hrSource)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"metrics": m})
}

// maxSessionLoadRangeDays bounds a ListSessionLoad query window IN TIME —
// MaxSessionLoadRows (biometric.go) is the separate ROW-COUNT ceiling the
// same query also carries, for the reason that constant's own doc comment
// gives; the two are independent bounds on the same query, exactly as
// maxListRangeDays and MaxSamplesPerListQuery are for ListSamples.
//
// Wider than maxListRangeDays (400) on purpose: that cap bounds a query
// against biometric_samples, whose row count scales with continuous
// per-second HR sampling and can run into the hundreds of thousands well
// inside a year. This query is against sessions/session_metrics instead —
// at most one row per session ever logged — so the realistic row count for
// even several years of daily training is a few thousand (MaxSessionLoadRows
// is the real backstop on that), and the mobile trend screen's widest preset
// ('All'/'1Y') fetches up to three years (see
// apps/mobile/app/trainingLoad/trend.tsx's FETCH_DAYS) to give 'All' enough
// history to actually draw from.
//
// **1200, not 1100 — measured, not assumed.** frontend-reviewer caught that
// an earlier 1100 did not actually have "three-year headroom": the mobile
// fetch is FETCH_DAYS(1095) + the hook's own LOOKBACK_SLACK_DAYS(7) days of
// slack, requested as a full calendar day at each end
// (`T00:00:00Z`..`T23:59:59Z`), which comes to ~1103 days every single
// time — computed directly with this app's own `shiftDate`, not estimated.
// 1100 rejected that request unconditionally, so the feature could never
// load a chart for anyone. 1200 gives ~97 real days of margin over the
// measured 1103-day requirement, rather than a number that merely sounds
// like enough.
const maxSessionLoadRangeDays = 1200

// ListSessionLoad serves the cross-session training-load trend — N489/#850.
// See Repository.ListSessionLoad's doc comment for why this is one query
// rather than a per-session fetch loop.
func (h *Handler) ListSessionLoad(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	from, err := parseTimestamp(r.URL.Query().Get("from"))
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "from must be RFC3339")
		return
	}
	to, err := parseTimestamp(r.URL.Query().Get("to"))
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "to must be RFC3339")
		return
	}
	if to.Before(from) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "to must not be before from")
		return
	}
	if to.Sub(from) > maxSessionLoadRangeDays*24*time.Hour {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"the range between from and to must not exceed "+strconv.Itoa(maxSessionLoadRangeDays)+" days")
		return
	}

	loads, err := h.repo.ListSessionLoad(r.Context(), claims.UserID, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"sessions": loads})
}

// GetMetrics reads back a previously computed row. 404 when none exists yet
// — a normal state (design doc §6.4), not a fault.
func (h *Handler) GetMetrics(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	m, err := h.repo.GetSessionMetrics(r.Context(), claims.UserID, r.PathValue("sessionID"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"metrics": m})
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "not found")
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"one or more sample ids already belong to a different session or account")
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, invalidInputMessage())
	default:
		apihttp.WriteInternal(w, r, "biometric", err)
	}
}

// invalidInputMessage names every value these endpoints accept. Built from
// the vocabulary rather than spelled out, matching running's helper of the
// same name and for the same reason: a literal list drifts, this can't.
func invalidInputMessage() string {
	return "metric_type must be one of " + join(MetricTypes()) +
		"; source must be one of " + join(Sources()) +
		"; source_platform must be one of " + join(SourcePlatforms()) +
		"; unit must not be empty; measured_at must not be zero" +
		"; period_end, if set, must not be before measured_at" +
		"; a session must have ended before its metrics can be computed"
}

func join[T ~string](vals []T) string {
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = string(v)
	}
	return strings.Join(out, ", ")
}
