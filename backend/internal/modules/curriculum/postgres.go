package curriculum

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// dateLayout matches Focus.StartedOn and Promotion.PromotedOn: a DATE column
// rendered as a full RFC3339 instant shows as the PREVIOUS DAY for anyone west
// of UTC once a client localises midnight.
const dateLayout = "2006-01-02"

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// visibleTo is the authorization predicate, written once.
//
// A curriculum is readable when it is public or the caller owns it. This is
// duplicated into no query — every read composes this string — because the
// same rule expressed twice is the shape that produced a cross-user
// enumeration bug in two other modules here, each time by one query being
// updated and the other not.
const visibleTo = `(c.visibility = 'public' OR c.owner_user_id = $1)`

func (r *PostgresRepository) List(ctx context.Context, userID string) ([]Curriculum, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT c.id, c.owner_user_id, c.name, c.description, c.belt, c.track, c.visibility,
		       c.created_at, c.updated_at,
		       e.user_id IS NOT NULL AS enrolled, e.started_on,
		       n.items, n.countable
		FROM curricula c
		-- Item counts, so a list card can tell a roadmap from a reading list.
		--
		-- It could not before, and the client built on that gap shipped a
		-- screen calling every roadmap "a reading list" -- the exact property
		-- it existed to convey, inverted, on every card.
		--
		-- Two COUNTs and no evidence: cheap enough for a 200-row list. MASTERY
		-- IS DELIBERATELY NOT HERE, because it is not cheap -- it needs the
		-- per-curriculum aggregate over bjj_session_tags that items() runs, and
		-- doing that 200 times to draw progress bars on a list nobody reads
		-- numbers off is the wrong trade. The list says what a curriculum IS;
		-- the detail says how far along you are.
		LEFT JOIN LATERAL (
		    SELECT count(*) AS items,
		           count(*) FILTER (
		               WHERE i.target_scored IS NOT NULL
		                  OR i.target_defended IS NOT NULL
		                  OR i.target_drilled_sessions IS NOT NULL
		           ) AS countable
		    FROM curriculum_items i WHERE i.curriculum_id = c.id
		) n ON true
		-- LEFT, and joined on the caller: enrollment decorates the row rather
		-- than filtering it, because this list is "what could I work on" and
		-- must include the ones they have not taken on yet.
		LEFT JOIN curriculum_enrollments e
		       ON e.curriculum_id = c.id AND e.user_id = $1 AND e.archived_on IS NULL
		WHERE `+visibleTo+`
		-- OWN ROWS FIRST, then enrolled, then belt, then name. The ordering is
		-- not cosmetic under the cap below: this list spans every user's public
		-- curricula, so leading with `+"`enrolled`"+` alone would let strangers'
		-- syllabuses evict the caller's own private ones from a truncated
		-- response. api-conventions.md requires the caller's own rows sort
		-- first for exactly this reason.
		--
		-- `+"`c.id`"+` makes the order TOTAL. Without it two equally-named rows can
		-- swap between requests, which flaps the ETag body hash for no reason.
		--
		-- Belt is a text column with no ordering of its own, so this is
		-- alphabetical within it rather than white-to-black; sorting by rank
		-- belongs to the client, which knows the athlete's own belt.
		ORDER BY (c.owner_user_id = $1) DESC, enrolled DESC, c.belt NULLS LAST, c.name, c.id
		LIMIT $2`, userID, maxList)
	if err != nil {
		return nil, fmt.Errorf("curriculum: list: %w", err)
	}
	defer rows.Close()

	// Non-nil so this marshals to [] rather than null.
	out := []Curriculum{}
	for rows.Next() {
		c, _, err := scanCurriculum(rows, userID)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

func scanCurriculum(rows pgx.Rows, userID string) (*Curriculum, *time.Time, error) {
	var (
		c         Curriculum
		startedOn *time.Time
	)
	if err := rows.Scan(
		&c.ID, &c.OwnerUserID, &c.Name, &c.Description, &c.Belt, &c.Track, &c.Visibility,
		&c.CreatedAt, &c.UpdatedAt, &c.Enrolled, &startedOn,
		&c.ItemCount, &c.CountableItems,
	); err != nil {
		return nil, nil, fmt.Errorf("curriculum: scan: %w", err)
	}
	// Resolved server-side rather than sent as an owner id for the client to
	// compare — a client that decides editability by comparing user ids is
	// one refactor away from being the authorization.
	c.Editable = c.OwnerUserID != nil && *c.OwnerUserID == userID
	if startedOn != nil {
		s := startedOn.Format(dateLayout)
		c.StartedOn = &s
	}
	return &c, startedOn, nil
}

func (r *PostgresRepository) Working(ctx context.Context, userID, tz string) ([]Curriculum, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT c.id, c.owner_user_id, c.name, c.description, c.belt, c.track, c.visibility,
		       c.created_at, c.updated_at,
		       true AS enrolled, e.started_on,
		       -- Filled from the items below, like Get: counting criteria in SQL
		       -- as well would put the rule in two places for one number.
		       0, 0
		FROM curriculum_enrollments e
		JOIN curricula c ON c.id = e.curriculum_id
		-- INNER on the enrollment, so this is "mine" by construction rather than
		-- by a filter someone could later drop. visibleTo is still composed in:
		-- a curriculum can be published, enrolled in, and then made private, and
		-- the athlete should stop seeing it rather than keep a copy.
		WHERE e.user_id = $1 AND e.archived_on IS NULL AND `+visibleTo+`
		ORDER BY e.started_on DESC, c.id
		-- Bounded like every other list here. Nobody works twenty syllabuses at
		-- once, but "nobody would" is not a limit.
		LIMIT 20`, userID)
	if err != nil {
		return nil, fmt.Errorf("curriculum: working: %w", err)
	}
	defer rows.Close()

	type pending struct {
		c       Curriculum
		started *time.Time
	}
	var found []pending
	for rows.Next() {
		c, started, err := scanCurriculum(rows, userID)
		if err != nil {
			return nil, err
		}
		found = append(found, pending{c: *c, started: started})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("curriculum: working: %w", err)
	}
	// Closed before the per-curriculum reads below: pgx holds the connection
	// for the lifetime of a Rows, and querying inside the loop would take a
	// second one from the pool while this one is still open -- the same nested
	// acquire that could stall the API from Update.
	rows.Close()

	out := make([]Curriculum, 0, len(found))
	for _, p := range found {
		phases, err := r.phases(ctx, p.c.ID)
		if err != nil {
			return nil, err
		}
		p.c.Phases = phases
		items, err := r.items(ctx, userID, p.c.ID, p.started, tz)
		if err != nil {
			return nil, err
		}
		p.c.Items = items
		p.c.ItemCount = len(items)
		for _, it := range items {
			if it.Countable() {
				p.c.CountableItems++
				if it.Mastered() {
					p.c.MasteredItems++
				}
			}
		}
		out = append(out, p.c)
	}
	return out, nil
}

func (r *PostgresRepository) Get(ctx context.Context, userID, id, tz string) (*Curriculum, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT c.id, c.owner_user_id, c.name, c.description, c.belt, c.track, c.visibility,
		       c.created_at, c.updated_at,
		       e.user_id IS NOT NULL AS enrolled, e.started_on,
		       -- Placeholders, filled below from the items this read fetches
		       -- anyway. Counting them in SQL here would put the criteria rule
		       -- in two places -- a WHERE clause and Countable() -- for one
		       -- number, which is how the two drift apart.
		       0, 0
		FROM curricula c
		LEFT JOIN curriculum_enrollments e
		       ON e.curriculum_id = c.id AND e.user_id = $1 AND e.archived_on IS NULL
		WHERE c.id = $2 AND `+visibleTo, userID, id)
	if err != nil {
		return nil, fmt.Errorf("curriculum: get: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("curriculum: get: %w", err)
		}
		// ErrNotFound, never ErrForbidden. A private curriculum the caller does
		// not own must be indistinguishable from one that does not exist, or
		// the 403 itself confirms it is there.
		return nil, ErrNotFound
	}
	c, started, err := scanCurriculum(rows, userID)
	if err != nil {
		return nil, err
	}
	rows.Close()

	phases, err := r.phases(ctx, id)
	if err != nil {
		return nil, err
	}
	c.Phases = phases

	// `started` is nil when the caller is not enrolled, which is what makes
	// items() return criteria with no progress: browsing a syllabus shows what
	// it asks of you, working one shows how far along you are.
	items, err := r.items(ctx, userID, id, started, tz)
	if err != nil {
		return nil, err
	}
	c.Items = items
	c.ItemCount = len(items)
	// Recomputed rather than trusted from the list query above: this read is
	// the one that also knows mastery, and having two sources for the same
	// number is how they drift. The progress rule lives in Countable() and
	// Mastered(), which are its single definition.
	c.CountableItems = 0
	for _, it := range items {
		if it.Countable() {
			c.CountableItems++
			if it.Mastered() {
				c.MasteredItems++
			}
		}
	}
	return c, nil
}

// phases reads a curriculum's phase list. No authorization predicate of its
// own: every caller has already resolved the curriculum through visibleTo, and
// a phase without its curriculum is unreachable.
func (r *PostgresRepository) phases(ctx context.Context, id string) ([]Phase, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT sort_order, title, description
		FROM curriculum_phases WHERE curriculum_id = $1
		ORDER BY sort_order`, id)
	if err != nil {
		return nil, fmt.Errorf("curriculum: phases: %w", err)
	}
	defer rows.Close()

	var out []Phase
	for rows.Next() {
		var p Phase
		if err := rows.Scan(&p.Order, &p.Title, &p.Description); err != nil {
			return nil, fmt.Errorf("curriculum: scan phase: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// items reads the list and, in the same round trip, the caller's evidence
// against every criterion on it.
//
// ONE QUERY, not one per item. A syllabus is a dozen techniques and a per-item
// aggregate would be a dozen scans of bjj_session_tags for one screen.
func (r *PostgresRepository) items(ctx context.Context, userID, id string, since *time.Time, tz string) ([]Item, error) {
	rows, err := r.pool.Query(ctx, `
		WITH ev AS (
			-- The caller's evidence, per technique, SINCE THEY ENROLLED.
			--
			-- The window is the whole point and not a refinement. Over all time
			-- the hit rate includes the months during which the athlete could
			-- not do the technique, so it measures the learning phase it exists
			-- to exclude -- and a belt syllabus is mostly techniques they have
			-- been failing at. $3 is curriculum_enrollments.started_on.
			--
			-- SUM(count), not COUNT(*): 000025 stores "hit three armbars" as
			-- ONE row with count = 3, so counting rows under-reports every
			-- athlete who logs the natural way.
			--
			-- Scoped to the caller in the WHERE. This is the clause that stops
			-- one athlete's progress being computed from another's evidence.
			SELECT t.technique_id,
			       COALESCE(SUM(t.count) FILTER (WHERE t.event = 'scored'), 0)   AS scored,
			       COALESCE(SUM(t.count) FILTER (WHERE t.event = 'defended'), 0) AS defended,
			       -- Sound only because 000025 keeps the two DISJOINT:
			       -- attempted is "tried it live, it didn't land", so adding
			       -- them is a total rather than a double count.
			       COALESCE(SUM(t.count) FILTER (WHERE t.event IN ('attempted', 'scored')), 0) AS attempts,
			       -- DISTINCT sessions, and LIVE ones only. drilled is
			       -- practice; letting it count here would let a technique
			       -- clear its spread requirement without ever being used on
			       -- somebody who was resisting.
			       COUNT(DISTINCT t.session_id)
			           FILTER (WHERE t.event IN ('attempted', 'scored', 'defended')) AS sessions,
			       -- The drilled spread, counted separately and read ONLY by
			       -- target_drilled_sessions — the one criterion that is
			       -- explicitly about practice. Sessions again, not volume:
			       -- forty reps in one class is one class.
			       COUNT(DISTINCT t.session_id)
			           FILTER (WHERE t.event = 'drilled') AS drilled_sessions
			FROM bjj_session_tags t
			JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
			WHERE t.user_id = $1
			  AND t.technique_id IS NOT NULL
			  -- Narrowed to THIS curriculum's techniques, which is the
			  -- difference between scaling with the roadmap and scaling with
			  -- the athlete's whole career. Unrestricted it seq-scanned every
			  -- tag ever logged and discarded all but a dozen groups: measured
			  -- 22ms against 24k tags, 1.4ms with this line, because it lets
			  -- bjj_session_tags_user_technique_idx do the work.
			  AND t.technique_id IN (
			      SELECT ci.technique_id FROM curriculum_items ci WHERE ci.curriculum_id = $2
			  )
			  -- The session's own start, not the tag's created_at: a class
			  -- logged late still happened when it happened.
			  --
			  -- Compared as LOCAL DATES on both sides. Against a bare
			  -- timestamptz the boundary was UTC midnight, so a class trained
			  -- on the evening of the enrollment day fell outside a window that
			  -- was supposed to start that morning.
			  AND ($3::date IS NULL
			       OR (s.started_at AT TIME ZONE $4)::date >= $3::date)
			GROUP BY t.technique_id
		)
		SELECT i.kind, i.technique_id, i.title,
		       COALESCE(lib.name, ''), COALESCE(lib.position, ''), COALESCE(lib.category, ''),
		       i.sort_order, i.phase_order, i.notes,
		       i.target_scored, i.target_defended, i.target_sessions, i.min_hit_rate,
		       i.target_drilled_sessions,
		       COALESCE(ev.scored, 0), COALESCE(ev.defended, 0),
		       COALESCE(ev.attempts, 0), COALESCE(ev.sessions, 0),
		       COALESCE(ev.drilled_sessions, 0)
		FROM curriculum_items i
		-- LEFT, for the CONCEPT rows only — their technique_id is NULL by
		-- constraint. For technique rows the join still cannot miss: the FK is
		-- ON DELETE CASCADE, so an item whose technique is gone cannot exist,
		-- and the COALESCEs above only ever fire for concepts.
		LEFT JOIN techniques lib ON lib.id = i.technique_id
		LEFT JOIN ev ON ev.technique_id = i.technique_id
		WHERE i.curriculum_id = $2
		ORDER BY i.sort_order`, userID, id, since, zone(tz))
	if err != nil {
		return nil, fmt.Errorf("curriculum: items: %w", err)
	}
	defer rows.Close()

	out := []Item{}
	for rows.Next() {
		var (
			it          Item
			techniqueID *string
			scored      int
			defended    int
			attempts    int
			sessions    int
			drilled     int
			tScored     *int
			tDef        *int
			tSess       *int
			minRate     *float64
			tDrilled    *int
		)
		if err := rows.Scan(
			&it.Kind, &techniqueID, &it.Title,
			&it.Name, &it.Position, &it.Category,
			&it.Order, &it.Phase, &it.Notes,
			&tScored, &tDef, &tSess, &minRate, &tDrilled,
			&scored, &defended, &attempts, &sessions, &drilled,
		); err != nil {
			return nil, fmt.Errorf("curriculum: scan item: %w", err)
		}
		if techniqueID != nil {
			it.TechniqueID = *techniqueID
		}
		if tScored != nil || tDef != nil || tDrilled != nil {
			it.Criteria = &Criteria{
				TargetScored:          tScored,
				TargetDefended:        tDef,
				TargetSessions:        tSess,
				MinHitRate:            minRate,
				TargetDrilledSessions: tDrilled,
			}
			// Progress only where the caller is actually working this — an
			// un-enrolled reader is browsing, and there is no window to
			// measure them over.
			if since != nil {
				p := Progress{Scored: scored, Defended: defended, Attempts: attempts, Sessions: sessions, DrilledSessions: drilled}
				if attempts > 0 {
					// Guarded here rather than with NULLIF in SQL: zero from
					// zero is not a rate, and rendering it as 0% would report a
					// failure the athlete has not had.
					rate := float64(scored) / float64(attempts)
					p.HitRate = &rate
				}
				p.Mastered = p.Met(*it.Criteria)
				it.Progress = &p
			}
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) Create(ctx context.Context, userID, tz string, in NewCurriculum) (*Curriculum, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("curriculum: begin create: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Defaulted here as well as in the handler. Private is the safe answer, and
	// a repository that turns an unset field into a constraint violation makes
	// every non-HTTP caller -- tests, a future seeder -- carry knowledge the
	// handler already has.
	if in.Visibility == "" {
		in.Visibility = "private"
	}

	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO curricula (owner_user_id, source, name, description, belt, track, visibility)
		-- source is always 'user' here. The seed and the admin console are the
		-- only writers of the other two, and curricula_source_matches_owner
		-- refuses an owned row that claims either.
		VALUES ($1, 'user', $2, $3, $4, $5, $6)
		RETURNING id`,
		userID, in.Name, in.Description, in.Belt, in.Track, in.Visibility).Scan(&id)
	if err != nil {
		return nil, translate(err, "create")
	}
	if err := replaceContent(ctx, tx, id, in.Phases, in.Items); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("curriculum: commit create: %w", err)
	}
	return r.Get(ctx, userID, id, tz)
}

func (r *PostgresRepository) Update(ctx context.Context, userID, id, tz string, in Update) (*Curriculum, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("curriculum: begin update: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// owner_user_id = $2 in the WHERE, not a read-then-check. A separate
	// ownership read is a race: two requests can both pass the check before
	// either writes. This makes the database enforce it in one statement, and
	// zero rows affected is the answer to both "gone" and "not yours".
	//
	// COALESCE per column so nil means "leave it alone" without building the
	// SQL string dynamically.
	tag, err := tx.Exec(ctx, `
		UPDATE curricula SET
			name        = COALESCE($3, name),
			description = COALESCE($4, description),
			belt        = CASE WHEN $5::boolean THEN $6 ELSE belt END,
			track       = CASE WHEN $7::boolean THEN $8 ELSE track END,
			visibility  = COALESCE($9, visibility),
			updated_at  = now()
		WHERE id = $1 AND owner_user_id = $2`,
		id, userID, in.Name, in.Description, in.SetBelt, in.Belt, in.SetTrack, in.Track, in.Visibility)
	if err != nil {
		return nil, translate(err, "update")
	}
	if tag.RowsAffected() == 0 {
		// On `tx`, not the pool -- see querier. Distinguished here and collapsed
		// again at the handler for reads: knowing which it was matters for the
		// write path, and "you may not edit the VOLA syllabus you are looking
		// at" leaks nothing, because the caller can already see the row.
		return nil, r.absentOrForbidden(ctx, tx, userID, id)
	}
	if in.Items != nil {
		if err := replaceContent(ctx, tx, id, in.Phases, in.Items); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("curriculum: commit update: %w", err)
	}
	return r.Get(ctx, userID, id, tz)
}

// querier is whatever can run a statement -- the pool, or a transaction that is
// already holding a connection.
//
// This exists because of a real stall, not for tidiness. absentOrForbidden used
// to take the pool while Update's transaction still held a connection, so N
// concurrent PATCHes at a missing id each held one and each waited for another
// to release. pgxpool has no acquire timeout and the server has no write
// timeout, so it unwound only when clients gave up -- and the pool is shared
// with every other endpoint, so any authenticated user could stall the whole
// API by patching an id that does not exist. workout.requireOwner already
// threads the transaction through for the same reason.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// absentOrForbidden decides which error a zero-row write deserves.
//
// Only ever called after a write has already failed to match, so the extra read
// costs nothing on the happy path.
func (r *PostgresRepository) absentOrForbidden(ctx context.Context, q querier, userID, id string) error {
	var visible bool
	err := q.QueryRow(ctx, `
		SELECT true FROM curricula c WHERE c.id = $2 AND `+visibleTo, userID, id).Scan(&visible)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("curriculum: ownership check: %w", err)
	}
	// They can see it but the write did not match, so it is somebody else's or
	// VOLA's.
	return ErrForbidden
}

func (r *PostgresRepository) Delete(ctx context.Context, userID, id string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("curriculum: begin delete: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The owner's OWN enrollment goes first.
	//
	// Without this, building a roadmap and then working it made it permanently
	// undeletable: the RESTRICT below counts every enrollment including your
	// own, so the API refused with "other athletes are working this" when
	// nobody else was. Create -> start -> change your mind is the ordinary
	// flow, and the error was not just unhelpful but false.
	//
	// Scoped to the caller, so this cannot be used to clear anyone else's.
	if _, err := tx.Exec(ctx, `
		DELETE FROM curriculum_enrollments WHERE curriculum_id = $1 AND user_id = $2`,
		id, userID); err != nil {
		return fmt.Errorf("curriculum: drop own enrollment: %w", err)
	}

	tag, err := tx.Exec(ctx, `DELETE FROM curricula WHERE id = $1 AND owner_user_id = $2`, id, userID)
	if err != nil {
		// curriculum_enrollments references this ON DELETE RESTRICT, so a
		// curriculum OTHER people are working refuses to go -- their enrollment
		// is their record, not the publisher's. The rollback above puts the
		// caller's own enrollment back, so a refused delete changes nothing.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return ErrInUse
		}
		return fmt.Errorf("curriculum: delete: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return r.absentOrForbidden(ctx, tx, userID, id)
	}
	return tx.Commit(ctx)
}

// replaceContent rewrites the phases and items wholesale, as one unit.
//
// Delete-then-insert rather than a diff, matching SetFocus and every other
// client-owned list here: the client holds the desired state and re-sends it,
// so a retry after a partial failure converges instead of duplicating. Order
// is assigned from slice order — for phases and items both — so it is always
// dense and always matches what the client sent.
//
// Items go before phases on the way out and after them on the way in, because
// the composite FK points from item to phase.
func replaceContent(ctx context.Context, tx pgx.Tx, id string, phases []NewPhase, items []NewItem) error {
	if _, err := tx.Exec(ctx, `DELETE FROM curriculum_items WHERE curriculum_id = $1`, id); err != nil {
		return fmt.Errorf("curriculum: clear items: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM curriculum_phases WHERE curriculum_id = $1`, id); err != nil {
		return fmt.Errorf("curriculum: clear phases: %w", err)
	}
	if len(phases) == 0 && len(items) == 0 {
		return nil
	}
	// One batch rather than up to 170 sequential round trips, matching
	// workout.insertItems.
	batch := &pgx.Batch{}
	for i, p := range phases {
		batch.Queue(`
			INSERT INTO curriculum_phases (curriculum_id, sort_order, title, description)
			VALUES ($1, $2, $3, $4)`,
			id, i, p.Title, p.Description)
	}
	for i, it := range items {
		var (
			tScored  *int
			tDef     *int
			tSess    *int
			minRate  *float64
			tDrilled *int
		)
		if it.Criteria != nil {
			tScored = it.Criteria.TargetScored
			tDef, tSess, minRate = it.Criteria.TargetDefended, it.Criteria.TargetSessions, it.Criteria.MinHitRate
			tDrilled = it.Criteria.TargetDrilledSessions
		}
		// The kind default lives here as well as in validation: an empty kind
		// is a technique, which is what every client predating kinds sends.
		kind := it.Kind
		if kind == "" {
			kind = "technique"
		}
		// NULL, not '', for a concept's technique column — the CHECK requires
		// it, and an empty-string FK target would be a miss anyway.
		var techniqueID *string
		if it.TechniqueID != "" {
			t := it.TechniqueID
			techniqueID = &t
		}
		batch.Queue(`
			INSERT INTO curriculum_items
				(curriculum_id, kind, technique_id, title, sort_order, phase_order, notes,
				 target_scored, target_defended, target_sessions, min_hit_rate,
				 target_drilled_sessions)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			id, kind, techniqueID, it.Title, i, it.Phase, it.Notes,
			tScored, tDef, tSess, minRate, tDrilled)
	}
	results := tx.SendBatch(ctx, batch)
	// One Exec per queued statement — phases first, then items, matching the
	// queue order above.
	for i := 0; i < len(phases)+len(items); i++ {
		if _, err := results.Exec(); err != nil {
			// Closed before returning, or the transaction cannot be rolled
			// back -- the batch owns the connection until it is.
			_ = results.Close()
			return translate(err, "insert item")
		}
	}
	if err := results.Close(); err != nil {
		return translate(err, "insert items")
	}
	return nil
}

func (r *PostgresRepository) Enroll(ctx context.Context, userID, id, tz string) error {
	// The visibility check is part of the INSERT rather than a prior read, for
	// the same race reason as Update — and it is load-bearing here in a way it
	// is not there: without it anyone could enroll in a private curriculum by
	// guessing its id, and then read its items through Get, whose own check
	// would pass because they are now enrolled.
	tag, err := r.pool.Exec(ctx, `
		-- The caller's local date, not the server's. CURRENT_DATE here is UTC
		-- in every deployed environment, so an athlete enrolling at 22:00 in
		-- New York was stamped with tomorrow -- and told their progress counted
		-- from a date that had not arrived.
		INSERT INTO curriculum_enrollments (user_id, curriculum_id, started_on)
		SELECT $1, c.id, (now() AT TIME ZONE $3)::date
		FROM curricula c WHERE c.id = $2 AND `+visibleTo+`
		-- Idempotent, and it clears an archive: enrolling again after putting
		-- something down is picking it back up, not an error. started_on is
		-- deliberately NOT reset — it is when they first took it on.
		ON CONFLICT (user_id, curriculum_id) DO UPDATE SET archived_on = NULL`,
		userID, id, zone(tz))
	if err != nil {
		return translate(err, "enroll")
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *PostgresRepository) Archive(ctx context.Context, userID, id string) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE curriculum_enrollments SET archived_on = CURRENT_DATE
		WHERE user_id = $1 AND curriculum_id = $2 AND archived_on IS NULL`, userID, id)
	if err != nil {
		return fmt.Errorf("curriculum: archive: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// zone normalises an IANA timezone for SQL.
//
// Empty means UTC, which is what every caller predating this got. Validated at
// the handler with time.LoadLocation, so an unknown name is a 400 rather than a
// Postgres error -- but defaulted here too, because a repository that takes an
// empty string and produces a silently wrong date is the bug this fixes.
func zone(tz string) string {
	if tz == "" {
		return "UTC"
	}
	return tz
}

// translate turns Postgres constraint violations into domain errors, so no raw
// SQL error can escape this package — the module pattern's rule, and the thing
// that stops a database message reaching a client.
func translate(err error, op string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			return ErrAlreadyExists
		case "23503": // foreign_key_violation — a technique id that isn't in the library
			return ErrInvalidInput
		case "23514": // check_violation — a criterion the schema refuses
			return ErrInvalidInput
		}
	}
	return fmt.Errorf("curriculum: %s: %w", op, err)
}
