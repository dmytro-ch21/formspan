package food

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

const selectColumns = `
	f.id, f.name, f.brand, f.category, f.aliases, f.serving_label, f.serving_grams,
	f.kcal, f.protein_g, f.carb_g, f.fat_g, f.fibre_g,
	f.saturated_fat_g, f.sugar_g, f.added_sugar_g, f.sodium_mg, f.cholesterol_mg,
	f.market, f.rank_tier, f.source,
	f.external_id, f.external_source, f.created_at, f.updated_at`

type scannable interface {
	Scan(dest ...any) error
}

func scanFood(row scannable) (*Food, error) {
	var f Food
	err := row.Scan(
		&f.ID, &f.Name, &f.Brand, &f.Category, &f.Aliases, &f.ServingLabel, &f.ServingGrams,
		&f.KCal, &f.ProteinG, &f.CarbG, &f.FatG, &f.FibreG,
		&f.SaturatedFatG, &f.SugarG, &f.AddedSugarG, &f.SodiumMG, &f.CholesterolMG,
		&f.Market, &f.RankTier, &f.Source,
		&f.ExternalID, &f.ExternalSource, &f.CreatedAt, &f.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	// pgx scans an empty TEXT[] as an empty slice but a NULL one as nil, and
	// `aliases` is NOT NULL DEFAULT '{}' so this should never fire. Normalised
	// anyway because `null` and `[]` are different values on the wire and a
	// client that iterates would have to guard one of them.
	if f.Aliases == nil {
		f.Aliases = []string{}
	}
	return &f, nil
}

// Search returns one page of matches and the TOTAL number that matched.
//
// The total comes back from the same query as the rows, via a window
// function, rather than from a second COUNT(*). Two queries would have to
// rebuild the identical WHERE clause, and a filter added to one and forgotten
// in the other is a "showing 20 of 3" bug that no test on page one can see.
func (r *PostgresRepository) Search(ctx context.Context, f SearchFilter) ([]Food, int, error) {
	f.Normalize()

	var (
		where []string
		args  []any
		// A TOTAL order, not just a sorted one. `name` carries no uniqueness
		// constraint — two brands of "Greek Yogurt" is the expected state once
		// the console authors rows — so without the id tie-break a category or
		// market browse pages non-deterministically, repeating rows on one page
		// and skipping them on the next. The query path has the same guard in
		// SearchRank; this is the path it does not cover. Raised in review.
		// rank_tier leads here too, so browsing a category shows the curated
		// foods before the bulk import rather than whatever sorts first
		// alphabetically — "Abiyuch, raw" is a real SR Legacy row and is not
		// what anyone opening `category=fruit` is looking for.
		order = "f.rank_tier ASC, f.name ASC, f.id ASC"
	)

	if f.Query != "" {
		// Matching and ranking are separate concerns and speak through
		// separate fragments — see SearchClause for why the technique library
		// had to learn that the hard way.
		clause, qargs := SearchClause(f.Query, len(args)+1)
		where = append(where, clause)
		args = append(args, qargs...)

		rank, rankArgs := SearchRank(f.Query, len(args)+1)
		order = rank
		args = append(args, rankArgs...)
	}
	if f.Category != "" {
		args = append(args, f.Category)
		where = append(where, fmt.Sprintf("f.category = $%d", len(args)))
	}
	if f.Market != "" {
		args = append(args, f.Market)
		where = append(where, fmt.Sprintf("f.market = $%d", len(args)))
	}

	clause := ""
	if len(where) > 0 {
		clause = "WHERE " + strings.Join(where, " AND ")
	}

	args = append(args, f.Limit)
	limitN := len(args)
	args = append(args, f.Offset)
	offsetN := len(args)

	//nolint:gosec // every fragment is composed from compile-time constants
	// and bound placeholders; no user input reaches the SQL text.
	query := fmt.Sprintf(`
		SELECT %s, count(*) OVER () AS total
		FROM food_catalog f
		%s
		ORDER BY %s
		LIMIT $%d OFFSET $%d`, selectColumns, clause, order, limitN, offsetN)

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("food: search: %w", err)
	}
	defer rows.Close()

	foods := make([]Food, 0, f.Limit)
	total := 0
	for rows.Next() {
		var (
			item Food
			n    int
		)
		// **This is the SECOND scanner over `selectColumns`**, the other being
		// `scanFood`, and the two must be kept in step by hand — it cannot use
		// `scanFood` because this query appends a window-function count that
		// the shared projection knows nothing about.
		//
		// N52 found that out the hard way: widening `selectColumns` by five
		// columns left this one at nineteen destinations and every search test
		// failed with "24 and 19". Loud, at least — but the exercise module
		// records the quiet version of the same trap, where a forgotten second
		// scanner shipped `offered_grips: null` on a whole endpoint. If you add
		// a column above, add it here.
		err := rows.Scan(
			&item.ID, &item.Name, &item.Brand, &item.Category, &item.Aliases,
			&item.ServingLabel, &item.ServingGrams, &item.KCal, &item.ProteinG,
			&item.CarbG, &item.FatG, &item.FibreG,
			&item.SaturatedFatG, &item.SugarG, &item.AddedSugarG,
			&item.SodiumMG, &item.CholesterolMG,
			&item.Market, &item.RankTier, &item.Source,
			&item.ExternalID, &item.ExternalSource, &item.CreatedAt, &item.UpdatedAt, &n,
		)
		if err != nil {
			return nil, 0, fmt.Errorf("food: scan: %w", err)
		}
		if item.Aliases == nil {
			item.Aliases = []string{}
		}
		foods = append(foods, item)
		total = n
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("food: search rows: %w", err)
	}
	return foods, total, nil
}

func (r *PostgresRepository) Get(ctx context.Context, id string) (*Food, error) {
	row := r.pool.QueryRow(ctx,
		//nolint:gosec // constant column list, bound id
		fmt.Sprintf("SELECT %s FROM food_catalog f WHERE f.id = $1", selectColumns), id)
	f, err := scanFood(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("food: get: %w", err)
	}
	// A second query rather than a JOIN. A join would repeat all 23 food
	// columns once per portion — up to 18 times — and then need de-duplicating
	// in Go. Two round trips on a single-food read is the cheaper mistake.
	//
	// Portions are loaded HERE and not in Search, deliberately: see
	// Food.Portions for why a 25-row search page must not carry them.
	portions, err := r.portionsFor(ctx, f.ID)
	if err != nil {
		return nil, err
	}
	f.Portions = portions
	return f, nil
}

// portionsFor returns one food's portions in USDA's own sequence order.
//
// Returns nil, not an empty slice, when a food has none — 268 of the 12,651
// catalog rows are in that state legitimately, and `omitempty` on the field
// then keeps `portions` off the wire entirely rather than sending `[]`.
func (r *PostgresRepository) portionsFor(ctx context.Context, foodID string) ([]Portion, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT seq, label, grams FROM food_catalog_portions
		  WHERE food_id = $1 ORDER BY seq ASC`, foodID)
	if err != nil {
		return nil, fmt.Errorf("food: portions: %w", err)
	}
	defer rows.Close()

	var out []Portion
	for rows.Next() {
		var p Portion
		if err := rows.Scan(&p.Seq, &p.Label, &p.Grams); err != nil {
			return nil, fmt.Errorf("food: scan portion: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("food: portion rows: %w", err)
	}
	return out, nil
}

// Coverage answers "what is actually in here".
//
// One round trip for the category counts, then the barcode count. Deliberately
// live rather than a cached or hand-written figure: this number's entire job is
// to be true at the moment an athlete got nothing back, and a stale one would
// be worse than none.
func (r *PostgresRepository) Coverage(ctx context.Context) (*Coverage, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT category, count(*) FROM food_catalog
		GROUP BY category ORDER BY category`)
	if err != nil {
		return nil, fmt.Errorf("food: coverage: %w", err)
	}
	defer rows.Close()

	cov := &Coverage{Categories: []CategoryCount{}, Markets: []string{}}
	for rows.Next() {
		var c CategoryCount
		if err := rows.Scan(&c.Category, &c.Foods); err != nil {
			return nil, fmt.Errorf("food: coverage scan: %w", err)
		}
		cov.Categories = append(cov.Categories, c)
		cov.Foods += c.Foods
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("food: coverage rows: %w", err)
	}

	mrows, err := r.pool.Query(ctx,
		`SELECT DISTINCT market FROM food_catalog ORDER BY market`)
	if err != nil {
		return nil, fmt.Errorf("food: coverage markets: %w", err)
	}
	defer mrows.Close()
	for mrows.Next() {
		var m string
		if err := mrows.Scan(&m); err != nil {
			return nil, fmt.Errorf("food: coverage market scan: %w", err)
		}
		cov.Markets = append(cov.Markets, m)
	}
	if err := mrows.Err(); err != nil {
		return nil, fmt.Errorf("food: coverage market rows: %w", err)
	}

	if err := r.pool.QueryRow(ctx,
		`SELECT count(*) FROM food_barcode_cache`).Scan(&cov.Barcode.Cached); err != nil {
		return nil, fmt.Errorf("food: coverage barcodes: %w", err)
	}
	return cov, nil
}

func (r *PostgresRepository) CountMarket(ctx context.Context, market string) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx,
		`SELECT count(*) FROM food_catalog WHERE market = $1`, market).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("food: count market: %w", err)
	}
	return n, nil
}

// upsertSQL writes a seeded row, and LEAVES A HUMAN'S EDIT ALONE.
//
// Two guards, copied deliberately from `exercise`'s upsert because they are
// each doing a separate job:
//
//   - `WHERE food_catalog.source = 'seed'` is the ownership rule. A console
//     PATCH sets source='admin', and from then on a deploy skips the row. Drop
//     this and the next deploy silently reverts every edit anybody made.
//   - The `IS DISTINCT FROM` comparison stops a no-op deploy touching
//     `updated_at` on 12,651 rows it did not change. That mattered little at
//     177 rows and matters a great deal now: seeding the full catalog takes
//     ~9s measured, and without this every deploy would rewrite every row.
//
// **Both lists are EXPLICIT columns, and that is load-bearing rather than
// stylistic.** A column left out of both is never written by a deploy and
// never even compared — which is how `exercise` gives a console-authored note
// a place to live on a seeded row without taking the row out of deploy
// management. `source` itself is deliberately absent from the SET list: a
// deploy must never write it, or it would hand ownership back to itself.
const upsertSQL = `
	INSERT INTO food_catalog (
		id, name, brand, category, aliases, serving_label, serving_grams,
		kcal, protein_g, carb_g, fat_g, fibre_g,
		saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
		market, rank_tier, external_id, external_source
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
	ON CONFLICT (id) DO UPDATE SET
		name            = EXCLUDED.name,
		brand           = EXCLUDED.brand,
		category        = EXCLUDED.category,
		aliases         = EXCLUDED.aliases,
		serving_label   = EXCLUDED.serving_label,
		serving_grams   = EXCLUDED.serving_grams,
		kcal            = EXCLUDED.kcal,
		protein_g       = EXCLUDED.protein_g,
		carb_g          = EXCLUDED.carb_g,
		fat_g           = EXCLUDED.fat_g,
		fibre_g         = EXCLUDED.fibre_g,
		saturated_fat_g = EXCLUDED.saturated_fat_g,
		sugar_g         = EXCLUDED.sugar_g,
		added_sugar_g   = EXCLUDED.added_sugar_g,
		sodium_mg       = EXCLUDED.sodium_mg,
		cholesterol_mg  = EXCLUDED.cholesterol_mg,
		market          = EXCLUDED.market,
		rank_tier       = EXCLUDED.rank_tier,
		external_id     = EXCLUDED.external_id,
		external_source = EXCLUDED.external_source,
		updated_at      = now()
	WHERE food_catalog.source = 'seed' AND (
		food_catalog.name, food_catalog.brand, food_catalog.category,
		food_catalog.aliases, food_catalog.serving_label, food_catalog.serving_grams,
		food_catalog.kcal, food_catalog.protein_g, food_catalog.carb_g,
		food_catalog.fat_g, food_catalog.fibre_g,
		food_catalog.saturated_fat_g, food_catalog.sugar_g, food_catalog.added_sugar_g,
		food_catalog.sodium_mg, food_catalog.cholesterol_mg,
		food_catalog.market, food_catalog.rank_tier,
		food_catalog.external_id, food_catalog.external_source
	) IS DISTINCT FROM (
		EXCLUDED.name, EXCLUDED.brand, EXCLUDED.category,
		EXCLUDED.aliases, EXCLUDED.serving_label, EXCLUDED.serving_grams,
		EXCLUDED.kcal, EXCLUDED.protein_g, EXCLUDED.carb_g,
		EXCLUDED.fat_g, EXCLUDED.fibre_g,
		EXCLUDED.saturated_fat_g, EXCLUDED.sugar_g, EXCLUDED.added_sugar_g,
		EXCLUDED.sodium_mg, EXCLUDED.cholesterol_mg,
		EXCLUDED.market, EXCLUDED.rank_tier,
		EXCLUDED.external_id, EXCLUDED.external_source
	)`

func upsertArgs(f Food) []any {
	aliases := f.Aliases
	if aliases == nil {
		aliases = []string{}
	}
	return []any{
		f.ID, f.Name, f.Brand, f.Category, aliases, f.ServingLabel, f.ServingGrams,
		f.KCal, f.ProteinG, f.CarbG, f.FatG, f.FibreG,
		f.SaturatedFatG, f.SugarG, f.AddedSugarG, f.SodiumMG, f.CholesterolMG,
		f.Market, f.RankTier,
		f.ExternalID, f.ExternalSource,
	}
}

// UpsertAll writes the whole catalog in one transaction, so a deploy either
// fully applies the content or leaves it untouched. A failure partway through
// a row-at-a-time loop would leave a half-updated catalog visible to readers.
func (r *PostgresRepository) UpsertAll(ctx context.Context, foods []Food) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("food: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	batch := &pgx.Batch{}
	for _, f := range foods {
		batch.Queue(upsertSQL, upsertArgs(f)...)
	}
	results := tx.SendBatch(ctx, batch)
	for i := range foods {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			return fmt.Errorf("food: upsert %q: %w", foods[i].ID, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("food: batch: %w", err)
	}

	// Portions are REPLACED wholesale for seed-owned foods, not diffed.
	//
	// The food upsert above goes to some trouble to avoid touching rows it did
	// not change (`IS DISTINCT FROM`), and this deliberately does not: a portion
	// row is four small columns with no `updated_at` and nothing downstream
	// watches it, so the diffing machinery would buy nothing. Delete-then-insert
	// is also the only shape that can REMOVE a portion USDA withdrew, which the
	// food upsert itself cannot do for a withdrawn food.
	//
	// **Both halves are scoped to `source = 'seed'`**, which is what stops a
	// deploy wiping the portions of a food the console has taken ownership of.
	// Drop that from either statement and an admin edit loses its portions on
	// the next deploy — silently, because the food row itself would be fine.
	if _, err := tx.Exec(ctx, `
		DELETE FROM food_catalog_portions p
		 USING food_catalog f
		 WHERE p.food_id = f.id AND f.source = 'seed'`); err != nil {
		return fmt.Errorf("food: clear portions: %w", err)
	}

	pbatch := &pgx.Batch{}
	queued := 0
	for _, f := range foods {
		for _, p := range f.Portions {
			pbatch.Queue(`
				INSERT INTO food_catalog_portions (food_id, seq, label, grams)
				SELECT $1, $2, $3, $4
				 WHERE EXISTS (SELECT 1 FROM food_catalog
				                WHERE id = $1 AND source = 'seed')`,
				f.ID, p.Seq, p.Label, p.Grams)
			queued++
		}
	}
	if queued > 0 {
		presults := tx.SendBatch(ctx, pbatch)
		for i := 0; i < queued; i++ {
			if _, err := presults.Exec(); err != nil {
				presults.Close() //nolint:errcheck // returning the more useful error
				return fmt.Errorf("food: upsert portion %d: %w", i, err)
			}
		}
		if err := presults.Close(); err != nil {
			return fmt.Errorf("food: portion batch: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("food: commit: %w", err)
	}
	return nil
}

// LookupBarcode reads the cache only. Going upstream is the Service's job —
// see barcode.go — because a repository that could make a network call would
// make "did this come from our database" unanswerable at the call site.
//
// Returns the provider alongside the food rather than folding it into the
// row, because it is a fact about who answered, not about the food.
func (r *PostgresRepository) LookupBarcode(ctx context.Context, barcode string) (*BarcodeFood, string, error) {
	var (
		f        BarcodeFood
		provider string
	)
	err := r.pool.QueryRow(ctx, `
		SELECT name, brand, serving_label, serving_grams,
		       packet_serving_label, packet_serving_grams,
		       kcal, protein_g, carb_g, fat_g, fibre_g,
		       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
		       provider, external_id
		FROM food_barcode_cache WHERE barcode = $1`, barcode).Scan(
		&f.Name, &f.Brand, &f.ServingLabel, &f.ServingGrams,
		&f.PacketServingLabel, &f.PacketServingGrams,
		&f.KCal, &f.ProteinG, &f.CarbG, &f.FatG, &f.FibreG,
		&f.SaturatedFatG, &f.SugarG, &f.AddedSugarG, &f.SodiumMG, &f.CholesterolMG,
		&provider, &f.ExternalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", fmt.Errorf("food: barcode lookup: %w", err)
	}
	return &f, provider, nil
}

func (r *PostgresRepository) CacheBarcode(ctx context.Context, barcode string, f BarcodeFood, provider string) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO food_barcode_cache (
			barcode, provider, name, brand, serving_label, serving_grams,
			packet_serving_label, packet_serving_grams,
			kcal, protein_g, carb_g, fat_g, fibre_g,
			saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
			external_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
		ON CONFLICT (barcode) DO UPDATE SET
			provider = EXCLUDED.provider,
			name = EXCLUDED.name, brand = EXCLUDED.brand,
			serving_label = EXCLUDED.serving_label, serving_grams = EXCLUDED.serving_grams,
			packet_serving_label = EXCLUDED.packet_serving_label,
			packet_serving_grams = EXCLUDED.packet_serving_grams,
			kcal = EXCLUDED.kcal, protein_g = EXCLUDED.protein_g,
			carb_g = EXCLUDED.carb_g, fat_g = EXCLUDED.fat_g, fibre_g = EXCLUDED.fibre_g,
			saturated_fat_g = EXCLUDED.saturated_fat_g, sugar_g = EXCLUDED.sugar_g,
			added_sugar_g = EXCLUDED.added_sugar_g, sodium_mg = EXCLUDED.sodium_mg,
			cholesterol_mg = EXCLUDED.cholesterol_mg,
			external_id = EXCLUDED.external_id,
			fetched_at = now()`,
		barcode, provider, f.Name, f.Brand, f.ServingLabel, f.ServingGrams,
		f.PacketServingLabel, f.PacketServingGrams,
		f.KCal, f.ProteinG, f.CarbG, f.FatG, f.FibreG,
		f.SaturatedFatG, f.SugarG, f.AddedSugarG, f.SodiumMG, f.CholesterolMG,
		f.ExternalID)
	if err != nil {
		return fmt.Errorf("food: cache barcode: %w", err)
	}
	return nil
}
