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

- [x] **W1** — 1RM estimate counts spotted reps. Nothing reads `soloReps`, so a spotted 8×102.5 estimates ~127 kg where honest solo-5 is ~115; also sets rep PRs not completed unaided. Done together with T1 — #231. (#226)
- [x] **W2** — A drop counts as a set in the Sets tile but not in the row numbers, so one screen shows both answers. Cross-stack: `localVolume` must match the server, and the same figure feeds Today and the calendar. — done #238, a drop no longer counts as a set but still contributes volume (#227)
- [ ] **W3** — Per-side load is right everywhere but unexplained: no "enter one dumbbell" hint, no `30 kg × 2 = 60` on a logged set. The athlete can do that maths and conclude the app is wrong. (#224)

## T — Traps set for the next change

Each compiles, passes its tests, and is wrong. Read before starting the related work.

- [x] **T1** — Add `assisted_reps` to `RecentEfforts`, `BestOneRMs`, `bestOneRMSets` and `Records` SELECTs **before** wiring progression to `soloReps`. They don't select it, unrecorded reads as all-solo, so a progression-only change silently reads full reps. — done #231 (#226)
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
- [ ] **L5** — Share leaves a ~1.6 MB temp file per share. **Both halves of the old reason were wrong**: it said "needs a third native dependency" (`react-native-view-shot` already exports `releaseCapture(uri)`, native on both platforms) and priced it at ~1–2 MB when the capture was actually exporting 10.5 MB. Size fixed in #232; cleanup still not done, because calling `releaseCapture` after `shareAsync` resolves needs device verification that every share target has finished reading by then. (#210 #232)
- [ ] **L6** — Instagram Stories direct hand-off. No longer blocked (`vola://` is ours now); what remains is a Facebook App ID, an account decision. (#210)
- [ ] **L7** — Adjacency is unenforced: nothing stops a client writing a stray `drop` row. It's skipped rather than misattributed. (#226)

## H — Housekeeping

- [ ] **H1** — `TestEverySeededTechniqueExistsInTheLibrary` skips in CI (CI never seeds), so the suite reports success while the assertion never runs. *In progress — spun off.*
- [x] **H2** — Document that `-p 1` also enforces cross-package test ordering, not just global counts: `session` alone against an unseeded database fails 23 tests. Documented in #228 (with an interim `TestMain` guard), then **fixed** rather than left documented: `session` (#231), `workout` (#234) and `profile` own their catalog rows now, and every module package passes alone against its own pristine database. `-p 1` is back to isolation only, and the rule is enforced structurally: `exercise`'s seeding tests now delete the catalog after themselves, so there is nothing left to borrow and a reintroduced id fails in the ordinary CI run. (#228 #231 #234)
- [ ] **H3** — Drop stale local databases: `vola_merge`, `vola_mig`, and the `vola_test_*` set from merged branches. They drift from main's schema and read as a broken checkout.
- [ ] **H4** — Mobile tests flake under load, and the two measurements of it **disagree by ~30×** — reconciling them is the first job, not fixing the tests. #235 saw `sharedScreen.test.tsx` "drops the accepted row locally" exhaust its 10s `asyncUtilTimeout` once, then **0 failures in 92 runs**, including under 8-way CPU saturation and alongside the web/admin builds, with 2.4–4.0s of headroom — concluding ≤3%, "low, not a coin flip". #233 then measured **1 failure in 3 runs**, on `main` and on a branch touching zero `apps/` files, across three tests — "keeps the LOCAL copy on screen when the local row is dirty", the same "drops the accepted row locally", and "a preference changed while Today sat mounted" — a different one each time, only under concurrent runs, so CI may be masking it. Both sides ran under load and both are first-hand, so treat the rate as **unknown** rather than adopting either. Cause never diagnosed; the original failures were real. (#232 #233 #235)
- [ ] **H5** — Give `technique`'s seeding tests the same `removeCatalogAfterTest` cleanup `exercise` now has. The 542 library rows survive the suite, so a package could start borrowing technique ids on that residue exactly as three did with exercise ids — and it already has a visible symptom: run the suite twice on one database and **H1**'s test skips on the first run and *passes* on the second (634/1 skip → 635/0), i.e. it silently starts passing on residue, which reads as coverage. Smaller exposure than exercises (`technique` sorts 17th of 19, so only `theme` and `workout` follow). **Read this before starting, because the FK shape inverts the danger:** every table referencing `techniques` is CASCADE or SET NULL, so unlike the exercise cleanup there is no `workout_items`-style wall to abort on — it will succeed *and silently hollow out the 5 seeded curricula* (`curriculum_items.technique_id`, 000034) and any seeded sequences (000035), which is quiet mutation of shared state and guts the very thing H1's test checks. Delete the seeded curricula and sequences first, mirroring the `workouts source='seed'` step this branch had to add. Deferred because **H1** is in flight against that library — do it once H1 lands, or the two collide.

---

## Done

Move nothing here — mark in place above. This section is for whole efforts, not individual lines.

- [x] Per-side dumbbell load — every dumbbell set was counting at half its real value (#224)
- [x] Spotter reps + drop sets, backend (#226) and phone (#227)
- [x] BJJ position map (#213), SQLite transaction serialisation (#214), contests schema (#215)
- [x] Session share card, feed cards, `share_training_details` (#210)
- [x] Check-in card width (#211), `.clerk/` gitignore (#212)
