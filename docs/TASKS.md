# TASKS

The open list. One line per task, a stable id, a checkbox.

## How to use it

- **Mark done in place**: `- [ ]` → `- [x]`, and append ` — done <PR or date>`. Don't delete the line; a
  finished task is the record that it was considered.
- **Add a task** at the end of its section with the next free id. Ids are never reused, so
  a commit message or a comment can say "closes W2" and still mean something in a year.
- **One line per task.** Two agents editing this file on different branches is normal and the
  conflict is then a single line, resolvable without reading the whole file. Put the detail in
  [decisions/history.md](decisions/history.md), not here.
- **Ordered by what an athlete would notice**, not by effort. If you disagree, move the line and
  say why in the PR — the ordering is a claim, not a formality.

Sections: **W** wrong now · **T** traps · **F** worth fixing · **N** new · **L** low · **H** housekeeping.

---

## W — Wrong on screen right now

These contradict each other or overstate what the athlete did. Visible without looking.

- [ ] **W1** — 1RM estimate counts spotted reps. Nothing reads `soloReps`, so a spotted 8×102.5 estimates ~127 kg where honest solo-5 is ~115; also sets rep PRs not completed unaided. Do **T1** first. (#226)
- [ ] **W2** — A drop counts as a set in the Sets tile but not in the row numbers, so one screen shows both answers. Cross-stack: `localVolume` must match the server, and the same figure feeds Today and the calendar. (#227)
- [ ] **W3** — Per-side load is right everywhere but unexplained: no "enter one dumbbell" hint, no `30 kg × 2 = 60` on a logged set. The athlete can do that maths and conclude the app is wrong. (#224)

## T — Traps set for the next change

Each compiles, passes its tests, and is wrong. Read before starting the related work.

- [ ] **T1** — Add `assisted_reps` to `RecentEfforts`, `BestOneRMs`, `bestOneRMSets` and `Records` SELECTs **before** wiring progression to `soloReps`. They don't select it, unrecorded reads as all-solo, so a progression-only change silently reads full reps. (#226)
- [ ] **T2** — `createWithin` never writes `load_mode`, so every console-authored dumbbell exercise starts `total` — the halving bug, for new content. No endpoint can correct a row today. (#224)
- [ ] **T3** — Any new `session_sets` column needs mobile pass-through **before** an authoring surface. The server replaces sets wholesale, so a phone shape that doesn't know a column wipes it on first edit. Applies to grip (**N1**). (#226)

## F — Worth fixing

- [ ] **F1** — Virtualise the social feed. Plain `ScrollView` holding full cards (~25–35 native views each, 30/page, +30 per "Show older"). `KeyboardAwareFlatList` already exists in the codebase. (#210)
- [ ] **F2** — Show the card at readable size before sharing. Only preview today is a share-sheet thumbnail, so the calorie figure — an inference from body data — is posted sight-unseen. (#210)
- [ ] **F3** — Review the 80 per-side classifications end to end. Classified by equipment + a hand-written single-implement exclusion list; spot-checks passed, nobody read the list. (#224)
- [x] **F4** — Share card exported at 3× its intended size. `captureRef`'s `width` is POINTS and the renderer multiplies by device scale, so 1080 became 3240px/10.5 MB on a 3× phone — the density dependence its own comment claimed to prevent. Measured 1080px/1.6 MB after. (#232) — done

## N — New work

- [ ] **N1** — Grip / wrist variation (regular, neutral, reversed, angled). Belongs on the **logged set**, not the catalog: you might press neutral today and regular next week, and a catalog row per grip turns 504 exercises into ~2,000 while still not expressing "I switched on the last set". Needs a design pass. See **T3**.
- [ ] **N2** — Find an exercise by the words you'd use. `pg_trgm` is **already installed** — fuzzy, word-order-independent matching, ~0 ms, no API. Two of three reported "missing" exercises already existed under other names.
- [ ] **N3** — Fill real catalog gaps. **Zero EZ-bar entries in 504 exercises.** Sweep for others.
- [ ] **N4** — Timer on any set. `session_sets.seconds` already exists, so client-only; circuits fall out of it.
- [ ] **N5** — Weight check-in graph (weekly/monthly/yearly), on mobile. Needs CLAUDE.md's platform rule amended — agreed that a trend read in 3 seconds is decision-support, not analysis.
- [ ] **N6** — Per-exercise load over time. Same platform-rule amendment; pairs with **N5**.
- [ ] **N7** — Point the camera at a machine. Can't be trained on our library (8 images for 504 exercises); works as a Claude vision call with an equipment-filtered shortlist. ~1–3 s, ~$0.005/call. After logging is solid.

## L — Recorded, low

- [ ] **L1** — Nothing on the phone has been seen on a phone: share card, feed, drop indent, `↳`, Assisted field placement. Typechecked and tested, never looked at. (#210 #227)
- [ ] **L2** — A drop dragged away from its parent re-parents. Inherent cost of expressing the relationship as order, since row ids are regenerated every save. (#227)
- [ ] **L3** — `dropsOf` has no consumer. Mirrors the server for whatever reads a drop group next; dead code until then. (#227)
- [ ] **L4** — 1RM and tonnage read `weight_kg` differently. Deliberate (a per-hand 1RM is what lifters quote) but nothing tells a client. (#224)
- [ ] **L5** — Share leaves a ~1–2 MB temp file per share. Deleting it needs a third native dependency; judged not worth it. (#210)
- [ ] **L6** — Instagram Stories direct hand-off. No longer blocked (`vola://` is ours now); what remains is a Facebook App ID, an account decision. (#210)
- [ ] **L7** — Adjacency is unenforced: nothing stops a client writing a stray `drop` row. It's skipped rather than misattributed. (#226)

## H — Housekeeping

- [ ] **H1** — `TestEverySeededTechniqueExistsInTheLibrary` skips in CI (CI never seeds), so the suite reports success while the assertion never runs. *In progress — spun off.*
- [ ] **H2** — Document that `-p 1` also enforces cross-package test ordering, not just global counts: `session` alone against an unseeded database fails 23 tests. *In progress — spun off.*
- [ ] **H3** — Drop stale local databases: `vola_merge`, `vola_mig`, and the `vola_test_*` set from merged branches. They drift from main's schema and read as a broken checkout.
- [ ] **H4** — `sharedScreen.test.tsx` "drops the accepted row locally" is load-sensitive: it exhausts its 10s `asyncUtilTimeout` and fails ~1 run in 3 once the suite count reaches 83. Measured: main 0/4, this branch minus one unrelated new test file 0/4, with it 1/3 — so any 83rd suite trips it, not that file's content. The stable-`getToken` cause is ruled out (the suite uses jest.setup's). Root cause unknown. (#232)

---

## Done

Move nothing here — mark in place above. This section is for whole efforts, not individual lines.

- [x] Per-side dumbbell load — every dumbbell set was counting at half its real value (#224)
- [x] Spotter reps + drop sets, backend (#226) and phone (#227)
- [x] BJJ position map (#213), SQLite transaction serialisation (#214), contests schema (#215)
- [x] Session share card, feed cards, `share_training_details` (#210)
- [x] Check-in card width (#211), `.clerk/` gitignore (#212)
