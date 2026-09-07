package body

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
	"github.com/dmytro-ch21/vola/backend/internal/platform/objectstore"
)

/*
Photo URL lifetimes.

**Read is short on purpose.** A presigned GET is a bearer credential for one
progress photo: anyone holding the string can fetch it until it expires, and
nothing about the read path benefits from a long life — the client renders it
immediately. Fifteen minutes covers a slow connection and a backgrounded app,
and bounds the damage from a URL that ends up in a log or a screenshot.

Write is longer only because an upload can be genuinely slow on gym wifi, and a
signature that expires mid-PUT fails in a way the athlete cannot act on.
*/
const (
	photoReadTTL  = 15 * time.Minute
	photoWriteTTL = 30 * time.Minute
)

// maxPhotoBytes is what the client is told to stay under. It is advisory here —
// the object store enforces nothing on our behalf — but it is the number the
// client downscales to, and stating it in the response is what keeps the two
// from drifting.
const maxPhotoBytes = 5 << 20 // 5 MiB

type Handler struct {
	repo  Repository
	store *objectstore.Store // nil when object storage is not configured
}

// NewHandler takes a possibly-nil store. Nil is a supported configuration, not
// a degraded one: local dev and CI have no bucket, and the photo endpoints then
// report that honestly instead of failing in a way that looks like a bug.
func NewHandler(repo Repository, store *objectstore.Store) *Handler {
	return &Handler{repo: repo, store: store}
}

func reason(err error) string {
	const marker = "body: invalid input: "
	if i := strings.LastIndex(err.Error(), marker); i >= 0 {
		return err.Error()[i+len(marker):]
	}
	return "invalid input"
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "not found")
	case errors.Is(err, ErrPhaseActive):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"you already have a phase running — end it before starting another")
	case errors.Is(err, ErrInvalidInput):
		// Cut at the marker rather than trimming a prefix: the repository wraps
		// with its own context first, so the string does not START with the
		// sentinel. Trimming returns the whole chain to the caller — the exact
		// mistake the themes module documents having made.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, reason(err))
	default:
		apihttp.WriteInternal(w, r, "body", err)
	}
}

// present mints a presigned read URL for a check-in's photo, if there is one.
//
// Done per response rather than stored, because the URL expires — a cached one
// is a broken image with extra steps. Failure is silent and the photo is simply
// absent: a check-in whose measurements loaded fine should not 500 because a
// signature could not be produced.
func (h *Handler) present(r *http.Request, c *Checkin) {
	if c.PhotoKey == nil || h.store == nil {
		return
	}
	url, err := h.store.PresignGet(*c.PhotoKey, photoReadTTL, time.Now())
	if err != nil {
		// Logged rather than swallowed: presigning only fails on config-class
		// problems, which is exactly the case worth seeing — a mistyped
		// R2_ENDPOINT would otherwise silently drop every photo in the product
		// with no signal anywhere. Raised in review.
		httplog.FromContext(r.Context()).Warn("body: could not presign check-in photo", "err", err)
		return
	}
	c.PhotoURL = url
}

// deleteObject removes one stored object, server-side.
func (h *Handler) deleteObject(ctx context.Context, key string) error {
	url, err := h.store.PresignDelete(key, photoWriteTTL, time.Now())
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// 404 counts as success: the object is gone, which is what was asked for.
	if res.StatusCode >= 300 && res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("objectstore: delete returned %d", res.StatusCode)
	}
	return nil
}

// ListCheckins handles GET /v1/body/checkins?from=&to=
func (h *Handler) ListCheckins(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return
	}
	userID := claims.UserID
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	if !isDate(from) || !isDate(to) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"from and to are required, as YYYY-MM-DD")
		return
	}
	if to < from {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "to is before from")
		return
	}
	list, err := h.repo.ListCheckins(r.Context(), userID, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	for i := range list {
		h.present(r, &list[i])
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"checkins": list})
}

// checkinBody is the wire shape for a save.
//
// A named type rather than decoding into Checkin, so `user_id`, `photo_key` and
// the timestamps cannot be set by a client. Writing one's own `user_id` is the
// whole of the cross-user write bug, and it is prevented by the type rather
// than by remembering to overwrite the field.
type checkinBody struct {
	WeightKG *float64 `json:"weight_kg"`

	NeckCM      *float64 `json:"neck_cm"`
	ShouldersCM *float64 `json:"shoulders_cm"`
	ChestCM     *float64 `json:"chest_cm"`
	WaistCM     *float64 `json:"waist_cm"`
	HipsCM      *float64 `json:"hips_cm"`
	ThighCM     *float64 `json:"thigh_cm"`
	CalfCM      *float64 `json:"calf_cm"`
	UpperArmCM  *float64 `json:"upper_arm_cm"`
	ForearmCM   *float64 `json:"forearm_cm"`

	// A POINTER: `Side` alone cannot tell "said right" from "said nothing", and
	// the upsert wrote it unconditionally — so a girth check-in taken on the
	// left, followed by that evening's weight-only save, silently relabelled
	// the left-side girths as right. That destroys exactly the consistency the
	// field exists to record. Raised in review.
	MeasuredSide *Side  `json:"measured_side"`
	Notes        string `json:"notes"`
}

// maxBodyRequestBytes bounds a check-in or phase request before it is
// buffered. Both are a handful of short fields (N164/#541) — the same 8 KiB
// `plan`, `session`, and `theme` already use for a comparably-shaped body.
const maxBodyRequestBytes = 8 << 10

// SaveCheckin handles PUT /v1/body/checkins/{date}
//
// PUT and not POST: the resource is identified by the day, the client names it,
// and sending it twice must be the same as sending it once. That is what makes
// an offline check-in safe to retry.
func (h *Handler) SaveCheckin(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return
	}
	userID := claims.UserID
	date := r.PathValue("date")

	var in checkinBody
	if err := apihttp.DecodeJSON(w, r, maxBodyRequestBytes, &in); err != nil {
		return
	}

	c := Checkin{
		UserID: userID, MeasuredOn: date, WeightKG: in.WeightKG,
		NeckCM: in.NeckCM, ShouldersCM: in.ShouldersCM, ChestCM: in.ChestCM,
		WaistCM: in.WaistCM, HipsCM: in.HipsCM, ThighCM: in.ThighCM,
		CalfCM: in.CalfCM, UpperArmCM: in.UpperArmCM, ForearmCM: in.ForearmCM,
		Notes: in.Notes,
	}
	// Left empty when the client said nothing; the repository then COALESCEs
	// and the column default covers a first insert.
	if in.MeasuredSide != nil {
		c.MeasuredSide = *in.MeasuredSide
	}
	if err := c.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	saved, err := h.repo.SaveCheckin(r.Context(), c)
	if err != nil {
		writeError(w, r, err)
		return
	}
	h.present(r, &saved)
	apihttp.WriteJSON(w, http.StatusOK, saved)
}

// DeleteCheckin handles DELETE /v1/body/checkins/{date}
//
// The way a mistyped measurement is removed. Correcting one is a re-save, but
// *clearing* one cannot be — the save coalesces absent fields on purpose, so
// there is no way to null a value through it. See `SaveCheckin` in postgres.go.
func (h *Handler) DeleteCheckin(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return
	}
	userID := claims.UserID
	date := r.PathValue("date")

	/*
		The object goes BEFORE the row, and its failure is not fatal.

		Before, because the row is what tells us the key exists at all — delete
		it first and a failed object delete leaves an orphan nothing points at.

		Not fatal, because a storage outage must not make a delete impossible;
		the athlete asked for this data to be gone and the row is the part we
		control. An object left behind is retained, which is a smaller problem
		than a check-in that cannot be deleted — but it is a real one, which is
		why it is logged rather than swallowed.

		This matters more than ordinary retention: the key is DERIVED, so an
		undeleted object is resurrectable — requesting an upload URL for the
		same day would otherwise hand back a link to the deleted photo. Raised
		in review.
	*/
	if h.store != nil {
		if existing, err := h.repo.GetCheckin(r.Context(), userID, date); err == nil && existing.PhotoKey != nil {
			if err := h.deleteObject(r.Context(), *existing.PhotoKey); err != nil {
				httplog.FromContext(r.Context()).Warn("body: could not delete check-in photo", "err", err)
			}
		}
	}

	if err := h.repo.DeleteCheckin(r.Context(), userID, date); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PhotoUploadURL handles POST /v1/body/checkins/{date}/photo
//
// Hands back a short-lived presigned PUT. The bytes never touch this API:
// proxying them would put multi-megabyte bodies through a process sized for
// JSON, and would make the API the thing that fails when somebody has bad
// signal in a gym.
//
// **The key is derived, never accepted.** It is built from the authenticated
// user and the date in the path, so a client cannot ask for a signature over
// somebody else's object — which is the entire security property of this
// endpoint, and would be lost the moment the key became an input.
func (h *Handler) PhotoUploadURL(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return
	}
	userID := claims.UserID
	if h.store == nil {
		// Honest rather than a 500: there is no bucket, which is a deployment
		// fact and not a fault in the request.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"photo storage is not configured on this environment")
		return
	}
	date := r.PathValue("date")
	if !isDate(date) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"date must be YYYY-MM-DD")
		return
	}

	// JPEG only, and stated rather than negotiated. The content type is signed
	// into the URL, so this is also what the upload is checked against.
	const contentType = "image/jpeg"
	key := PhotoKey(userID, date)
	url, err := h.store.PresignPut(key, contentType, photoWriteTTL, time.Now())
	if err != nil {
		apihttp.WriteInternal(w, r, "body", err)
		return
	}

	// Recorded against the day now, so a client that uploads and then loses
	// connectivity has not orphaned the object. Re-uploading overwrites the
	// same key, so this cannot accumulate.
	//
	// Through `AttachPhotoKey`, NOT a full save: routing this through
	// `SaveCheckin` sent an empty `notes`, which that path replaces by design —
	// so asking for an upload URL wiped whatever the athlete wrote that
	// morning. Raised in review.
	saved, err := h.repo.AttachPhotoKey(r.Context(), userID, date, key)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Deliberately NOT presented. The key is deterministic, so a presigned GET
	// here would resolve to the PREVIOUS photo for this day — including one the
	// athlete deleted — before a single byte of the new one has been uploaded.
	saved.PhotoURL = ""

	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"upload_url":   url,
		"content_type": contentType,
		"max_bytes":    maxPhotoBytes,
		"expires_in":   int(photoWriteTTL.Seconds()),
		"checkin":      saved,
	})
}

// PhotoKey is the storage layout, in one place.
//
// Exported so the integration test can assert the shape rather than restate it.
// The user id leads, which keeps one athlete's objects contiguous in the bucket
// and makes "delete everything belonging to this account" a prefix operation —
// the thing a deletion request will need.
func PhotoKey(userID, date string) string {
	return "checkins/" + userID + "/" + date + ".jpg"
}

// ListPhases handles GET /v1/body/phases
func (h *Handler) ListPhases(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return
	}
	userID := claims.UserID
	list, err := h.repo.ListPhases(r.Context(), userID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"phases": list,
		// The vocabulary travels with the data so a client renders its picker
		// from the server's list rather than a copy that can drift — the same
		// reason the exercise console is handed `load_types`.
		"kinds": PhaseKinds,
	})
}

type phaseBody struct {
	Kind           PhaseKind `json:"kind"`
	StartedOn      string    `json:"started_on"`
	TargetOn       *string   `json:"target_on"`
	TargetWeightKG *float64  `json:"target_weight_kg"`
	Notes          string    `json:"notes"`
	// ID is client-generated, so starting a phase is idempotent on retry — the
	// same contract sessions and workouts already use for offline creation.
	ID string `json:"id"`
}

// CreatePhase handles POST /v1/body/phases
func (h *Handler) CreatePhase(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return
	}
	userID := claims.UserID
	var in phaseBody
	if err := apihttp.DecodeJSON(w, r, maxBodyRequestBytes, &in); err != nil {
		return
	}
	if strings.TrimSpace(in.ID) == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"id is required — the client generates it so a retry is not a second phase")
		return
	}
	p := Phase{
		ID: in.ID, UserID: userID, Kind: in.Kind, StartedOn: in.StartedOn,
		TargetOn: in.TargetOn, TargetWeightKG: in.TargetWeightKG, Notes: in.Notes,
	}
	if err := p.Validate(); err != nil {
		writeError(w, r, err)
		return
	}
	created, err := h.repo.CreatePhase(r.Context(), p)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, created)
}

// EndPhase handles POST /v1/body/phases/{id}/end
//
// A sub-resource verb rather than a PATCH setting `ended_on`, because ending is
// the only mutation a phase has and a general PATCH would invite editing the
// start date of a span that measurements are already anchored to.
func (h *Handler) EndPhase(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return
	}
	userID := claims.UserID
	var in struct {
		EndedOn string `json:"ended_on"`
	}
	// An empty body is fine and means today — ending a phase is a one-tap
	// action and should not require the client to say what day it is. Any
	// decode failure (empty or otherwise malformed) is deliberately ignored
	// here too, same as before N164/#541 — only the size bound is new, via
	// DecodeJSONError so a malformed-but-harmless body still doesn't write a
	// response out from under this handler's own error path below.
	_ = apihttp.DecodeJSONError(w, r, maxBodyRequestBytes, &in)
	if in.EndedOn == "" {
		in.EndedOn = time.Now().UTC().Format("2006-01-02")
	}
	if !isDate(in.EndedOn) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"ended_on must be YYYY-MM-DD")
		return
	}
	p, err := h.repo.EndPhase(r.Context(), userID, r.PathValue("id"), in.EndedOn)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, p)
}
