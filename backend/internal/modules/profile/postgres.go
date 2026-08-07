package profile

import (
	"context"
	"errors"
	"fmt"
	"sort"
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
		SELECT user_id, username, display_name, date_of_birth, sex, unit_system, track_effort, created_at, updated_at
		FROM profiles WHERE user_id = $1`, userID)
	return scanProfile(row)
}

func (r *PostgresRepository) GetByUsername(ctx context.Context, username string) (*PublicProfile, error) {
	// lower(username) = $1 is not defensive fluff: it is the exact expression
	// the unique index from 000040 is built on, so this lookup is an index
	// scan rather than a table walk. Only public-card columns are selected —
	// the row's private fields never enter this code path at all.
	var p PublicProfile
	err := r.pool.QueryRow(ctx, `
		SELECT username, display_name FROM profiles
		WHERE lower(username) = lower($1)`, username).Scan(&p.Username, &p.DisplayName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, translatePgError(err)
	}
	return &p, nil
}

func (r *PostgresRepository) Create(ctx context.Context, userID string, in NewProfile) (*Profile, error) {
	dob, err := parseDate(in.DateOfBirth)
	if err != nil {
		return nil, err
	}
	row := r.pool.QueryRow(ctx, `
		INSERT INTO profiles (user_id, display_name, date_of_birth, sex)
		VALUES ($1, $2, $3, $4)
		RETURNING user_id, username, display_name, date_of_birth, sex, unit_system, track_effort, created_at, updated_at
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
			username = COALESCE($2, username),
			display_name = COALESCE($3, display_name),
			date_of_birth = COALESCE($4, date_of_birth),
			sex = COALESCE($5, sex),
			unit_system = COALESCE($6, unit_system),
			track_effort = COALESCE($7, track_effort),
			updated_at = now()
		WHERE user_id = $1
		RETURNING user_id, username, display_name, date_of_birth, sex, unit_system, track_effort, created_at, updated_at
	`, userID, in.Username, in.DisplayName, dob, in.Sex, in.UnitSystem, in.TrackEffort)
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
	err := row.Scan(&p.UserID, &p.Username, &p.DisplayName, &dob, &p.Sex,
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
			// Two different facts share this SQLSTATE on one table: the
			// primary key (a profile already exists — only reachable from
			// Create) and the username index (the handle belongs to someone
			// else — only reachable from Update). Discriminated by constraint
			// name, same as the 23514 branch below and for the same reason:
			// the two need different sentences on the client.
			if strings.Contains(pgErr.ConstraintName, "username") {
				return ErrUsernameTaken
			}
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
			// Named by constraint, because this table isn't the only one with
			// an FK any more. Toggling modules for a user who hasn't
			// onboarded reported "unknown exercise" — a message written for
			// exercise_unit_prefs, nonsensical here, and reachable by any
			// signed-in user who never completed onboarding.
			if strings.Contains(pgErr.ConstraintName, "profile_modules") {
				return fmt.Errorf("%w: no profile yet — create one before setting modules", ErrInvalidInput)
			}
			return fmt.Errorf("%w: unknown exercise", ErrInvalidInput)
		}
	}
	return err
}

// ListModules returns only what this user has explicitly stored.
//
// Deliberately does NOT fill in defaults: the default belongs to the registry
// (internal/platform/discipline), and a repository that invented them would be
// a second place to change when one moves.
func (r *PostgresRepository) ListModules(ctx context.Context, userID string) (map[string]bool, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT module_key, enabled FROM profile_modules WHERE user_id = $1`, userID)
	if err != nil {
		return nil, fmt.Errorf("profile: list modules: %w", err)
	}
	defer rows.Close()

	out := map[string]bool{}
	for rows.Next() {
		var key string
		var enabled bool
		if err := rows.Scan(&key, &enabled); err != nil {
			return nil, fmt.Errorf("profile: scan module: %w", err)
		}
		out[key] = enabled
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("profile: iterate modules: %w", err)
	}
	return out, nil
}

// SetModules upserts the given keys, leaving unmentioned ones untouched so a
// client can send one toggle rather than the whole set.
//
// One batch, so a multi-key PATCH is atomic: pgx sends it inside an implicit
// transaction, and a failure part-way leaves none of it applied rather than
// half a user's preferences.
func (r *PostgresRepository) SetModules(ctx context.Context, userID string, enabled map[string]bool) error {
	if len(enabled) == 0 {
		return nil
	}
	// Sorted, so the batch locks rows in a consistent order. Go randomises map
	// iteration, and two concurrent multi-key PATCHes for the same user could
	// otherwise take the same locks in opposite orders and deadlock (40P01,
	// which surfaces as a 500). Cheap to prevent, tedious to diagnose.
	keys := make([]string, 0, len(enabled))
	for key := range enabled {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	batch := &pgx.Batch{}
	for _, key := range keys {
		on := enabled[key]
		batch.Queue(`
			INSERT INTO profile_modules (user_id, module_key, enabled)
			VALUES ($1, $2, $3)
			ON CONFLICT (user_id, module_key)
			DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
			WHERE profile_modules.enabled IS DISTINCT FROM EXCLUDED.enabled`,
			userID, key, on)
	}
	br := r.pool.SendBatch(ctx, batch)
	defer br.Close()
	for range enabled {
		if _, err := br.Exec(); err != nil {
			// The FK to profiles is the only constraint here: toggling modules
			// for a user with no profile row is the real error worth naming.
			return translatePgError(fmt.Errorf("profile: set modules: %w", err))
		}
	}
	return nil
}
