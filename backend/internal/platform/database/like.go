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
// **`column` is interpolated raw and must be a compile-time constant.** Every
// caller passes a literal; passing anything derived from a request would be
// SQL injection. The per-module comments used to carry that warning, and it
// has to live here now that the SQL fragment does.
//
// The term and the clause ship together because the escaping is only
// meaningful alongside an escape character. In PostgreSQL specifically the
// `ESCAPE '\'` is redundant — backslash is already the default, and the
// clause behaves identically without it. It's kept because it's explicit
// about a dependency that is otherwise invisible, and because it is *not* the
// default everywhere; but nobody should expect removing it to change a result
// in this database, and "add ESCAPE" is not the fix for a search bug here.
//
//	args = append(args, database.LikeTerm(f.Query))
//	where = append(where, database.LikeClause("s.name", len(args)))
func LikeClause(column string, n int) string {
	return fmt.Sprintf(`%s ILIKE '%%' || $%d || '%%' ESCAPE '\'`, column, n)
}
