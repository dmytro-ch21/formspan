package featureflag

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
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
