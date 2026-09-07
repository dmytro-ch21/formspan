package bjj

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
	"github.com/dmytro-ch21/vola/backend/internal/platform/objectstore"
)

/*
Photo URL lifetimes — the exact numbers `body`'s check-in photos use, for the
exact reasons: read is short because a presigned GET is a bearer credential
and the client renders it immediately; write is longer because an upload can
be genuinely slow on gym wifi.
*/
const (
	photoReadTTL  = 15 * time.Minute
	photoWriteTTL = 30 * time.Minute
)

// maxPhotoBytes is what the client is told to stay under — advisory, since
// the object store enforces nothing on our behalf, but it is the number the
// client downscales to. Same figure `body` uses.
const maxPhotoBytes = 5 << 20 // 5 MiB

type Handler struct {
	repo Repository
	// now is injectable so time-at-belt is testable without waiting a year.
	now   func() time.Time
	store *objectstore.Store // nil when object storage is not configured
}

// NewHandler takes a possibly-nil store. Nil is a supported configuration —
// local dev and CI have no bucket — and the photo endpoint reports that
// honestly rather than failing in a way that looks like a bug.
func NewHandler(repo Repository, store *objectstore.Store) *Handler {
	return &Handler{repo: repo, now: time.Now, store: store}
}

// present mints a presigned read URL for a promotion's photo, if there is
// one. Done per response rather than stored, because the URL expires — a
// cached one is a broken image with extra steps. Failure is silent and the
// photo is simply absent: a promotion whose rank loaded fine should not 500
// because a signature could not be produced.
func (h *Handler) present(r *http.Request, p *Promotion) {
	if p.PhotoKey == nil || h.store == nil {
		return
	}
	url, err := h.store.PresignGet(*p.PhotoKey, photoReadTTL, time.Now())
	if err != nil {
		httplog.FromContext(r.Context()).Warn("bjj: could not presign promotion photo", "err", err)
		return
	}
	p.PhotoURL = url
}

// deleteObject removes one stored object, server-side. Identical to
// body.Handler.deleteObject — both talk to the same kind of presigned-DELETE
// object store, and there is nothing here specific to either domain.
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

// PhotoKey is the storage layout, in one place. Exported so the integration
// test can assert the shape rather than restate it. Unlike a check-in's key
// (date-derived, so a same-day re-upload overwrites in place) a promotion's
// key is id-derived and stable for the life of the row — replacing the photo
// overwrites the same object.
func PhotoKey(userID, promotionID string) string {
	return "promotions/" + userID + "/" + promotionID + ".jpg"
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
	for i := range promotions {
		h.present(r, &promotions[i])
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
	for i := range promotions {
		h.present(r, &promotions[i])
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

// maxPromotionBody bounds a promotion request before it is buffered. A
// handful of short fields (N164/#541) — the same 8 KiB `plan`/`session`/
// `theme` already use for a comparably-shaped body.
const maxPromotionBody = 8 << 10

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
	if err := apihttp.DecodeJSON(w, r, maxPromotionBody, &req); err != nil {
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
	if err := apihttp.DecodeJSON(w, r, maxPromotionBody, &req); err != nil {
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
	// A rank/date/note correction leaves any already-attached photo alone —
	// this call doesn't touch photo_key — so the response should still show
	// it rather than reading as though editing a promotion silently drops
	// its picture.
	h.present(r, &updated)
	apihttp.WriteJSON(w, http.StatusOK, updated)
}

// PhotoUploadURL handles POST /v1/bjj/promotions/{promotionID}/photo
//
// Hands back a short-lived presigned PUT, exactly as
// body.Handler.PhotoUploadURL does and for the same reasons — the bytes never
// touch this API. **The key is derived, never accepted**, built from the
// authenticated user and the promotion id in the path, so a client cannot ask
// for a signature over somebody else's object.
//
// Unlike a check-in, there is no upsert here: the promotion must already
// exist (created via POST /v1/bjj/promotions first, which is how the mobile
// form works — create, then optionally attach a photo using the id the create
// returned). AttachPhotoKey is scoped by user_id, so an id belonging to
// somebody else — or no id at all — is ErrNotFound, not a signature handed
// out over a guess.
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
	id := r.PathValue("promotionID")

	// JPEG only, and stated rather than negotiated. The content type is signed
	// into the URL, so this is also what the upload is checked against.
	const contentType = "image/jpeg"
	key := PhotoKey(userID, id)
	url, err := h.store.PresignPut(key, contentType, photoWriteTTL, time.Now())
	if err != nil {
		apihttp.WriteInternal(w, r, "bjj", err)
		return
	}

	saved, err := h.repo.AttachPhotoKey(r.Context(), userID, id, key)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Deliberately NOT presented. The key is deterministic for this
	// promotion, so a presigned GET here would resolve to the PREVIOUS photo
	// — including one uploaded to this same key before a single byte of the
	// new one has arrived.
	saved.PhotoURL = ""

	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"upload_url":   url,
		"content_type": contentType,
		"max_bytes":    maxPhotoBytes,
		"expires_in":   int(photoWriteTTL.Seconds()),
		"promotion":    saved,
	})
}

func (h *Handler) DeletePromotion(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	userID := claims.UserID
	id := r.PathValue("promotionID")

	/*
		The object goes BEFORE the row, and its failure is not fatal — same
		ordering and the same reasoning as body.Handler.DeleteCheckin.

		Before, because the row is what tells us the key exists at all — delete
		it first and a failed object delete leaves an orphan nothing points at.

		Not fatal, because a storage outage must not make a delete impossible;
		the athlete asked for this promotion to be gone and the row is the part
		we control. An object left behind is retained, which is a smaller
		problem than a promotion that cannot be deleted — but it is logged
		rather than swallowed, because the key is DERIVED from the promotion
		id: once this id is gone, nothing can ever ask for a delete of that key
		again, so an object left behind here is retained for good, not merely
		until the next attempt.
	*/
	if h.store != nil {
		if existing, err := h.repo.GetPromotion(r.Context(), userID, id); err == nil && existing.PhotoKey != nil {
			if err := h.deleteObject(r.Context(), *existing.PhotoKey); err != nil {
				httplog.FromContext(r.Context()).Warn("bjj: could not delete promotion photo", "err", err)
			}
		}
	}

	if err := h.repo.DeletePromotion(r.Context(), userID, id); err != nil {
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
