package profile

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

const dateLayout = "2006-01-02"

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

func (r *PostgresRepository) Get(ctx context.Context, userID string) (*Profile, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT user_id, display_name, date_of_birth, sex, bjj_enabled, strength_enabled, nutrition_enabled, running_enabled, unit_system, track_effort, created_at, updated_at
		FROM profiles WHERE user_id = $1`, userID)
	return scanProfile(row)
}

func (r *PostgresRepository) Create(ctx context.Context, userID string, in NewProfile) (*Profile, error) {
	dob, err := parseDate(in.DateOfBirth)
	if err != nil {
		return nil, err
	}
	row := r.pool.QueryRow(ctx, `
		INSERT INTO profiles (user_id, display_name, date_of_birth, sex)
		VALUES ($1, $2, $3, $4)
		RETURNING user_id, display_name, date_of_birth, sex, bjj_enabled, strength_enabled, nutrition_enabled, running_enabled, unit_system, track_effort, created_at, updated_at
	`, userID, in.DisplayName, dob, in.Sex)
	p, err := scanProfile(row)
	if err != nil {
		return nil, translatePgError(err)
	}
	return p, nil
}

func (r *PostgresRepository) Update(ctx context.Context, userID string, in ProfileUpdate) (*Profile, error) {
	dob, err := parseDate(in.DateOfBirth)
	if err != nil {
		return nil, err
	}
	row := r.pool.QueryRow(ctx, `
		UPDATE profiles SET
			display_name = COALESCE($2, display_name),
			date_of_birth = COALESCE($3, date_of_birth),
			sex = COALESCE($4, sex),
			bjj_enabled = COALESCE($5, bjj_enabled),
			strength_enabled = COALESCE($6, strength_enabled),
			nutrition_enabled = COALESCE($7, nutrition_enabled),
			running_enabled = COALESCE($8, running_enabled),
			unit_system = COALESCE($9, unit_system),
			track_effort = COALESCE($10, track_effort),
			updated_at = now()
		WHERE user_id = $1
		RETURNING user_id, display_name, date_of_birth, sex, bjj_enabled, strength_enabled, nutrition_enabled, running_enabled, unit_system, track_effort, created_at, updated_at
	`, userID, in.DisplayName, dob, in.Sex, in.BJJEnabled, in.StrengthEnabled, in.NutritionEnabled, in.RunningEnabled, in.UnitSystem, in.TrackEffort)
	p, err := scanProfile(row)
	if err != nil {
		return nil, translatePgError(err)
	}
	return p, nil
}

func (r *PostgresRepository) ListExerciseUnits(
	ctx context.Context, userID string,
) (map[string]string, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT exercise_id, unit_system FROM exercise_unit_prefs WHERE user_id = $1`, userID)
	if err != nil {
		return nil, fmt.Errorf("profile: list exercise units: %w", err)
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var id, unit string
		if err := rows.Scan(&id, &unit); err != nil {
			return nil, fmt.Errorf("profile: scan exercise unit: %w", err)
		}
		out[id] = unit
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("profile: exercise unit rows: %w", err)
	}
	return out, nil
}

func (r *PostgresRepository) SetExerciseUnit(
	ctx context.Context, userID, exerciseID, unit string,
) error {
	if unit == "" {
		// Clearing an override is a delete, so "no row" stays the single
		// meaning of "use the profile default".
		_, err := r.pool.Exec(ctx,
			`DELETE FROM exercise_unit_prefs WHERE user_id = $1 AND exercise_id = $2`,
			userID, exerciseID)
		if err != nil {
			return fmt.Errorf("profile: clear exercise unit: %w", err)
		}
		return nil
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO exercise_unit_prefs (user_id, exercise_id, unit_system)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, exercise_id)
		DO UPDATE SET unit_system = excluded.unit_system, updated_at = now()`,
		userID, exerciseID, unit)
	if err != nil {
		// An unknown exercise is bad input, not an internal failure.
		return translatePgError(err)
	}
	return nil
}

func scanProfile(row pgx.Row) (*Profile, error) {
	var p Profile
	var dob *time.Time
	err := row.Scan(&p.UserID, &p.DisplayName, &dob, &p.Sex,
		&p.BJJEnabled, &p.StrengthEnabled, &p.NutritionEnabled, &p.RunningEnabled,
		&p.UnitSystem, &p.TrackEffort, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("profile: scan: %w", err)
	}
	p.DateOfBirth = formatDate(dob)
	return &p, nil
}

func parseDate(s *string) (*time.Time, error) {
	if s == nil {
		return nil, nil
	}
	t, err := time.Parse(dateLayout, *s)
	if err != nil {
		return nil, fmt.Errorf("%w: date_of_birth must be YYYY-MM-DD: %v", ErrInvalidInput, err)
	}
	return &t, nil
}

func formatDate(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(dateLayout)
	return &s
}

// translatePgError maps Postgres constraint violations to domain errors so
// handlers don't need to know about SQLSTATE codes.
func translatePgError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			return ErrAlreadyExists
		case "23514": // check_violation
			// Mapped by constraint name rather than echoing pgErr.Message:
			// Postgres includes the offending value and the constraint body
			// in that text, and it used to go straight to the client.
			switch {
			case strings.Contains(pgErr.ConstraintName, "unit_system"):
				return fmt.Errorf("%w: unit_system must be metric or imperial", ErrInvalidInput)
			case strings.Contains(pgErr.ConstraintName, "sex"):
				return fmt.Errorf("%w: sex must be male or female", ErrInvalidInput)
			}
			return fmt.Errorf("%w: a value is out of range", ErrInvalidInput)
		case "23503": // foreign_key_violation
			return fmt.Errorf("%w: unknown exercise", ErrInvalidInput)
		}
	}
	return err
}
