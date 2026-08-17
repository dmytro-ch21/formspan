# TASKS

The open list. One line per task, a stable id, a checkbox.

## How to use it

- **Claim before you work.** This list is priority-ordered, so every session picks the same top line —
  two full rounds were lost that way in one afternoon. Run `gh pr list --state open` first (a draft PR
  is a claim), then claim with an empty commit and a draft PR titled `[claim] <ID> — <task>` before
  writing code. A check cannot see unpushed work; `gh pr list` is the one channel every session sees.
  Full rationale in [CLAUDE.md](../CLAUDE.md#claiming-hard-rule).
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
- [ ] **W5** — The lunge / split-squat / step-up family disagrees with itself about implement count, and at least one side of every pair is wrong. Every **kettlebell** lunge doubles; every **dumbbell** lunge except `dumbbell-lunge` does not — same movement, opposite factor by equipment. Worse within one implement: `kettlebell-split-squat` ×2 vs `kettlebell-bulgarian-split-squat` ×1. Provable from internal inconsistency alone, but which side is right is a product call (is a dumbbell lunge one dumbbell or two?), so it wants a decision before ~14 rows move athletes' tonnage. Found by review of #254. (#254)

## T — Traps set for the next change

Each compiles, passes its tests, and is wrong. Read before starting the related work.

- [x] **T1** — Add `assisted_reps` to `RecentEfforts`, `BestOneRMs`, `bestOneRMSets` and `Records` SELECTs **before** wiring progression to `soloReps`. They don't select it, unrecorded reads as all-solo, so a progression-only change silently reads full reps. — done #231 (#226)
- [x] **T2** — `createWithin` never writes `load_mode`, so every console-authored dumbbell exercise starts `total` — the halving bug, for new content. No endpoint can correct a row today. — done #244: INSERT and UPDATE both write it, the console has a Load mode select, and an unknown value is a 400 rather than a coercion to `total`. (#224)
- [x] **T3** — Any new `session_sets` column needs mobile pass-through **before** an authoring surface. The server replaces sets wholesale, so a phone shape that doesn't know a column wipes it on first edit. Applies to grip (**N1**). — done #248 with N1. Two corrections worth keeping: the danger is **not** only mobile (any client that PUTs sets), and the worst case is the SERVER's own read — miss `grip` in `attachSets` and every correct client PUTs back a set the server failed to hand it. (#226)
- [ ] **T4** — **Adding a fifth `grip` value will be ERASED by stale clients.** `repairSet` nulls any grip outside mobile's own union — right for garbage, wrong for a value a newer server legitimately added: an old build reads it, nulls it, and the wholesale PUT writes that null back over real data. The guard exists because an illegal value 400s forever with no UI able to clear it. Extending the enum (see **N9** — `mixed`/`hook`) needs this solved first: repair only after a 400 that names grip, or serve the vocabulary, or gate on a client-version floor. (#248)

## F — Worth fixing

- [x] **F1** — The social feed is a `KeyboardAwareFlatList` now, not a `ScrollView` holding every card ever loaded. Header, empty state and the "Show older" footer moved to the list's own slots; the three-way loading/error/empty distinction had to be re-made inside `ListEmptyComponent`, because `data` is `[]` for both "loading" and "quiet". (#210) — done
- [x] **F2** — Tapping Share now opens the card at readable size with Share / Not now, instead of going straight to the share sheet whose only preview is a ~40pt thumbnail. Lives in `ShareCardHost`, so the celebration, the finished strength session and the BJJ class all inherit it. The off-screen capture card stays the capture source — that path is measured, and a preview inside a `Modal` is exactly the "is it laid out" question that produces blank PNGs. (#210) — done
- [ ] **F3** — **Eleven fixed, the sweep is not finished.** Seven single-implement movements (`svend`, `hip-thrust`, `glute-bridge`, `russian-twist`, `offset`) were `per_side` while their identical peers (`goblet-squat`, `halo`, `pullover`) were correctly `total`; the two `alternating-dumbbell-*` doubled a dumbbell they move one at a time; `double-dumbbell-kickstand-deadlift` counted ×1 because `is_unilateral` was true about the STANCE. A name guard now fails on all eleven if reintroduced. **Left open — see W5.** (#224 #241 #254)
- [x] **F4** — Share card exported at 3× its intended size. `captureRef`'s `width` is POINTS and the renderer multiplies by device scale, so 1080 became 3240px/10.5 MB on a 3× phone — the density dependence its own comment claimed to prevent. Measured 1080px/1.6 MB after. (#232) — done

## N — New work

- [x] **N1** — Grip / wrist variation (regular, neutral, reversed, angled). Belongs on the **logged set**, not the catalog: you might press neutral today and regular next week, and a catalog row per grip turns 504 exercises into ~2,000 while still not expressing "I switched on the last set". Needs a design pass. See **T3**. — done #248: `session_sets.grip`, nullable (NULL is unrecorded, never `regular`), picker on mobile gated to pushes/pulls/isolation, read-only on web. (#248)
- [x] **N2** — Find an exercise by the words you'd use. `pg_trgm` is **already installed** — fuzzy, word-order-independent matching, ~0 ms, no API. Two of three reported "missing" exercises already existed under other names. — done #255. **ALL THREE existed.** And trigrams alone fix only one of them: measured, "bench"→"press" and "overhead"→"shoulder" are vocabulary, not spelling, so a small synonym map does the other two. Ranking runs on the EXPANDED query, or a row containing every typed word outranks the movement meant.
- [x] **N3** — Fill real catalog gaps. **Zero EZ-bar entries in 504 exercises.** Sweep for others. — **closed as STALE, not done (#255).** The premise is false: there are **20** EZ-bar entries and the catalog is **762**, not 504. All three exercises reported missing exist today (Incline Dumbbell Press, EZ-Bar Curl, Seated Dumbbell Shoulder Press) — the complaint was findability, which is **N2**. Reopen with a measured gap if one is found; do not act on the numbers in this line.
- [ ] **N4** — Timer on any set. `session_sets.seconds` already exists, so client-only; circuits fall out of it.
- [ ] **N5** — Weight check-in graph (weekly/monthly/yearly), on mobile. Needs CLAUDE.md's platform rule amended — agreed that a trend read in 3 seconds is decision-support, not analysis.
- [ ] **N6** — Per-exercise load over time. Same platform-rule amendment; pairs with **N5**.
- [ ] **N7** — Point the camera at a machine. Can't be trained on our library (8 images for 504 exercises); works as a Claude vision call with an equipment-filtered shortlist. ~1–3 s, ~$0.005/call. After logging is solid.
- [x] **N8** — One working-set rule the copies read instead of restating. The session module's `SQLWorkingSet`, `SQLCountsAsSet` and `SQLTonnage` are exported now, and `feed` uses them in place of its **four** inline restatements. A test asserts the feed's SQL still contains the session module's rule, so a restatement that drifts fails immediately rather than waiting for a fixture that happens to notice. **The Go/SQL and the TS copies remain** — see the entry for why neither can be shared without a bigger change. (#243) — done
- [ ] **N9** — Grip has no `mixed` or `hook`, so the picker is withheld from hinges, carries and olympic lifts — the movements where grip matters MOST. A deadlifter cannot record how they pull. Needs those two values plus a decision on whether `mixed` needs a side. (#248)
- [ ] **N10** — Web cannot author grip, only display it. Its `SetRow` takes a name and booleans, not the `Exercise`, so gating a picker needs a prop change. Logging is a phone thing, so this is for correcting a session at a desk. (#248)
- [x] **N11** — Feed reaches back 3 days only, and the poster leads with an avatar. The window is a rolling 72h on `ended_at` inside `visibleFrom`, so the count cannot disagree with the list; the avatar is a monogram derived from the handle (no upload path, nothing new on the wire, stable colour per person). — done #252
- [ ] **N12** — Real uploaded avatars. The monogram is the fallback layer either way, so this is additive: needs `profiles.avatar_url`, the platform `objectstore` wired up, an upload surface, resizing, and a moderation answer — `display_name` is already unguarded prose friends can see and a photo is worse. (#252)
- [ ] **N13** — The 3-day feed window is not configurable and not surfaced beyond one line of copy. If athletes want a week, it is a constant (`feed.FeedWindow`) plus the copy that names it in three places. (#252)
- [ ] **N14** — `sessions` has no index on `ended_at`. The feed's 3-day window is a Filter, not an Index Cond, so every friend's LIFETIME rows are still fetched and then discarded. Harmless now (the window strictly reduces sort and count input), but `(user_id, ended_at DESC)` — optionally partial `WHERE ended_at IS NOT NULL` — is the fix when the table grows. (#252)
- [x] **N15** — The search synonym map is hand-maintained lifting vocabulary (`exercise/search.go`). It is small and closed by design — it grows when a word is ambiguous in the gym, never per exercise — but nothing checks it against the catalog, so a synonym pointing at a word no row contains is silently dead. — done #255, filed and closed in the same change: review pointed out it costs one test and no database. It immediately found three dead entries, two of them written that hour. (#255)

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
- [x] **H3** — Drop stale local databases. **Done:** 11 databases → 2, 139 MB → 25 MB. Dropped `vola_merge` (v33), `vola_mig` and `vola_test_contests` (no `schema_migrations` at all), and `vola_test_{body,energy,library,load,pr207,setdetail}` (v39–53, all behind main's 000054). Kept `vola` (the local dev database) and `vola_test` (shared, current at 54). All had zero connections and none matched an in-flight worktree. **Diagnosing this reproduced the trap CLAUDE.md warns about**: `vola_test` at 54 against a checkout showing 53 looks like somebody's unmerged migration reached the shared database — but 000054 is on main (#248) and the *primary checkout was three commits stale*. Check whether the version exists on `origin/main` before reaching for the rollback recipe.
- [x] **H4** — Mobile tests flake under load: **reconciled, and it is not load.** #235 (0 failures/92 runs) and #233 (1-in-3) were both right and measured different things. Measured across 74 full-suite runs: one jest instance never fails, *even at load 89 under CPU saturation* (0/12); **three concurrent instances fail 8% (2/24) at load 69** — lower load, more failures. The variable is worker oversubscription, not CPU: jest sets no `maxWorkers`, so each instance claims 9 on a 10-core box and three claim 27. Suite wall time goes 6.5s → 33.7s and the 10s `asyncUtilTimeout` at `sharedScreen.test.tsx:135` expires with the card still rendered. Capping each instance to 3 workers: **0/18 failures and nearly twice as fast** (15.9s). Not a CI risk — CI runs one instance — so nothing was changed in jest config; the mitigation is guidance in CLAUDE.md for parallel sessions. (#232 #233 #235)
- [x] **H5** — Give `technique`'s seeding tests the same cleanup `exercise` has. **Done.** Five full-library seeding sites, not the two a `Seed(ctx` grep finds — three more load it via `UpsertAll(ctx, SeedData())`, and guarding only the two left 542 rows behind with the suite green; the row count found them, the grep did not. The cleanup removes the seeded curricula first because every FK into `techniques` is CASCADE, so a bare delete succeeds and silently guts them (measured: 136 curriculum items → 38, suite green). Side effect: H1's test now skips consistently instead of skipping on a fresh database and passing on a reused one. `positions` (11 rows) left deliberately.
- [x] **H6** — Claim a task before working it. **Done:** `gh pr list --state open` before starting, then an empty commit + draft PR titled `[claim] <ID>` before writing code. Chosen over a claim field in this file because TASKS.md *is* the contended resource — a claim written here is one more edit to the file two sessions are already fighting over, needs a push to be visible anyway, and conflicts more. Written down in CLAUDE.md, and this PR claimed itself that way to prove the mechanic works. It does not close the window between deciding and claiming, and nothing enforces it — but the check half already paid for itself: a session picked up **H1**, ran `gh pr list` first, found #216 open with the work done but a week stale, and landed that instead of writing a second copy. (#242)

---

## Done

Move nothing here — mark in place above. This section is for whole efforts, not individual lines.

- [x] Per-side dumbbell load — every dumbbell set was counting at half its real value (#224)
- [x] Spotter reps + drop sets, backend (#226) and phone (#227)
- [x] BJJ position map (#213), SQLite transaction serialisation (#214), contests schema (#215)
- [x] Session share card, feed cards, `share_training_details` (#210)
- [x] Check-in card width (#211), `.clerk/` gitignore (#212)
