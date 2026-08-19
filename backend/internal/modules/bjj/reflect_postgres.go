package bjj

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresDraftUsage meters the reflection-draft endpoint.
//
// Its own type rather than methods on PostgresRepository, matching
// `nutrition.PostgresEstimateUsage`: this is spend metering, and folding it into
// the repository every session read goes through would put a billing concern
// inside the type that answers "what happened on Tuesday".
type PostgresDraftUsage struct {
	pool *pgxpool.Pool
}

func NewPostgresDraftUsage(pool *pgxpool.Pool) *PostgresDraftUsage {
	return &PostgresDraftUsage{pool: pool}
}

var _ DraftUsageRepository = (*PostgresDraftUsage)(nil)

// DraftQuota counts one athlete's calls inside the window.
//
// One round trip for both the count and the oldest row, because they are the
// same scan — asking twice would double the cost of a check that runs before
// every call. The `MIN(created_at)` is what `resets_at` derives from: the oldest
// call in the window is the next one to age out.
func (r *PostgresDraftUsage) DraftQuota(ctx context.Context, userID string, now time.Time) (DraftQuota, error) {
	since := now.Add(-DraftQuotaWindow)

	var used int
	var oldest *time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT count(*), MIN(created_at)
		  FROM bjj_reflection_drafts
		 WHERE user_id = $1
		   AND created_at > $2`,
		userID, since,
	).Scan(&used, &oldest)
	if err != nil {
		return DraftQuota{}, fmt.Errorf("bjj: draft quota: %w", err)
	}
	return NewDraftQuota(used, oldest), nil
}

// RecordDraft writes one call.
//
// Written for FAILURES too — see the migration's comment. A refusal and an
// upstream error both cost tokens, so a quota that counted only successes would
// let a caller loop on input the model keeps declining and pay for every
// attempt.
func (r *PostgresDraftUsage) RecordDraft(ctx context.Context, rec DraftRecord) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO bjj_reflection_drafts (user_id, succeeded, model, tag_count)
		VALUES ($1, $2, $3, $4)`,
		rec.UserID, rec.Succeeded, rec.Model, rec.TagCount,
	)
	if err != nil {
		return fmt.Errorf("bjj: record draft: %w", err)
	}
	return nil
}
