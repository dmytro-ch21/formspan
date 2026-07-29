package activity

import (
	"context"
	"encoding/json"
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

func (r *PostgresRepository) Create(ctx context.Context, in NewActivity) (*Activity, error) {
	row := r.pool.QueryRow(ctx, `
		INSERT INTO activities (id, user_id, kind, occurred_at, notes, details, request_id, trace_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO NOTHING
		RETURNING id, user_id, kind, occurred_at, notes, details, request_id, trace_id, created_at
	`, in.ID, in.UserID, in.Kind, in.OccurredAt, in.Notes, nullableJSON(in.Details), in.RequestID, in.TraceID)

	a, err := scanActivity(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// id already existed (ON CONFLICT DO NOTHING) — an idempotent
			// sync retry, not an error. Return the original row.
			return r.getByID(ctx, in.ID)
		}
		return nil, err
	}
	return a, nil
}

func (r *PostgresRepository) getByID(ctx context.Context, id string) (*Activity, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, user_id, kind, occurred_at, notes, details, request_id, trace_id, created_at
		FROM activities WHERE id = $1`, id)
	return scanActivity(row)
}

func (r *PostgresRepository) ListByUser(ctx context.Context, userID string) ([]Activity, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, user_id, kind, occurred_at, notes, details, request_id, trace_id, created_at
		FROM activities WHERE user_id = $1 ORDER BY occurred_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("activity: list: %w", err)
	}
	defer rows.Close()

	activities := []Activity{}
	for rows.Next() {
		a, err := scanActivity(rows)
		if err != nil {
			return nil, err
		}
		activities = append(activities, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("activity: rows: %w", err)
	}
	return activities, nil
}

func (r *PostgresRepository) ListUsers(ctx context.Context) ([]UserSummary, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT p.user_id, p.display_name, count(a.id), max(a.occurred_at)
		FROM profiles p
		LEFT JOIN activities a ON a.user_id = p.user_id
		GROUP BY p.user_id, p.display_name
		ORDER BY p.user_id`)
	if err != nil {
		return nil, fmt.Errorf("activity: list users: %w", err)
	}
	defer rows.Close()

	users := []UserSummary{}
	for rows.Next() {
		var u UserSummary
		if err := rows.Scan(&u.UserID, &u.DisplayName, &u.ActivityCount, &u.LastActivityAt); err != nil {
			return nil, fmt.Errorf("activity: scan user: %w", err)
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("activity: rows: %w", err)
	}
	return users, nil
}

// scanner is satisfied by both pgx.Row (QueryRow) and pgx.Rows (Query, one
// row at a time via Next/Scan) — lets Create/getByID/ListByUser share one
// scan function instead of two near-identical copies.
type scanner interface {
	Scan(dest ...any) error
}

func scanActivity(row scanner) (*Activity, error) {
	var a Activity
	var details []byte
	err := row.Scan(&a.ID, &a.UserID, &a.Kind, &a.OccurredAt, &a.Notes, &details, &a.RequestID, &a.TraceID, &a.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		return nil, fmt.Errorf("activity: scan: %w", err)
	}
	if details != nil {
		a.Details = json.RawMessage(details)
	}
	return &a, nil
}

// nullableJSON avoids inserting the JSON literal "null" for a nil/empty
// Details — a real SQL NULL instead, so the column stays genuinely absent.
func nullableJSON(details json.RawMessage) any {
	if len(details) == 0 {
		return nil
	}
	return details
}
