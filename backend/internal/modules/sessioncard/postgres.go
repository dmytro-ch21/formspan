package sessioncard

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/energy"
	"github.com/dmytro-ch21/vola/backend/internal/platform/score"
)

// ErrNotFound covers absent, not-yours and unfinished alike. Three answers
// would tell a caller which session ids are real, which is this codebase's
// signature bug and has been fixed three times already.
var ErrNotFound = errors.New("sessioncard: not found")

type PostgresRepository struct{ pool *pgxpool.Pool }

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

type sessionRow struct {
	// id is carried so the history query can EXCLUDE this session. Without it
	// the session ranks against itself: a guaranteed tie that drags every
	// percentile toward the middle, and worst for the athlete with the least
	// history, where one row of twenty is a whole 5 points.
	id      string
	sport   string
	minutes float64
	endedAt time.Time
}

func (r *PostgresRepository) Card(ctx context.Context, callerID, sessionID string) (Card, error) {
	s, err := r.session(ctx, callerID, sessionID)
	if err != nil {
		return Card{}, err
	}

	card := Card{Detail: []Detail{}}

	// Effort and the intensity blocks differ entirely by sport, so they are
	// gathered per sport rather than through one query with nullable halves.
	var effort float64
	var blocks []energy.Block
	if s.sport == "bjj" {
		var rounds, roundMinutes int
		effort, rounds, roundMinutes, err = r.matEffort(ctx, callerID, sessionID)
		if err != nil {
			return Card{}, err
		}
		blocks = energy.MatBlocks(s.minutes, rounds, roundMinutes)
		if card.Detail, card.More, err = r.techniques(ctx, callerID, sessionID); err != nil {
			return Card{}, err
		}
	} else {
		var sets int
		var loaded, heavy bool
		effort, sets, loaded, heavy, err = r.liftEffort(ctx, callerID, sessionID)
		if err != nil {
			return Card{}, err
		}
		blocks = energy.StrengthBlocks(s.minutes, sets, loaded, heavy)
		if card.Detail, card.More, err = r.exercises(ctx, callerID, sessionID); err != nil {
			return Card{}, err
		}
	}

	if c, err := r.calories(ctx, callerID, s.endedAt, blocks); err != nil {
		return Card{}, err
	} else {
		card.Calories = c
	}

	if sc, err := r.score(ctx, callerID, s, effort); err != nil {
		return Card{}, err
	} else {
		card.Score = sc
	}

	return card, nil
}

// session reads the one row everything else hangs off, and is where ownership
// is enforced for the whole request.
func (r *PostgresRepository) session(ctx context.Context, callerID, id string) (sessionRow, error) {
	var s sessionRow
	err := r.pool.QueryRow(ctx, `
		SELECT sport,
		       EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0,
		       ended_at
		FROM sessions
		WHERE id = $1 AND user_id = $2 AND ended_at IS NOT NULL`,
		id, callerID).Scan(&s.sport, &s.minutes, &s.endedAt)
	s.id = id
	if errors.Is(err, pgx.ErrNoRows) {
		return s, ErrNotFound
	}
	if err != nil {
		return s, fmt.Errorf("sessioncard: session: %w", err)
	}
	if s.minutes < 0 {
		// A session that ended before it started is corrupt data, not a
		// negative workout. Treat the duration as unknown rather than letting
		// it drive a negative calorie estimate.
		s.minutes = 0
	}
	return s, nil
}

// calories needs the athlete, not the session: the most recent bodyweight ON
// OR BEFORE the session, so a card opened months later prices the session at
// the weight it was actually performed at rather than today's.
func (r *PostgresRepository) calories(
	ctx context.Context, callerID string, endedAt time.Time, blocks []energy.Block,
) (*Calories, error) {
	var p energy.Profile
	// THE DAY IS COMPUTED IN GO, IN UTC, and handed over as a string — never
	// `$2::date` on the timestamp itself.
	//
	// That cast has two frames in it and neither is ours. pgx returns a
	// timestamptz in the Go process's LOCAL zone and sends it back without
	// qualifying it, and Postgres then resolves it in the SERVER's `TimeZone`.
	// Measured here: a session ending 18:38 local (01:38 UTC the next day) cast
	// to 2026-08-08 while the check-in sat on 2026-08-09, so the weight was
	// never found and the card silently dropped its calorie estimate. It failed
	// for the ~7 hours a day the two zones disagree and passed for the other
	// 17 — on a CI runner in UTC and a laptop in PDT it would differ by
	// machine, not by data.
	//
	// `measured_on` is a plain DATE the athlete recorded; there is no stored
	// timezone to be right about, so the only defensible choice is a fixed
	// frame. UTC is this app's frame everywhere else.
	day := endedAt.UTC().Format("2006-01-02")
	err := r.pool.QueryRow(ctx, `
		SELECT p.height_cm,
		       to_char(p.date_of_birth, 'YYYY-MM-DD'),
		       p.sex,
		       (SELECT c.weight_kg FROM body_checkins c
		         WHERE c.user_id = p.user_id
		           AND c.weight_kg IS NOT NULL
		           AND c.measured_on <= $2::date
		         ORDER BY c.measured_on DESC
		         LIMIT 1)
		FROM profiles p
		WHERE p.user_id = $1`,
		callerID, day).Scan(&p.HeightCM, &p.DateOfBirth, &p.Sex, &p.WeightKG)
	if errors.Is(err, pgx.ErrNoRows) {
		// No profile at all is a legitimate state — the estimate is simply
		// absent, exactly as it is with no bodyweight.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("sessioncard: profile: %w", err)
	}

	kcal, ok := energy.Estimate(p, blocks)
	if !ok {
		return nil, nil
	}
	return &Calories{
		Kcal:      energy.Round(kcal),
		Precision: string(energy.PrecisionOf(p)),
	}, nil
}

// liftEffort returns the session's mean WORKING-set effort plus what the
// energy model needs to pick a MET.
//
// Warmups are excluded deliberately: including them drags every score down in
// proportion to how carefully somebody warms up, which punishes the right
// behaviour.
//
// `completed AND set_type <> 'warmup'` is `session.Summarise`'s rule, and the
// only definition of "a working set" this codebase has. `set_type = 'working'`
// was used here first, which both counted sets that were never performed and
// silently dropped every back-off, drop, AMRAP and failure set — so the effort
// average ignored the hardest set of a session that ended on an AMRAP.
func (r *PostgresRepository) liftEffort(
	ctx context.Context, callerID, id string,
) (effort float64, sets int, loaded, heavy bool, err error) {
	// COALESCE(rpe, 10 - rir): the two are one quantity recorded two ways
	// (RPE 8 == 2 RIR), and a session logged entirely in RIR would otherwise
	// score as though effort were untracked.
	err = r.pool.QueryRow(ctx, `
		SELECT COALESCE(AVG(COALESCE(ss.rpe, 10 - ss.rir)), 0),
		       COUNT(*),
		       COALESCE(BOOL_OR(ss.weight_kg > 0), false),
		       COALESCE(MAX(ss.weight_kg) >= 100, false)
		FROM session_sets ss
		JOIN sessions s ON s.id = ss.session_id AND s.user_id = $2
		WHERE ss.session_id = $1 AND ss.completed AND ss.set_type <> 'warmup'`,
		id, callerID).Scan(&effort, &sets, &loaded, &heavy)
	if err != nil {
		return 0, 0, false, false, fmt.Errorf("sessioncard: lift effort: %w", err)
	}
	return effort, sets, loaded, heavy, nil
}

func (r *PostgresRepository) matEffort(
	ctx context.Context, callerID, id string,
) (effort float64, rounds, roundMinutes int, err error) {
	err = r.pool.QueryRow(ctx, `
		SELECT COALESCE(d.session_rpe, 0), COALESCE(d.rounds, 0), COALESCE(d.round_minutes, 0)
		FROM bjj_session_details d
		WHERE d.session_id = $1 AND d.user_id = $2`,
		id, callerID).Scan(&effort, &rounds, &roundMinutes)
	if errors.Is(err, pgx.ErrNoRows) {
		// A BJJ session with no detail row yet: no effort, no rounds. Not an
		// error — the card simply prices it as practice time.
		return 0, 0, 0, nil
	}
	if err != nil {
		return 0, 0, 0, fmt.Errorf("sessioncard: mat effort: %w", err)
	}
	return effort, rounds, roundMinutes, nil
}

func (r *PostgresRepository) exercises(ctx context.Context, callerID, id string) ([]Detail, int, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT e.name,
		       MAX(ss.weight_kg),
		       (ARRAY_AGG(ss.reps ORDER BY ss.weight_kg DESC NULLS LAST, ss.reps DESC))[1],
		       MIN(ss.position)
		FROM session_sets ss
		JOIN sessions s  ON s.id = ss.session_id AND s.user_id = $2
		JOIN exercises e ON e.id = ss.exercise_id
		WHERE ss.session_id = $1 AND ss.completed AND ss.set_type <> 'warmup'
		GROUP BY e.id, e.name
		ORDER BY MIN(ss.position)`,
		id, callerID)
	if err != nil {
		return nil, 0, fmt.Errorf("sessioncard: exercises: %w", err)
	}
	defer rows.Close()

	out := []Detail{}
	total := 0
	for rows.Next() {
		var name string
		var weight *float64
		var reps *int
		var pos int
		if err := rows.Scan(&name, &weight, &reps, &pos); err != nil {
			return nil, 0, fmt.Errorf("sessioncard: exercises scan: %w", err)
		}
		total++
		if len(out) >= MaxDetail {
			continue
		}
		d := Detail{Name: name}
		switch {
		case weight != nil && *weight > 0 && reps != nil:
			d.Figure = fmt.Sprintf("%g kg × %d", *weight, *reps)
		case reps != nil:
			// Bodyweight work has no load, and "0 kg × 12" reads as a bug.
			d.Figure = fmt.Sprintf("× %d", *reps)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("sessioncard: exercises rows: %w", err)
	}
	return out, max(0, total-len(out)), nil
}

func (r *PostgresRepository) techniques(ctx context.Context, callerID, id string) ([]Detail, int, error) {
	// Ordered by what the outcome MEANS rather than alphabetically: something
	// you scored with is the interesting line, and something you only drilled
	// is context. A card that led with drilling would bury the session.
	rows, err := r.pool.Query(ctx, `
		SELECT t.name,
		       g.event,
		       SUM(g.count)::int
		FROM bjj_session_tags g
		JOIN sessions s   ON s.id = g.session_id AND s.user_id = $2
		JOIN techniques t ON t.id = g.technique_id
		WHERE g.session_id = $1 AND g.technique_id IS NOT NULL
		GROUP BY t.id, t.name, g.event
		ORDER BY CASE g.event
		           WHEN 'scored'    THEN 0
		           WHEN 'conceded'  THEN 1
		           WHEN 'attempted' THEN 2
		           ELSE 3
		         END, SUM(g.count) DESC, t.name`,
		id, callerID)
	if err != nil {
		return nil, 0, fmt.Errorf("sessioncard: techniques: %w", err)
	}
	defer rows.Close()

	out := []Detail{}
	total := 0
	for rows.Next() {
		var name, event string
		var count int
		if err := rows.Scan(&name, &event, &count); err != nil {
			return nil, 0, fmt.Errorf("sessioncard: techniques scan: %w", err)
		}
		total++
		if len(out) >= MaxDetail {
			continue
		}
		d := Detail{Name: name, Outcome: event}
		if count > 1 {
			d.Count = count
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("sessioncard: techniques rows: %w", err)
	}
	return out, max(0, total-len(out)), nil
}

// score ranks this session's load against the caller's own recent history of
// the SAME sport.
//
// One windowed query, not one per session. The obvious shape — fetch the
// sessions, then compute each one's load — is the N+1 that would make this the
// slowest endpoint in the app, and it would get worse exactly as somebody
// trained more.
//
// # Effort and duration come back separately, and the basis is decided HERE
//
// The query used to fold the basis into SQL with a `CASE WHEN $4`, which meant
// a history session with no recorded effort — a BJJ session with no detail row,
// a strength session logged before effort tracking was switched on — arrived as
// load ZERO. Any real session beats a zero, so an athlete whose first
// effort-tracked session followed eight untracked ones scored ~100 "of your
// last 8". That is exactly the flattery this package exists not to do, and it
// hit hardest at the moment somebody first turned the setting on.
//
// So the rows carry effort and minutes, and this function decides:
//
//   - Effort basis needs MinHistory priors that ACTUALLY RECORDED effort. Rows
//     without it are not zeroes, they are silent, and are dropped rather than
//     counted.
//   - If too few remain, fall back to the VOLUME basis over the full window
//     rather than refusing — the package doc already promises that fallback for
//     an athlete who does not track effort, and "you tracked effort once" is the
//     same situation. `Basis` travels with the score, so the meaning is never
//     silently different.
//
// The window is the last twenty SESSIONS, then filtered — not the last twenty
// effort-tracked ones. Window is a recency claim ("roughly the last six
// weeks"), and reaching further back to fill it would rank this month against
// last year's fitness.
func (r *PostgresRepository) score(
	ctx context.Context, callerID string, s sessionRow, effort float64,
) (*Score, error) {
	basis := score.BasisEffort
	if effort <= 0 {
		// Effort tracking is off, or this sport did not record it. Fall back
		// to size, and say so — a number whose meaning changed silently is
		// worse than no number.
		basis = score.BasisVolume
	}

	var rows pgx.Rows
	var err error
	// ORDER BY ... , s.id — a TOTAL order. `ended_at` alone can tie, and the
	// feed documents why that is real rather than theoretical: a client
	// supplying its own `ended_at` on a sync retry. A tie at the LIMIT boundary
	// makes window membership nondeterministic, so the same card could score
	// differently on two consecutive opens.
	if s.sport == "bjj" {
		rows, err = r.pool.Query(ctx, `
			SELECT COALESCE(d.session_rpe, 0),
			       EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 60.0
			FROM sessions s
			LEFT JOIN bjj_session_details d ON d.session_id = s.id AND d.user_id = s.user_id
			WHERE s.user_id = $1 AND s.sport = 'bjj'
			  AND s.ended_at IS NOT NULL AND s.id <> $2
			ORDER BY s.ended_at DESC, s.id
			LIMIT $3`,
			callerID, s.id, score.Window)
	} else {
		rows, err = r.pool.Query(ctx, `
			SELECT COALESCE(e.rpe, 0),
			       EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 60.0
			FROM sessions s
			LEFT JOIN LATERAL (
				SELECT AVG(COALESCE(ss.rpe, 10 - ss.rir)) AS rpe
				FROM session_sets ss
				WHERE ss.session_id = s.id AND ss.completed AND ss.set_type <> 'warmup'
			) e ON true
			WHERE s.user_id = $1 AND s.sport <> 'bjj'
			  AND s.ended_at IS NOT NULL AND s.id <> $2
			ORDER BY s.ended_at DESC, s.id
			LIMIT $3`,
			callerID, s.id, score.Window)
	}
	if err != nil {
		return nil, fmt.Errorf("sessioncard: history: %w", err)
	}
	defer rows.Close()

	effortHistory := make([]float64, 0, score.Window)
	volumeHistory := make([]float64, 0, score.Window)
	for rows.Next() {
		var rpe, minutes float64
		if err := rows.Scan(&rpe, &minutes); err != nil {
			return nil, fmt.Errorf("sessioncard: history scan: %w", err)
		}
		if minutes < 0 {
			// A session that ended before it started, same as the card's own
			// guard. Unknown rather than negative.
			minutes = 0
		}
		volumeHistory = append(volumeHistory, score.Load(1, minutes))
		if rpe > 0 {
			effortHistory = append(effortHistory, score.Load(rpe, minutes))
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sessioncard: history rows: %w", err)
	}

	if basis == score.BasisEffort && len(effortHistory) < score.MinHistory {
		// Not enough priors recorded effort to rank against. Measure size
		// instead of cost, and say which happened.
		basis = score.BasisVolume
	}

	history := effortHistory
	load := score.Load(effort, s.minutes)
	if basis == score.BasisVolume {
		history = volumeHistory
		load = score.Load(1, s.minutes)
	}

	sc, ok := score.Of(load, history, basis)
	if !ok {
		return nil, nil
	}
	return &Score{Value: sc.Value, Basis: string(sc.Basis), Compared: sc.Compared}, nil
}
