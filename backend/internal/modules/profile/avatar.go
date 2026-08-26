// Avatar upload, removal and the server-side resize in between.
//
// # Why this proxies bytes through the API, unlike a check-in photo
//
// `objectstore`'s own doc comment says the bytes must not flow through this
// process — that argument is about progress photos specifically, which are
// large, sensitive, and never need this process to look inside them.
// N12's acceptance criteria make a different demand of an avatar: **the
// original is never served to other athletes** — only a resized copy is, and
// something has to do the resizing. Nothing between a client and R2 can do
// that; only code that sees the bytes can. So this endpoint proxies, the
// same way `exercise.IdentifyHandler` already proxies a machine photo through
// to a vision API — small, capped, and for a reason the direct-to-storage
// path structurally cannot serve.
package profile

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/jpeg" // decoders, registered by import for image.Decode
	_ "image/png"
	"net/http"
	"time"

	"golang.org/x/image/draw"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

const (
	// avatarReadTTL is short for the same reason body's photoReadTTL is: a
	// presigned GET is a bearer credential for the object, minted fresh on
	// every response and rendered immediately, so nothing benefits from a
	// longer life.
	avatarReadTTL = 15 * time.Minute
	// avatarWriteTTL only needs to outlive one small PUT the API itself
	// performs (see putObject) — nowhere near body's 30m, which has to
	// survive a slow upload over gym wifi from the CLIENT.
	avatarWriteTTL = 2 * time.Minute

	// maxAvatarUploadBytes bounds what the client may SEND, before any
	// resizing happens. Generous enough for an un-downscaled phone photo
	// (matches exercise.maxIdentifyBody's reasoning) while keeping the
	// process's memory bounded — the decode step below holds the whole
	// image, uncompressed, at once.
	maxAvatarUploadBytes = 8 << 20

	// avatarMaxDim is what the STORED copy is resized to fit within,
	// preserving aspect ratio, never upscaled. 512 is generous for anything
	// this app currently renders an avatar at and small enough that the
	// re-encoded JPEG is consistently under 100KB.
	avatarMaxDim = 512

	// avatarJPEGQuality trades file size for fidelity on the re-encode. Not
	// tuned to a measurement the way scripts/generate_sounds.py's levels are
	// — picked as a reasonable default for a small, cropped photo of a face,
	// and worth revisiting against a real device photo if it ever looks soft.
	avatarJPEGQuality = 85
)

// resizeAvatar decodes an arbitrary image, fits it within avatarMaxDim on its
// longer side (never upscaling a smaller source), and re-encodes as JPEG.
//
// Pure and side-effect-free on purpose: it takes bytes and returns bytes,
// so it is testable without a network, a database, or an object store — see
// avatar_test.go. Everything about validating the UPLOAD (size cap, content
// sniffing) happens in the handler, before this is ever called.
func resizeAvatar(raw []byte) ([]byte, error) {
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: not a readable image", ErrInvalidInput)
	}

	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("%w: image has no content", ErrInvalidInput)
	}

	// Fit within avatarMaxDim × avatarMaxDim, preserving aspect ratio, never
	// upscaling: a smaller source stays its own size rather than being
	// blown up into a soft, oversized copy nobody asked for.
	scale := 1.0
	if w > avatarMaxDim || h > avatarMaxDim {
		scale = float64(avatarMaxDim) / float64(w)
		if hs := float64(avatarMaxDim) / float64(h); hs < scale {
			scale = hs
		}
	}
	dw := max(1, int(float64(w)*scale))
	dh := max(1, int(float64(h)*scale))

	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	// CatmullRom over NearestNeighbor or BiLinear: this is a downscale of a
	// photo of a FACE, where ringing artefacts matter less than the blur a
	// cheaper filter leaves behind — and unlike the checkin/identify photo
	// paths (client-side, budget-constrained), this runs once per upload on
	// the server, where the extra cost is not felt by anyone waiting on it.
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)

	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: avatarJPEGQuality}); err != nil {
		return nil, fmt.Errorf("profile: encode avatar: %w", err)
	}
	return out.Bytes(), nil
}

// present mints a presigned read URL for p's avatar, if it has one.
//
// Mirrors body.Handler.present exactly, including the failure mode: presign
// only fails on a config-class problem, so it is logged rather than turned
// into a request failure — an athlete's whole profile should not 500 because
// a signature could not be produced.
func (h *Handler) present(r *http.Request, p *Profile) {
	if !p.HasAvatar || h.store == nil {
		return
	}
	url, err := h.store.PresignGet(AvatarKey(p.UserID), avatarReadTTL, time.Now())
	if err != nil {
		httplog.FromContext(r.Context()).Warn("profile: could not presign avatar", "err", err)
		return
	}
	p.AvatarURL = url
}

// presentPublic is present's counterpart for the shape a lookup returns —
// which carries the key rather than a user id, precisely so no id has to
// reach this function to do its job. See PublicProfile.AvatarKey.
func (h *Handler) presentPublic(r *http.Request, p *PublicProfile) {
	if p.AvatarKey == nil || h.store == nil {
		return
	}
	url, err := h.store.PresignGet(*p.AvatarKey, avatarReadTTL, time.Now())
	if err != nil {
		httplog.FromContext(r.Context()).Warn("profile: could not presign avatar", "err", err)
		return
	}
	p.AvatarURL = url
	// The key itself never leaves this function — p.AvatarKey stays
	// json:"-" regardless, this just makes the intent explicit at the one
	// call site that reads it.
}

// putObject writes body to key, server-side, via a presigned PUT the API
// mints and performs itself rather than handing to a client.
//
// This is the one place in the codebase an avatar's resized bytes touch the
// network after decoding: the original never does (it lives only in the
// handler's request buffer and resizeAvatar's argument, both discarded once
// this returns), which is the property the acceptance criteria name.
func (h *Handler) putObject(ctx context.Context, key, contentType string, body []byte) error {
	url, err := h.store.PresignPut(key, contentType, avatarWriteTTL, time.Now())
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = int64(len(body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("objectstore: put returned %d", res.StatusCode)
	}
	return nil
}

// deleteAvatarObject removes userID's avatar object, best-effort. Mirrors
// body.Handler.deleteObject, including 404-counts-as-success.
func (h *Handler) deleteAvatarObject(ctx context.Context, userID string) error {
	url, err := h.store.PresignDelete(AvatarKey(userID), avatarWriteTTL, time.Now())
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
	if res.StatusCode >= 300 && res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("objectstore: delete returned %d", res.StatusCode)
	}
	return nil
}

// parseAvatarUpload reads and validates the multipart body, sniffing the
// content type rather than trusting the part's declared one — same reasoning
// as exercise.parseIdentifyRequest: a header is a claim, the magic number is
// evidence.
func parseAvatarUpload(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarUploadBytes)
	if err := r.ParseMultipartForm(maxAvatarUploadBytes); err != nil {
		return nil, fmt.Errorf("%w: could not read the upload", ErrInvalidInput)
	}
	file, _, err := r.FormFile("avatar")
	if err != nil {
		return nil, fmt.Errorf("%w: a photo is required in the \"avatar\" part", ErrInvalidInput)
	}
	defer file.Close()

	raw := make([]byte, 0, 512<<10)
	buf := make([]byte, 32<<10)
	for {
		n, rerr := file.Read(buf)
		if n > 0 {
			raw = append(raw, buf[:n]...)
		}
		if rerr != nil {
			break
		}
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("%w: the upload was empty", ErrInvalidInput)
	}
	mediaType := http.DetectContentType(raw)
	if mediaType != "image/jpeg" && mediaType != "image/png" {
		return nil, fmt.Errorf("%w: send a JPEG or PNG image", ErrInvalidInput)
	}
	return raw, nil
}

// UploadAvatar handles POST /v1/profile/avatar — upload or replace, the same
// path either way, because the object key is deterministic per user.
//
// **Order matters, and it is the whole answer to "upload failures do not
// leave a half-set avatar or a broken image" (N12's acceptance criterion):**
// decode and resize first, entirely in memory; write the resized object to
// storage SECOND; record has_avatar=true LAST, only after the write
// succeeds. A failure at any step before the last one leaves the database
// exactly as it was — either still pointing at the previous avatar (a
// replace that fails changes nothing an athlete can see) or still saying
// there is none (a first upload that fails leaves the monogram showing,
// which is never a broken image).
func (h *Handler) UploadAvatar(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if h.store == nil {
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"avatar storage is not configured on this environment")
		return
	}

	raw, err := parseAvatarUpload(w, r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	resized, err := resizeAvatar(raw)
	if err != nil {
		writeError(w, r, err)
		return
	}

	if err := h.putObject(r.Context(), AvatarKey(claims.UserID), "image/jpeg", resized); err != nil {
		// The object write failed — has_avatar is never touched, so a replace
		// that fails this way leaves the PREVIOUS avatar in place rather than
		// pointing at an object that was never written.
		apihttp.WriteInternal(w, r, "profile", err)
		return
	}
	if err := h.repo.SetAvatar(r.Context(), claims.UserID); err != nil {
		writeError(w, r, err)
		return
	}

	p, err := h.repo.Get(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	h.present(r, p)
	apihttp.WriteJSON(w, http.StatusOK, p)
}

// RemoveAvatar handles DELETE /v1/profile/avatar — the athlete's own removal.
//
// **Order is reversed from upload, and deliberately**: has_avatar is cleared
// FIRST, the object delete is best-effort SECOND. A delete that fails after
// the flag is cleared leaves an orphaned object nobody can reach any more
// (present() only presigns when HasAvatar is true) — invisible rather than
// unsafe. Clearing the flag AFTER a failed delete would instead leave the
// athlete's profile still claiming an avatar that they just asked to remove
// and were told succeeded, which is the half-finished state the acceptance
// criteria refuse.
func (h *Handler) RemoveAvatar(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	h.removeAvatarFor(w, r, claims.UserID)
}

// AdminClearAvatar handles DELETE /v1/admin/users/{userID}/avatar — the
// moderation answer this ticket's acceptance criteria require be written
// down: an admin (today, the ADMIN_USER_IDS allowlist — the same one that
// gates every other /v1/admin/* route) can remove any account's avatar by
// user id. There is no in-app report flow yet; a takedown is initiated by
// however a complaint reaches an operator today (email, a DM), the same way
// every other admin action in this console is.
func (h *Handler) AdminClearAvatar(w http.ResponseWriter, r *http.Request) {
	h.removeAvatarFor(w, r, r.PathValue("userID"))
}

func (h *Handler) removeAvatarFor(w http.ResponseWriter, r *http.Request, userID string) {
	if h.store == nil {
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"avatar storage is not configured on this environment")
		return
	}
	if err := h.repo.ClearAvatar(r.Context(), userID); err != nil {
		writeError(w, r, err)
		return
	}
	if err := h.deleteAvatarObject(r.Context(), userID); err != nil {
		// Logged, not surfaced: the athlete-facing property that matters is
		// already true (HasAvatar is false, the monogram is back) — an
		// orphaned object nobody can reach is a storage-hygiene concern, not
		// a broken response to send the caller.
		httplog.FromContext(r.Context()).Warn("profile: could not delete avatar object",
			"user_id", userID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}
