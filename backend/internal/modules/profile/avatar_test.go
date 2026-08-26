package profile

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/objectstore"
)

// resizeAvatar is pure — no network, no database — so its shape (fits within
// the cap, never upscales, refuses garbage) is tested directly here rather
// than only indirectly through the handler.

func solidJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode fixture jpeg: %v", err)
	}
	return buf.Bytes()
}

func solidPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode fixture png: %v", err)
	}
	return buf.Bytes()
}

func decodedSize(t *testing.T, raw []byte) (int, int) {
	t.Helper()
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("resizeAvatar's output does not decode as JPEG: %v", err)
	}
	b := img.Bounds()
	return b.Dx(), b.Dy()
}

func TestResizeAvatar_FitsWithinTheCapPreservingAspect(t *testing.T) {
	// 2000×1000 — well over avatarMaxDim on the wide side only. A resize that
	// forced both dimensions to the cap, or picked the wrong axis to bind on,
	// would distort the image rather than merely shrink it.
	out, err := resizeAvatar(solidJPEG(t, 2000, 1000))
	if err != nil {
		t.Fatalf("resize: %v", err)
	}
	w, h := decodedSize(t, out)
	if w != avatarMaxDim {
		t.Errorf("width = %d, want the cap %d (the longer side)", w, avatarMaxDim)
	}
	if h != avatarMaxDim/2 {
		t.Errorf("height = %d, want %d — aspect ratio must survive the resize", h, avatarMaxDim/2)
	}
}

func TestResizeAvatar_NeverUpscalesASmallerSource(t *testing.T) {
	// Smaller than the cap on both axes. Scaling it UP would be a soft,
	// pointless copy nobody asked for — the acceptance criterion is "fits
	// within", not "is exactly".
	out, err := resizeAvatar(solidJPEG(t, 100, 60))
	if err != nil {
		t.Fatalf("resize: %v", err)
	}
	w, h := decodedSize(t, out)
	if w != 100 || h != 60 {
		t.Errorf("size = %dx%d, want the untouched 100x60 — a small source must not be upscaled", w, h)
	}
}

func TestResizeAvatar_AcceptsPNGAndReencodesToJPEG(t *testing.T) {
	// The acceptance criterion is "resized server-side" for whatever the
	// client sent, and the upload handler accepts PNG (see
	// TestUploadAvatar_RejectsNonImageContent below) — so the resize path
	// itself has to actually decode one, not just JPEG.
	out, err := resizeAvatar(solidPNG(t, 800, 800))
	if err != nil {
		t.Fatalf("resize a PNG source: %v", err)
	}
	if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
		t.Errorf("output does not decode as JPEG even though the source was PNG: %v", err)
	}
}

func TestResizeAvatar_RefusesGarbage(t *testing.T) {
	_, err := resizeAvatar([]byte("this is not an image, it is a sentence"))
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("want ErrInvalidInput for undecodable bytes, got %v", err)
	}
}

// --- Handler-level sequencing, against a fake S3-compatible endpoint ---
//
// This is NOT a claim about how R2 behaves — that would be exactly the "stub
// built from an assumption" CLAUDE.md warns against, and `presign.go`'s own
// tests already check the SigV4 algorithm against AWS's published vectors.
// What's under test here is OUR code's sequencing: does a successful PUT
// happen before SetAvatar, does a failed PUT leave SetAvatar uncalled, does
// RemoveAvatar clear the flag even when the object delete fails. Any HTTP
// server can stand in for that, because the presigned-URL protocol is
// generic — only the SEQUENCE is being asserted, never R2-specific behaviour.

// spyRepo records exactly the avatar-related calls a test needs to assert on,
// and answers everything else from an embedded Repository that is nil and
// therefore panics if a test reaches a method it did not expect to.
type spyRepo struct {
	Repository
	setAvatarCalls   []string
	clearAvatarCalls []string
	setAvatarErr     error
	getProfile       *Profile
}

func (s *spyRepo) SetAvatar(_ context.Context, userID string) error {
	s.setAvatarCalls = append(s.setAvatarCalls, userID)
	return s.setAvatarErr
}

func (s *spyRepo) ClearAvatar(_ context.Context, userID string) error {
	s.clearAvatarCalls = append(s.clearAvatarCalls, userID)
	return nil
}

func (s *spyRepo) Get(_ context.Context, userID string) (*Profile, error) {
	if s.getProfile != nil {
		return s.getProfile, nil
	}
	return &Profile{UserID: userID, HasAvatar: true}, nil
}

// fakeObjectStore stands up an httptest.Server and a *objectstore.Store
// pointed at it, recording every request the handler sends.
type fakeObjectStore struct {
	srv       *httptest.Server
	store     *objectstore.Store
	requests  []*http.Request
	bodies    [][]byte
	putStatus int // 0 defaults to 200
	delStatus int // 0 defaults to 204
}

func newFakeObjectStore(t *testing.T) *fakeObjectStore {
	t.Helper()
	f := &fakeObjectStore{putStatus: http.StatusOK, delStatus: http.StatusNoContent}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests = append(f.requests, r)
		body, _ := readAll(r)
		f.bodies = append(f.bodies, body)
		switch r.Method {
		case http.MethodPut:
			w.WriteHeader(f.putStatus)
		case http.MethodDelete:
			w.WriteHeader(f.delStatus)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(f.srv.Close)
	store, err := objectstore.New(objectstore.Config{
		Endpoint:  f.srv.URL,
		Bucket:    "test-avatars",
		AccessKey: "AKIATEST",
		SecretKey: "test-secret",
	})
	if err != nil {
		t.Fatalf("build fake store: %v", err)
	}
	f.store = store
	return f
}

func readAll(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	defer r.Body.Close()
	buf := new(bytes.Buffer)
	_, err := buf.ReadFrom(r.Body)
	return buf.Bytes(), err
}

func multipartAvatarRequest(t *testing.T, userID string, imageBytes []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("avatar", "avatar.jpg")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write(imageBytes); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/profile/avatar", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	ctx := auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: userID})
	return req.WithContext(ctx)
}

func TestUploadAvatar_HappyPath(t *testing.T) {
	fake := newFakeObjectStore(t)
	repo := &spyRepo{}
	h := NewHandler(repo, fake.store)

	req := multipartAvatarRequest(t, "u1", solidJPEG(t, 900, 900))
	rec := httptest.NewRecorder()
	h.UploadAvatar(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// The object write happens BEFORE the database is told an avatar exists
	// — asserted by the fact both happened at all, and by
	// TestUploadAvatar_ObjectWriteFailureLeavesTheFlagUnset below asserting
	// the negative half of the same claim.
	if len(fake.requests) != 1 || fake.requests[0].Method != http.MethodPut {
		t.Fatalf("want exactly one PUT to storage, got %d requests", len(fake.requests))
	}
	if ct := fake.requests[0].Header.Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("stored content-type = %q, want image/jpeg (always, regardless of the source format)", ct)
	}
	if len(repo.setAvatarCalls) != 1 || repo.setAvatarCalls[0] != "u1" {
		t.Fatalf("SetAvatar calls = %v, want exactly one for u1", repo.setAvatarCalls)
	}
	// The bytes actually written are the RESIZED copy, never the 900x900
	// original — this is the acceptance criterion ("the original is never
	// served to other athletes") checked at the point it could be violated.
	w, h2 := decodedSize(t, fake.bodies[0])
	if w != avatarMaxDim || h2 != avatarMaxDim {
		t.Errorf("stored image = %dx%d, want %dx%d (the resized copy, not the 900x900 original)",
			w, h2, avatarMaxDim, avatarMaxDim)
	}
}

// The acceptance criterion this pins directly: "upload failures do not
// leave a half-set avatar". Mutation-checked by hand while writing this
// file — swapping resizeAvatar-then-write-then-SetAvatar's ordering for
// write-then-SetAvatar-then-check-error turns this red.
func TestUploadAvatar_ObjectWriteFailureLeavesTheFlagUnset(t *testing.T) {
	fake := newFakeObjectStore(t)
	fake.putStatus = http.StatusInternalServerError
	repo := &spyRepo{}
	h := NewHandler(repo, fake.store)

	req := multipartAvatarRequest(t, "u1", solidJPEG(t, 300, 300))
	rec := httptest.NewRecorder()
	h.UploadAvatar(rec, req)

	if rec.Code == http.StatusOK {
		t.Fatalf("a failed object write must not report success, got 200: %s", rec.Body.String())
	}
	if len(repo.setAvatarCalls) != 0 {
		t.Errorf("SetAvatar must not be called when the object write failed, got calls: %v", repo.setAvatarCalls)
	}
}

func TestUploadAvatar_RejectsNonImageContent(t *testing.T) {
	fake := newFakeObjectStore(t)
	repo := &spyRepo{}
	h := NewHandler(repo, fake.store)

	req := multipartAvatarRequest(t, "u1", []byte("%PDF-1.4 not actually an image"))
	rec := httptest.NewRecorder()
	h.UploadAvatar(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a non-image upload", rec.Code)
	}
	if len(fake.requests) != 0 {
		t.Errorf("nothing should reach storage for a rejected upload, got %d requests", len(fake.requests))
	}
	if len(repo.setAvatarCalls) != 0 {
		t.Errorf("SetAvatar must not be called for a rejected upload")
	}
}

func TestUploadAvatar_WithNoStoreConfigured(t *testing.T) {
	repo := &spyRepo{}
	h := NewHandler(repo, nil) // the supported "no bucket on this deploy" state
	req := multipartAvatarRequest(t, "u1", solidJPEG(t, 100, 100))
	rec := httptest.NewRecorder()
	h.UploadAvatar(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 when storage is not configured", rec.Code)
	}
}

func TestRemoveAvatar_ClearsTheFlagEvenWhenTheObjectDeleteFails(t *testing.T) {
	// The mirror image of the upload test, and deliberately the OPPOSITE
	// order: RemoveAvatar's own doc comment argues clearing the flag first
	// is correct because an orphaned object is invisible (present() never
	// presigns once HasAvatar is false), where leaving the flag set after a
	// "successful" removal would tell the athlete it worked when it had not.
	fake := newFakeObjectStore(t)
	fake.delStatus = http.StatusInternalServerError
	repo := &spyRepo{}
	h := NewHandler(repo, fake.store)

	req := httptest.NewRequest(http.MethodDelete, "/v1/profile/avatar", nil)
	ctx := auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: "u1"})
	rec := httptest.NewRecorder()
	h.RemoveAvatar(rec, req.WithContext(ctx))

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204 — the athlete-facing removal succeeded regardless of storage hygiene", rec.Code)
	}
	if len(repo.clearAvatarCalls) != 1 || repo.clearAvatarCalls[0] != "u1" {
		t.Fatalf("ClearAvatar calls = %v, want exactly one for u1", repo.clearAvatarCalls)
	}
}

func TestAdminClearAvatar_UsesThePathUserIDNotTheCallersOwn(t *testing.T) {
	// The whole security property of the admin route: an operator's own
	// identity must never leak into which account gets cleared.
	fake := newFakeObjectStore(t)
	repo := &spyRepo{}
	h := NewHandler(repo, fake.store)

	req := httptest.NewRequest(http.MethodDelete, "/v1/admin/users/target_user/avatar", nil)
	req.SetPathValue("userID", "target_user")
	// The admin operator, NOT the target — RequireAdmin puts THEIR claims in
	// context, and the handler must ignore them for this decision.
	ctx := auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: "admin_operator"})
	rec := httptest.NewRecorder()
	h.AdminClearAvatar(rec, req.WithContext(ctx))

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
	if len(repo.clearAvatarCalls) != 1 || repo.clearAvatarCalls[0] != "target_user" {
		t.Fatalf("cleared user = %v, want exactly [target_user] — never the admin's own id", repo.clearAvatarCalls)
	}
}
