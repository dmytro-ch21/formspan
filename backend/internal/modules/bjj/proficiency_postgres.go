package bjj

import (
	"context"
	"fmt"
)

// ListProficiency aggregates the evidence stream into one row per technique.
//
// ONLY TECHNIQUE-TAGGED ROWS, and that is the convention this endpoint
// establishes rather than an accident of the WHERE clause. The same real event
// can be recorded twice: the wizard's drilled step writes a technique-tagged
// `scored` row, and its live grid writes an untagged one for the same
// category. Both are correct locally and each screen renders them separately,
// but summing both here would count one armbar twice. The rule is that a
// technique-tagged row is the specific record and an untagged row is the
// catch-all — so per-technique reads take the former and only the former.
//
// The join to `sessions` is on (id, user_id), not id alone. `bjj_session_tags`
// carries its own user_id and the composite FK keeps the two in step, but
// joining on id alone would still be a query whose correctness depends on that
// invariant holding rather than on the query saying what it means.
func (r *PostgresRepository) ListProficiency(
	ctx context.Context, userID string,
) ([]Proficiency, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
			t.technique_id,
			COALESCE(lib.name, ''),
			COALESCE(lib.position, ''),
			COALESCE(lib.category, ''),
			SUM(CASE WHEN t.event = 'drilled'   THEN t.count ELSE 0 END)::int,
			SUM(CASE WHEN t.event = 'attempted' THEN t.count ELSE 0 END)::int,
			SUM(CASE WHEN t.event = 'scored'    THEN t.count ELSE 0 END)::int,
			SUM(CASE WHEN t.event = 'conceded'  THEN t.count ELSE 0 END)::int,
			SUM(CASE WHEN t.event = 'defended'  THEN t.count ELSE 0 END)::int,
			COUNT(DISTINCT t.session_id)::int,
			MAX(s.started_at)
		FROM bjj_session_tags t
		JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
		-- LEFT, not INNER. The FK means a non-null technique_id always
		-- resolves today (retiring a technique sets the tag id NULL rather
		-- than orphaning it, migration 000025), so this is unreachable
		-- defence rather than a live concern -- but an INNER JOIN would turn
		-- a future dropped FK into an athlete silently losing history from
		-- this view, where LEFT shows the row with the id as its name.
		LEFT JOIN techniques lib ON lib.id = t.technique_id
		WHERE t.user_id = $1 AND t.technique_id IS NOT NULL
		GROUP BY t.technique_id, lib.name, lib.position, lib.category
		-- Most evidence first: the techniques where a conclusion is safest.
		-- technique_id last makes the order TOTAL, which the cap needs -- two
		-- techniques tied on total evidence would otherwise swap between
		-- identical requests, so which one falls outside the limit would be
		-- nondeterministic and the response would hash differently every time,
		-- making the ETag on this endpoint a permanent cache miss.
		ORDER BY
			SUM(t.count) DESC,
			t.technique_id
		LIMIT $2`, userID, maxProficiencyRows)
	if err != nil {
		return nil, fmt.Errorf("bjj: list proficiency: %w", err)
	}
	defer rows.Close()

	// Non-nil empty slice so this marshals to [] rather than null.
	out := []Proficiency{}
	for rows.Next() {
		var p Proficiency
		if err := rows.Scan(&p.TechniqueID, &p.Name, &p.Position, &p.Category,
			&p.Drilled, &p.Attempted, &p.Scored, &p.Conceded, &p.Defended,
			&p.Sessions, &p.LastSeen); err != nil {
			return nil, fmt.Errorf("bjj: scan proficiency: %w", err)
		}
		// One fallback, one answer — the clients already use the id as the
		// display name when the library can't resolve it, so the API should
		// not hand back an empty string for the same case. Unreachable while
		// the FK holds; see the LEFT JOIN note.
		if p.Name == "" {
			p.Name = p.TechniqueID
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
