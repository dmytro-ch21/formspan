# Technique research prompt

A prompt for producing a complete, form-ready BJJ technique entry for VOLA's
admin console (`/content/new`).

**Why it exists:** the console's `Description` field is *parsed*, not displayed —
`executionSteps` in `apps/mobile/lib/techniques.ts` splits it into the numbered
sequence the technique screen renders. The two ways an author would most
naturally write a step list (numbering them, bulleting them) both break it, and
one fails silently. A general "write me a BJJ technique" prompt produces text
that looks right and renders as a paragraph. This one encodes the constraints.

**Keep it in sync.** Everything below is a statement about how the code behaves
today: the parser's rules, the nine categories, the `function` verbs, the
gi/no-gi values. If any of those change, this prompt is wrong. The
`/content/guide` page in the admin console is the same information for a human.

---

## The prompt

> Copy everything between the rules, replacing the technique name on the last
> line.

---

You are helping author an entry for a Brazilian Jiu-Jitsu technique library used
by real practitioners. Accuracy matters more than completeness: this library is
read by people deciding what to drill and what is legal to use in competition.

Research the technique named at the end and return the fields listed below.

## How to research

- Prefer primary and well-established sources: the IBJJF rulebook for legality,
  recognised instructors and academies for mechanics and naming, established
  instructional platforms for setups and counters.
- **Where sources disagree, say so** in the `Source notes` field rather than
  picking one silently. Naming especially varies by lineage.
- **Where you are not confident, leave the field empty and say why.** An empty
  field renders as nothing at all in the app — a section with no content does
  not appear — so a blank is always safe. A guess is not. This is the single
  most important instruction here.
- Do not invent IBJJF legality. If you cannot verify whether a technique is
  legal for a given belt or age division, say "unverified" explicitly.

## The fields

**Name** — the name a coach would actually say. This is also the key other
techniques reference for graph edges, so prefer the most widely recognised form
over a lineage-specific one.

**Aliases** — one per line. Gym slang, Portuguese, common misspellings, the name
a different lineage uses. Search matches these, so this is how somebody finds
the technique when they only know what their own coach calls it. Be generous.

**Category** — exactly one of:
`Control/Pin`, `Escape`, `Guard Retention`, `Other`, `Pass`, `Submission`,
`Sweep`, `Takedown`, `Transition`.
Nothing else — anything outside this list breaks the catalog importer.

**Function** — exactly one of `advance`, `reverse`, `escape`, `control`,
`finish`, or empty. Empty is legal and correct for library content that is not a
technique (breakfalls, stance, movement fundamentals).

**Position** — the coarse family it happens from (e.g. "Closed Guard", "Side
Control", "Mount", "Back Control", "Half Guard", "Standing", "Turtle", "Leg
Entanglement").

**Position detail** — the specific configuration a coach would name: "Knee
shield", "Cross-collar grip", "Underhook half guard".

**To position** — where it leaves you, if it moves you somewhere. Empty means
"not recorded", never "goes nowhere".

**Gi / No-Gi** — exactly one of `Both`, `Gi Only`, `No-Gi Only`.

**Typical belt** — one of `White`, `Blue`, `Purple`, `Brown`, `Black`. This is
advisory ("commonly taught from"), *not* a rule, and it is separate from IBJJF
legality, which is a rule you can be disqualified for breaking. It is also a
filter, so leaving it blank hides the technique from anyone filtering by belt.

### Description — the field with rules

This becomes a numbered step list. **Write it as one ordinary sentence with
clauses separated by commas**, or as one step per line with each line ending in
a full stop. Both work. Then check it against these rules:

1. **Do not number the steps yourself.** `1. Grip the collar. 2. Step through.`
   produces the steps `"1"`, `"Grip the collar, 2"`, `"Step through, 3, ..."` —
   visibly broken.
2. **Do not use bullets or dashes.** A line break is not a separator. Hyphens
   render as literal text and the whole thing stays one paragraph.
3. **Every clause must be at least 10 characters.** Shorter fragments are folded
   into the clause before them. `Break the grip, step in, and finish.` collapses
   to a single step and renders as a paragraph, silently. Write `break the grip,
   step your hips in, and finish the choke` instead.
4. **It must yield at least two steps**, or it renders as a paragraph. That is
   intentional — a one-item numbered list reads as a bug — so a technique that
   genuinely is one action should just be one sentence.

Aim for 3–6 steps. Each step should be one physical action, in the order it
happens, written as an instruction ("grip the far collar deep", not "the far
collar is gripped").

**Good:**
`Grip the far collar deep with your right hand, step your left foot across the
hip, and fall back while pulling the elbow tight across the throat.`

**When to use** — plain prose, not parsed, shown as written. Answers *when the
mechanics apply*: the grip you already have, the reaction that opens it, the
mistake it punishes. Keep this out of the description — merged, they answer
neither question well.

**Setup from / Common next moves / Common counters** — names, one per line.
These are matched against other techniques **by name, exactly**. A near-miss is
not an error and not a warning: the edge silently does not resolve and the app
shows nothing. Give the most standard name for each, and flag any you are unsure
exists in a library of ~470 mainstream techniques.

**IBJJF ruleset id** — leave empty unless you know the specific ruleset entry.

**Source notes** — where this came from, and any disagreement between sources.

## Output format

Return each field as a labelled block, ready to paste. Use exactly the field
names above. For empty fields, write the field name followed by `(empty — ` and
your reason.

End with a short section headed **Confidence**, listing anything you could not
verify and anything where sources disagreed. Do not omit this section; if
everything was verifiable, say so.

---

**Technique:** `<NAME HERE>`

---

## Using the result

Paste field by field into `/content/new`. Before saving, re-read the
description against the four rules above — that is the only field where the
console cannot show you what the app will do with your text.

After saving, the technique is live in the catalog immediately, but a release
does not carry it until it has been exported:

```bash
cd backend && go run ./cmd/exportcontent
```

Review that diff and merge it, or the row exists in the database and is missing
from the next environment built from the seed files.
