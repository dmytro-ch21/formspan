package bjj

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Say what happened, and have it fill the chips.
//
// # A draft, never a session
//
// Nothing in this file writes anything. `POST /v1/bjj/reflect/draft` returns a
// draft the athlete confirms or corrects in the reflection wizard, and the
// confirmed version is PUT through the ordinary session endpoint. That is the
// same rule N26 set for a meal estimate and N41 for a barcode scan, and it is
// the whole design rather than caution: a tag written without confirmation is
// indistinguishable from one the athlete recorded, and every downstream number
// in this module — the funnel, the position map, the focus list — is only worth
// reading because a logged tag is a thing that actually happened.
//
// # Why BJJ suits this better than food did
//
// The target vocabulary is CLOSED: six categories, five events, nine position
// families and 542 technique ids. So this is enum-mapping, not open-ended
// estimation, and a wrong answer is CHECKABLE — an id either exists in the
// catalog or it does not. `ResolveDraft` below is where that check happens, and
// it is the heart of the feature. A plausible-looking id must never reach a
// client unvalidated.
//
// # Transcription is on-device
//
// The athlete dictates into the system keyboard, so this endpoint only ever
// receives TEXT. There is no audio vendor, no upload, and no recording anywhere
// in the stack — which answers open question 4 in bjj-tracking-design.md and
// removes the retention question entirely. What does leave the device is the
// sentence, which is about the athlete's own training and sometimes their body,
// so a client must say where it is going before it sends it. See the note on
// `REFLECT_PROVIDER` in backend/.env.example.

var (
	// ErrDraftRefused is the model declining, or answering with nothing this
	// package can use. Distinct from unavailable, and the distinction is the one
	// a client acts on: a refusal is a real answer about this sentence and will
	// be the same answer next time, so nothing should retry it.
	ErrDraftRefused = errors.New("bjj: could not read that as a session")
	// ErrDraftUnavailable is the upstream being unreachable, erroring, or
	// unconfigured. Retryable, unlike a refusal.
	ErrDraftUnavailable = errors.New("bjj: drafting a reflection is unavailable")
	// ErrDraftUnreachable is the provider never answering at all — a refused
	// connection, a DNS failure, a revoked key, an upstream 5xx.
	//
	// **It WRAPS ErrDraftUnavailable**, so every existing `errors.Is(err,
	// ErrDraftUnavailable)` keeps matching and the cost of overlooking this
	// sentinel somewhere is "behaves as it did before" rather than a 500. Same
	// shape as nutrition's ErrEstimateUnreachable, deliberately — two endpoints
	// with the same problem should not grow two different answers to it.
	//
	// What it changes is that the handler does not METER a call carrying it.
	// The provider spent nothing, so the athlete is charged nothing. F16
	// (#367); `llm.ErrUnreachable` holds the taxonomy.
	ErrDraftUnreachable = fmt.Errorf("%w: the provider never answered", ErrDraftUnavailable)
	// ErrDraftQuotaExhausted is the per-athlete daily cap. Its own error rather
	// than a generic invalid-input, because the client's response is to say when
	// the cap resets rather than to change the request.
	ErrDraftQuotaExhausted = errors.New("bjj: daily reflection draft limit reached")
)

// MaxDictationRunes bounds the input.
//
// A reflection is a paragraph or two said out loud on the walk to the car —
// measured against the eval corpus, the longest case is 341 characters, so this
// is roughly six times the longest thing anyone has actually said to it.
//
// It is a COST bound rather than a safety one, and a mild one: the catalog
// block dominates the request at ~10,600 tokens (measured, see
// DailyReflectionDrafts) and 2,000 characters of speech adds ~500 on top. What
// it really prevents is a caller pasting a book into the one route in this
// module that turns an input directly into somebody's money.
const MaxDictationRunes = 2000

// DictationInput is what the athlete said.
type DictationInput struct {
	// Dictation is the transcript, as the keyboard produced it. Deliberately
	// not cleaned up before sending: the disfluency is signal, and so is
	// whatever the transcription made of "omoplata".
	Dictation string
}

// Validate checks the input before any token is spent.
func (in DictationInput) Validate() error {
	text := strings.TrimSpace(in.Dictation)
	if text == "" {
		return fmt.Errorf("%w: say what happened", ErrInvalidInput)
	}
	if len([]rune(text)) > MaxDictationRunes {
		return fmt.Errorf("%w: dictation is longer than %d characters", ErrInvalidInput, MaxDictationRunes)
	}
	return nil
}

// DraftTag is one tag the model heard, shaped exactly like the `Tag` the
// session endpoint accepts — minus the id, because nothing has been stored.
//
// The field names match `Tag`'s on the wire on purpose: the client's next
// request is `PUT /v1/bjj/sessions/{id}` carrying the tags the athlete
// confirmed, and a draft in a different shape would mean a translation layer
// where the two could disagree about what a tag is. `ResolveDraft` guarantees
// every tag it returns would pass `Tag.Validate()`, which is pinned by a test.
type DraftTag struct {
	Category Category `json:"category"`
	Event    Event    `json:"event"`
	// Position is the family ("Half Guard"), or "" when the athlete did not say.
	Position string `json:"position"`
	// TechniqueID is set only when the words identified ONE catalog entry.
	// Nil is the ordinary outcome and not a failure — see UnresolvedPhrase.
	TechniqueID *string `json:"technique_id"`
	Count       int     `json:"count"`
	// CountHedged is the model's OWN signal that count could not be pinned to
	// a definite number — "a couple", "maybe three or four" — as opposed to a
	// definite number that the guard below could not verify. Read on input
	// only: `ResolveDraft` turns a true value into a Notice and always clears
	// it before a tag is returned (the `omitempty` tag means it never actually
	// serialises `true`), so nothing downstream should read it off a response.
	//
	// N121/#510: without this, a model correctly leaving `count` at 1 for a
	// hedge is indistinguishable on the wire from an athlete who said "one" —
	// both are just `count: 1`, no notice, and the confirm screen shows a
	// confident number instead of asking. This is the signal that tells them
	// apart; see NoticeHedgedCount.
	CountHedged bool `json:"count_hedged,omitempty"`
}

// AsTag is the tag this draft becomes once confirmed, for validating a draft
// against the rules the session endpoint will apply to it anyway.
func (d DraftTag) AsTag() Tag {
	return Tag{
		Category:    d.Category,
		Event:       d.Event,
		Position:    d.Position,
		TechniqueID: d.TechniqueID,
		Count:       d.Count,
	}
}

// UnresolvedPhrase is something the athlete named that does not pick out one
// technique — "armbar" on its own could be a dozen entries.
//
// This is the feature's best idea and not a fallback. A guess here would be
// pre-ticked, plausible, and one tap from permanent; a phrase the athlete
// resolves with the ordinary picker costs them one tap and cannot be wrong.
type UnresolvedPhrase struct {
	Phrase   string   `json:"phrase"`
	Category Category `json:"category"`
	Event    Event    `json:"event"`
}

// The reasons a Notice exists. Part of the contract — a client may branch on
// these; it must never pattern-match the human sentence beside them.
const (
	// NoticeUnknownTechnique is an id that is not in the catalog. The phrase
	// moves to `unresolved` and the tag keeps everything else.
	NoticeUnknownTechnique = "unknown_technique"
	// NoticeNotSpoken is a number that does not appear in the dictation.
	NoticeNotSpoken = "not_spoken"
	// NoticeUnknownValue is a value outside the vocabulary or the scale — a
	// kind this build does not know, an RPE of 12. Separate from
	// NoticeNotSpoken because the remedies differ: one means "we could not find
	// that in your words", the other means "that is not a thing this records".
	NoticeUnknownValue = "unknown_value"
	// NoticeCountBelowOne is a count of zero or less, floored to one.
	NoticeCountBelowOne = "count_below_one"
	// NoticeHedgedCount is the model reporting an indefinite quantity — "a
	// couple", "maybe three or four" — correctly left at 1 rather than
	// invented into one of the numbers named. Distinct from NoticeNotSpoken:
	// there the model proposed a number and it was rejected; here it proposed
	// nothing, on purpose, and the 1 is not a floor but the honest "at least
	// once". Added for N121/#510 — without it, this case and an athlete's own
	// stated "one" are the same `count: 1` with no notice at all.
	NoticeHedgedCount = "hedged_count"
	// NoticeTooManyTags is the tag list being cut to MaxDraftTags.
	NoticeTooManyTags = "too_many_tags"
)

// Notice is one change this package made to the model's answer.
//
// Reported rather than applied silently, and that is the point. Every guard
// below either drops something or rewrites it, and a draft that quietly differs
// from what the model said is a draft nobody can debug and the athlete cannot
// interpret — "we did not find that number in what you said" is a sentence a
// client can show, where a silently blank field is just a blank field.
type Notice struct {
	// Field is the path in the draft: "rounds", "tags[2].count".
	Field string `json:"field"`
	// Was is what the model said, rendered as text because the fields it
	// describes are of different types.
	Was string `json:"was"`
	// Reason is one of the constants above.
	Reason string `json:"reason"`
}

// Draft is what comes back.
//
// Every field mirrors `SessionDetail`'s, including its conventions for absence:
// a nil `Gi` is "didn't say" rather than no-gi, an empty `Kind` is "didn't say"
// rather than a class. Absence is the normal case here, not a degraded one —
// the prompt tells the model that a blank field costs one tap and a wrong one
// that looks right gets confirmed without being read.
type Draft struct {
	Kind         Kind   `json:"kind"`
	Gi           *bool  `json:"gi"`
	Rounds       *int   `json:"rounds"`
	RoundMinutes *int   `json:"round_minutes"`
	SessionRPE   *int   `json:"session_rpe"`
	Note         string `json:"note"`
	BodyNote     string `json:"body_note"`

	Tags       []DraftTag         `json:"tags"`
	Unresolved []UnresolvedPhrase `json:"unresolved"`
	Notices    []Notice           `json:"notices"`

	// Empty reports a well-formed answer with nothing in it, and it is here
	// because of a measurement rather than a hunch.
	//
	// N37 fed `gpt-5.6-luna` a dictation carrying an injected instruction. It
	// neither obeyed nor failed: it wrote no tags at all and put the entire
	// sentence in `note`, INCLUDING dropping the real armbar the athlete had
	// reported. At the transport layer that is a successful call — no refusal
	// stop reason, no `refusal` field, no truncation — so `internal/platform/llm`
	// cannot flag it and deliberately does not try.
	//
	// It is not an error either, because the identical shape is the CORRECT
	// answer to "reminder to buy a mouthguard". So it is neither refused nor
	// silently returned as an ordinary draft: it is reported, and the client
	// says "nothing was picked up from that" rather than showing an empty
	// confirm screen that looks like a successful reading.
	//
	// Note what `Empty` does NOT mean: `note` may be long. A model that dumps
	// the whole sentence into free text has extracted nothing while producing a
	// lot of characters, which is exactly the failure this flag exists for, so
	// note and body_note are excluded from the emptiness test on purpose.
	Empty bool `json:"empty"`

	// Model is the id the provider reports having used, so a later quality
	// question can be answered rather than guessed at.
	Model string `json:"model"`
}

// MaxDraftTags bounds one draft.
//
// Far below `MaxTags` (500), which bounds what a client may STORE, because this
// bounds what a human is about to check by eye. A hard session produces tens of
// tags; a draft past forty is not a reflection anyone corrects in the ninety
// seconds the design budgets, and the honest response to it is to cut the list
// and say so rather than to hand over a wall.
const MaxDraftTags = 40

// CatalogEntry is the one technique fact this feature needs.
//
// A local type rather than `technique.Summary` so the vocabulary this package
// reasons about is visible in this package — and so a test can build a
// three-entry catalog instead of depending on 542 rows of real content.
type CatalogEntry struct {
	ID   string
	Name string
	// Category is the LIBRARY's vocabulary ("Submission", "Transition"), not
	// the tag vocabulary. `toTagCategory` maps between them.
	Category string
	// Position is the library's specific position ("Guard - Bottom"), not the
	// family. `familyOf` maps between them.
	Position string
}

// Catalog is the closed set a draft is resolved against.
type Catalog struct {
	byID     map[string]CatalogEntry
	entries  []CatalogEntry
	families []string
}

// NewCatalog builds the resolution set. Entries are sorted by id, which is
// load-bearing rather than tidy — see `CatalogBlock`.
func NewCatalog(entries []CatalogEntry, families []string) Catalog {
	sorted := make([]CatalogEntry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })

	byID := make(map[string]CatalogEntry, len(sorted))
	for _, e := range sorted {
		byID[e.ID] = e
	}
	fams := make([]string, len(families))
	copy(fams, families)
	return Catalog{byID: byID, entries: sorted, families: fams}
}

// Len is how many techniques the model is offered.
func (c Catalog) Len() int { return len(c.entries) }

// Families is the position vocabulary, in order.
func (c Catalog) Families() []string {
	out := make([]string, len(c.families))
	copy(out, c.families)
	return out
}

// toTagCategory maps the library's nine categories onto the tag vocabulary's
// six.
//
// Mirrors `toCategory` in apps/mobile/lib/bjjSession.ts, and the mirroring is
// checked rather than trusted — a category derived differently on the two sides
// splits one technique's evidence between two rows in the funnel, with nothing
// anywhere reporting an error. Anything without a symmetric opposite lands in
// `control`, which is honest rather than inventing a seventh category.
func toTagCategory(libraryCategory string) Category {
	switch libraryCategory {
	case "Submission":
		return CategorySubmission
	case "Sweep":
		return CategorySweep
	case "Pass":
		return CategoryPass
	case "Escape":
		return CategoryEscape
	case "Takedown":
		return CategoryTakedown
	default:
		return CategoryControl
	}
}

// familyOf maps a specific position onto its family: "Half Guard - Bottom" is
// "Half Guard". Mirrors `familyOf` in bjjSession.ts — exact match, or a " - "
// prefix.
//
// Returns "" for a position no family covers, which is the same value the
// schema offers for "the athlete did not say". That collapse is deliberate: a
// family this build does not know is not a family the athlete can filter by,
// and inventing one would put a chip in the wizard that matches nothing.
func familyOf(position string, families []string) string {
	for _, f := range families {
		if position == f || strings.HasPrefix(position, f+" - ") {
			return f
		}
	}
	return ""
}

// ResolveDraft is the guard, and it is where this feature's honesty lives.
//
// The model is constrained by a JSON schema, so the SHAPE is guaranteed. What
// is not guaranteed is that any of it is TRUE, and the four things checked here
// are the four a server can check without a human:
//
//  1. A technique id exists in the catalog, or the phrase becomes something the
//     athlete picks. Never a nearest neighbour: a fuzzy match would turn "I
//     invented this" into "here is a confident wrong answer", which is strictly
//     worse than saying nothing. Same rule N7 applies to an exercise id.
//  2. A resolved tag's category and position are DERIVED from the catalog entry
//     rather than taken from the response, so the funnel joins.
//  3. A number appears in what the athlete actually said, or it is dropped —
//     see `spokenNumber`.
//  4. The list is bounded and every tag is one the session endpoint would
//     accept.
//
// `dictation` is passed in because of (3): the words are the only evidence a
// count is real, and a draft is checked against them rather than against a
// confidence score the model would happily supply. N40 is why — the first real
// photograph through the food estimator invented an item AND doubled a
// quantity, and flagged the invention three ways while flagging the miscount
// not at all. Confidence answers "can I identify this", never "can I count it".
func ResolveDraft(raw Draft, cat Catalog, dictation string) Draft {
	out := raw
	out.Notices = nil

	// Kind is the one enum the schema cannot police, because the schema's
	// nullable-enum union permits null and this package spells absence as "".
	if out.Kind != "" && !out.Kind.Valid() {
		out.Notices = append(out.Notices, Notice{Field: "kind", Was: string(out.Kind), Reason: NoticeUnknownValue})
		out.Kind = ""
	}

	// The bounds are the SESSION endpoint's own, not new ones: a draft whose
	// rounds are zero or whose RPE is twelve would be refused the moment the
	// athlete confirmed it, and a draft that cannot be confirmed is worse than
	// a blank field.
	out.Rounds = checkedNumber("rounds", raw.Rounds, 1, maxDraftRounds, dictation, &out.Notices)
	out.RoundMinutes = checkedNumber("round_minutes", raw.RoundMinutes, 1, maxDraftRoundMinutes, dictation, &out.Notices)
	out.SessionRPE = checkedNumber("session_rpe", raw.SessionRPE, 1, MaxRPE, dictation, &out.Notices)

	unresolved := make([]UnresolvedPhrase, 0, len(raw.Unresolved))
	for _, u := range raw.Unresolved {
		if strings.TrimSpace(u.Phrase) == "" || !u.Category.Valid() || !u.Event.Valid() {
			continue
		}
		unresolved = append(unresolved, u)
	}

	// Per-tag notices are collected ALONGSIDE the tags rather than appended
	// straight onto the draft, so that `Notice.Field` can index the list the
	// client actually receives.
	//
	// The two lists diverge in both directions: a tag with a broken vocabulary
	// is skipped, and the whole list is truncated at MaxDraftTags AFTER the
	// per-tag checks have run. Using the model's own index would therefore emit
	// `tags[44].count` on a response holding forty tags, and a client resolving
	// that path would index into nothing. Notices belonging to a truncated tag
	// are dropped with it — the tag is not in the answer, so an explanation of a
	// change made to it has nothing to explain.
	tags := make([]DraftTag, 0, len(raw.Tags))
	tagNotices := make([][]Notice, 0, len(raw.Tags))
	for _, t := range raw.Tags {
		var notices []Notice
		if !t.Category.Valid() || !t.Event.Valid() {
			// Unreachable through a structured-output enum, and checked anyway:
			// this package's contract is that every tag it returns is one the
			// session endpoint accepts, and a contract that holds only because
			// of what the provider did today is not a contract.
			continue
		}

		if t.TechniqueID != nil {
			id := strings.TrimSpace(*t.TechniqueID)
			entry, known := cat.byID[id]
			switch {
			case id == "":
				t.TechniqueID = nil
			case !known:
				// NOT dropped and NOT guessed at. The phrase becomes something
				// the athlete resolves with the ordinary picker, so an invented
				// id costs a tap instead of writing a technique nobody named.
				unresolved = append(unresolved, UnresolvedPhrase{
					Phrase: humanisePhrase(id), Category: t.Category, Event: t.Event,
				})
				notices = append(notices, Notice{
					Field: "technique_id", Was: id, Reason: NoticeUnknownTechnique,
				})
				t.TechniqueID = nil
			default:
				// DERIVED, both of them, overwriting whatever the model said.
				// The prompt tells it as much; deriving here is what makes that
				// true rather than hoped for.
				resolved := entry.ID
				t.TechniqueID = &resolved
				t.Category = toTagCategory(entry.Category)
				t.Position = familyOf(entry.Position, cat.families)
			}
		}
		if t.TechniqueID == nil {
			// An untagged tag carries the athlete's own position, which has to
			// be one the wizard can render. Anything else is dropped to "",
			// the schema's own value for "did not say".
			t.Position = familyOf(t.Position, cat.families)
		}

		switch {
		case t.Count < 1:
			notices = append(notices, Notice{
				Field: "count", Was: strconv.Itoa(t.Count), Reason: NoticeCountBelowOne,
			})
			t.Count = 1
		case t.Count > 1 && !spokenNumber(dictation, t.Count):
			// FLOORED TO ONE, not dropped. The tag itself is evidence the thing
			// happened at least once; only the repetitions are unverifiable, and
			// keeping the event while dropping the multiplier is the reading
			// that discards the least.
			notices = append(notices, Notice{
				Field: "count", Was: strconv.Itoa(t.Count), Reason: NoticeNotSpoken,
			})
			t.Count = 1
		case t.Count > maxTagCount:
			// Unreachable in practice — nobody says a number this size out loud,
			// so the trace above catches it first. Kept because `Tag.Validate`
			// enforces the same ceiling and this package's promise is that every
			// tag it emits would pass it.
			notices = append(notices, Notice{
				Field: "count", Was: strconv.Itoa(t.Count), Reason: NoticeUnknownValue,
			})
			t.Count = 1
		}

		// Independent of the switch above, and deliberately not exclusive with
		// it: `CountHedged` is the model's own report about what the athlete
		// SAID, not a verdict about the number that ended up in `count`. A
		// compliant model leaves `count` at 1 for a hedge, which matches no
		// case above (1 is not <1, not >1, not >max) — so without this, a
		// hedge that the model got exactly right produces zero notices and
		// looks identical to an athlete who genuinely said "one". See
		// NoticeHedgedCount and the CountHedged field doc.
		if t.CountHedged {
			notices = append(notices, Notice{
				Field: "count", Was: strconv.Itoa(t.Count), Reason: NoticeHedgedCount,
			})
		}
		t.CountHedged = false // never round-trips true; see the field's doc comment.

		tags = append(tags, t)
		tagNotices = append(tagNotices, notices)
	}

	if len(tags) > MaxDraftTags {
		out.Notices = append(out.Notices, Notice{
			Field: "tags", Was: strconv.Itoa(len(tags)), Reason: NoticeTooManyTags,
		})
		tags = tags[:MaxDraftTags]
		tagNotices = tagNotices[:MaxDraftTags]
	}
	for i, notices := range tagNotices {
		for _, n := range notices {
			n.Field = fmt.Sprintf("tags[%d].%s", i, n.Field)
			out.Notices = append(out.Notices, n)
		}
	}

	out.Tags = tags
	out.Unresolved = unresolved
	out.Note = strings.TrimSpace(out.Note)
	out.BodyNote = strings.TrimSpace(out.BodyNote)
	if out.Notices == nil {
		// Non-nil so an ordinary draft encodes as [] rather than null, matching
		// every other list this API returns.
		out.Notices = []Notice{}
	}
	out.Empty = len(out.Tags) == 0 && len(out.Unresolved) == 0 &&
		out.Kind == "" && out.Gi == nil && out.Rounds == nil &&
		out.RoundMinutes == nil && out.SessionRPE == nil
	return out
}

// The scalar ceilings, which are absurdity bounds rather than opinions about
// training. Nothing here should ever fire on a session somebody had: twenty
// rounds is a competition day and ninety-minute rounds do not exist, so what
// these catch is a misheard number, not a hard night.
const (
	maxDraftRounds       = 30
	maxDraftRoundMinutes = 60
)

// checkedNumber keeps a scalar only if it is in range AND the athlete said it.
//
// Dropping to nil rather than clamping, deliberately. A clamped number is still
// a number the athlete has to notice is wrong; a blank is a field they fill in
// one tap, which the prompt already tells the model is the cheaper failure.
func checkedNumber(field string, v *int, lo, hi int, dictation string, notices *[]Notice) *int {
	if v == nil {
		return nil
	}
	if *v < lo || *v > hi {
		*notices = append(*notices, Notice{Field: field, Was: strconv.Itoa(*v), Reason: NoticeUnknownValue})
		return nil
	}
	if !spokenNumber(dictation, *v) {
		*notices = append(*notices, Notice{Field: field, Was: strconv.Itoa(*v), Reason: NoticeNotSpoken})
		return nil
	}
	return v
}

// numberWords maps a value onto the ways somebody says it out loud.
//
// Not a general number parser: the question is only ever "did this number come
// from the sentence", so it needs the forms a grappler uses for rounds, round
// lengths, RPEs and repetitions, and nothing else. `couple` is 2, `few` is 3 —
// the corpus has a case ("a couple, maybe three") whose honest answer is either
// — and both are accepted because the point is to catch a number that came from
// nowhere, not to adjudicate between two readings of a hedge.
var numberWords = map[int][]string{
	0:  {"zero", "no"},
	1:  {"one", "once", "a", "an", "single"},
	2:  {"two", "twice", "couple", "pair", "double"},
	3:  {"three", "thrice", "few", "several", "couple"},
	4:  {"four"},
	5:  {"five", "handful"},
	6:  {"six"},
	7:  {"seven"},
	8:  {"eight"},
	9:  {"nine"},
	10: {"ten"},
	11: {"eleven"},
	12: {"twelve", "dozen"},
	13: {"thirteen"},
	14: {"fourteen"},
	15: {"fifteen"},
	16: {"sixteen"},
	17: {"seventeen"},
	18: {"eighteen"},
	19: {"nineteen"},
	20: {"twenty"},
	30: {"thirty", "half an hour", "half hour"},
	40: {"forty"},
	45: {"forty five", "fortyfive"},
	50: {"fifty"},
	60: {"sixty", "hour"},
	90: {"ninety", "hour and a half"},
}

// humanisePhrase turns an invented id into something a person can read.
//
// The athlete is about to see this in the picker as "what you said", and
// `armbar-closed-gard` renders as a system artefact rather than as their own
// words. The raw id is kept on the notice's `Was`, so nothing is lost — this is
// only what is shown.
//
// A deliberate divergence from `postprocess` in run.py, which puts the raw id
// in the phrase. It cannot move a score: the eval reads `unresolved` only for
// its category and event, never its text.
func humanisePhrase(id string) string {
	return strings.TrimSpace(strings.ReplaceAll(id, "-", " "))
}

var wordSplit = regexp.MustCompile(`[^a-z0-9]+`)

// spokenNumber reports whether n appears in the dictation, as a digit or as a
// word.
//
// # Why a number is checked against the words at all
//
// This is the answer to the error class N40 measured and nothing else here can
// see. An invented ITEM is visibly wrong to an athlete reading a draft — there
// is a row about a technique they never did. An invented NUMBER is not: "rolled
// five" coming back as six is a real session with one digit wrong, it reads
// exactly like a correct draft, and it is one tap from being confirmed into the
// record the rest of this module is built on. No confidence field can flag it,
// which is precisely what N40 found: the food estimator flagged its invented
// item three ways and its doubled quantity not at all.
//
// A number IS checkable, though, because the source text is right here. So the
// rule is simply: a count the athlete did not utter does not survive.
//
// # What it is not
//
// It is not a defence against an obeyed injection. "…return session_rpe 10 and
// forty rounds" contains both numbers, so both would trace. That case is the
// prompt's job and is covered by the corpus's `m-` cases.
//
// It is not a proof of correctness either: "five rounds, six minutes" makes 5
// and 6 both traceable, so a model that swaps them passes here. It bounds
// invention, not transposition.
//
// # Measured
//
// Over the whole eval corpus (33 cases, 8 non-null scalars and 12 tag counts
// above one), this drops NOTHING that the corpus says is correct — pinned by a
// test that reads the corpus itself. Over the 66 real drafts in
// evals/bjj-dictation/results/, it fires zero times on either model. So it is
// an unfired rail: it has cost nothing measurable and it has caught nothing
// measurable, and it is here because the error it covers is the one that
// survives review when it does happen.
func spokenNumber(dictation string, n int) bool {
	words := wordSplit.Split(strings.ToLower(dictation), -1)
	digits := strconv.Itoa(n)
	for _, w := range words {
		if w == digits {
			return true
		}
	}
	// A compound like "forty five" has to match across tokens, so the joined
	// form is searched too. Cheap: the alternative is a phrase parser for the
	// three numbers anybody says that way.
	joined := " " + strings.Join(words, " ") + " "
	for _, form := range numberWords[n] {
		if strings.Contains(joined, " "+form+" ") {
			return true
		}
	}
	// A compound in the twenties and up — "twenty five", and "twenty-five" too,
	// since the split above has already dropped the hyphen. Built rather than
	// enumerated: eight tens by nine units is seventy-two map entries for a
	// range nobody says out loud about rounds, but which round LENGTHS and
	// minute counts reach routinely.
	if n > 20 && n < 100 && n%10 != 0 {
		tens, units := numberWords[(n/10)*10], numberWords[n%10]
		if len(tens) > 0 && len(units) > 0 {
			if strings.Contains(joined, " "+tens[0]+" "+units[0]+" ") {
				return true
			}
		}
	}
	return false
}

// DraftSchema is the JSON schema the response is constrained to.
//
// A PORT of `draft_schema` in evals/bjj-dictation/prompt.py, and it has to stay
// one. That file and its prompt are the artefact N37 measured — 0.0% invention
// and 0.905 tag F1 on `gpt-5.6-luna` — and a score describes the prompt and
// schema it was run against and nothing else. Change either here and the
// measurement no longer describes what ships, so `reflect_parity_test.go`
// compares the two and fails when they drift.
//
// Structured outputs support `enum` and `additionalProperties: false`, which
// covers category, event, position and gi exactly. They do NOT support
// `minimum`, so "count is at least 1" and "RPE is 1-10" are not expressible
// here — that is `ResolveDraft`'s job, exactly as it is for a hand-typed
// reflection. Model output is untrusted input.
func DraftSchema(families []string) map[string]any {
	positions := make([]any, 0, len(families)+1)
	positions = append(positions, "")
	for _, f := range families {
		positions = append(positions, f)
	}

	tag := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"category", "event", "position", "technique_id", "count", "count_hedged"},
		"properties": map[string]any{
			"category":     map[string]any{"type": "string", "enum": enumOf(categoryStrings())},
			"event":        map[string]any{"type": "string", "enum": enumOf(eventStrings())},
			"position":     map[string]any{"type": "string", "enum": positions},
			"technique_id": map[string]any{"type": []any{"string", "null"}},
			"count":        map[string]any{"type": "integer"},
			// See DraftTag.CountHedged: true only for an indefinite quantity
			// ("a couple", "maybe three or four"), never for a plain unstated
			// count — that is simply false, not a hedge.
			"count_hedged": map[string]any{"type": "boolean"},
		},
	}
	unresolved := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"phrase", "category", "event"},
		"properties": map[string]any{
			"phrase":   map[string]any{"type": "string"},
			"category": map[string]any{"type": "string", "enum": enumOf(categoryStrings())},
			"event":    map[string]any{"type": "string", "enum": enumOf(eventStrings())},
		},
	}
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required": []any{
			"kind", "gi", "rounds", "round_minutes", "session_rpe",
			"note", "body_note", "tags", "unresolved",
		},
		"properties": map[string]any{
			"kind":          map[string]any{"type": []any{"string", "null"}, "enum": append(enumOf(kindStrings()), nil)},
			"gi":            map[string]any{"type": []any{"boolean", "null"}},
			"rounds":        map[string]any{"type": []any{"integer", "null"}},
			"round_minutes": map[string]any{"type": []any{"integer", "null"}},
			"session_rpe":   map[string]any{"type": []any{"integer", "null"}},
			"note":          map[string]any{"type": []any{"string", "null"}},
			"body_note":     map[string]any{"type": []any{"string", "null"}},
			"tags":          map[string]any{"type": "array", "items": tag},
			"unresolved":    map[string]any{"type": "array", "items": unresolved},
		},
	}
}

// The vocabularies as plain strings, taken from the same slices the rest of the
// module validates against so the schema cannot offer a value `Tag.Validate`
// would reject.
func categoryStrings() []string {
	out := make([]string, 0, len(categories))
	for _, c := range Categories() {
		out = append(out, string(c))
	}
	return out
}

func eventStrings() []string {
	out := make([]string, 0, len(events))
	for _, e := range Events() {
		out = append(out, string(e))
	}
	return out
}

func kindStrings() []string {
	out := make([]string, 0, len(kinds))
	for _, k := range Kinds() {
		out = append(out, string(k))
	}
	return out
}

func enumOf(values []string) []any {
	out := make([]any, 0, len(values))
	for _, v := range values {
		out = append(out, v)
	}
	return out
}
