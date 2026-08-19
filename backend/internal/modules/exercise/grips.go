package exercise

// OfferedGrips is which grips are worth OFFERING for a movement.
//
// # Why this lives here now, and why it is served (N16)
//
// It used to be `session.GripsFor`, with hand-maintained copies in
// `apps/mobile/lib/sessions.ts` and `apps/web/src/lib/api.ts` and a Python
// script (`scripts/check-grip-parity.py`) failing the build when the three
// drifted. That trade was deliberate and it is written down: there is no shared
// TypeScript package between the two apps, so the alternative to copying was
// inventing one and rewiring two builds.
//
// Serving it is the cheaper answer, and it removes the drift surface rather
// than policing it. Two facts made the old arrangement worse than it looked:
//
//   - **The Go copy had no production caller.** `GripsFor` and `GripApplies`
//     were referenced by nothing but their own tests — a specification the
//     server published and never used, which the clients then re-implemented.
//     Serving it gives the table exactly one authoritative reader.
//   - **The table grew from a boolean to a 4-way switch** when N9 added `mixed`
//     and `hook`, so the surface a copy can be wrong on grew with it. The
//     numbers in mobile's copy of this comment were wrong for two PRs.
//
// It is DERIVED, never stored: no column, no migration, no 762 rows of
// hand-classification to keep true. That also finishes the half of #256 that
// was left open — the server already decided how many grips EXIST, and now
// decides which APPLY, so a seventh needs no app release.
//
// # The subsets, which are grounded in the catalog rather than in what sounds right
//
// Two of them are counter-intuitive:
//
//   - **Hinges get `neutral`**, which looks wrong for a deadlift until you
//     count them: 20 of those 55 rows are kettlebell, dumbbell or hex-bar.
//     Not all of those are palms-facing — the four swings are held overhand —
//     but the hex bar and the dumbbells-at-the-sides work carry the argument
//     on their own. (`regular` is on this list for the 13 barbell rows, not
//     for the swings; four of 55 would not earn a value.)
//   - **Olympic lifts get `neutral`** for the same reason: 12 of those 25 rows
//     are kettlebell (11) or dumbbell (1), none of which hook-grips anything.
//     Barbell is 13 — a bare majority, not a plurality, and stating it the
//     generous way was itself corrected once. Twelve real rows still need
//     `neutral`, which is the whole argument; the split does not have to be
//     even to need both values.
//
// `mixed` appears on hinges ALONE. You do not mix-grip a snatch, and a mixed
// farmer's carry is not a thing — offering it there would be the same
// false-entry mistake in a new place.
//
// `isolation` is the debatable inclusion: 210 rows, the catalog's honest bucket
// for the single-joint long tail, so it carries calf raises (grip is
// meaningless) alongside hammer and reverse curls — the purest grip variations
// there are. The asymmetry decides it. A false positive is an optional control
// somebody ignores on a calf raise; a false negative is the feature not
// existing for reverse curls. Cheap wrong beats expensive wrong.
//
// Returns nil where the question is meaningless — squats, lunges, jumps,
// conditioning, core, mobility, rotation. An empty picker is a question with no
// answers, so a client renders none. Together the eight patterns here are 496 of
// the catalog's 762 exercises; it was 403 before N9 added the last three.
//
// # This is advisory, not a validation rule
//
// The server does NOT refuse a grip outside a movement's subset — `ValidGrip`
// checks the vocabulary and stops there, deliberately, because refusing an
// unusual pairing would turn a UI affordance into a data-integrity rule and
// invent a false negative (a hook-gripped shrug is `isolation`, real, and
// nobody's business to refuse). That is what makes serving this safe: a client
// working from a stale copy over-offers or under-offers, and never 400s.
//
// Each branch returns a FRESH slice, deliberately — and the mechanism matters,
// because the first version of this note named the wrong one. `append` is NOT
// the hazard: a slice literal has len == cap, so appending reallocates and the
// caller's copy diverges harmlessly. The hazard is an in-place write or a
// `sort` on the returned slice, which a package-level table would carry into
// every later caller. Pinned by `TestOfferedGripsReturnsAFreshSliceEachCall`.
//
// Plain strings rather than `session.Grip`: this package is the catalog and
// must not depend on the logging module. The vocabulary is still one
// vocabulary — `TestEveryOfferedGripIsInTheVocabulary` over in `session` fails
// if these two ever name different things.
func OfferedGrips(movementPattern string) []string {
	switch movementPattern {
	case "horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "isolation":
		return []string{"regular", "neutral", "reverse", "angled"}
	case "hinge":
		return []string{"regular", "neutral", "mixed", "hook"}
	case "carry", "olympic":
		return []string{"regular", "neutral", "hook"}
	}
	return nil
}
