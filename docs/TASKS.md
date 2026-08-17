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
- [x] **W3** — Per-side load is right everywhere but unexplained: no "enter one dumbbell" hint, no `30 kg × 2 = 60` on a logged set. The athlete can do that maths and conclude the app is wrong. — done #241, the weight field says "per hand" and the row shows "(60kg total)". (#224)
- [x] **W4** — The web sessions list shows two "Working sets" figures on one page under two different rules. The totals strip reads the server's `working_sets` (drops excluded, #238); each `SessionRow` recomputes `s.completed && s.set_type !== 'warmup'` client-side (drops included). Same label, same screen, two answers — W2 exactly, still alive on web because #238 consolidated the MOBILE clients only. — done #241, together with a THIRD bug on the same reduce (it also dropped `load_factor`, halving every dumbbell session). All of it now lives in `sessionVolume()` in `lib/api.ts` with nine tests, because a figure compared across screens must not live in a screen. (#238)

## T — Traps set for the next change

Each compiles, passes its tests, and is wrong. Read before starting the related work.

- [x] **T1** — Add `assisted_reps` to `RecentEfforts`, `BestOneRMs`, `bestOneRMSets` and `Records` SELECTs **before** wiring progression to `soloReps`. They don't select it, unrecorded reads as all-solo, so a progression-only change silently reads full reps. — done #231 (#226)
- [x] **T2** — `createWithin` never writes `load_mode`, so every console-authored dumbbell exercise starts `total` — the halving bug, for new content. No endpoint can correct a row today. — done #244: INSERT and UPDATE both write it, the console has a Load mode select, and an unknown value is a 400 rather than a coercion to `total`. (#224)
- [x] **T3** — Any new `session_sets` column needs mobile pass-through **before** an authoring surface. The server replaces sets wholesale, so a phone shape that doesn't know a column wipes it on first edit. Applies to grip (**N1**). — done #248 with N1. Two corrections worth keeping: the danger is **not** only mobile (any client that PUTs sets), and the worst case is the SERVER's own read — miss `grip` in `attachSets` and every correct client PUTs back a set the server failed to hand it. (#226)
- [ ] **T4** — **Adding a fifth `grip` value will be ERASED by stale clients.** `repairSet` nulls any grip outside mobile's own union — right for garbage, wrong for a value a newer server legitimately added: an old build reads it, nulls it, and the wholesale PUT writes that null back over real data. The guard exists because an illegal value 400s forever with no UI able to clear it. Extending the enum (see **N9** — `mixed`/`hook`) needs this solved first: repair only after a 400 that names grip, or serve the vocabulary, or gate on a client-version floor. (#248)

## F — Worth fixing

- [x] **F1** — The social feed is a `KeyboardAwareFlatList` now, not a `ScrollView` holding every card ever loaded. Header, empty state and the "Show older" footer moved to the list's own slots; the three-way loading/error/empty distinction had to be re-made inside `ListEmptyComponent`, because `data` is `[]` for both "loading" and "quiet". (#210) — done
- [ ] **F2** — Show the card at readable size before sharing. Only preview today is a share-sheet thumbnail, so the calorie figure — an inference from body data — is posted sight-unseen. (#210)
- [ ] **F3** — Review the per-side classifications end to end: **142** are `per_side`, **108** of which double (34 are also `is_unilateral`, so factor 1). Classified by equipment + a hand-written single-implement exclusion list; spot-checks passed, nobody read the list. Known-suspect: `double-dumbbell-kickstand-deadlift` counts ×1 despite the name, and the `alternating-dumbbell-*` rows count ×2. (#224 #241)
- [x] **F4** — Share card exported at 3× its intended size. `captureRef`'s `width` is POINTS and the renderer multiplies by device scale, so 1080 became 3240px/10.5 MB on a 3× phone — the density dependence its own comment claimed to prevent. Measured 1080px/1.6 MB after. (#232) — done

## N — New work

- [x] **N1** — Grip / wrist variation (regular, neutral, reversed, angled). Belongs on the **logged set**, not the catalog: you might press neutral today and regular next week, and a catalog row per grip turns 504 exercises into ~2,000 while still not expressing "I switched on the last set". Needs a design pass. See **T3**. — done #248: `session_sets.grip`, nullable (NULL is unrecorded, never `regular`), picker on mobile gated to pushes/pulls/isolation, read-only on web. (#248)
- [ ] **N2** — Find an exercise by the words you'd use. `pg_trgm` is **already installed** — fuzzy, word-order-independent matching, ~0 ms, no API. Two of three reported "missing" exercises already existed under other names.
- [ ] **N3** — Fill real catalog gaps. **Zero EZ-bar entries in 504 exercises.** Sweep for others.
- [ ] **N4** — Timer on any set. `session_sets.seconds` already exists, so client-only; circuits fall out of it.
- [ ] **N5** — Weight check-in graph (weekly/monthly/yearly), on mobile. Needs CLAUDE.md's platform rule amended — agreed that a trend read in 3 seconds is decision-support, not analysis.
- [ ] **N6** — Per-exercise load over time. Same platform-rule amendment; pairs with **N5**.
- [ ] **N7** — Point the camera at a machine. Can't be trained on our library (8 images for 504 exercises); works as a Claude vision call with an equipment-filtered shortlist. ~1–3 s, ~$0.005/call. After logging is solid.
- [x] **N8** — One working-set rule the copies read instead of restating. The session module's `SQLWorkingSet`, `SQLCountsAsSet` and `SQLTonnage` are exported now, and `feed` uses them in place of its **four** inline restatements. A test asserts the feed's SQL still contains the session module's rule, so a restatement that drifts fails immediately rather than waiting for a fixture that happens to notice. **The Go/SQL and the TS copies remain** — see the entry for why neither can be shared without a bigger change. (#243) — done
- [ ] **N9** — Grip has no `mixed` or `hook`, so the picker is withheld from hinges, carries and olympic lifts — the movements where grip matters MOST. A deadlifter cannot record how they pull. Needs those two values plus a decision on whether `mixed` needs a side. (#248)
- [ ] **N10** — Web cannot author grip, only display it. Its `SetRow` takes a name and booleans, not the `Exercise`, so gating a picker needs a prop change. Logging is a phone thing, so this is for correcting a session at a desk. (#248)

## L — Recorded, low

- [ ] **L1** — Nothing on the phone has been seen on a phone: share card, feed, drop indent, `↳`, Assisted field placement. Typechecked and tested, never looked at. (#210 #227)
- [ ] **L2** — A drop dragged away from its parent re-parents. Inherent cost of expressing the relationship as order, since row ids are regenerated every save. (#227)
- [ ] **L3** — `dropsOf` has no consumer. Mirrors the server for whatever reads a drop group next; dead code until then. (#227)
- [ ] **L4** — 1RM and tonnage read `weight_kg` differently. Deliberate (a per-hand 1RM is what lifters quote) but nothing tells a client. (#224)
- [ ] **L5** — Share leaves a ~1.6 MB temp file per share. **Both halves of the old reason were wrong**: it said "needs a third native dependency" (`react-native-view-shot` already exports `releaseCapture(uri)`, native on both platforms) and priced it at ~1–2 MB when the capture was actually exporting 10.5 MB. Size fixed in #232; cleanup still not done, because calling `releaseCapture` after `shareAsync` resolves needs device verification that every share target has finished reading by then. (#210 #232)
- [ ] **L6** — Instagram Stories direct hand-off. No longer blocked (`vola://` is ours now); what remains is a Facebook App ID, an account decision. (#210)
- [ ] **L7** — Adjacency is unenforced: nothing stops a client writing a stray `drop` row. It's skipped rather than misattributed. (#226)
- [ ] **L8** — `apps/web`'s `describeSet` has **zero callers** and formats raw `${weight}kg`, ignoring the athlete's unit preference. Dead and wrong at once; delete it, or give it units and a caller. (#241)

## H — Housekeeping

- [x] **H1** — `TestEverySeededTechniqueExistsInTheLibrary` skipped in CI (CI never seeds), so the suite reported success while the assertion never ran. **Fixed by reading the EMBEDDED technique catalog instead of querying `techniques`**, so it runs everywhere, needs no database, and cannot skip. Both sides now also fail rather than pass vacuously on an empty file. Note the database version was the *weaker* check: a hand-seeded local DB also holds admin-authored rows, which would satisfy an id no fresh deploy has. (#216)
- [x] **H2** — Document that `-p 1` also enforces cross-package test ordering, not just global counts: `session` alone against an unseeded database fails 23 tests. Documented in #228 (with an interim `TestMain` guard), then **fixed** rather than left documented: `session` (#231), `workout` (#234) and `profile` own their catalog rows now, and every module package passes alone against its own pristine database. `-p 1` is back to isolation only, and the rule is enforced structurally: `exercise`'s seeding tests now delete the catalog after themselves, so there is nothing left to borrow and a reintroduced id fails in the ordinary CI run. (#228 #231 #234)
- [ ] **H3** — Drop stale local databases: `vola_merge`, `vola_mig`, and the `vola_test_*` set from merged branches. They drift from main's schema and read as a broken checkout.
- [ ] **H4** — Mobile tests flake under load, and the two measurements of it **disagree by ~30×** — reconciling them is the first job, not fixing the tests. #235 saw `sharedScreen.test.tsx` "drops the accepted row locally" exhaust its 10s `asyncUtilTimeout` once, then **0 failures in 92 runs**, including under 8-way CPU saturation and alongside the web/admin builds, with 2.4–4.0s of headroom — concluding ≤3%, "low, not a coin flip". #233 then measured **1 failure in 3 runs**, on `main` and on a branch touching zero `apps/` files, across three tests — "keeps the LOCAL copy on screen when the local row is dirty", the same "drops the accepted row locally", and "a preference changed while Today sat mounted" — a different one each time, only under concurrent runs, so CI may be masking it. Both sides ran under load and both are first-hand, so treat the rate as **unknown** rather than adopting either. Cause never diagnosed; the original failures were real. (#232 #233 #235)
- [x] **H5** — Give `technique`'s seeding tests the same cleanup `exercise` has. **Done.** Five full-library seeding sites, not the two a `Seed(ctx` grep finds — three more load it via `UpsertAll(ctx, SeedData())`, and guarding only the two left 542 rows behind with the suite green; the row count found them, the grep did not. The cleanup removes the seeded curricula first because every FK into `techniques` is CASCADE, so a bare delete succeeds and silently guts them (measured: 136 curriculum items → 38, suite green). Side effect: H1's test now skips consistently instead of skipping on a fresh database and passing on a reused one. `positions` (11 rows) left deliberately.
- [ ] **H6** — Claim a task before working it: `TASKS.md` is ordered by priority and has no claim field, so parallel agents converge on the same top line. Two full rounds were lost this way in one afternoon (W2, then W4), both times with the checks genuinely run — a check cannot see unpushed work. Cheapest fix that works with the tooling: an empty commit and a **draft PR** before writing code, since `gh pr list` is the one channel every session can see. Convention, not code. (#242) **And retitle before marking ready** — #242 merged with `[WIP]` in its squash title because the draft's placeholder name was never changed, and that is permanent in `main`'s history.

---

## Done

Move nothing here — mark in place above. This section is for whole efforts, not individual lines.

- [x] Per-side dumbbell load — every dumbbell set was counting at half its real value (#224)
- [x] Spotter reps + drop sets, backend (#226) and phone (#227)
- [x] BJJ position map (#213), SQLite transaction serialisation (#214), contests schema (#215)
- [x] Session share card, feed cards, `share_training_details` (#210)
- [x] Check-in card width (#211), `.clerk/` gitignore (#212)
