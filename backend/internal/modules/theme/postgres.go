package theme

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// maxRangeDays bounds a single List, mirroring `plan.maxRangeDays`.
//
// Requiring `from` and `to` bounds the CALENDAR, not the response: nothing
// stops `from=0001-01-01&to=9999-12-27`, and `api-conventions.md` is explicit
// that a list endpoint without a cap silently unbounds the ETag buffer.
//
// Unlike plans, no second row cap is needed. A week holds at most one theme by
// primary key, so bounding the span bounds the response exactly — at most
// span/7 + 1 rows. That is the whole benefit of the one-per-week model showing
// up somewhere unexpected.
const maxRangeDays = 800

type PostgresRepository struct{ pool *pgxpool.Pool }

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// translate turns a constraint violation into a domain error.
//
// Never let a raw SQL error escape: the handler surfaces ErrInvalidInput's text
// to the client, and Postgres messages name constraints and columns.
func translate(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	// Class 22 is data exception — datetime field overflow (22008) is the one
	// that reaches here, because Go's time.Parse happily accepts "0000-01-03"
	// and calls it a Monday while Postgres has no year zero. Caller input, so a
	// 400 rather than a 500.
	if strings.HasPrefix(pgErr.Code, "22") {
		return fmt.Errorf("%w: that is not a date this can store", ErrInvalidInput)
	}
	if pgErr.Code == "23514" { // check_violation
		switch pgErr.ConstraintName {
		case "training_themes_week_starts_monday":
			return fmt.Errorf("%w: a week must start on a Monday", ErrInvalidInput)
		case "training_themes_title_present":
			return fmt.Errorf("%w: title is required", ErrInvalidInput)
		case "training_themes_title_len":
			return fmt.Errorf("%w: title is too long", ErrInvalidInput)
		case "training_themes_notes_len":
			return fmt.Errorf("%w: notes are too long", ErrInvalidInput)
		}
		return fmt.Errorf("%w: a value is out of range", ErrInvalidInput)
	}
	return err
}

// `to_char` rather than `week_start::text`, matching `plan/postgres.go`.
//
// Both avoid the real trap — scanning a DATE into `time.Time` and formatting
// server-side, which lands a day early west of Greenwich. But `::text` follows
// the session's `DateStyle`, which nothing in this stack pins; `to_char` is
// deterministic whatever the connection was handed.
const columns = `to_char(week_start, 'YYYY-MM-DD'), title, notes, created_at, updated_at`

func scan(row pgx.Row) (*Theme, error) {
	var t Theme
	if err := row.Scan(&t.WeekStart, &t.Title, &t.Notes, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	return &t, nil
}

func (r *PostgresRepository) List(ctx context.Context, userID, from, to string) ([]Theme, error) {
	fromT, err1 := time.Parse("2006-01-02", from)
	toT, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil {
		return nil, fmt.Errorf("%w: from and to must be YYYY-MM-DD", ErrInvalidInput)
	}
	if toT.Sub(fromT).Hours()/24 > maxRangeDays {
		return nil, fmt.Errorf("%w: that range is too wide", ErrInvalidInput)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+columns+`
		FROM training_themes
		WHERE user_id = $1 AND week_start BETWEEN $2::date AND $3::date
		ORDER BY week_start`, userID, from, to)
	if err != nil {
		return nil, fmt.Errorf("theme: list: %w", translate(err))
	}
	defer rows.Close()

	// Non-nil so the handler serialises `[]` rather than `null` — a client
	// mapping over the result should not have to defend against a missing week.
	out := []Theme{}
	for rows.Next() {
		t, err := scan(rows)
		if err != nil {
			return nil, fmt.Errorf("theme: scan: %w", err)
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) Get(ctx context.Context, userID, weekStart string) (*Theme, error) {
	t, err := scan(r.pool.QueryRow(ctx, `
		SELECT `+columns+` FROM training_themes
		WHERE user_id = $1 AND week_start = $2::date`, userID, weekStart))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("theme: get: %w", translate(err))
	}
	return t, nil
}

// Set creates or replaces a week's theme.
//
// One statement rather than a read-then-write: a week holds at most one theme,
// so "set" is the whole verb and an upsert says exactly that. `created_at` is
// deliberately not touched on conflict — when the week was first given a theme
// stays true even after the wording changes.
func (r *PostgresRepository) Set(ctx context.Context, userID, weekStart string, in Input) (*Theme, error) {
	t, err := scan(r.pool.QueryRow(ctx, `
		INSERT INTO training_themes (user_id, week_start, title, notes)
		VALUES ($1, $2::date, $3, $4)
		ON CONFLICT (user_id, week_start) DO UPDATE SET
			title      = excluded.title,
			notes      = excluded.notes,
			updated_at = now()
		RETURNING `+columns, userID, weekStart, in.Title, in.Notes))
	if err != nil {
		return nil, fmt.Errorf("theme: set: %w", translate(err))
	}
	return t, nil
}

func (r *PostgresRepository) Delete(ctx context.Context, userID, weekStart string) error {
	tag, err := r.pool.Exec(ctx, `
		DELETE FROM training_themes WHERE user_id = $1 AND week_start = $2::date`,
		userID, weekStart)
	if err != nil {
		return fmt.Errorf("theme: delete: %w", translate(err))
	}
	if tag.RowsAffected() == 0 {
		// Absent is not success. A client that asked to remove something which
		// was never there should learn that, not be told it worked.
		return ErrNotFound
	}
	return nil
}
