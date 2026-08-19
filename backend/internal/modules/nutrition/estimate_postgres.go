package nutrition

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresEstimateUsage meters the estimate endpoint.
//
// Its own type rather than methods on PostgresRepository: this is spend
// metering, and folding it into the food-log repository would put a billing
// concern inside the type every food read goes through.
type PostgresEstimateUsage struct {
	pool *pgxpool.Pool
}

func NewPostgresEstimateUsage(pool *pgxpool.Pool) *PostgresEstimateUsage {
	return &PostgresEstimateUsage{pool: pool}
}

// Quota counts one athlete's calls of one source inside the window.
//
// One round trip for both the count and the oldest row, because they are the
// same scan — asking twice would double the cost of a check that runs before
// every call. The `MIN(created_at)` is what `resets_at` is derived from: the
// oldest call in the window is the next one to age out.
func (r *PostgresEstimateUsage) Quota(ctx context.Context, userID string, src EstimateSource, now time.Time) (Quota, error) {
	since := now.Add(-QuotaWindow)

	var used int
	var oldest *time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT count(*), MIN(created_at)
		  FROM nutrition_estimates
		 WHERE user_id = $1
		   AND source = $2
		   AND created_at > $3`,
		userID, string(src), since,
	).Scan(&used, &oldest)
	if err != nil {
		return Quota{}, fmt.Errorf("nutrition: estimate quota: %w", err)
	}
	return NewQuota(src, used, oldest), nil
}

// Record writes one call.
//
// Written for FAILURES too — see the migration's comment. A refusal and an
// upstream error both cost tokens, so a quota that counted only successes
// would let a caller loop on input the model keeps declining and pay for
// every attempt.
func (r *PostgresEstimateUsage) Record(ctx context.Context, rec EstimateRecord) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO nutrition_estimates (user_id, source, succeeded, model, item_count)
		VALUES ($1, $2, $3, $4, $5)`,
		rec.UserID, string(rec.Source), rec.Succeeded, rec.Model, rec.ItemCount,
	)
	if err != nil {
		return fmt.Errorf("nutrition: record estimate: %w", err)
	}
	return nil
}
