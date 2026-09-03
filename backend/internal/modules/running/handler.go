package running

import (
	"encoding/json"
	"errors"
	"net/http"
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

// Handler serves the running half of a session — matching bjj.SessionHandler
// in shape and in name-of-methods, so a client that already knows the BJJ
// detail endpoints can guess these.
type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

type routePointRequest struct {
	Lat        float64  `json:"lat"`
	Lng        float64  `json:"lng"`
	ElevationM *float64 `json:"elevation_m"`
	RecordedAt string   `json:"recorded_at"`
}

type splitRequest struct {
	DistanceM       float64 `json:"distance_m"`
	DurationSeconds int     `json:"duration_seconds"`
}

type sessionDetailRequest struct {
	RoutePoints     []routePointRequest `json:"route_points"`
	Splits          []splitRequest      `json:"splits"`
	ElevationGainM  *float64            `json:"elevation_gain_m"`
	AvgPaceSecPerKm *float64            `json:"avg_pace_sec_per_km"`
	DistanceM       *float64            `json:"distance_m"`
	DurationSeconds *int                `json:"duration_seconds"`
	Source          string              `json:"source"`
	HealthKitUUID   *string             `json:"healthkit_uuid"`
}

// maxDetailBody bounds the request body before the decoder materialises it
// in memory. A full MaxRoutePoints track — each point roughly
// `{"lat":40.7128,"lng":-74.0060,"elevation_m":12.5,"recorded_at":"2026-08-01T07:00:00Z"}`,
// ~110 bytes with field names — is a little over 2 MiB on its own, so this
// is 4 MiB: comfortable headroom over a genuine full-size payload and still
// far short of "unbounded".
const maxDetailBody = 4 << 20

func (req sessionDetailRequest) toDetail(sessionID string) (SessionDetail, error) {
	d := SessionDetail{
		SessionID:       sessionID,
		ElevationGainM:  req.ElevationGainM,
		AvgPaceSecPerKm: req.AvgPaceSecPerKm,
		DistanceM:       req.DistanceM,
		DurationSeconds: req.DurationSeconds,
		Source:          Source(req.Source),
		HealthKitUUID:   req.HealthKitUUID,
		RoutePoints:     make([]RoutePoint, 0, len(req.RoutePoints)),
		Splits:          make([]Split, 0, len(req.Splits)),
	}
	for _, p := range req.RoutePoints {
		recordedAt, err := parseTimestamp(p.RecordedAt)
		if err != nil {
			return SessionDetail{}, err
		}
		d.RoutePoints = append(d.RoutePoints, RoutePoint{
			Lat:        p.Lat,
			Lng:        p.Lng,
			ElevationM: p.ElevationM,
			RecordedAt: recordedAt,
		})
	}
	for _, s := range req.Splits {
		d.Splits = append(d.Splits, Split{
			DistanceM:       s.DistanceM,
			DurationSeconds: s.DurationSeconds,
		})
	}
	return d, nil
}

// PutDetail stores the running detail for a session the caller already
// created.
//
// PUT and an upsert, matching bjj.SessionHandler.PutDetail exactly and for
// the same reason: the client holds the desired state (the track and splits
// it recorded) and re-sends it, so a retry after a failed push converges
// rather than duplicating — the property the mobile offline outbox depends
// on.
func (h *Handler) PutDetail(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req sessionDetailRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxDetailBody)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	d, err := req.toDetail(r.PathValue("sessionID"))
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"route_points[].recorded_at must be RFC3339")
		return
	}
	if err := d.Validate(); err != nil {
		writeError(w, r, err)
		return
	}

	saved, err := h.repo.PutDetail(r.Context(), claims.UserID, d)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"detail": saved})
}

func (h *Handler) GetDetail(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	d, err := h.repo.GetDetail(r.Context(), claims.UserID, r.PathValue("sessionID"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"detail": d})
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		// Covers "no such session", "not yours" and "not a running session"
		// alike — see the owner-FK and sport notes in the repository.
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "session not found")
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"this HealthKit workout is already attached to a different session")
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, invalidInputMessage())
	default:
		apihttp.WriteInternal(w, r, "running", err)
	}
}

// invalidInputMessage names every value this endpoint accepts. Built from
// the vocabulary rather than spelled out, so it cannot drift the way a
// literal list did once in bjj — see that package's comment on the same
// function.
func invalidInputMessage() string {
	return "source must be one of " + join(Sources()) +
		"; distance_m, duration_seconds, elevation_gain_m and avg_pace_sec_per_km must not be negative" +
		"; route_points[].lat must be -90..90 and .lng -180..180" +
		"; splits[].distance_m and .duration_seconds must be greater than 0"
}

// join renders a vocabulary for the message above, matching bjj's helper of
// the same name.
func join[T ~string](vals []T) string {
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = string(v)
	}
	return strings.Join(out, ", ")
}
