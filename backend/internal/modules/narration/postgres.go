package narration

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresUsage meters the narration endpoint. Its own type, like
// `bjj.PostgresDraftUsage`: spend metering is not domain data.
type PostgresUsage struct {
	pool *pgxpool.Pool
}

func NewPostgresUsage(pool *pgxpool.Pool) *PostgresUsage {
	return &PostgresUsage{pool: pool}
}

var _ UsageRepository = (*PostgresUsage)(nil)

// Quota counts one athlete's calls inside the window. The count and the oldest
// row come from one scan; the oldest is the next to age out.
func (r *PostgresUsage) Quota(ctx context.Context, userID string, now time.Time) (Quota, error) {
	var used int
	var oldest *time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT count(*), MIN(created_at)
		  FROM day_narration_generations
		 WHERE user_id = $1
		   AND created_at > $2`,
		userID, now.Add(-QuotaWindow),
	).Scan(&used, &oldest)
	if err != nil {
		return Quota{}, fmt.Errorf("narration: quota: %w", err)
	}
	return NewQuota(used, oldest), nil
}

// Record writes one call. Usage is NULL when no call produced any (the zero
// value), and real numbers otherwise, including on a billed refusal. That is the
// rule `nutrition.PostgresEstimateUsage.Record` states: a 0 would claim a call
// was metered and cost nothing.
func (r *PostgresUsage) Record(ctx context.Context, rec Record) error {
	var in, out, cached, reasoning *int64
	if rec.Usage != (Usage{}) {
		in, out = &rec.Usage.InputTokens, &rec.Usage.OutputTokens
		cached, reasoning = &rec.Usage.CachedInputTokens, &rec.Usage.ReasoningTokens
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO day_narration_generations (
			user_id, succeeded, model, sentences_kept,
			input_tokens, output_tokens, cached_input_tokens, reasoning_tokens)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		rec.UserID, rec.Succeeded, rec.Model, rec.SentencesKept, in, out, cached, reasoning,
	)
	if err != nil {
		return fmt.Errorf("narration: record: %w", err)
	}
	return nil
}
