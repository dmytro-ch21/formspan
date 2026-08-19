package exercise

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresIdentifyUsage meters the identify endpoint.
//
// Its own type rather than methods on PostgresRepository, matching
// nutrition.PostgresEstimateUsage: this is spend metering, and folding it into
// the catalog repository would put a billing concern inside the type every
// exercise read goes through.
type PostgresIdentifyUsage struct {
	pool *pgxpool.Pool
}

func NewPostgresIdentifyUsage(pool *pgxpool.Pool) *PostgresIdentifyUsage {
	return &PostgresIdentifyUsage{pool: pool}
}

// Quota counts one athlete's calls inside the window.
//
// **A query over the rows, never a stored counter.** A counter drifts, cannot
// be recomputed after a bug, and cannot answer "what did this athlete actually
// do" — which is the question anyone investigating a bill will ask.
//
// One round trip for both the count and the oldest row, because they are the
// same scan: this runs before every call, so asking twice would double the cost
// of the gate. `MIN(created_at)` is what `resets_at` derives from — the oldest
// call in the window is the next one to age out.
func (r *PostgresIdentifyUsage) Quota(ctx context.Context, userID string, now time.Time) (IdentifyQuota, error) {
	since := now.Add(-IdentifyQuotaWindow)

	var used int
	var oldest *time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT count(*), MIN(created_at)
		  FROM exercise_identifications
		 WHERE user_id = $1
		   AND created_at > $2`,
		userID, since,
	).Scan(&used, &oldest)
	if err != nil {
		return IdentifyQuota{}, fmt.Errorf("exercise: identify quota: %w", err)
	}
	return NewIdentifyQuota(used, oldest), nil
}

// Record writes one call.
//
// Written for FAILURES too — see the migration. A refusal and an upstream error
// both spend tokens, so a quota counting only successes would let a caller loop
// on a photo the model keeps declining and pay for every attempt.
func (r *PostgresIdentifyUsage) Record(ctx context.Context, rec IdentifyRecord) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO exercise_identifications (user_id, succeeded, model, candidate_count)
		VALUES ($1, $2, $3, $4)`,
		rec.UserID, rec.Succeeded, rec.Model, rec.CandidateCount,
	)
	if err != nil {
		return fmt.Errorf("exercise: record identification: %w", err)
	}
	return nil
}
