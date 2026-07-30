package database

import (
	"fmt"
	"strings"
)

// escaper neutralises LIKE's own metacharacters so a search for "50%" looks
// for those two characters rather than "anything starting with 50".
//
// The backslash has to be escaped first, or escaping the others would go on to
// mangle the backslashes this replacer just introduced. strings.NewReplacer
// scans once and never re-examines what it wrote, so the order in this literal
// is documentation rather than a dependency — but it's the order to keep.
var escaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// LikeTerm escapes a user-supplied search term for use with LikeClause.
func LikeTerm(q string) string { return escaper.Replace(q) }

// LikeClause builds a case-insensitive contains-match against `column`, with
// the search term bound at `$n`.
//
// The term and the clause are one helper because they are one decision. The
// escaping is only correct in combination with `ESCAPE '\'`, and the ESCAPE is
// the half that gets forgotten — omit it and the backslashes LikeTerm inserted
// become literal characters to match, so searching for "50%" silently finds
// nothing while searching for "%" still matches everything. Three modules had
// their own copy of both halves; this is the one place to get it right.
//
//	args = append(args, database.LikeTerm(f.Query))
//	where = append(where, database.LikeClause("s.name", len(args)))
func LikeClause(column string, n int) string {
	return fmt.Sprintf(`%s ILIKE '%%' || $%d || '%%' ESCAPE '\'`, column, n)
}
