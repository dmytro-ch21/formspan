package tracker

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// One list of columns, one scan order, used by every query in this file.
// Written once because a per-query column list is how a SELECT and its scanner
// drift apart.
const trackerCols = `
	id, user_id, preset, name, icon, color_key, unit, increment, target,
	render_style, sort_order, count_noun, archived_at, created_at, updated_at`

const entryCols = `
	id, tracker_id, user_id, logged_on::text, logged_at, amount, created_at`

func scanTracker(row pgx.Row) (*Tracker, error) {
	var t Tracker
	err := row.Scan(
		&t.ID, &t.UserID, &t.Preset, &t.Name, &t.Icon, &t.ColorKey, &t.Unit,
		&t.Increment, &t.Target, &t.RenderStyle, &t.SortOrder, &t.CountNoun,
		&t.ArchivedAt, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &t, nil
}

func scanEntry(row pgx.Row) (*Entry, error) {
	var e Entry
	err := row.Scan(&e.ID, &e.TrackerID, &e.UserID, &e.LoggedOn, &e.LoggedAt, &e.Amount, &e.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &e, nil
}

// translatePgError keeps SQLSTATE codes out of the handlers, and — the half
// that matters — keeps Postgres's own message text out of the client's response.
// A check-violation message quotes the offending value and the constraint body.
func translatePgError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			return ErrAlreadyExists
		case "23514": // check_violation
			switch {
			case strings.Contains(pgErr.ConstraintName, "increment"):
				return fmt.Errorf("%w: increment must be greater than zero", ErrInvalidInput)
			case strings.Contains(pgErr.ConstraintName, "target"):
				return fmt.Errorf("%w: target must be greater than zero, or null", ErrInvalidInput)
			case strings.Contains(pgErr.ConstraintName, "render_style"):
				return fmt.Errorf("%w: unrecognised render_style", ErrInvalidInput)
			case strings.Contains(pgErr.ConstraintName, "amount"):
				return fmt.Errorf("%w: amount must be greater than zero", ErrInvalidInput)
			}
			return fmt.Errorf("%w: a value is out of range", ErrInvalidInput)
		case "23503": // foreign_key_violation
			return fmt.Errorf("%w: no such tracker", ErrInvalidInput)
		case "22007", "22008": // invalid/out-of-range datetime
			return fmt.Errorf("%w: logged_on must be YYYY-MM-DD", ErrInvalidInput)
		}
	}
	return err
}

// EnsureDefaults provisions the presets an athlete should start with.
//
// Idempotent through the (user_id, preset) partial unique index rather than a
// "provisioned" flag: two devices listing at once, or a retried request, both
// converge on one water card. It also means an athlete who ARCHIVES water does
// not get it handed back — the archived row still holds the index entry, which
// is the whole reason archiving is a timestamp on the row and not a delete.
func (r *PostgresRepository) EnsureDefaults(ctx context.Context, userID string, presets []New) error {
	if len(presets) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, p := range presets {
		batch.Queue(`
			INSERT INTO daily_trackers (
				id, user_id, preset, name, icon, color_key, unit,
				increment, target, render_style, sort_order, count_noun)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			-- NO ARBITER, and that is the point. An arbiter names ONE constraint,
			-- so the (user_id, preset) form absorbed a re-provision and let a
			-- PRIMARY KEY collision raise 23505 -- which List turned into a 409 on
			-- every subsequent read, permanently, because nothing can free the id.
			-- That was reachable from outside: preset ids are derived from the
			-- athlete's user id, so anybody could plant a row on one. The bare form
			-- absorbs every unique violation, which is exactly what provisioning
			-- means: insert if you can, otherwise leave what is already there.
			-- (No backticks in here -- this is a Go raw string literal, and one
			-- silently ends it. Same trap db.ts records for its CREATE statements.)
			ON CONFLICT DO NOTHING`,
			p.ID, userID, p.Preset, p.Name, p.Icon, p.ColorKey, p.Unit,
			p.Increment, p.Target, p.RenderStyle, p.SortOrder, p.CountNoun)
	}
	results := r.pool.SendBatch(ctx, batch)
	for i := range presets {
		if _, err := results.Exec(); err != nil {
			results.Close()
			return fmt.Errorf("tracker: provision %q: %w", presets[i].Preset, translatePgError(err))
		}
	}
	return results.Close()
}

// List returns the live trackers, archived ones excluded.
//
// Unbounded only in the sense that an athlete could author a thousand: N78 owns
// the cap, and it belongs in the create path rather than as a LIMIT here, where
// truncating the list would silently hide a tracker somebody is looking for.
func (r *PostgresRepository) List(ctx context.Context, userID string) ([]Tracker, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+trackerCols+`
		  FROM daily_trackers
		 WHERE user_id = $1 AND archived_at IS NULL
		 ORDER BY sort_order, created_at, id`, userID)
	if err != nil {
		return nil, translatePgError(err)
	}
	defer rows.Close()

	out := []Tracker{}
	for rows.Next() {
		t, err := scanTracker(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// Create stores a tracker under a client-supplied id.
//
// ON CONFLICT DO NOTHING plus an owner-scoped re-read, exactly as `activity`
// does it: a sync retry after a lost response returns the original row rather
// than failing, and an id that belongs to somebody else is reported as a
// conflict rather than handed over. Ids are client-generated, so without the
// user_id predicate on the re-read this endpoint would be an IDOR that any
// caller could walk by replaying UUIDs.
func (r *PostgresRepository) Create(ctx context.Context, userID string, in New) (*Tracker, error) {
	// Validated HERE and not only in the handler. The handler is the only caller
	// today, so this is redundant — and "the caller validates" is a convention,
	// which means it holds until the second caller arrives and does not. One of
	// the rules it enforces is a security guard (the reserved `t_` namespace),
	// and a security guard that lives one layer above the write is one somebody
	// can walk around without noticing.
	if err := in.Validate(); err != nil {
		return nil, err
	}
	// **INSERT ... SELECT ... WHERE, so the cap is evaluated inside the same
	// statement as the write** rather than as a round trip before it. Not
	// serialisable — two concurrent creates can still both see seven — but it
	// closes the window to a single statement's snapshot instead of a network
	// hop, and the residual race costs one card too many (see MaxLiveTrackers).
	//
	// The cap is deliberately NOT allowed to break idempotency. A retried create
	// whose first attempt landed hits ON CONFLICT DO NOTHING, returns zero rows,
	// and is answered from the re-read below with the athlete's own tracker —
	// never with ErrTooMany, which would turn a lost response into a permanent
	// rejection and make the outbox drop a tracker the server already has.
	row := r.pool.QueryRow(ctx, `
		INSERT INTO daily_trackers (
			id, user_id, preset, name, icon, color_key, unit,
			increment, target, render_style, sort_order, count_noun)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
		 WHERE (SELECT count(*) FROM daily_trackers
		         WHERE user_id = $2 AND archived_at IS NULL) < $13
		ON CONFLICT (id) DO NOTHING
		RETURNING `+trackerCols,
		in.ID, userID, in.Preset, in.Name, in.Icon, in.ColorKey, in.Unit,
		in.Increment, in.Target, in.RenderStyle, in.SortOrder, in.CountNoun,
		MaxLiveTrackers)

	t, err := scanTracker(row)
	if err == nil {
		return t, nil
	}
	if errors.Is(err, ErrNotFound) {
		// Zero rows means one of three things, and they are told apart here
		// rather than guessed at: the id already existed and is ours (an
		// idempotent retry), the id belongs to somebody else, or the WHERE
		// refused the insert because the athlete is at the cap.
		existing, getErr := r.getOwned(ctx, userID, in.ID)
		if getErr == nil {
			return existing, nil
		}
		if !errors.Is(getErr, ErrNotFound) {
			return nil, getErr
		}
		// Not ours and not there. Either the cap stopped it or the id is taken.
		// Asking about the cap does not leak anything: it is a fact about the
		// CALLER's own row count, never about the id.
		full, capErr := r.atCap(ctx, userID)
		if capErr != nil {
			return nil, capErr
		}
		if full {
			return nil, fmt.Errorf("%w: you can track %d things at once — stop one first",
				ErrTooMany, MaxLiveTrackers)
		}
		return nil, ErrAlreadyExists
	}
	return nil, translatePgError(err)
}

// AddPreset turns a non-default preset on, or brings back one that was stopped.
//
// **Three states, and only one of them is an insert.** Getting this wrong is
// quiet rather than loud, because the (user_id, preset) partial unique index
// absorbs the duplicate: a naive `EnsureDefaults`-style provision would return
// no row for an archived tracker and the athlete would tap "Coffee" and watch
// nothing happen.
//
//   - **Live already** — return it. Tapping twice is not an error.
//   - **Archived** — restore it, with every cup it ever recorded. This is the
//     on/off switch working in both directions, which is the whole reason
//     coffee can ship `Default: false` safely.
//   - **Absent** — provision it, cap-guarded exactly as Create is.
//
// `in` comes from `PresetByKey`, never from a request body — see the note
// there. So this legitimately mints an id in the reserved `t_` namespace, and
// validates with `validateFields` rather than `Validate` for that reason.
func (r *PostgresRepository) AddPreset(ctx context.Context, userID string, in New) (*Tracker, error) {
	if err := in.validateFields(); err != nil {
		return nil, err
	}
	existing, err := r.getOwned(ctx, userID, in.ID)
	if err == nil {
		if existing.ArchivedAt == nil {
			return existing, nil
		}
		// Restore enforces the cap, so turning a preset back on cannot walk past
		// a limit that Create respects.
		if err := r.Restore(ctx, userID, in.ID); err != nil {
			return nil, err
		}
		return r.getOwned(ctx, userID, in.ID)
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	row := r.pool.QueryRow(ctx, `
		INSERT INTO daily_trackers (
			id, user_id, preset, name, icon, color_key, unit,
			increment, target, render_style, sort_order, count_noun)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
		 WHERE (SELECT count(*) FROM daily_trackers
		         WHERE user_id = $2 AND archived_at IS NULL) < $13
		ON CONFLICT DO NOTHING
		RETURNING `+trackerCols,
		in.ID, userID, in.Preset, in.Name, in.Icon, in.ColorKey, in.Unit,
		in.Increment, in.Target, in.RenderStyle, in.SortOrder, in.CountNoun,
		MaxLiveTrackers)

	t, err := scanTracker(row)
	if err == nil {
		return t, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, translatePgError(err)
	}
	// Nothing inserted. Either the cap refused it, or the derived id was
	// squatted by another athlete — the hazard `DefaultsFor` documents, which
	// `New.Validate`'s namespace guard makes unreachable from a request body but
	// which is still worth answering rather than reporting as a phantom success.
	full, capErr := r.atCap(ctx, userID)
	if capErr != nil {
		return nil, capErr
	}
	if full {
		return nil, fmt.Errorf("%w: you can track %d things at once — stop one first",
			ErrTooMany, MaxLiveTrackers)
	}
	return nil, ErrAlreadyExists
}

// atCap reports whether the athlete already holds MaxLiveTrackers live ones.
//
// Live only — archived rows do not count against it, which is what makes
// archiving a real answer to "I want to track something else" rather than a
// half-measure that leaves you stuck.
func (r *PostgresRepository) atCap(ctx context.Context, userID string) (bool, error) {
	var n int
	err := r.pool.QueryRow(ctx,
		`SELECT count(*) FROM daily_trackers WHERE user_id = $1 AND archived_at IS NULL`,
		userID).Scan(&n)
	if err != nil {
		return false, translatePgError(err)
	}
	return n >= MaxLiveTrackers, nil
}

func (r *PostgresRepository) getOwned(ctx context.Context, userID, id string) (*Tracker, error) {
	return scanTracker(r.pool.QueryRow(ctx,
		`SELECT `+trackerCols+` FROM daily_trackers WHERE id = $1 AND user_id = $2`, id, userID))
}

// Update applies a partial patch, and is the ONLY statement in this module that
// writes an existing tracker's fields.
//
// **The SET clause is built from the patch. It is not written out.** A field the
// caller did not name is not in the statement, so it cannot be blanked — which
// is the failure `exercise.updateWithin` shipped three times (migrations 000052,
// 000057, 000061), each time by growing a fixed SET clause. `patch_test.go`
// enumerates the patch's fields by reflection and `postgres_test.go` proves,
// per field, that patching one leaves the other seven untouched.
//
// Zero rows updated means either "no such tracker" or "not yours", and both are
// ErrNotFound. Distinguishing them would confirm a row exists to somebody
// enumerating ids.
func (r *PostgresRepository) Update(ctx context.Context, userID, id string, p Patch) (*Tracker, error) {
	// Same reasoning as Create: the handler validates, and so does this, because
	// the alternative is a repository that writes whatever it is handed. Without
	// it, a caller passing {Name: set, Value: nil} writes an empty string into a
	// column whose emptiness nothing downstream expects.
	if err := p.Validate(); err != nil {
		return nil, err
	}
	cols := patchColumns(p)
	if len(cols) == 0 {
		return nil, fmt.Errorf("%w: nothing to update", ErrInvalidInput)
	}
	// $1 and $2 are the identity; the patch columns start at $3.
	sets := make([]string, 0, len(cols)+1)
	args := make([]any, 0, len(cols)+2)
	args = append(args, id, userID)
	for _, c := range cols {
		args = append(args, c.value)
		sets = append(sets, fmt.Sprintf("%s = $%d", c.name, len(args)))
	}
	sets = append(sets, "updated_at = now()")

	// The column names come from patchColumns' own literals, never from the
	// request — a caller cannot introduce one. The values are always bound.
	sql := `UPDATE daily_trackers SET ` + strings.Join(sets, ", ") +
		` WHERE id = $1 AND user_id = $2 RETURNING ` + trackerCols

	t, err := scanTracker(r.pool.QueryRow(ctx, sql, args...))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, translatePgError(err)
	}
	return t, nil
}

// Archive hides a tracker and keeps everything it ever recorded.
//
// Already-archived is not an error: the athlete asked for it gone and it is
// gone. `archived_at IS NULL` in the predicate keeps the original timestamp
// rather than moving it on every retry.
func (r *PostgresRepository) Archive(ctx context.Context, userID, id string) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE daily_trackers SET archived_at = now(), updated_at = now()
		 WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`, id, userID)
	if err != nil {
		return translatePgError(err)
	}
	if tag.RowsAffected() == 0 {
		// Either gone, never existed, not ours, or already archived. Only the
		// last is benign, so check for it rather than reporting 404 at somebody
		// retrying a delete.
		var exists bool
		if err := r.pool.QueryRow(ctx,
			`SELECT true FROM daily_trackers WHERE id = $1 AND user_id = $2`, id, userID,
		).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return translatePgError(err)
		}
	}
	return nil
}

// ListArchived returns the trackers an athlete has stopped, newest first.
//
// Newest-archived first because the one you want back is almost always the one
// you just stopped — the mis-tap on a destructive-adjacent control, and the
// "actually I do still want that" ten seconds later.
//
// Not merged into List behind a flag on the same slice: a screen that shows
// both would have to decide what an archived card's `+` button does, and the
// honest answer is that an archived tracker has no `+`. Two calls, two screens.
func (r *PostgresRepository) ListArchived(ctx context.Context, userID string) ([]Tracker, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+trackerCols+`
		  FROM daily_trackers
		 WHERE user_id = $1 AND archived_at IS NOT NULL
		 ORDER BY archived_at DESC, id`, userID)
	if err != nil {
		return nil, translatePgError(err)
	}
	defer rows.Close()

	out := []Tracker{}
	for rows.Next() {
		t, err := scanTracker(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// Restore puts an archived tracker back on Today, with everything it logged.
//
// **The cap is enforced here too, and forgetting that is the obvious hole.**
// Create refuses the ninth tracker; without the same check restoring eight
// archived ones walks straight past it. Same single-statement form for the same
// reason.
//
// Restoring one that is already live is not an error — it is what a retried
// request looks like — but it must not be mistaken for "no such tracker", so
// the zero-row case is disambiguated rather than assumed.
func (r *PostgresRepository) Restore(ctx context.Context, userID, id string) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE daily_trackers SET archived_at = NULL, updated_at = now()
		 WHERE id = $1 AND user_id = $2 AND archived_at IS NOT NULL
		   AND (SELECT count(*) FROM daily_trackers
		         WHERE user_id = $2 AND archived_at IS NULL) < $3`,
		id, userID, MaxLiveTrackers)
	if err != nil {
		return translatePgError(err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	// Nothing moved. Already live, gone, not ours, or blocked by the cap.
	var archived bool
	err = r.pool.QueryRow(ctx,
		`SELECT archived_at IS NOT NULL FROM daily_trackers WHERE id = $1 AND user_id = $2`,
		id, userID).Scan(&archived)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return translatePgError(err)
	}
	if !archived {
		return nil // Already live. The athlete asked for it back and it is back.
	}
	return fmt.Errorf("%w: you can track %d things at once — stop one first",
		ErrTooMany, MaxLiveTrackers)
}

// Destroy removes a tracker and every entry it ever held.
//
// **This is the one path in the module that loses data**, which is why it is a
// separate method with a separate route rather than a flag on Archive: the two
// have to be impossible to confuse at the call site, and the client's
// confirmation copy has to be able to name what goes.
//
// The entries go by ON DELETE CASCADE (migration 000068), so this is one
// statement — and the cascade is what makes the copy's promise true rather than
// aspirational.
//
// Destroying something already gone is not an error, for the same reason
// DeleteEntry's is not: a retried destroy over a flaky connection is the common
// case, and a 404 on the second attempt puts a failure on the sync screen for
// something that landed.
//
// **A PROVISIONED row is refused, and this is not water being privileged.** The
// (user_id, preset) index entry is what makes EnsureDefaults idempotent, so
// deleting the row deletes the record that provisioning already happened and
// the next GET /v1/trackers hands water straight back. The destroy would appear
// to work and then silently undo itself, which is worse than refusing it — and
// the honest alternative, archiving, does exactly what the athlete wanted. The
// preset flag is doing its documented job here (provisioning key) rather than
// becoming a discriminator anything else branches on.
func (r *PostgresRepository) Destroy(ctx context.Context, userID, id string) error {
	// Scoped by user_id, so this cannot report on somebody else's row.
	var preset string
	err := r.pool.QueryRow(ctx,
		`SELECT preset FROM daily_trackers WHERE id = $1 AND user_id = $2`, id, userID).Scan(&preset)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // Already gone. Destroying twice is not an error.
		}
		return translatePgError(err)
	}
	if preset != "" {
		return fmt.Errorf("%w: %q is set up for you automatically and would come "+
			"back — stop tracking it instead", ErrInvalidInput, preset)
	}
	// `user_id = $2` here is DELIBERATELY REDUNDANT with the lookup above, which
	// already returned early for a row that is not the caller's. Kept, and
	// recorded as kept, because a surviving mutation on this clause reads as
	// dead code and "the tests still pass without it" is a persuasive argument
	// for deleting the last thing standing between a client-supplied id and
	// somebody else's row. The scoped lookup is what the cross-user test
	// exercises; this is the second lock on the same door.
	if _, err := r.pool.Exec(ctx,
		`DELETE FROM daily_trackers WHERE id = $1 AND user_id = $2`, id, userID); err != nil {
		return translatePgError(err)
	}
	return nil
}

// Entries returns every entry across an athlete's trackers in a local-day
// window. One request serves a whole screen of cards; splitting it per tracker
// would be an N+1 on the one screen that renders several of them.
func (r *PostgresRepository) Entries(ctx context.Context, userID, from, to string) ([]Entry, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+entryCols+`
		  FROM tracker_entries
		 WHERE user_id = $1 AND logged_on BETWEEN $2::date AND $3::date
		 ORDER BY logged_on, logged_at, id`, userID, from, to)
	if err != nil {
		return nil, translatePgError(err)
	}
	defer rows.Close()

	out := []Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// LogEntry records one tap, idempotently.
//
// DO NOTHING rather than DO UPDATE: an entry is a fact about a moment, and the
// only legitimate reason to send the same id twice is a retry of the identical
// tap. There is no edit path — correcting a mis-tap is DeleteEntry, which is
// what the card's tap-a-filled-cup gesture calls.
//
// The tracker is confirmed to be the caller's BEFORE the insert, so a valid
// entry id can never be attached to somebody else's tracker.
func (r *PostgresRepository) LogEntry(ctx context.Context, userID, trackerID string, in NewEntry) (*Entry, error) {
	if _, err := r.getOwned(ctx, userID, trackerID); err != nil {
		return nil, err
	}
	row := r.pool.QueryRow(ctx, `
		INSERT INTO tracker_entries (id, tracker_id, user_id, logged_on, logged_at, amount)
		VALUES ($1, $2, $3, $4::date, $5, $6)
		ON CONFLICT (id) DO NOTHING
		RETURNING `+entryCols,
		in.ID, trackerID, userID, in.LoggedOn, in.LoggedAt, in.Amount)

	e, err := scanEntry(row)
	if err == nil {
		return e, nil
	}
	if errors.Is(err, ErrNotFound) {
		existing, getErr := scanEntry(r.pool.QueryRow(ctx,
			`SELECT `+entryCols+` FROM tracker_entries
			  WHERE id = $1 AND user_id = $2 AND tracker_id = $3`, in.ID, userID, trackerID))
		if getErr != nil {
			if errors.Is(getErr, ErrNotFound) {
				return nil, ErrAlreadyExists
			}
			return nil, getErr
		}
		return existing, nil
	}
	return nil, translatePgError(err)
}

// DeleteEntry removes one tap. Deleting something already gone is not an error
// — a delete retried over a flaky connection is the common case, and a 404 at
// the second attempt would put a failure on the sync screen for a correction
// that landed.
func (r *PostgresRepository) DeleteEntry(ctx context.Context, userID, trackerID, entryID string) error {
	_, err := r.pool.Exec(ctx, `
		DELETE FROM tracker_entries
		 WHERE id = $1 AND user_id = $2 AND tracker_id = $3`, entryID, userID, trackerID)
	if err != nil {
		return translatePgError(err)
	}
	return nil
}
