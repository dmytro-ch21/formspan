package contest

import (
	"errors"
	"strings"
	"testing"
)

// These cover Validate, which is the ONLY gate on four columns the database
// does not constrain at all (`sport`, `format`, `result`, `method` are TEXT
// with no CHECK) and on six that have no length limit. The migration made that
// trade deliberately — vocabulary in Go so a new value is an enum edit rather
// than a migration — and the trade only pays if these tests hold the line.

func valid() Input {
	return Input{
		Sport: "bjj",
		Name:  "Pan Ams",
	}
}

func TestValidateAcceptsAMinimalEntry(t *testing.T) {
	in := valid()
	if err := in.Validate(); err != nil {
		t.Fatalf("want accepted, got %v", err)
	}
	// A placement alone, or even a name alone, is a complete thing to remember.
	// Matches must still marshal as [] rather than null.
	if in.Matches == nil {
		t.Error("matches should be normalised to an empty slice, not nil")
	}
}

func TestValidateTrimsAndNormalises(t *testing.T) {
	blank := "  "
	in := valid()
	in.Name = "  Pan Ams  "
	in.Organisation = " IBJJF "
	in.Note = " felt good "
	in.DivisionBelt = " brown "
	// The shape a cleared form field arrives in. It means the same as omitting
	// the field, and a caller should not have to special-case its own empty
	// input.
	in.HeldOn = &blank

	if err := in.Validate(); err != nil {
		t.Fatalf("want accepted, got %v", err)
	}
	if in.Name != "Pan Ams" || in.Organisation != "IBJJF" || in.Note != "felt good" {
		t.Errorf("not trimmed: %q %q %q", in.Name, in.Organisation, in.Note)
	}
	if in.DivisionBelt != "brown" {
		t.Errorf("division not trimmed: %q", in.DivisionBelt)
	}
	if in.HeldOn != nil {
		t.Errorf("a blank held_on should normalise to nil, got %q", *in.HeldOn)
	}
}

func TestValidateRejectsANameOfOnlySpaces(t *testing.T) {
	in := valid()
	in.Name = "   "
	// Trimming happens before the emptiness check for exactly this: three
	// spaces is not a name, and storing it would put an invisible row in a
	// career record.
	if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
}

// The cap counts RUNES, and BOTH sides are asserted.
//
// Asserting only the refusal passes against a bytes-for-runes bug, because
// under `len` a 120-character multibyte name is refused too — for the wrong
// reason. CLAUDE.md records a rename endpoint that shipped exactly that, and
// `theme.CleanTitle` exists as its own function so this pair could be written.
func TestNameCapCountsRunesNotBytes(t *testing.T) {
	// Three bytes each in UTF-8, so 120 of them is 360 bytes.
	at := strings.Repeat("技", MaxName)
	in := valid()
	in.Name = at
	if err := in.Validate(); err != nil {
		t.Fatalf("%d multibyte runes must be accepted, got %v", MaxName, err)
	}

	over := valid()
	over.Name = at + "技"
	if err := over.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("%d runes must be refused, got %v", MaxName+1, err)
	}
}

func TestValidateRejectsAnUnknownSport(t *testing.T) {
	in := valid()
	in.Sport = "quidditch"
	if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
	// "nutrition" is a real module and a nonsense sport — the distinction
	// `discipline.ValidSport` exists to make, so this is the case that proves
	// the stricter of the two checks is the one being called.
	in.Sport = "nutrition"
	if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("nutrition is not a sport: want ErrInvalidInput, got %v", err)
	}
}

func TestValidateHeldOn(t *testing.T) {
	for _, bad := range []string{"2026-13-01", "01/02/2026", "2026", "yesterday"} {
		day := bad
		in := valid()
		in.HeldOn = &day
		if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%q: want ErrInvalidInput, got %v", bad, err)
		}
	}
	good := "2026-03-14"
	in := valid()
	in.HeldOn = &good
	if err := in.Validate(); err != nil {
		t.Errorf("a well-formed date must be accepted, got %v", err)
	}
}

func TestValidateFormat(t *testing.T) {
	in := valid()
	in.Format = "ibjjf"
	if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
	// Empty is a real value, not a missing one: a powerlifting meet and a 10k
	// have no format worth naming.
	in.Format = ""
	if err := in.Validate(); err != nil {
		t.Fatalf("an empty format must be accepted, got %v", err)
	}
	in.Format = FormatSubmissionOnly
	if err := in.Validate(); err != nil {
		t.Fatalf("submission_only must be accepted, got %v", err)
	}
}

func TestValidatePlacementAndEntrants(t *testing.T) {
	n := func(i int) *int { return &i }

	cases := map[string]struct {
		placement, entrants *int
		wantErr             bool
	}{
		"both absent":            {nil, nil, false},
		"won it":                 {n(1), n(32), false},
		"placement alone":        {n(3), nil, false},
		"entrants alone":         {nil, n(8), false},
		"zero placement":         {n(0), nil, true},
		"negative placement":     {n(-2), nil, true},
		"zero entrants":          {nil, n(0), true},
		"second of one":          {n(2), n(1), true},
		"last of the field":      {n(64), n(64), false},
		"a real road race":       {n(41203), n(60000), false},
		"placement over INTEGER": {n(maxPlacement + 1), nil, true},
	}
	for name, c := range cases {
		in := valid()
		in.Placement, in.Entrants = c.placement, c.entrants
		err := in.Validate()
		if c.wantErr && !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s: want ErrInvalidInput, got %v", name, err)
		}
		if !c.wantErr && err != nil {
			t.Errorf("%s: want accepted, got %v", name, err)
		}
	}
}

// The overflow arm specifically. `placement` is INTEGER, and a value above its
// ceiling raises SQLSTATE 22003 in Postgres — a numeric range error carrying NO
// constraint name, so the repository's constraint-name translation cannot see
// it and it would surface as a 500. The migration flags this trap in writing.
// Bounding it here is what keeps it a 400.
func TestPlacementAboveTheColumnCeilingIsRefusedBeforeItReachesPostgres(t *testing.T) {
	over := maxPlacement + 1
	in := valid()
	in.Placement = &over
	if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
}

func TestMatchPositionsAreAssignedFromOrder(t *testing.T) {
	in := valid()
	in.Matches = []Match{
		// Deliberately pre-set to nonsense. A caller cannot send `position`
		// through the HTTP request struct at all, so this asserts the domain
		// layer's own guarantee: array order IS bracket order, and nothing
		// downstream depends on what arrived here.
		{Result: Won, Position: 99},
		{Result: Won, Position: 99},
		{Result: Lost, Position: 99},
	}
	if err := in.Validate(); err != nil {
		t.Fatalf("want accepted, got %v", err)
	}
	for i, m := range in.Matches {
		if m.Position != i+1 {
			t.Errorf("match %d: want position %d, got %d", i, i+1, m.Position)
		}
	}
}

func TestValidateMatchVocabulary(t *testing.T) {
	in := valid()
	in.Matches = []Match{{Result: "drew"}}
	// A draw is deliberately outside the vocabulary — IBJJF brackets do not
	// draw. If one is ever added this test is the place it announces itself.
	if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput for an unknown result, got %v", err)
	}

	in.Matches = []Match{{Result: Won, Method: "heel hook"}}
	if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput for an unknown method, got %v", err)
	}

	in.Matches = []Match{{Result: Won, Method: ""}}
	if err := in.Validate(); err != nil {
		t.Fatalf("an unrecorded method must be accepted, got %v", err)
	}
}

func TestTechniqueIsOnlyMeaningfulOnASubmission(t *testing.T) {
	tech := "armbar-from-guard"
	in := valid()
	in.Matches = []Match{{Result: Won, Method: MethodPoints, TechniqueID: &tech}}
	// Refused rather than silently dropped: quietly discarding a field the
	// client believed it sent is how a UI ends up showing a value the server
	// never stored.
	if err := in.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}

	in.Matches = []Match{{Result: Won, Method: MethodSubmission, TechniqueID: &tech}}
	if err := in.Validate(); err != nil {
		t.Fatalf("a submission may name its technique, got %v", err)
	}
}

func TestABlankTechniqueIsAbsentRatherThanAMissingForeignKey(t *testing.T) {
	blank := ""
	in := valid()
	// A cleared select sends "". Normalised to nil BEFORE the submission check,
	// so it must not trip the rule above either.
	in.Matches = []Match{{Result: Won, Method: MethodPoints, TechniqueID: &blank}}
	if err := in.Validate(); err != nil {
		t.Fatalf("want accepted, got %v", err)
	}
	if in.Matches[0].TechniqueID != nil {
		t.Error("a blank technique_id should normalise to nil")
	}
}

// The cap exists because `contest_matches.position` is SMALLINT: position
// 32,768 fails with a 22003 the repository cannot translate by constraint name.
// Both sides asserted so the boundary is pinned rather than assumed.
func TestMatchCountCap(t *testing.T) {
	at := valid()
	at.Matches = make([]Match, MaxMatches)
	for i := range at.Matches {
		at.Matches[i] = Match{Result: Won}
	}
	if err := at.Validate(); err != nil {
		t.Fatalf("%d matches must be accepted, got %v", MaxMatches, err)
	}

	over := valid()
	over.Matches = make([]Match, MaxMatches+1)
	for i := range over.Matches {
		over.Matches[i] = Match{Result: Won}
	}
	if err := over.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("%d matches must be refused, got %v", MaxMatches+1, err)
	}
}

func TestFreeTextCapsCountRunes(t *testing.T) {
	// These six columns have NO length constraint in the database, so this
	// function is the only bound on them. Deleting a cap does not merely worsen
	// an error message here — it lets a megabyte into `opponent`.
	cases := []struct {
		name string
		set  func(*Input, string)
		max  int
	}{
		{"organisation", func(in *Input, v string) { in.Organisation = v }, MaxOrganisation},
		{"division_belt", func(in *Input, v string) { in.DivisionBelt = v }, MaxDivision},
		{"division_age", func(in *Input, v string) { in.DivisionAge = v }, MaxDivision},
		{"division_weight", func(in *Input, v string) { in.DivisionWeight = v }, MaxDivision},
		{"note", func(in *Input, v string) { in.Note = v }, MaxNote},
		{"opponent", func(in *Input, v string) {
			in.Matches = []Match{{Result: Won, Opponent: v}}
		}, MaxOpponent},
		{"match note", func(in *Input, v string) {
			in.Matches = []Match{{Result: Won, Note: v}}
		}, MaxMatchNote},
	}
	for _, c := range cases {
		at := valid()
		c.set(&at, strings.Repeat("技", c.max))
		if err := at.Validate(); err != nil {
			t.Errorf("%s: %d runes must be accepted, got %v", c.name, c.max, err)
		}

		over := valid()
		c.set(&over, strings.Repeat("技", c.max+1))
		if err := over.Validate(); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s: %d runes must be refused, got %v", c.name, c.max+1, err)
		}
	}
}
