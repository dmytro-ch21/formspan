package bjj

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// No postgres-level test existed for the promotions repository before this —
// StandingFrom (bjj_test.go) covers the pure derivation, but nothing here
// exercised CreatePromotion/UpdatePromotion/DeletePromotion against a real
// database. These focus on the properties only a database can show: the photo
// key surviving an unrelated update, an id scoped to its owner, and
// AttachPhotoKey's not-an-upsert semantics.

func newPromotionTestRepo(t *testing.T) (*PostgresRepository, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	pool, err := database.NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered first so it closes LAST under LIFO cleanup — every other
	// t.Cleanup below still needs the pool open. See CLAUDE.md.
	t.Cleanup(pool.Close)
	return NewPostgresRepository(pool), pool
}

func cleanupPromotions(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM bjj_promotions WHERE user_id = $1`, userID)
	})
}

func TestCreatePromotion_ThenGetPromotion_RoundTrips(t *testing.T) {
	repo, pool := newPromotionTestRepo(t)
	userID := "u_create_get"
	cleanupPromotions(t, pool, userID)
	ctx := context.Background()

	created, err := repo.CreatePromotion(ctx, Promotion{
		UserID: userID, Rank: Rank{Belt: Blue, Stripes: 2}, Academy: "Origin",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == "" {
		t.Fatal("id was not minted")
	}
	if created.PhotoKey != nil {
		t.Errorf("a freshly created promotion already has a photo key: %v", *created.PhotoKey)
	}

	got, err := repo.GetPromotion(ctx, userID, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Academy != "Origin" || got.Belt != Blue {
		t.Errorf("got = %+v, want the row just created", got)
	}
}

func TestGetPromotion_ScopedToTheOwner(t *testing.T) {
	// The same IDOR-shaped check UpdatePromotion and DeletePromotion already
	// carry — an id that is real but belongs to somebody else must read
	// exactly like an id that does not exist at all, never a distinguishable
	// "found but not yours" response.
	repo, pool := newPromotionTestRepo(t)
	owner, other := "u_owner_get", "u_other_get"
	cleanupPromotions(t, pool, owner)
	cleanupPromotions(t, pool, other)
	ctx := context.Background()

	created, err := repo.CreatePromotion(ctx, Promotion{UserID: owner, Rank: Rank{Belt: White}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := repo.GetPromotion(ctx, other, created.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound for another account's promotion", err)
	}
}

func TestAttachPhotoKey_SetsTheKeyOnAnExistingPromotion(t *testing.T) {
	repo, pool := newPromotionTestRepo(t)
	userID := "u_attach"
	cleanupPromotions(t, pool, userID)
	ctx := context.Background()

	created, err := repo.CreatePromotion(ctx, Promotion{UserID: userID, Rank: Rank{Belt: Purple}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	key := PhotoKey(userID, created.ID)
	saved, err := repo.AttachPhotoKey(ctx, userID, created.ID, key)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if saved.PhotoKey == nil || *saved.PhotoKey != key {
		t.Errorf("photo_key = %v, want %q", saved.PhotoKey, key)
	}
	// Everything else about the row must survive untouched — the same
	// "partial write has no business going through a full-save contract"
	// reasoning body.Repository.AttachPhotoKey documents.
	if saved.Belt != Purple {
		t.Errorf("belt = %q, an unrelated field was disturbed by attaching a photo", saved.Belt)
	}
}

func TestAttachPhotoKey_UnknownIDIsNotFound(t *testing.T) {
	// Unlike a check-in, there is no natural key to upsert on — a promotion
	// must already exist, so attaching a photo to an id nobody created is a
	// 404-shaped ErrNotFound rather than a silent insert of a bare row.
	repo, pool := newPromotionTestRepo(t)
	userID := "u_attach_missing"
	cleanupPromotions(t, pool, userID)
	ctx := context.Background()

	if _, err := repo.AttachPhotoKey(ctx, userID, "00000000-0000-0000-0000-000000000000", "some/key.jpg"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestAttachPhotoKey_CannotAttachToSomebodyElsesPromotion(t *testing.T) {
	repo, pool := newPromotionTestRepo(t)
	owner, other := "u_owner_attach", "u_other_attach"
	cleanupPromotions(t, pool, owner)
	cleanupPromotions(t, pool, other)
	ctx := context.Background()

	created, err := repo.CreatePromotion(ctx, Promotion{UserID: owner, Rank: Rank{Belt: White}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := repo.AttachPhotoKey(ctx, other, created.ID, "stolen/key.jpg"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestUpdatePromotion_LeavesThePhotoKeyAlone(t *testing.T) {
	// UpdatePromotion's SET clause never names photo_key — this is the
	// regression the module pattern's exercise.updateWithin note warns about:
	// a column silently added to that clause has, three times, blanked an
	// authored value. Written here so a future column addition has a test to
	// break.
	repo, pool := newPromotionTestRepo(t)
	userID := "u_update_photo"
	cleanupPromotions(t, pool, userID)
	ctx := context.Background()

	created, err := repo.CreatePromotion(ctx, Promotion{UserID: userID, Rank: Rank{Belt: Blue}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	key := PhotoKey(userID, created.ID)
	if _, err := repo.AttachPhotoKey(ctx, userID, created.ID, key); err != nil {
		t.Fatalf("attach: %v", err)
	}

	updated, err := repo.UpdatePromotion(ctx, Promotion{
		ID: created.ID, UserID: userID, Rank: Rank{Belt: Blue, Stripes: 3}, Academy: "New academy",
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.PhotoKey == nil || *updated.PhotoKey != key {
		t.Errorf("photo_key = %v after an unrelated update, want it to survive as %q", updated.PhotoKey, key)
	}
}
