package nutrition

import (
	"context"
	"encoding/json"
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
	source_food_id::text, notes, created_at, updated_at`

func scanEntry(row pgx.Row) (Entry, error) {
	var e Entry
	err := row.Scan(
		&e.ID, &e.UserID, &e.EatenOn, &e.Meal,
		&e.Name, &e.Servings, &e.ServingLabel,
		&e.Kcal, &e.ProteinG, &e.CarbG, &e.FatG, &e.FibreG,
		&e.SaturatedFatG, &e.SugarG, &e.AddedSugarG, &e.SodiumMG, &e.CholesterolMG,
		&e.SourceFoodID, &e.Notes, &e.CreatedAt, &e.UpdatedAt,
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
	rows, err := r.pool.Query(ctx, `
		SELECT `+entryCols+`
		FROM nutrition_entries
		WHERE user_id = $1 AND eaten_on BETWEEN $2::date AND $3::date
		ORDER BY eaten_on DESC, created_at, id
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

// SaveEntry is a create-or-replace on a client-generated id.
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
	row := r.pool.QueryRow(ctx, `
		INSERT INTO nutrition_entries (
			id, user_id, eaten_on, meal,
			name, servings, serving_label,
			kcal, protein_g, carb_g, fat_g, fibre_g,
			saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
			source_food_id, notes)
		VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12,
		        $13, $14, $15, $16, $17, $18, $19)
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
			saturated_fat_g = EXCLUDED.saturated_fat_g,
			sugar_g = EXCLUDED.sugar_g,
			added_sugar_g = EXCLUDED.added_sugar_g,
			sodium_mg = EXCLUDED.sodium_mg,
			cholesterol_mg = EXCLUDED.cholesterol_mg,
			source_food_id = EXCLUDED.source_food_id,
			notes = EXCLUDED.notes,
			updated_at = now()
		WHERE nutrition_entries.user_id = $2
		RETURNING `+entryCols,
		e.ID, e.UserID, e.EatenOn, e.Meal,
		e.Name, e.Servings, e.ServingLabel,
		e.Kcal, e.ProteinG, e.CarbG, e.FatG, e.FibreG,
		e.SaturatedFatG, e.SugarG, e.AddedSugarG, e.SodiumMG, e.CholesterolMG,
		e.SourceFoodID, e.Notes)

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

const foodCols = `
	id::text, user_id, kind, name, brand,
	serving_label, serving_grams,
	kcal, protein_g, carb_g, fat_g, fibre_g,
	saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
	yield_servings, source, external_id, barcode,
	created_at, updated_at`

func scanFood(row pgx.Row) (Food, error) {
	var f Food
	err := row.Scan(
		&f.ID, &f.UserID, &f.Kind, &f.Name, &f.Brand,
		&f.ServingLabel, &f.ServingGrams,
		&f.Kcal, &f.ProteinG, &f.CarbG, &f.FatG, &f.FibreG,
		&f.SaturatedFatG, &f.SugarG, &f.AddedSugarG, &f.SodiumMG, &f.CholesterolMG,
		&f.YieldServings, &f.Source, &f.ExternalID, &f.Barcode,
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
	return `regexp_replace(btrim(lower(` + expr + `)), '\s+', ' ', 'g')`
}

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
	f.Macros = f.PerServing()

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
			saturated_fat_g = EXCLUDED.saturated_fat_g,
			sugar_g = EXCLUDED.sugar_g,
			added_sugar_g = EXCLUDED.added_sugar_g,
			sodium_mg = EXCLUDED.sodium_mg,
			cholesterol_mg = EXCLUDED.cholesterol_mg,
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
			updated_at = now()
		WHERE nutrition_foods.user_id = $2
		RETURNING `+foodCols,
		f.ID, f.UserID, f.Kind, f.Name, f.Brand,
		f.ServingLabel, f.ServingGrams,
		f.Kcal, f.ProteinG, f.CarbG, f.FatG, f.FibreG,
		f.SaturatedFatG, f.SugarG, f.AddedSugarG, f.SodiumMG, f.CholesterolMG,
		f.YieldServings, f.Source, f.ExternalID, f.Barcode)

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
