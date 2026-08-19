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

// Quota counts one athlete's calls inside the window, across BOTH paths.
//
// No `source` filter any more — there is one budget. See quota.go for the
// measurement that collapsed the two.
//
// One round trip for both the count and the oldest row, because they are the
// same scan — asking twice would double the cost of a check that runs before
// every call. The `MIN(created_at)` is what `resets_at` is derived from: the
// oldest call in the window is the next one to age out.
//
// Served by `nutrition_estimates_user_window_idx`, added in migration 000064.
// The original index leads `(user_id, source, created_at)`, and dropping the
// source predicate makes it unusable as a range scan — `source` sits between
// the two columns still being filtered, so this query would degrade to
// scanning every row the athlete has ever produced. A correctness test would
// not have noticed.
func (r *PostgresEstimateUsage) Quota(ctx context.Context, userID string, now time.Time) (Quota, error) {
	since := now.Add(-QuotaWindow)

	var used int
	var oldest *time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT count(*), MIN(created_at)
		  FROM nutrition_estimates
		 WHERE user_id = $1
		   AND created_at > $2`,
		userID, since,
	).Scan(&used, &oldest)
	if err != nil {
		return Quota{}, fmt.Errorf("nutrition: estimate quota: %w", err)
	}
	return NewQuota(used, oldest), nil
}

// Record writes one call.
//
// Written for FAILURES too — see the migration's comment. A refusal and an
// upstream error both cost tokens, so a quota that counted only successes
// would let a caller loop on input the model keeps declining and pay for
// every attempt.
func (r *PostgresEstimateUsage) Record(ctx context.Context, rec EstimateRecord) error {
	// Usage is written as NULL when no call reached the provider, and as real
	// numbers otherwise — including on a refusal, which was billed in full.
	//
	// The distinction is the point: a `0` here means "metered, and it cost
	// nothing", which is a claim about a call that happened. A validation
	// rejection or a transport failure never produced usage at all, and
	// recording that as `0` would put confident zeros into the exact dataset
	// the caps are about to be re-derived from. Same rule the migration states
	// for the pre-metering backfill.
	var in, out, cached, reasoning, image *int64
	if rec.Usage != (Usage{}) {
		in, out = &rec.Usage.InputTokens, &rec.Usage.OutputTokens
		cached, reasoning = &rec.Usage.CachedInputTokens, &rec.Usage.ReasoningTokens
		// Only recorded when the provider broke it out. Anthropic does not, so
		// a zero from it would read as "the image was free" rather than "not
		// reported" — see the column comment.
		if rec.Usage.ImageTokens > 0 {
			image = &rec.Usage.ImageTokens
		}
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO nutrition_estimates (
			user_id, source, succeeded, model, item_count,
			input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, image_tokens)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		rec.UserID, string(rec.Source), rec.Succeeded, rec.Model, rec.ItemCount,
		in, out, cached, reasoning, image,
	)
	if err != nil {
		return fmt.Errorf("nutrition: record estimate: %w", err)
	}
	return nil
}
