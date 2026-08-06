# Content authoring — retiring the spreadsheet, and publishing without a PR

Status: **proposal, 2026-08-06. All six steps are built** (see history.md).
Step 6 landed against **staging** rather than production, which does not exist
yet — the environment is a variable, and the console now says which one it is
writing to. It complements
[history.md](history.md) (what was decided and when) and describes where the
content pipeline should end up, in two phases that can land months apart.

The immediate goal is narrow: **stop the spreadsheet being the authoring
surface.** The longer goal is the one worth designing toward: **author and
publish catalog content from the admin console, with no PR and no deploy.**

---

## 1. Where content comes from today

Three writers, and they do not have equal rights.

| Writer | Owns | Reaches production by |
| --- | --- | --- |
| The spreadsheet (`.xlsx`, outside the repo) | 450 of 542 techniques, 504 of 504 exercises | import → JSON → PR → deploy → seed |
| Hand-edited `*.additions.json` | 92 techniques, 0 exercises | PR → deploy → seed |
| The admin console (`/content`) | anything it created | writes the database directly |

The asymmetry is the problem. A technique the console created can be edited in
three ways. One of the 450 can be edited in exactly **one** way — a file on a
laptop — because:

- the console refuses it: `UPDATE … WHERE id = $1 AND source = 'admin'`
  ([content_postgres.go:101](../../backend/internal/modules/technique/content_postgres.go:101));
- editing `techniques.json` is reverted by the next import, which is a **full
  replacement** rather than a patch;
- `techniques.additions.json` refuses sheet-owned ids outright
  (`refuseSheetOwned` in `cmd/exportcontent`).

### The mechanic that makes the rest of this document possible

`cmd/seed` upserts by id, and the update is scoped:

```sql
ON CONFLICT (id) DO UPDATE SET … WHERE techniques.source = 'seed' AND (…changed…)
```

Three consequences worth stating plainly, because the whole design rests on
them:

1. **A row marked `source = 'admin'` is immune to deploys.** Reseeding on every
   deploy cannot touch it.
2. **Seeding never deletes a technique.** Only orphan rulesets are pruned, so a
   console-created row survives any number of reseeds.
3. **`source` is database state, not content state.** There is no `source` field
   in `techniques.json`. A brand-new environment seeds *everything* as
   `'seed'` — so "who owns this row" does not travel between environments. This
   is the single most important fact for phase 2 and the easiest to miss.

---

## 2. What the spreadsheet costs

It earned its place. 450 rows × 21 columns, built in three visible enrichment
passes (`completed` → `enriched` → `ibjjf-legality`). That is spreadsheet work,
and hand-writing 450 JSON objects would have been worse.

What it costs now, measured on this week rather than imagined:

- **Adding 202 aliases took two PRs**, a generator, an apply tool with a drift
  guard, and a hunt across six candidate `.xlsx` files to establish which was
  real. The content change itself was one column.
- **It lives outside git**, in two hand-synced copies, with nothing detecting
  drift between them. They happened to be byte-identical. Nothing guarantees
  the next pair will be.
- **Its pipeline only runs when a human runs it**, which is why PR #147 could
  break the importer and survive two review passes and a green CI. The break
  was found by re-importing, weeks later, by accident.
- **It is already not the source of truth.** `to_position` — 170 authored
  destinations — exists only in `techniques.json` and is carried forward on
  every import, because the sheet has no such column. The precedent for "the
  JSON owns a field the sheet does not" is already load-bearing.

---

## 3. Phase 1 — retire the spreadsheet — **DONE**

**This is smaller than it looks, and smaller than I first described it.** The
only reason a JSON edit to a seeded row fails to stick is that someone might
re-run the importer. Remove the importer from the authoring path and the
problem is gone by construction — no data migration, no `source` flip, no
change to how anything is seeded.

### What changes

1. **`techniques.json` and `exercises.json` become hand-authored**, not
   generated. They are already the deploy artifact, already committed, already
   the thing `//go:embed` bakes in. This only changes who writes them.
2. **`scripts/import-exercise-catalog.py` stops being an authoring step.** Keep
   it in-tree as a historical record of how the catalog was built — it also
   documents the taxonomy derivation — but mark it clearly as retired, and
   delete the "regenerate from the sheet" instructions from `CLAUDE.md` and the
   README.
3. **`techniques.additions.json` is folded back into `techniques.json` and
   deleted.** Its entire purpose is surviving a re-import. With no re-import,
   two files where one will do is just a second place to forget. Same for
   `exercises.additions.json`, which is already empty.
4. **The taxonomy moves or is frozen.** *(Built — and only half of it moved,
   deliberately.)* `apply_taxonomy` did two things. The leg-entanglement
   `position` rule is a genuine invariant and is now a biconditional check in
   the Go seed validator, running in CI on every `SeedData()`. The `function`
   regexes did **not** move: as a build step over a sheet with no function
   column they were reasonable, but as a validator they would make a name
   pattern a hard requirement for new content — authoring "Cement Mixer" in the
   console would be rejected for matching no rule, which is precisely how the
   gap-fill broke the importer. `function` is authored data now, checked against
   the vocabulary and nothing more.
5. **The console's write surface widens.** Once the deploy is the only other
   writer, there is no reason `/content` cannot edit any row — see phase 2 for
   what that requires.

### What it costs

You lose bulk editing in a grid. That matters for a future pass like "add a
video URL to all 542", and the answer is a **JSON → XLSX export** you edit and
re-import as a one-off, rather than the sheet permanently owning the rows. Note
the inversion: export-then-import is a tool you reach for; import-as-authoring
is an ownership claim that costs you every other day.

### Risks

- **Losing the spreadsheet's provenance.** The `.xlsx` files carry the shape the
  content was authored in. Mitigation: commit a final export under
  `docs/content/` as an archive, or keep the files where they are and note the
  path.
- **The one-way door.** Once the JSON diverges from the sheet, re-importing
  becomes destructive. *(Built, and harder than proposed: the importer refuses
  unconditionally, with no override. An override was drafted and then removed on
  the evidence — the sheet holds 450 rows and the catalog 542, so a re-import
  can only ever drop the 92 this repo authored. That is an override of
  correctness, not of caution.)*

---

## 4. Phase 2 — publish from the console, no PR

The end state you actually want: open `/content`, write a technique, publish it,
and athletes have it. No PR, no deploy, no `cmd/seed`.

Most of this already exists. The console writes to the database, the write path
shares `ValidateFields` with the seeder, ids are immutable (`UPDATE … WHERE id
= $1` never sets `id`), and `source = 'admin'` already makes a row immune to
deploys. What's missing is everything that the PR was quietly providing.

### What the PR is currently doing for you

| The PR provides | Without it you need |
| --- | --- |
| Review before a permanent id exists | Validation the console enforces, and a rename path or an explicit "ids are forever" gate |
| A durable copy in git | A backup story for content that exists only in a database |
| Rollback (revert + deploy) | Content versioning and an undo in the product |
| Promotion between environments | A deliberate answer to "I edited staging; how does production get it?" |
| A record of who changed what | An audit trail on the row |

None of these is a reason not to do it. They are the work.

### The four things that make it safe

**1. The JSON becomes a generated snapshot, not an authored file.**
A fresh environment still has to come from somewhere, and `//go:embed` is a
good bootstrap. So `cmd/exportcontent` keeps running — but on a schedule, as a
bot commit, not as a human PR. The snapshot's job stops being "the source of
truth" and becomes "how a new environment starts, and where the backup is."

Note this interacts with fact 3 in §1: a fresh environment seeds everything as
`'seed'`, so a restored database silently re-grants deploy ownership of rows the
console owned. Either the snapshot carries `source`, or restore has to re-flip
it. **This is the sharpest edge in the whole design.**

**2. Draft and published are different states.**
Today a console write is live the instant it commits. That is fine when a PR
stands between the write and production; it is not fine when nothing does. A
`status` column (`draft` / `published`) with the public API filtering to
published is the minimum, and it also gives you a place to stage a batch.

**3. Every write is audited and reversible.**
Today the only provenance is `updated_at`. For content that reaches athletes
with no review, you want who, when, and what it was before — a
`content_revisions` table written in the same transaction as the update. That
buys rollback in the product, which is what replaces "revert the commit."

**4. One environment is where content is written. — DECIDED: production;
STAGING in the meantime.**
The honest version of "no PR" is that content is authored in production, because
anything else re-invents promotion. Confirmed 2026-08-06. Staging is therefore a
place to try the console, not a place content flows from, and cross-environment
promotion is off the design board entirely.

Two consequences follow immediately, and they reorder the plan:

- **There is no production Postgres yet.** Only `staging`, currently doing
  double duty for dev and testing. Resolved by making the environment a
  variable rather than waiting: the console points at staging today and moves
  by changing `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_CONTENT_ENV`. What that
  needed was not a config mechanism — one already existed — but for the console
  to SAY which environment it is writing to, since content saves live and a
  console is a tab you leave open.
- **The durability gap is live NOW, not later.** The moment content is authored
  in any console, the database is its only copy: nothing in this repo documents
  a backup, and the snapshot export is what would provide one. That is a
  content-loss exposure, and content loss is silent — which is why the snapshot
  moves to the front of the queue rather than sitting behind two features.

### What it does not need

A CMS. A workflow engine. Multi-user approvals. There is one author.

---

## 5. Sequencing

| Step | Depends on | Rough size |
| --- | --- | --- |
| 1. Retire the importer; fold the additions files in; move the taxonomy into Go | nothing | small |
| 2. Widen the console to edit any row — **DONE**, and note it is not a "drop the restriction": the clause MOVES to the SET clause, or the next deploy reverts every edit | 1 | small |
| 3. Scheduled snapshot export — **DONE** (`.github/workflows/content-snapshot.yml`), as a bot PR rather than a bot commit: the files it writes are the bootstrap, so they get CI-equivalent validation before landing | 2 | medium |
| 4. `status` draft/published, API filters to published — **DONE** for techniques; the exercise catalog deliberately did not get a column it has no publish path for | 2 | medium |
| 5. Revisions + audit + rollback — **DONE** as `technique_revisions`: snapshots rather than diffs, rollback appends rather than truncates, and restore never touches `status` | 2 | medium |
| 6. Point the console at an environment — **DONE**, at staging, with the target shown in the console. The "stop reseeding content on deploy" half turned out to be already done and better done: `source = 'seed'` scopes the seeder, so a deploy skips console-owned rows selectively rather than the whole seed being switched off, which a fresh environment still needs | 3, 4, 5 | small |

Steps 1 and 2 are done. Every one of the 542 techniques is editable from the
console, and a content fix is a PR that touches one JSON file instead of a
spreadsheet expedition.

**Reordered once production was confirmed as the authoring environment.** The
snapshot was step 5 and is now step 3, because the three remaining features
answer different risks and only one of them is silent:

| Risk | Answered by | Severity |
| --- | --- | --- |
| Content exists only in one database and is lost | snapshot export | **silent and total** |
| A half-written technique is live to athletes | draft/published | visible, self-correcting |
| An edit needs undoing | revisions/rollback | inconvenient; re-editing works |

Durability before features. The other two can be reordered freely; each is safe
to stop at.

---

## 6. What I would want decided before starting

1. ~~**Is production really where content gets authored?**~~ **ANSWERED
   2026-08-06: yes.** Promotion between environments is therefore not a design
   problem — there is one place content is written. Note the follow-on it
   exposes: production does not exist yet, so step 6 is gated on infrastructure
   rather than on the work above it.
2. **What is the rollback expectation?** "Undo my last edit" is a revisions
   table. "Restore the catalog to last Tuesday" is snapshots. They are different
   builds.
3. **Do exercises follow techniques?** They share the mechanism (`source`,
   `exportcontent`, an additions file) but not the pressure — the exercise
   catalog is not being actively authored. Retiring its spreadsheet is nearly
   free; giving it a publish flow may not be worth it yet.
4. **What replaces review for the failure it actually caught?** On this
   library's PRs, review caught wrong-row aliases and an id that needed renaming
   before it became a permanent foreign key. Neither is a validation rule. A
   console that lets you fix content in ten seconds also lets you break it in
   ten seconds, and that trade is probably right — but it should be a trade you
   made on purpose.
