package nutrition

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
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

func translate(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			// Matched on the constraint NAME rather than assumed, so an index
			// added later cannot silently inherit this message. The only unique
			// index here beyond the primary keys is the external-id one.
			if pgErr.ConstraintName == "nutrition_foods_external_idx" {
				return fmt.Errorf("%w: that catalog entry is already saved", ErrInvalidInput)
			}
			return fmt.Errorf("%w: that already exists", ErrInvalidInput)
		case "22P02": // invalid_text_representation — a malformed UUID
			return fmt.Errorf("%w: id must be a UUID", ErrInvalidInput)
		case "23503": // foreign_key_violation
			// source_food_id pointing at a food that is not there (or is not
			// the caller's). Not fatal to the intent — the entry's own numbers
			// are what matter — but the client sent something it should not
			// have, so say so rather than dropping it silently.
			return fmt.Errorf("%w: source_food_id does not name a saved food", ErrInvalidInput)
		case "23514": // check_violation
			// Domain validation catches these first and names the field.
			// Reaching here means a path skipped Validate, so the message stays
			// generic rather than leaking a constraint name to a client.
			return fmt.Errorf("%w: a value is out of range", ErrInvalidInput)
		}
	}
	return err
}

const entryCols = `
	id::text, user_id, eaten_on::text, meal,
	name, servings, serving_label,
	kcal, protein_g, carb_g, fat_g, fibre_g,
	saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
	source_food_id::text, category, notes, position, created_at, updated_at`

func scanEntry(row pgx.Row) (Entry, error) {
	var e Entry
	err := row.Scan(
		&e.ID, &e.UserID, &e.EatenOn, &e.Meal,
		&e.Name, &e.Servings, &e.ServingLabel,
		&e.Kcal, &e.ProteinG, &e.CarbG, &e.FatG, &e.FibreG,
		&e.SaturatedFatG, &e.SugarG, &e.AddedSugarG, &e.SodiumMG, &e.CholesterolMG,
		&e.SourceFoodID, &e.Category, &e.Notes, &e.Position, &e.CreatedAt, &e.UpdatedAt,
	)
	return e, err
}

func (r *PostgresRepository) ListEntries(ctx context.Context, userID, from, to string, limit int) ([]Entry, error) {
	// The LIMIT is not optional. apihttp.Stack buffers every response to
	// compute an ETag and to gzip it, so an unbounded list is a memory bug that
	// only shows up on the athlete with the longest history.
	//
	// ORDER BY carries a total order — eaten_on alone ties for every entry in a
	// day, and a tie makes the page boundary non-deterministic between two
	// requests that should agree.
	//
	// `position` (N553) sits ahead of created_at, and it is per (day, meal) —
	// so two entries in DIFFERENT meals routinely share a value and interleave
	// here. That is harmless and deliberate: every client groups a day by meal
	// before rendering it (mobile's bySlot, web's entries.filter), so what each
	// one actually reads off this list is the order WITHIN one meal, which
	// position alone decides. created_at and id still follow, so the total
	// order — the thing pagination depends on — is unchanged.
	rows, err := r.pool.Query(ctx, `
		SELECT `+entryCols+`
		FROM nutrition_entries
		WHERE user_id = $1 AND eaten_on BETWEEN $2::date AND $3::date
		ORDER BY eaten_on DESC, position, created_at, id
		LIMIT $4`, userID, from, to, limit)
	if err != nil {
		return nil, translate(err)
	}
	defer rows.Close()

	out := []Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, translate(err)
		}
		out = append(out, e)
	}
	return out, translate(rows.Err())
}

// endOfMeal is the position an entry gets when nobody asked for one: one step
// past whatever is currently last in the meal it is being written into.
//
// A scalar subquery over the same table the statement is writing, which is
// safe here because it reads the statement's own snapshot — the row being
// inserted is not yet visible to it, and the row being UPDATED is excluded by
// id so a cross-meal move cannot measure itself.
//
// MAX over an empty meal is null, so COALESCE gives the first entry of a meal
// position 1024 rather than null — matching the migration's backfill and the
// phone's, which is what lets the two stores land on the same numbers without
// ever comparing notes.
//
// 0 itself is an ORDINARY position, not a sentinel: dragging the second row of
// a meal above the first is 1024 - 1024. Nothing anywhere may read 0 as "unset".
//
// $1 id, $2 user_id, $3 eaten_on, $4 meal — the same placeholders SaveEntry
// already binds, which is why this is a fragment rather than its own query.
var endOfMeal = `(
	SELECT COALESCE(MAX(x.position), 0) + ` + positionStepSQL + `
	FROM nutrition_entries x
	WHERE x.user_id = $2 AND x.eaten_on = $3::date AND x.meal = $4 AND x.id <> $1::uuid
)`

// positionStepSQL is PositionStep, as SQL text. Deriving it rather than
// typing 1024 again is what stops the constant and the query drifting apart.
var positionStepSQL = strconv.Itoa(PositionStep)

// SaveEntry is a create-or-replace on a client-generated id.
//
// # position is PRESERVED when the caller does not mention it
//
// `PositionWanted` nil means "leave the order alone", and the CASE in the SET
// clause is what honours that. This is not a nicety — it is the guard against
// the failure this repository has shipped three times on exercise's
// updateWithin: a column added to a SET clause, a caller that predates it
// sending the zero value, and an authored fact silently overwritten with an
// empty one. Every existing caller of PUT /v1/nutrition/entries/{id} is
// exactly such a caller. Web's entry editor and its scale-by-a-factor button
// send an entryBody with no position at all; so does any build of the phone
// older than N553. If position were `= EXCLUDED.position` like every line
// above it, the first edit to any entry would drop it to 0 and a meal edited
// twice would collapse into id order — a reordering the athlete never made,
// looking exactly like the feature misbehaving rather than like data loss.
//
// The one case where a nil PositionWanted does NOT preserve is a row that has
// MOVED — a different meal or a different day than the stored row. Its old
// position is a coordinate in a list it has left, so it is appended to the end
// of the list it has joined instead. A caller that wants it dropped somewhere
// specific says so; the phone's drag always does.
//
// # The WHERE clause in the conflict is the entire security property
//
// Without `WHERE nutrition_entries.user_id = $2`, any caller could overwrite
// any entry in the database by guessing a UUID — and because user_id is in the
// SET list of a naive version, they could take ownership of it too. This is the
// cross-user bug the reviewers have already caught twice in this codebase, and
// a client-generated primary key is exactly what re-opens it.
//
// Zero rows updated therefore means either "no such entry" or "not yours", and
// both must return 404. Returning 403 for the second would confirm the row
// exists to somebody enumerating UUIDs, which is the oracle these bugs keep
// handing out.
func (r *PostgresRepository) SaveEntry(ctx context.Context, e Entry) (Entry, error) {
	// The five label macros in their three states — see nutrition.go's
	// LabelWanted. Resolved once here so the SET clause and the arg list
	// cannot disagree about what "stated" means.
	label := e.LabelWanted.resolve(e.Macros)
	row := r.pool.QueryRow(ctx, `
		INSERT INTO nutrition_entries (
			id, user_id, eaten_on, meal,
			name, servings, serving_label,
			kcal, protein_g, carb_g, fat_g, fibre_g,
			saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
			source_food_id, category, notes, position)
		VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12,
		        $13, $14, $15, $16, $17, $18, $19, $20,
		        COALESCE($21, `+endOfMeal+`))
		ON CONFLICT (id) DO UPDATE SET
			eaten_on = EXCLUDED.eaten_on,
			meal = EXCLUDED.meal,
			name = EXCLUDED.name,
			servings = EXCLUDED.servings,
			serving_label = EXCLUDED.serving_label,
			kcal = EXCLUDED.kcal,
			protein_g = EXCLUDED.protein_g,
			carb_g = EXCLUDED.carb_g,
			fat_g = EXCLUDED.fat_g,
			fibre_g = EXCLUDED.fibre_g,
			-- **THE FIVE LABEL MACROS ARE CONDITIONAL, NOT "EXCLUDED" (F37).**
			--
			-- "$NN::boolean" is "did the caller state this column at all?", and
			-- only a stated column is written. It is the same guard "source"
			-- above and "position" below already carry, for the same reason and
			-- against the same failure: an unconditional
			-- "saturated_fat_g = EXCLUDED.saturated_fat_g" is what made every
			-- PUT from a client that has never heard of these columns wipe them.
			-- Web is exactly such a client today.
			--
			-- NOT "COALESCE($13, nutrition_entries.saturated_fat_g)", which is the obvious
			-- one-liner and is wrong here: it cannot tell an OMITTED key from an
			-- explicit null, and the phone sends all five on every push as
			-- "number | null". Under COALESCE its null would read as "keep", so
			-- a re-scan that corrected a figure to unknown could never take the
			-- stale number back off the row. See nutrition.go's LabelWanted.
			saturated_fat_g = CASE WHEN $22::boolean THEN $13::numeric ELSE nutrition_entries.saturated_fat_g END,
			sugar_g = CASE WHEN $23::boolean THEN $14::numeric ELSE nutrition_entries.sugar_g END,
			added_sugar_g = CASE WHEN $24::boolean THEN $15::numeric ELSE nutrition_entries.added_sugar_g END,
			sodium_mg = CASE WHEN $25::boolean THEN $16::numeric ELSE nutrition_entries.sodium_mg END,
			cholesterol_mg = CASE WHEN $26::boolean THEN $17::numeric ELSE nutrition_entries.cholesterol_mg END,
			source_food_id = EXCLUDED.source_food_id,
			category = EXCLUDED.category,
			notes = EXCLUDED.notes,
			position = CASE
				WHEN $21::bigint IS NOT NULL THEN $21::bigint
				WHEN nutrition_entries.meal = $4 AND nutrition_entries.eaten_on = $3::date
					THEN nutrition_entries.position
				ELSE `+endOfMeal+`
			END,
			updated_at = now()
		WHERE nutrition_entries.user_id = $2
		RETURNING `+entryCols,
		e.ID, e.UserID, e.EatenOn, e.Meal,
		e.Name, e.Servings, e.ServingLabel,
		e.Kcal, e.ProteinG, e.CarbG, e.FatG, e.FibreG,
		label[0].Value, label[1].Value, label[2].Value, label[3].Value, label[4].Value,
		e.SourceFoodID, e.Category, e.Notes, e.PositionWanted,
		label[0].Stated, label[1].Stated, label[2].Stated, label[3].Stated, label[4].Stated)

	out, err := scanEntry(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, ErrNotFound
	}
	return out, translate(err)
}

// DeleteEntry is idempotent: an absent row is not an error.
//
// Diverges from body.DeleteCheckin's 404 deliberately. An outbox retrying a
// delete that already succeeded would otherwise record a permanent failure for
// a row that is correctly gone, and the athlete would see it stuck on the sync
// screen forever. It is also the non-oracle answer — a foreign UUID and an
// absent one become indistinguishable, which is the property the ID-enumeration
// bugs in this codebase kept violating.
func (r *PostgresRepository) DeleteEntry(ctx context.Context, userID, id string) error {
	_, err := r.pool.Exec(ctx,
		`DELETE FROM nutrition_entries WHERE user_id = $1 AND id = $2`, userID, id)
	return translate(err)
}

// DayTotals sums a window, and pairs each day with the target that was live
// THAT day.
//
// FOR READ-ONLY WINDOWS ONLY — a month being reviewed on web. Never for the day
// the client is currently editing: the phone's outbox holds entries the server
// has never seen, so this figure is not stylistically but numerically wrong
// there, during the exact minute somebody is looking at it.
//
// The target is resolved per day with a lateral join rather than fetched once
// for the window, because a target set mid-window applies from its own date
// forward and a single figure would misattribute every day before it.
func (r *PostgresRepository) DayTotals(ctx context.Context, userID, from, to string) ([]DayTotals, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT d.eaten_on::text,
		       d.entries, d.kcal, d.protein_g, d.carb_g, d.fat_g, d.fibre_g,
		       d.saturated_fat_g, d.sugar_g, d.added_sugar_g, d.sodium_mg, d.cholesterol_mg,
		       t.kcal, t.protein_g
		FROM (
			SELECT eaten_on,
			       count(*)          AS entries,
			       sum(kcal)         AS kcal,
			       sum(protein_g)    AS protein_g,
			       sum(carb_g)       AS carb_g,
			       sum(fat_g)        AS fat_g,
			       -- NULL when no entry that day stated fibre, rather than 0:
			       -- a day nobody recorded fibre for is not a zero-fibre day.
			       sum(fibre_g)      AS fibre_g,
			       -- The label macros (N52), same NULL-not-zero rule. Sodium
			       -- is the one worth having a daily total for at all — it is
			       -- the nutrient with a daily guideline rather than a
			       -- per-food one.
			       --
			       -- CAVEAT worth knowing before rendering these: SQL sum()
			       -- SKIPS nulls, so a day where three of five entries stated
			       -- sodium returns the sum of three and looks complete. NULL
			       -- means "nobody stated it all day"; a number does NOT mean
			       -- "everything is accounted for". Same caveat has always
			       -- applied to fibre. A client showing these against a daily
			       -- guideline should say how many entries contributed —
			       -- exactly the honesty rule N28 set for averages.
			       sum(saturated_fat_g) AS saturated_fat_g,
			       sum(sugar_g)         AS sugar_g,
			       sum(added_sugar_g)   AS added_sugar_g,
			       sum(sodium_mg)       AS sodium_mg,
			       sum(cholesterol_mg)  AS cholesterol_mg
			FROM nutrition_entries
			WHERE user_id = $1 AND eaten_on BETWEEN $2::date AND $3::date
			GROUP BY eaten_on
		) d
		LEFT JOIN LATERAL (
			SELECT kcal, protein_g
			FROM nutrition_targets
			WHERE user_id = $1 AND effective_on <= d.eaten_on
			ORDER BY effective_on DESC
			LIMIT 1
		) t ON true
		ORDER BY d.eaten_on`, userID, from, to)
	if err != nil {
		return nil, translate(err)
	}
	defer rows.Close()

	out := []DayTotals{}
	for rows.Next() {
		var d DayTotals
		if err := rows.Scan(&d.EatenOn, &d.Entries,
			&d.Kcal, &d.ProteinG, &d.CarbG, &d.FatG, &d.FibreG,
			&d.SaturatedFatG, &d.SugarG, &d.AddedSugarG, &d.SodiumMG, &d.CholesterolMG,
			&d.TargetKcal, &d.TargetProteinG); err != nil {
			return nil, translate(err)
		}
		out = append(out, d)
	}
	return out, translate(rows.Err())
}

// foodCols is every column a Food is read with, and it is used in a RETURNING
// clause as well as in SELECTs — which is why the sharer's handle is a
// correlated scalar subquery on `nutrition_foods.shared_by_user_id` rather
// than a LEFT JOIN: a JOIN cannot be expressed in `INSERT ... RETURNING`, and
// two column lists (one joined, one not) is exactly the "a new column was
// forgotten in one of them" hazard the mobile cache's own FOOD_COL_NAMES
// comment describes. The qualified name resolves in all four callers because
// none of them aliases the table.
//
// Resolved LIVE, never stored (N532/#963): profiles.username is renameable,
// and a handle copied at accept time would be wrong from the first rename on
// with nothing to correct it. Same reasoning, same shape, as the share
// inbox's `from` (share/postgres.go). A sharer whose profile is gone, or who
// has no username, reads as NULL — the CHECK constraint guarantees shared_at
// still says the food was shared, so a client keys presence on that.
const foodCols = `
	id::text, user_id, kind, name, brand,
	serving_label, serving_grams,
	kcal, protein_g, carb_g, fat_g, fibre_g,
	saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
	yield_servings, source, external_id, barcode,
	(SELECT p.username FROM profiles p WHERE p.user_id = nutrition_foods.shared_by_user_id),
	shared_at,
	created_at, updated_at`

func scanFood(row pgx.Row) (Food, error) {
	var f Food
	err := row.Scan(
		&f.ID, &f.UserID, &f.Kind, &f.Name, &f.Brand,
		&f.ServingLabel, &f.ServingGrams,
		&f.Kcal, &f.ProteinG, &f.CarbG, &f.FatG, &f.FibreG,
		&f.SaturatedFatG, &f.SugarG, &f.AddedSugarG, &f.SodiumMG, &f.CholesterolMG,
		&f.YieldServings, &f.Source, &f.ExternalID, &f.Barcode,
		&f.SharedBy, &f.SharedAt,
		&f.CreatedAt, &f.UpdatedAt,
	)
	return f, err
}

func (r *PostgresRepository) ListFoods(ctx context.Context, userID, q string, limit int) ([]Food, error) {
	// A prefix-and-substring match on a lowered name. Deliberately not the
	// trigram search the exercise catalog uses: that index exists because that
	// catalog has 762 rows shared by everybody, where this is one athlete's own
	// saved list and will be dozens. ILIKE over an indexed lower(name) is the
	// honest tool at this size; revisit if a seeded catalog ever lands.
	// The athlete's own text is escaped before it becomes a LIKE pattern.
	// Without this, searching for "100%" or "protein_shake" turns their own
	// characters into wildcards and quietly returns the wrong rows — a bug that
	// looks like broken search rather than like an escaping mistake. Backslash
	// first, or it re-escapes the escapes it just added.
	esc := strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`)
	pattern := "%" + esc.Replace(strings.ToLower(strings.TrimSpace(q))) + "%"
	rows, err := r.pool.Query(ctx, `
		SELECT `+foodCols+`
		FROM nutrition_foods
		WHERE user_id = $1 AND ($2 = '%%' OR lower(name) LIKE $2 ESCAPE '\')
		ORDER BY lower(name), id
		LIMIT $3`, userID, pattern, limit)
	if err != nil {
		return nil, translate(err)
	}
	defer rows.Close()

	out := []Food{}
	ids := []string{}
	for rows.Next() {
		f, err := scanFood(rows)
		if err != nil {
			return nil, translate(err)
		}
		f.Items = []RecipeItem{}
		out = append(out, f)
		ids = append(ids, f.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, translate(err)
	}
	if len(out) == 0 {
		return out, nil
	}

	// Items in ONE query keyed by the ids just fetched, not one query per
	// recipe. The picker lists dozens of rows and an N+1 here would be a
	// per-recipe round trip on a screen that opens on every meal.
	items, err := r.itemsFor(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		if got, ok := items[out[i].ID]; ok {
			out[i].Items = got
		}
	}
	return out, nil
}

func (r *PostgresRepository) itemsFor(ctx context.Context, foodIDs []string) (map[string][]RecipeItem, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT food_id::text, name, quantity, serving_label,
		       kcal, protein_g, carb_g, fat_g, fibre_g,
		       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source_food_id::text
		FROM nutrition_recipe_items
		WHERE food_id = ANY($1::uuid[])
		ORDER BY food_id, position`, foodIDs)
	if err != nil {
		return nil, translate(err)
	}
	defer rows.Close()

	out := map[string][]RecipeItem{}
	for rows.Next() {
		var id string
		var it RecipeItem
		if err := rows.Scan(&id, &it.Name, &it.Quantity, &it.ServingLabel,
			&it.Kcal, &it.ProteinG, &it.CarbG, &it.FatG, &it.FibreG,
			&it.SaturatedFatG, &it.SugarG, &it.AddedSugarG, &it.SodiumMG, &it.CholesterolMG,
			&it.SourceFoodID); err != nil {
			return nil, translate(err)
		}
		out[id] = append(out[id], it)
	}
	return out, translate(rows.Err())
}

func (r *PostgresRepository) GetFood(ctx context.Context, userID, id string) (Food, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT `+foodCols+`
		FROM nutrition_foods WHERE user_id = $1 AND id = $2`, userID, id)
	f, err := scanFood(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Food{}, ErrNotFound
	}
	if err != nil {
		return Food{}, translate(err)
	}
	items, err := r.itemsFor(ctx, []string{f.ID})
	if err != nil {
		return Food{}, err
	}
	f.Items = items[f.ID]
	if f.Items == nil {
		f.Items = []RecipeItem{}
	}
	return f, nil
}

// normalizedNameSQL is the SQL half of NormalizeFoodName.
//
// **These two are one rule spelled twice, and they must not be allowed to
// drift.** `TestTheSQLNormalisationAgreesWithTheGoOne` runs the same vectors
// through both against a real database; if you change either, change both and
// watch that test go red first.
//
// `regexp_replace(btrim(lower(x)), '\s+', ' ', 'g')` is the exact analogue of
// `strings.Join(strings.Fields(strings.ToLower(x)), " ")`: lowercase, trim the
// ends, collapse internal runs. All three functions are IMMUTABLE, which is
// what lets migration 000074 index this expression.
// A FUNCTION of the expression to normalise rather than a constant naming the
// column, so a test can put the same rule over a literal and compare it with
// NormalizeFoodName. A constant hardcoding `name` can only be exercised through
// a row, and the test that tried inlined the expression by hand instead — which
// meant it agreed with a copy of the rule rather than with the rule, and drift
// in this line passed it. Measured: changing the constant left that test green.
func normalizedNameSQL(expr string) string {
	return `btrim(regexp_replace(lower(` + expr + `), '` + whitespaceClassSQL + `', ' ', 'g'))`
}

// whitespaceClassSQL is what Go's `strings.Fields` treats as a separator,
// spelled for Postgres — and it is NOT `\s`.
//
// Measured 2026-08-21 against this database, after review pointed at it. Go's
// `unicode.IsSpace` folds every one of these; Postgres' `[:space:]` folds only
// some, and the ones it misses are reachable:
//
//	U+00A0 NBSP              Go folds · SQL did NOT   <- iOS keyboards insert it
//	U+1680 OGHAM SPACE       Go folds · SQL did NOT
//	U+202F NARROW NBSP       Go folds · SQL did NOT
//	U+0085 U+2002 U+3000     both fold
//
// A food saved with an internal NBSP was therefore permanently unmatchable —
// which is precisely the complaint N114 exists to fix, surviving inside the
// fix, for that row, forever. The failure direction was safe (a Go-normalised
// query can never contain one, so a mismatch is a MISSED reuse rather than a
// wrong substitution), and safe is not the same as right.
//
// **The BTRIM MOVED OUTWARDS in the same change, and that is the second half.**
// It used to run before the collapse, and `btrim` with no explicit character
// set removes ordinary spaces only — so a stored name with a leading TAB or
// NEWLINE normalised to `' pork shashlik '` and matched nothing. Collapsing
// first turns every edge separator into a plain space, which is exactly what
// `btrim` then removes. Measured: tab-edge, newline-edge and NBSP-edge all
// failed before and all pass now.
//
// The remaining known divergence is `lower()` versus `strings.ToLower` on
// exotic scripts, which is locale-dependent in Postgres and not in Go. Left
// alone: closing it means carrying a case-folding table, and no vector anybody
// has produced reaches it.
const whitespaceClassSQL = `[[:space:]\u00a0\u0085\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+`

// FindFoodByNormalizedName is N114's reuse lookup: the caller's own saved food
// whose name normalises to exactly this string.
//
// **Scoped to user_id inside the WHERE, and that predicate is the security
// property** — the same one SaveFood's conflict clause carries. Without it this
// method answers "does any athlete have a food called X", and a reuse would
// hand one athlete another's numbers.
//
// Served by `nutrition_foods_user_normalized_name_idx` (migration 000074),
// whose expression must stay byte-identical to `normalizedNameSQL` or Postgres
// will not use it and this degrades to a scan of the athlete's whole food list.
//
// **Ordered, because a match must be reproducible.** Nothing stops an athlete
// having two saved foods that normalise the same way — two devices offline,
// two client-generated ids, one name — and an unordered LIMIT 1 would then
// return whichever row the plan happened to reach first, so the same
// description could yield different numbers on consecutive calls. That is the
// defect N114 was reported for, reproduced by the fix for it. Newest wins,
// which is the athlete's most recent correction, with `id` breaking a tie so
// the answer is total rather than merely usually-stable.
func (r *PostgresRepository) FindFoodByNormalizedName(ctx context.Context, userID, normalized string) (Food, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT `+foodCols+`
		FROM nutrition_foods
		WHERE user_id = $1 AND `+normalizedNameSQL("name")+` = $2
		ORDER BY updated_at DESC, id
		LIMIT 1`, userID, normalized)
	f, err := scanFood(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Food{}, ErrNotFound
	}
	if err != nil {
		return Food{}, translate(err)
	}
	items, err := r.itemsFor(ctx, []string{f.ID})
	if err != nil {
		return Food{}, err
	}
	f.Items = items[f.ID]
	if f.Items == nil {
		f.Items = []RecipeItem{}
	}
	return f, nil
}

// SaveFood writes the parent and its items atomically, recomputing a recipe's
// per-serving macros from its items on the way through.
//
// Items are replaced wholesale rather than diffed: they are an ordered list the
// client owns in full, which is the same contract a session's sets use, and
// diffing would need stable item ids the client has no reason to carry.
func (r *PostgresRepository) SaveFood(ctx context.Context, f Food) (Food, error) {
	// Derived here rather than by the caller so there is exactly one place that
	// decides what a portion of a recipe contains, and so it cannot be skipped
	// by a second write path later.
	derived := f.DerivesMacros()
	f.Macros = f.PerServing()

	// The five label macros in their three states — see nutrition.go's
	// LabelWanted. Resolved once so the SET clause and the arg list cannot
	// disagree about what "stated" means.
	label := f.LabelWanted.resolve(f.Macros)

	// **A RECIPE HAS NO "KEEP" STATE, AND THAT IS NOT AN EXCEPTION TO THE RULE
	// ABOVE — IT IS THE RULE (F37).** "Keep" exists because a client that never
	// mentioned a column has no opinion about it. For a recipe, the column was
	// not left unmentioned: it was COMPUTED, a line ago, by summing the items
	// the client just sent. That is an opinion, and it is the authoritative one.
	//
	// It matters in the direction that is easy to miss. Deriving a real figure
	// works either way, because a non-nil Macros already resolves as stated.
	// Deriving NOTHING does not: drop the one sodium-carrying ingredient out of
	// a recipe and the derivation correctly says "nobody states sodium now" —
	// and without this the row would quietly hold on to the total from back when
	// something did, a number no ingredient stands behind any more.
	if derived {
		for i := range label {
			label[i].Stated = true
		}
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Food{}, translate(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, `
		INSERT INTO nutrition_foods (
			id, user_id, kind, name, brand,
			serving_label, serving_grams,
			kcal, protein_g, carb_g, fat_g, fibre_g,
			saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
			yield_servings, source, external_id, barcode)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
		        $13, $14, $15, $16, $17, $18,
		        COALESCE(NULLIF($19::text, ''), 'user'), $20, $21)
		ON CONFLICT (id) DO UPDATE SET
			kind = EXCLUDED.kind,
			name = EXCLUDED.name,
			brand = EXCLUDED.brand,
			serving_label = EXCLUDED.serving_label,
			serving_grams = EXCLUDED.serving_grams,
			kcal = EXCLUDED.kcal,
			protein_g = EXCLUDED.protein_g,
			carb_g = EXCLUDED.carb_g,
			fat_g = EXCLUDED.fat_g,
			fibre_g = EXCLUDED.fibre_g,
			-- **THE FIVE LABEL MACROS ARE CONDITIONAL, NOT "EXCLUDED" (F37).**
			--
			-- "$NN::boolean" is "did the caller state this column at all?", and
			-- only a stated column is written. It is the same guard "source"
			-- above and "position" below already carry, for the same reason and
			-- against the same failure: an unconditional
			-- "saturated_fat_g = EXCLUDED.saturated_fat_g" is what made every
			-- PUT from a client that has never heard of these columns wipe them.
			-- Web is exactly such a client today.
			--
			-- NOT "COALESCE($13, nutrition_foods.saturated_fat_g)", which is the obvious
			-- one-liner and is wrong here: it cannot tell an OMITTED key from an
			-- explicit null, and the phone sends all five on every push as
			-- "number | null". Under COALESCE its null would read as "keep", so
			-- a re-scan that corrected a figure to unknown could never take the
			-- stale number back off the row. See nutrition.go's LabelWanted.
			saturated_fat_g = CASE WHEN $22::boolean THEN $13::numeric ELSE nutrition_foods.saturated_fat_g END,
			sugar_g = CASE WHEN $23::boolean THEN $14::numeric ELSE nutrition_foods.sugar_g END,
			added_sugar_g = CASE WHEN $24::boolean THEN $15::numeric ELSE nutrition_foods.added_sugar_g END,
			sodium_mg = CASE WHEN $25::boolean THEN $16::numeric ELSE nutrition_foods.sodium_mg END,
			cholesterol_mg = CASE WHEN $26::boolean THEN $17::numeric ELSE nutrition_foods.cholesterol_mg END,
			yield_servings = EXCLUDED.yield_servings,
			-- **NOT "EXCLUDED.source", and this is the whole of N114's
			-- restore-path guard.**
			--
			-- An empty Source means the caller did not state one, and the right
			-- answer to that on an UPDATE is the value already stored — not a
			-- default. Adding a column to this SET clause has silently blanked
			-- authored data three times in this repo ("load_mode", "implements",
			-- "note" on "exercises"); making an EXISTING column client-settable
			-- is the same hazard wearing different clothes, and it would land on
			-- provenance, which is the one field here nothing downstream can
			-- reconstruct. An athlete correcting the macros of an AI-drafted
			-- food would have relabelled it as something they measured.
			--
			-- "$19" rather than "EXCLUDED.source" because EXCLUDED holds the
			-- row that WOULD have been inserted — i.e. after the COALESCE in
			-- VALUES above has already turned '' into 'user'. Reading EXCLUDED
			-- here compiles, looks right, and can never see the empty case.
			-- Pinned by "TestEditingAFoodWithoutSayingItsSourceKeepsIt".
			source = COALESCE(NULLIF($19::text, ''), nutrition_foods.source),
			external_id = EXCLUDED.external_id,
			barcode = EXCLUDED.barcode,
			-- shared_by_user_id / shared_at are DELIBERATELY ABSENT from this
			-- SET clause, and from the INSERT's column list above (N532/#963).
			-- They are written by share.go's insertFood alone. Listing them
			-- here — even as "EXCLUDED.shared_at", which would be NULL on
			-- every client write — is the exact fourth instance of the
			-- exercise.updateWithin wipe CLAUDE.md warns about: the receiver
			-- correcting a shared recipe's macros would silently erase who
			-- sent it. Pinned by TestEditingACopyKeepsWhoSharedIt.
			updated_at = now()
		WHERE nutrition_foods.user_id = $2
		RETURNING `+foodCols,
		f.ID, f.UserID, f.Kind, f.Name, f.Brand,
		f.ServingLabel, f.ServingGrams,
		f.Kcal, f.ProteinG, f.CarbG, f.FatG, f.FibreG,
		label[0].Value, label[1].Value, label[2].Value, label[3].Value, label[4].Value,
		f.YieldServings, f.Source, f.ExternalID, f.Barcode,
		label[0].Stated, label[1].Stated, label[2].Stated, label[3].Stated, label[4].Stated)

	saved, err := scanFood(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// Same reasoning as SaveEntry: somebody else's UUID and a UUID that
		// does not exist are the same answer.
		return Food{}, ErrNotFound
	}
	if err != nil {
		return Food{}, translate(err)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM nutrition_recipe_items WHERE food_id = $1`, saved.ID); err != nil {
		return Food{}, translate(err)
	}
	for i, it := range f.Items {
		if _, err := tx.Exec(ctx, `
			INSERT INTO nutrition_recipe_items (
				food_id, position, name, quantity, serving_label,
				kcal, protein_g, carb_g, fat_g, fibre_g,
				saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source_food_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
			        $11, $12, $13, $14, $15, $16)`,
			saved.ID, i, it.Name, it.Quantity, it.ServingLabel,
			it.Kcal, it.ProteinG, it.CarbG, it.FatG, it.FibreG,
			it.SaturatedFatG, it.SugarG, it.AddedSugarG, it.SodiumMG, it.CholesterolMG,
			it.SourceFoodID); err != nil {
			return Food{}, translate(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Food{}, translate(err)
	}

	saved.Items = f.Items
	if saved.Items == nil {
		saved.Items = []RecipeItem{}
	}
	return saved, nil
}

// DeleteFood removes a saved food. Entries logged from it keep their own
// numbers — source_food_id is ON DELETE SET NULL — so deleting a favourite can
// never change what the log says you ate.
func (r *PostgresRepository) DeleteFood(ctx context.Context, userID, id string) error {
	_, err := r.pool.Exec(ctx,
		`DELETE FROM nutrition_foods WHERE user_id = $1 AND id = $2`, userID, id)
	return translate(err)
}

const targetCols = `
	user_id, effective_on::text, kcal, protein_g, carb_g, fat_g, fibre_g,
	source, basis, created_at, updated_at`

func scanTarget(row pgx.Row) (Target, error) {
	var t Target
	var basis []byte
	err := row.Scan(&t.UserID, &t.EffectiveOn, &t.Kcal, &t.ProteinG, &t.CarbG, &t.FatG, &t.FibreG,
		&t.Source, &basis, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return t, err
	}
	if len(basis) > 0 {
		var b Basis
		if err := json.Unmarshal(basis, &b); err == nil {
			t.Basis = &b
		}
		// A basis that no longer parses is not fatal: the target's own numbers
		// are what the athlete eats to, and losing the explanation of a target
		// set two schema versions ago is a far smaller failure than refusing to
		// serve it. The UI already handles an absent basis (a manual target has
		// none).
	}
	return t, nil
}

// ListTargets returns the rows in [from,to] PLUS the one live at `from`.
//
// The carry-in row is the whole reason this is not a plain BETWEEN. A target
// set three months ago means a week-long window contains no rows at all, and
// the client would then honestly report "no target" for a week the athlete was
// eating to one — a bug that only appears for people who have not changed their
// target recently, which is to say the ones doing it right.
func (r *PostgresRepository) ListTargets(ctx context.Context, userID, from, to string) ([]Target, error) {
	// The carry-in branch is WRAPPED IN A SUBQUERY, and it has to be.
	//
	// In Postgres an ORDER BY / LIMIT written after a UNION ALL binds to the
	// WHOLE union, not to the branch above it — so the unwrapped version
	// returned exactly one row: the newest target overall, silently discarding
	// every in-window row it was supposed to return. It compiled, it ran, and
	// the test passed, because the only case covered was a window with no rows
	// of its own, where one row is also the right answer.
	rows, err := r.pool.Query(ctx, `
		SELECT `+targetCols+` FROM nutrition_targets
		WHERE user_id = $1 AND effective_on BETWEEN $2::date AND $3::date
		UNION ALL
		SELECT * FROM (
			SELECT `+targetCols+` FROM nutrition_targets
			WHERE user_id = $1 AND effective_on < $2::date
			ORDER BY effective_on DESC
			LIMIT 1
		) carry_in
		ORDER BY effective_on DESC`, userID, from, to)
	if err != nil {
		return nil, translate(err)
	}
	defer rows.Close()

	out := []Target{}
	for rows.Next() {
		t, err := scanTarget(rows)
		if err != nil {
			return nil, translate(err)
		}
		out = append(out, t)
	}
	return out, translate(rows.Err())
}

func (r *PostgresRepository) TargetOn(ctx context.Context, userID, on string) (Target, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT `+targetCols+` FROM nutrition_targets
		WHERE user_id = $1 AND effective_on <= $2::date
		ORDER BY effective_on DESC LIMIT 1`, userID, on)
	t, err := scanTarget(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Target{}, ErrNotFound
	}
	return t, translate(err)
}

func (r *PostgresRepository) SaveTarget(ctx context.Context, t Target) (Target, error) {
	// Keyed on (user_id, effective_on), so no cross-user WHERE is needed here:
	// user_id is half the primary key, and a conflict can only be with this
	// caller's own row.
	var basis []byte
	if t.Basis != nil {
		b, err := json.Marshal(t.Basis)
		if err != nil {
			return Target{}, fmt.Errorf("%w: basis could not be stored", ErrInvalidInput)
		}
		basis = b
	}
	row := r.pool.QueryRow(ctx, `
		INSERT INTO nutrition_targets (
			user_id, effective_on, kcal, protein_g, carb_g, fat_g, fibre_g, source, basis)
		VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (user_id, effective_on) DO UPDATE SET
			kcal = EXCLUDED.kcal,
			protein_g = EXCLUDED.protein_g,
			carb_g = EXCLUDED.carb_g,
			fat_g = EXCLUDED.fat_g,
			fibre_g = EXCLUDED.fibre_g,
			source = EXCLUDED.source,
			basis = EXCLUDED.basis,
			updated_at = now()
		RETURNING `+targetCols,
		t.UserID, t.EffectiveOn, t.Kcal, t.ProteinG, t.CarbG, t.FatG, t.FibreG, t.Source, basis)
	out, err := scanTarget(row)
	return out, translate(err)
}

func (r *PostgresRepository) DeleteTarget(ctx context.Context, userID, on string) error {
	_, err := r.pool.Exec(ctx,
		`DELETE FROM nutrition_targets WHERE user_id = $1 AND effective_on = $2::date`, userID, on)
	return translate(err)
}
