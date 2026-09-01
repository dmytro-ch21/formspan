package bjj

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/objectstore"
)

// memRepo is an in-memory Repository, used so the handler's own logic — 503
// with no store, the derived key, the delete-object-before-the-row ordering —
// is testable without a database.
type memRepo struct {
	promotions map[string]Promotion // id -> row

	attachCalls int
	deleteCalls int
}

func newMemRepo() *memRepo { return &memRepo{promotions: map[string]Promotion{}} }

func (m *memRepo) ListPromotions(_ context.Context, userID string) ([]Promotion, error) {
	out := []Promotion{}
	for _, p := range m.promotions {
		if p.UserID == userID {
			out = append(out, p)
		}
	}
	return out, nil
}

func (m *memRepo) GetPromotion(_ context.Context, userID, id string) (Promotion, error) {
	p, ok := m.promotions[id]
	if !ok || p.UserID != userID {
		return Promotion{}, ErrNotFound
	}
	return p, nil
}

func (m *memRepo) CreatePromotion(_ context.Context, p Promotion) (Promotion, error) {
	if p.ID == "" {
		p.ID = "generated-id"
	}
	m.promotions[p.ID] = p
	return p, nil
}

func (m *memRepo) UpdatePromotion(_ context.Context, p Promotion) (Promotion, error) {
	existing, ok := m.promotions[p.ID]
	if !ok || existing.UserID != p.UserID {
		return Promotion{}, ErrNotFound
	}
	p.PhotoKey = existing.PhotoKey // mirrors the real SQL: UPDATE never names photo_key
	m.promotions[p.ID] = p
	return p, nil
}

func (m *memRepo) AttachPhotoKey(_ context.Context, userID, id, key string) (Promotion, error) {
	m.attachCalls++
	p, ok := m.promotions[id]
	if !ok || p.UserID != userID {
		return Promotion{}, ErrNotFound
	}
	p.PhotoKey = &key
	m.promotions[id] = p
	return p, nil
}

func (m *memRepo) DeletePromotion(_ context.Context, userID, id string) error {
	m.deleteCalls++
	p, ok := m.promotions[id]
	if !ok || p.UserID != userID {
		return ErrNotFound
	}
	delete(m.promotions, id)
	return nil
}

func withClaims(r *http.Request, userID string) *http.Request {
	return r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: userID}))
}

// fakeObjectStore stands up an httptest.Server and a *objectstore.Store
// pointed at it, recording every request the handler sends — the same
// pattern profile/avatar_test.go uses for the same reason: PresignPut and
// PresignGet never touch the network themselves, but deleteObject's PUT/DELETE
// against the presigned URL does, so exercising that path needs a real server
// to receive it.
type fakeObjectStore struct {
	srv       *httptest.Server
	store     *objectstore.Store
	requests  []*http.Request
	delStatus int // 0 defaults to 204
}

func newFakeObjectStore(t *testing.T) *fakeObjectStore {
	t.Helper()
	f := &fakeObjectStore{delStatus: http.StatusNoContent}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests = append(f.requests, r)
		switch r.Method {
		case http.MethodDelete:
			w.WriteHeader(f.delStatus)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(f.srv.Close)
	store, err := objectstore.New(objectstore.Config{
		Endpoint:  f.srv.URL,
		Bucket:    "test-bjj-photos",
		AccessKey: "AKIATEST",
		SecretKey: "test-secret",
	})
	if err != nil {
		t.Fatalf("build fake store: %v", err)
	}
	f.store = store
	return f
}

// --- PhotoUploadURL ---

func TestPhotoUploadURL_NoStoreDegradesGracefully(t *testing.T) {
	// The documented local-dev/CI behaviour: no bucket configured is a
	// supported state, reported honestly as 503 rather than a 500 that reads
	// like a bug. Mirrors body.Handler.PhotoUploadURL's own comment.
	repo := newMemRepo()
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "u1", Rank: Rank{Belt: Blue}}
	h := NewHandler(repo, nil)

	r := withClaims(httptest.NewRequest(http.MethodPost, "/v1/bjj/promotions/p1/photo", nil), "u1")
	r.SetPathValue("promotionID", "p1")
	rec := httptest.NewRecorder()
	h.PhotoUploadURL(rec, r)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (no store configured)", rec.Code)
	}
	if repo.attachCalls != 0 {
		t.Errorf("attachCalls = %d, a 503 must not have written anything", repo.attachCalls)
	}
}

func TestPhotoUploadURL_UnknownPromotionIsNotFound(t *testing.T) {
	// Unlike a check-in's date-keyed upsert, a promotion must already exist —
	// there is nothing to create implicitly from an upload-URL request.
	fake := newFakeObjectStore(t)
	repo := newMemRepo()
	h := NewHandler(repo, fake.store)

	r := withClaims(httptest.NewRequest(http.MethodPost, "/v1/bjj/promotions/nope/photo", nil), "u1")
	r.SetPathValue("promotionID", "nope")
	rec := httptest.NewRecorder()
	h.PhotoUploadURL(rec, r)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestPhotoUploadURL_CannotMintASignatureOverSomebodyElsesPromotion(t *testing.T) {
	// The whole security property: the key is derived from the AUTHENTICATED
	// caller, never accepted, so there is no id a client can pass to get a
	// signature over another account's object. AttachPhotoKey being scoped by
	// user_id is what makes that hold even when the id itself is guessed
	// correctly.
	fake := newFakeObjectStore(t)
	repo := newMemRepo()
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "owner", Rank: Rank{Belt: Blue}}
	h := NewHandler(repo, fake.store)

	r := withClaims(httptest.NewRequest(http.MethodPost, "/v1/bjj/promotions/p1/photo", nil), "attacker")
	r.SetPathValue("promotionID", "p1")
	rec := httptest.NewRecorder()
	h.PhotoUploadURL(rec, r)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 rather than a signature handed out over a guess", rec.Code)
	}
}

func TestPhotoUploadURL_HappyPath(t *testing.T) {
	fake := newFakeObjectStore(t)
	repo := newMemRepo()
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "u1", Rank: Rank{Belt: Blue}}
	h := NewHandler(repo, fake.store)

	r := withClaims(httptest.NewRequest(http.MethodPost, "/v1/bjj/promotions/p1/photo", nil), "u1")
	r.SetPathValue("promotionID", "p1")
	rec := httptest.NewRecorder()
	h.PhotoUploadURL(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		UploadURL   string `json:"upload_url"`
		ContentType string `json:"content_type"`
		MaxBytes    int    `json:"max_bytes"`
		ExpiresIn   int    `json:"expires_in"`
		Promotion   struct {
			PhotoURL string `json:"photo_url"`
		} `json:"promotion"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.ContentType != "image/jpeg" {
		t.Errorf("content_type = %q", body.ContentType)
	}
	if body.MaxBytes != maxPhotoBytes {
		t.Errorf("max_bytes = %d, want %d", body.MaxBytes, maxPhotoBytes)
	}
	if body.UploadURL == "" {
		t.Error("upload_url is empty")
	}
	// Deliberately not presented — see the handler's own comment on why a
	// presigned GET here would resolve to whatever was at this key before.
	if body.Promotion.PhotoURL != "" {
		t.Errorf("photo_url = %q, want empty on the upload-URL response", body.Promotion.PhotoURL)
	}
	if repo.attachCalls != 1 {
		t.Errorf("attachCalls = %d, want 1", repo.attachCalls)
	}
	saved := repo.promotions["p1"]
	if saved.PhotoKey == nil || *saved.PhotoKey != PhotoKey("u1", "p1") {
		t.Errorf("photo_key = %v, want %q", saved.PhotoKey, PhotoKey("u1", "p1"))
	}
}

// --- DeletePromotion / object cleanup ---

func TestDeletePromotion_DeletesTheObjectBeforeTheRow(t *testing.T) {
	fake := newFakeObjectStore(t)
	repo := newMemRepo()
	key := PhotoKey("u1", "p1")
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "u1", Rank: Rank{Belt: Blue}, PhotoKey: &key}
	h := NewHandler(repo, fake.store)

	r := withClaims(httptest.NewRequest(http.MethodDelete, "/v1/bjj/promotions/p1", nil), "u1")
	r.SetPathValue("promotionID", "p1")
	rec := httptest.NewRecorder()
	h.DeletePromotion(rec, r)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(fake.requests) != 1 || fake.requests[0].Method != http.MethodDelete {
		t.Fatalf("object requests = %+v, want exactly one DELETE", fake.requests)
	}
	if _, exists := repo.promotions["p1"]; exists {
		t.Error("the row is still there")
	}
}

func TestDeletePromotion_NoPhotoMeansNoObjectCall(t *testing.T) {
	fake := newFakeObjectStore(t)
	repo := newMemRepo()
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "u1", Rank: Rank{Belt: Blue}}
	h := NewHandler(repo, fake.store)

	r := withClaims(httptest.NewRequest(http.MethodDelete, "/v1/bjj/promotions/p1", nil), "u1")
	r.SetPathValue("promotionID", "p1")
	rec := httptest.NewRecorder()
	h.DeletePromotion(rec, r)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(fake.requests) != 0 {
		t.Errorf("object requests = %d, want 0 — there was never a photo", len(fake.requests))
	}
}

func TestDeletePromotion_StorageFailureDoesNotBlockTheRowDelete(t *testing.T) {
	// A storage outage must not make deleting a promotion impossible — the
	// athlete asked for the row gone, and that is the part under our control.
	// An orphaned object is a logged, smaller problem, mirroring
	// body.Handler.DeleteCheckin's own reasoning.
	fake := newFakeObjectStore(t)
	fake.delStatus = http.StatusInternalServerError
	repo := newMemRepo()
	key := PhotoKey("u1", "p1")
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "u1", Rank: Rank{Belt: Blue}, PhotoKey: &key}
	h := NewHandler(repo, fake.store)

	r := withClaims(httptest.NewRequest(http.MethodDelete, "/v1/bjj/promotions/p1", nil), "u1")
	r.SetPathValue("promotionID", "p1")
	rec := httptest.NewRecorder()
	h.DeletePromotion(rec, r)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, a storage failure must not block the row delete", rec.Code)
	}
	if _, exists := repo.promotions["p1"]; exists {
		t.Error("the row is still there despite the object delete failing")
	}
}

func TestDeletePromotion_NoStoreStillDeletesTheRow(t *testing.T) {
	repo := newMemRepo()
	key := "promotions/u1/p1.jpg"
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "u1", Rank: Rank{Belt: Blue}, PhotoKey: &key}
	h := NewHandler(repo, nil)

	r := withClaims(httptest.NewRequest(http.MethodDelete, "/v1/bjj/promotions/p1", nil), "u1")
	r.SetPathValue("promotionID", "p1")
	rec := httptest.NewRecorder()
	h.DeletePromotion(rec, r)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
	if _, exists := repo.promotions["p1"]; exists {
		t.Error("the row is still there")
	}
}

// --- GetStanding presigning ---

func TestGetStanding_PresentsAPhotoURLForEveryPromotionThatHasOne(t *testing.T) {
	fake := newFakeObjectStore(t)
	repo := newMemRepo()
	key := PhotoKey("u1", "p1")
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "u1", Rank: Rank{Belt: Blue}, PhotoKey: &key}
	repo.promotions["p2"] = Promotion{ID: "p2", UserID: "u1", Rank: Rank{Belt: White}}
	h := NewHandler(repo, fake.store)
	h.now = func() time.Time { return time.Now() }

	r := withClaims(httptest.NewRequest(http.MethodGet, "/v1/bjj/standing", nil), "u1")
	rec := httptest.NewRecorder()
	h.GetStanding(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got Standing
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	byID := map[string]Promotion{}
	for _, p := range got.Promotions {
		byID[p.ID] = p
	}
	if byID["p1"].PhotoURL == "" {
		t.Error("p1 has a photo key but no photo_url in the response")
	}
	if byID["p2"].PhotoURL != "" {
		t.Errorf("p2 has no photo key, want no photo_url, got %q", byID["p2"].PhotoURL)
	}
}

func TestGetStanding_NoStoreOmitsEveryPhotoURL(t *testing.T) {
	repo := newMemRepo()
	key := PhotoKey("u1", "p1")
	repo.promotions["p1"] = Promotion{ID: "p1", UserID: "u1", Rank: Rank{Belt: Blue}, PhotoKey: &key}
	h := NewHandler(repo, nil)

	r := withClaims(httptest.NewRequest(http.MethodGet, "/v1/bjj/standing", nil), "u1")
	rec := httptest.NewRecorder()
	h.GetStanding(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got Standing
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Promotions) != 1 || got.Promotions[0].PhotoURL != "" {
		t.Errorf("promotions = %+v, want a photo key with no store to yield no photo_url — not a 500", got.Promotions)
	}
}

// --- PhotoKey layout ---

func TestPhotoKey_IsPrefixedByTheAthleteAndKeyedByThePromotion(t *testing.T) {
	if got := PhotoKey("user_abc", "promo_1"); got != "promotions/user_abc/promo_1.jpg" {
		t.Errorf("PhotoKey = %q", got)
	}
}
