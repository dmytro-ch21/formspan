package bjj

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const dateLayout = "2006-01-02"

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

const promotionColumns = `id, belt, stripes, degree, promoted_on, academy, instructor, note, created_at, updated_at`

func (r *PostgresRepository) ListPromotions(ctx context.Context, userID string) ([]Promotion, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+promotionColumns+`
		FROM bjj_promotions
		WHERE user_id = $1
		-- Newest first for display. NOT how the current rank is decided —
		-- that is StandingFrom, ordering by rank, because dates are optional
		-- and hand-entered. NULLS LAST keeps undated promotions from
		-- squatting at the top of the timeline.
		ORDER BY promoted_on DESC NULLS LAST, created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Non-nil empty slice: this marshals to [] rather than null, so a client
	// can iterate it without a null check.
	out := []Promotion{}
	for rows.Next() {
		p, err := scanPromotion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) CreatePromotion(ctx context.Context, p Promotion) (Promotion, error) {
	on, err := parseDate(p.PromotedOn)
	if err != nil {
		return Promotion{}, err
	}
	// `id` is omitted so the column default mints it.
	row := r.pool.QueryRow(ctx, `
		INSERT INTO bjj_promotions
			(user_id, belt, stripes, degree, promoted_on, academy, instructor, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING `+promotionColumns,
		p.UserID, string(p.Belt), p.Stripes, p.Degree, on, p.Academy, p.Instructor, p.Note)
	return scanPromotion(row)
}

func (r *PostgresRepository) UpdatePromotion(ctx context.Context, p Promotion) (Promotion, error) {
	on, err := parseDate(p.PromotedOn)
	if err != nil {
		return Promotion{}, err
	}
	row := r.pool.QueryRow(ctx, `
		UPDATE bjj_promotions SET
			belt = $3, stripes = $4, degree = $5, promoted_on = $6,
			academy = $7, instructor = $8, note = $9, updated_at = now()
		-- user_id in the WHERE, never trusted from the body. Without it this
		-- is an IDOR: any id from any account would be editable, and the
		-- reviewers have caught exactly that shape twice in this codebase.
		WHERE id = $1 AND user_id = $2
		RETURNING `+promotionColumns,
		p.ID, p.UserID, string(p.Belt), p.Stripes, p.Degree, on, p.Academy, p.Instructor, p.Note)
	return scanPromotion(row)
}

func (r *PostgresRepository) DeletePromotion(ctx context.Context, userID, id string) error {
	tag, err := r.pool.Exec(ctx,
		`DELETE FROM bjj_promotions WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	// Zero rows is indistinguishable from "belongs to someone else", and
	// deliberately so: a distinct response would confirm the id exists, which
	// is the enumeration leak the admin module was fixed for.
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanPromotion(s scanner) (Promotion, error) {
	var (
		p  Promotion
		on *time.Time
		b  string
	)
	err := s.Scan(&p.ID, &b, &p.Stripes, &p.Degree, &on, &p.Academy, &p.Instructor, &p.Note,
		&p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Promotion{}, ErrNotFound
	}
	if err != nil {
		return Promotion{}, err
	}
	p.Belt = Belt(b)
	if on != nil {
		s := on.Format(dateLayout)
		p.PromotedOn = &s
	}
	return p, nil
}

func parseDate(in *string) (*time.Time, error) {
	if in == nil || *in == "" {
		return nil, nil
	}
	t, err := time.Parse(dateLayout, *in)
	if err != nil {
		return nil, ErrInvalidInput
	}
	return &t, nil
}
