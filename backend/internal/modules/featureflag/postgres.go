package featureflag

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// Enabled answers one flag by key. A missing row (never seeded, or a typo in
// the key a caller passed) reads as disabled rather than an error — the same
// "absent means off" reading the migration's seed data establishes for
// `new_recommendation_engine` itself.
func (r *PostgresRepository) Enabled(ctx context.Context, key string) (bool, error) {
	var enabled bool
	err := r.pool.QueryRow(ctx,
		`SELECT enabled FROM feature_flags WHERE key = $1`, key,
	).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("featureflag: enabled %q: %w", key, err)
	}
	return enabled, nil
}

func (r *PostgresRepository) List(ctx context.Context) ([]Flag, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT key, enabled, description, updated_at
		FROM feature_flags ORDER BY key`)
	if err != nil {
		return nil, fmt.Errorf("featureflag: list: %w", err)
	}
	defer rows.Close()

	flags := []Flag{}
	for rows.Next() {
		var f Flag
		if err := rows.Scan(&f.Key, &f.Enabled, &f.Description, &f.UpdatedAt); err != nil {
			return nil, fmt.Errorf("featureflag: scan: %w", err)
		}
		flags = append(flags, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("featureflag: rows: %w", err)
	}
	return flags, nil
}
