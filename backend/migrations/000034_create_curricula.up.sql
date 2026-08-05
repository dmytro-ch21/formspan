-- Matching 000025, which does the same FK-onto-a-hot-catalog-table thing:
-- a lock wait behind a long-running read should fail fast rather than queue
-- behind it and block every writer that arrives after.
SET lock_timeout = '3s';

-- A curriculum is an ordered set of TECHNIQUES to learn, worked over months.
--
-- Structurally this is the `workouts` template model and it deliberately copies
-- that shape rather than inventing a second sharing story: nullable owner,
-- `visibility`, and a CHECK that an ownerless row must be public. See
-- 000006_create_workouts, whose own comment argues the case — two sharing cases
-- (VOLA-authored official content, and a user publishing their own) without an
-- ACL table, which would be premature.
--
-- What that buys is the READ path: `workouts` already demonstrates the
-- visible-to-me predicate and the My / Shared split the Plan tab renders. It
-- does NOT buy the seed path — nothing in this repo has ever seeded a table
-- with a nullable owner, and `cmd/seed` touches only exercises, techniques,
-- positions and rulesets, none of which have one. Seeding belt syllabuses is
-- unstarted work, not a solved problem.
--
-- WHY NOT REUSE `workouts` OUTRIGHT? 000006 anticipates a nullable
-- `technique_id` on `workout_items` "with a CHECK that exactly one is set", and
-- that would have worked for a plain technique list. It stops working here
-- because of the criteria columns below: a workout item's targets describe what
-- you will do IN ONE SESSION (5 sets of 5), and a curriculum item's describe
-- what you must accumulate ACROSS MONTHS before the technique counts as
-- mastered. Same column names would mean opposite things on one table, and the
-- adherence query would have to know which. Separate tables, same shape.
CREATE TABLE curricula (
    -- SERVER-GENERATED, unlike workouts and activities.
    --
    -- Those take a client id because they are created offline and synced, and
    -- the client id is what makes the sync retry idempotent. A curriculum is
    -- authored at a desk against a catalog the client had to fetch anyway, so
    -- there is no offline case to serve -- and a client-chosen id lets a caller
    -- probe for existing ones by watching which inserts conflict. Same
    -- reasoning and same mechanism as 000023's promotions.
    id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

    -- NULL means VOLA-authored ("White belt basics"), exactly as in workouts.
    owner_user_id TEXT,

    -- Which deploy or console wrote an ownerless row.
    --
    -- `owner_user_id IS NULL` cannot answer this: a seeded syllabus and one
    -- authored in the admin console are both ownerless, and 000032 exists
    -- precisely because the content path needs to tell them apart — the seed
    -- scopes itself to `source = 'seed'` so console-authored rows are
    -- untouchable by deploys.
    --
    -- Added NOW, while all three tables are empty, because 000032's backfill
    -- argument runs backwards here: a later `ADD COLUMN source DEFAULT 'seed'`
    -- would hand every already-authored curriculum to the deploy to clobber.
    -- Meaningless for user-owned rows, which is why it defaults to 'user'.
    source        TEXT        NOT NULL DEFAULT 'user',

    name          TEXT        NOT NULL,
    description   TEXT        NOT NULL DEFAULT '',

    -- Which belt's fundamentals this is, when it is one. Nullable because an
    -- athlete's own curriculum ("guard passing for the winter") is not about a
    -- belt at all.
    --
    -- This exists so a curriculum can be OFFERED by rank — the app already
    -- knows the athlete's belt from `bjj_promotions`, so "Blue belt basics" can
    -- surface first without asking a question it can already answer. Offered,
    -- never imposed: working white-belt fundamentals at purple is not a
    -- mistake, and the UX direction rules out the app implying otherwise. That
    -- is why this is a hint for ordering and not a filter, and why nothing here
    -- constrains it against the athlete's actual rank.
    --
    -- Unconstrained TEXT, matching `bjj_promotions.belt`: 000023 is explicit
    -- that adding the kids belts should be "an enum edit rather than a
    -- migration". NULLABLE, unlike `techniques.typical_belt`, which is
    -- NOT NULL DEFAULT '' — here "no belt" is a real and common state rather
    -- than missing data, and a sentinel empty string would sort among the
    -- belts.
    belt          TEXT,

    visibility    TEXT        NOT NULL DEFAULT 'private',

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT curricula_visibility_valid CHECK (visibility IN ('private', 'public')),
    CONSTRAINT curricula_source_valid CHECK (source IN ('seed', 'admin', 'user')),
    -- Same reasoning as workouts_official_is_public: an official curriculum
    -- nobody can see is pointless, and a private ownerless row is unreachable.
    CONSTRAINT curricula_official_is_public CHECK (
        owner_user_id IS NOT NULL OR visibility = 'public'
    ),
    -- An owned row is the athlete's; an ownerless one is content. Without this
    -- a user-created curriculum could claim source = 'seed' and be picked up by
    -- whatever the seed prunes.
    CONSTRAINT curricula_source_matches_owner CHECK (
        (owner_user_id IS NULL) = (source <> 'user')
    )
);

CREATE INDEX curricula_owner_idx ON curricula (owner_user_id);
-- Just (belt): `visibility` is constant inside the partial predicate, so
-- leading with it wastes the column. (`workouts_public_idx` has the same flaw;
-- copied shape, not copied mistake.)
CREATE INDEX curricula_public_belt_idx ON curricula (belt) WHERE visibility = 'public';


-- The ordered contents, and — when the criteria columns are set — the thing
-- that makes a curriculum a ROADMAP.
--
-- ONE TABLE, NOT TWO. Splitting them would mean two engines and, inevitably, a
-- second-class one. But note the grain: the criteria are per ITEM, so a
-- curriculum can be part reading list and part roadmap, and "is this a
-- roadmap?" has no single answer for such a row.
--
-- THE PROGRESS RULE, stated here because otherwise the first caller to compute
-- a percentage picks one silently: **progress counts only items that carry
-- criteria.** An item with none is reading, and reading is not something the
-- record can mark done. A curriculum where no item carries criteria therefore
-- has no progress at all — not 0%, which would read as failure, and not 100%,
-- which would claim something.
CREATE TABLE curriculum_items (
    id            BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    curriculum_id TEXT    NOT NULL REFERENCES curricula (id) ON DELETE CASCADE,

    -- ON DELETE CASCADE, unlike `bjj_session_tags.technique_id`, which is SET
    -- NULL. The asymmetry is deliberate and the reason is whose data it is:
    -- a tag is the athlete's record of something they did, and retiring a
    -- library entry must never delete it. A curriculum item is a POINTER into
    -- the shared library — with the technique gone it names nothing, and a
    -- roadmap step that cannot say what to practise is worse than one fewer
    -- step.
    --
    -- A DEPENDENCY WORTH NAMING: this is only safe while nothing deletes
    -- techniques. `cmd/seed` upserts and never prunes, and there is no
    -- DELETE /v1/admin/techniques — but `UpsertPositions` already establishes
    -- the prune-what-is-not-in-the-JSON pattern for positions. The day
    -- `techniques` gains it, every curriculum silently loses items, with no
    -- error anywhere.
    technique_id  TEXT    NOT NULL REFERENCES techniques (id) ON DELETE CASCADE,

    -- `sort_order`, NOT `position`. One join away, `bjj_session_tags.position`
    -- means "Half Guard" — and the mastery query joins those two tables, so two
    -- columns named `position` meaning an ordinal and a place would sit in one
    -- statement.
    sort_order    INTEGER NOT NULL,
    notes         TEXT    NOT NULL DEFAULT '',

    -- ---------------------------------------------------------------------
    -- COMPLETION CRITERIA
    --
    -- All nullable. NULL across the board means this item has no completion
    -- criterion — see the progress rule above.
    --
    -- These are thresholds, not stored state. NOTHING here records whether an
    -- athlete has met them: mastery is DERIVED from `bjj_session_tags` on every
    -- read, and there is no column anywhere in this migration that says
    -- "mastered". That follows the rule `lib/adherence.ts` and the suggestion
    -- design already argue for — a stored derivation goes stale against the
    -- evidence it came from, and deleting a session must withdraw the claim it
    -- supported.
    --
    -- The consequence, and it is intended: mastery is a statement about the
    -- record NOW, not a trophy. A long enough bad run can take it back. That is
    -- the honest reading of a derived claim, and it is why the copy must say
    -- "your record shows" rather than "you have earned".
    --
    -- There is deliberately NO way to mark a technique mastered by hand. Note
    -- what that does and does not buy: the evidence is still self-reported —
    -- `bjj_session_tags.count` is client-supplied — so these criteria make
    -- fabrication tedious rather than impossible. They are a bar, not a
    -- tamper-proof one.
    --
    -- COUNTING NOTES for whoever writes the query, all three load-bearing:
    --   * `bjj_session_tags.count` exists because "hit three armbars" is ONE
    --     row with count = 3. Volume thresholds are SUM(count), never COUNT(*).
    --   * Every threshold is measured SINCE THE ATHLETE ENROLLED
    --     (`curriculum_enrollments.started_on`), never over all time. See
    --     `min_hit_rate` for why this is not a detail.
    --   * `drilled` never counts toward any of these. It is practice, and a
    --     criterion it could satisfy would be a technique mastered without ever
    --     being used on a resisting opponent.
    -- ---------------------------------------------------------------------

    -- Times landed live, since enrolling. The offensive half.
    --
    -- WHY THE DEFAULT IS 25 AND NOT 10. Ten clears in about twelve
    -- focus-sessions — a month at three sessions a week — and a month is not
    -- what anyone means by mastering a technique. At the same modelled rate
    -- (~0.83 scores per focus-session with four techniques in focus) 25 lands
    -- in roughly 30 focus-sessions, or about ten weeks; a twelve-technique belt
    -- syllabus worked four at a time therefore runs seven or eight months,
    -- which is the right order of magnitude for a belt.
    target_scored    INTEGER,

    -- Times you stopped THEIRS, since enrolling. The defensive half, and the
    -- number most likely to be set wrong.
    --
    -- Roughly a THIRD of the offensive target, and not because defence matters
    -- less. You choose when to attempt a technique; you do not choose when one
    -- is attempted on you, so defensive evidence arrives more slowly — modelled
    -- at about 3.2x, though the design doc's own Known Gaps section is clear
    -- that this ratio "is modelled, not measured" and rests on an assumed
    -- opportunity rate nobody has data on. On that model a symmetric criterion
    -- makes defence the gate on everything and leaves a roadmap sitting at 76%
    -- offence-complete and stuck; 25 against 8 completes both halves at about
    -- the same moment.
    target_defended  INTEGER,

    -- Distinct sessions the evidence must be spread across, since enrolling.
    --
    -- The guard against one lucky night, and against a single open mat where
    -- someone hit the same sweep on a tired training partner fifteen times.
    --
    -- COUNTED OVER LIVE SESSIONS ONLY — sessions carrying an `attempted`,
    -- `scored` or `defended` tag for this technique. Unfiltered it would count
    -- twelve *drilled* classes and let a technique clear its spread requirement
    -- with no live use at all, which is the exact opposite of the point.
    target_sessions  INTEGER,

    -- The minimum live hit rate: scored / (attempted + scored), SINCE
    -- ENROLLING.
    --
    -- THIS IS THE COLUMN THAT EARNS THE WORD "MASTERED". The design doc argued
    -- the honest term was "complete", on the exact grounds that a volume
    -- threshold says nothing about the denominator — "landed it 25 times" is
    -- satisfied by 25-from-30 and by 25-from-400 alike, and only the first is
    -- skill. Including the denominator answers that rather than weakening the
    -- word.
    --
    -- IT IS COMPUTABLE ONLY BECAUSE `attempted` AND `scored` ARE DISJOINT:
    -- 000025 defines `attempted` as "tried it live, it didn't land", not as
    -- total tries, so attempts + scores is a total rather than a double count.
    -- That disjointness is a property of the CAPTURE UI as much as the schema —
    -- if the counter labelled for misses is ever read by athletes as "tries",
    -- every rate computed here is silently wrong and biased downward.
    --
    -- THE WINDOW IS NOT OPTIONAL, and it is why every threshold above shares
    -- it. Over all time this ratio includes the months during which the athlete
    -- could not do the technique — so it measures the learning phase it exists
    -- to exclude. Concretely: 25 scores at 0.35 permits only 46 lifetime
    -- misses, so twenty honest early failures force the rest of the athlete's
    -- career to run at 0.49 to compensate; and someone arriving at a syllabus
    -- with 20-from-200 already logged would need several hundred further
    -- attempts to drag the lifetime figure up, which is most of a year at one
    -- technique. A belt syllabus is mostly techniques the athlete has been
    -- failing at — that is what makes it a syllabus — so this is the common
    -- case, not the edge. Anchoring on enrollment makes the criterion mean
    -- "you got good at this while working the roadmap", which is the claim
    -- anyone actually wants.
    --
    -- 0.35 is the intended default and is not modest: landing a specific named
    -- technique on a resisting opponent better than a third of the times you
    -- commit to it is a genuinely good number. It implies roughly 70 live
    -- attempts to reach 25 scores.
    --
    -- NUMERIC, not FLOAT: a threshold compared with >= must not depend on
    -- binary rounding.
    min_hit_rate     NUMERIC(4, 3),

    CONSTRAINT curriculum_items_order_unique UNIQUE (curriculum_id, sort_order),
    -- One technique cannot appear twice in the same curriculum. Two rows would
    -- each derive their own progress from the same evidence and the item would
    -- complete twice.
    CONSTRAINT curriculum_items_technique_unique UNIQUE (curriculum_id, technique_id),

    CONSTRAINT curriculum_items_targets_positive CHECK (
        (target_scored   IS NULL OR target_scored   > 0) AND
        (target_defended IS NULL OR target_defended > 0) AND
        (target_sessions IS NULL OR target_sessions > 0)
    ),
    CONSTRAINT curriculum_items_hit_rate_valid CHECK (
        min_hit_rate IS NULL OR (min_hit_rate > 0 AND min_hit_rate <= 1)
    ),
    -- A criterion is anchored on VOLUME — offensive or defensive — or it does
    -- not exist.
    --
    -- Defensive-only is expressly allowed, because it is the requirement that
    -- justified adding the `defended` event at all: "not get caught in guard
    -- pull N times" has no offensive half, and an earlier draft of this
    -- constraint would have forced an author to invent a `target_scored` to
    -- express it.
    CONSTRAINT curriculum_items_criteria_anchored CHECK (
        target_scored IS NOT NULL
        OR target_defended IS NOT NULL
        OR (target_sessions IS NULL AND min_hit_rate IS NULL)
    ),
    -- `min_hit_rate` divides the offensive attempt count, so without a scored
    -- target it has nothing to be a rate OF — and on a defence-only item it
    -- would silently gate on an unrelated number.
    CONSTRAINT curriculum_items_hit_rate_needs_volume CHECK (
        min_hit_rate IS NULL OR target_scored IS NOT NULL
    )
);

-- No separate index on (curriculum_id): the UNIQUE (curriculum_id, sort_order)
-- constraint's index already serves every lookup by curriculum, and 000006's
-- equivalent standalone index is redundant for the same reason.
--
-- "Which curricula call for this technique" — needed to attribute a logged
-- technique back to the roadmaps it advances, so progress moves without the
-- athlete telling the app what they were working on.
CREATE INDEX curriculum_items_technique_idx ON curriculum_items (technique_id);


-- Which curricula an athlete is actually working, and — because every
-- criterion is measured from it — the clock the whole roadmap runs on.
--
-- Separate from `curricula` because following is not owning: the point of the
-- seeded belt syllabuses is that many athletes work the same one.
--
-- Shaped like `bjj_focus` (000031) — composite PK, a `started_on` date, no
-- surrogate id. Deliberately NOT named `bjj_curriculum_enrollments` despite
-- being per-athlete BJJ state: the `bjj_` prefix marks which discipline a table
-- belongs to, and this row's discipline is already fixed by the curriculum it
-- points at. Keeping the curriculum family together in one alphabetical block
-- is worth more than the prefix here.
CREATE TABLE curriculum_enrollments (
    user_id       TEXT NOT NULL,

    -- NOT ON DELETE CASCADE, and this is the one place this migration departs
    -- from the workouts shape on purpose.
    --
    -- An enrollment is the ATHLETE's record, not the publisher's. Cascading
    -- would mean a stranger deleting a curriculum they published erases every
    -- follower's history of having worked it — the same argument
    -- `bjj_session_tags.technique_id` makes for SET NULL, and it contradicts
    -- this table's own reason for keeping archived rows. RESTRICT instead: an
    -- owner cannot delete a curriculum other people are working, and the
    -- handler turns that into a refusal they can act on.
    curriculum_id TEXT NOT NULL REFERENCES curricula (id) ON DELETE RESTRICT,

    -- When they took it on, and the anchor for every threshold on every item.
    -- Not derivable afterwards.
    started_on    DATE NOT NULL DEFAULT CURRENT_DATE,

    -- Set when the athlete puts it down, rather than deleting the row: having
    -- worked a syllabus and stopped is a fact about them, and a roadmap that
    -- vanishes on abandonment cannot later say "you did three quarters of
    -- this". NULL means active.
    --
    -- It does NOT mean completed. Completion is derived from the items and the
    -- evidence; this is the athlete's decision to stop, which is a different
    -- thing.
    --
    -- Note the consequence of the PK below: picking a syllabus back up reuses
    -- this row and KEEPS the original `started_on`, so the measurement window
    -- spans the gap. That is the deliberate choice — the alternative resets the
    -- clock and discards everything they did the first time — but it means
    -- "how long has this been running" includes months they were away, and a
    -- screen that renders elapsed time has to say so.
    archived_on   DATE,

    PRIMARY KEY (user_id, curriculum_id),

    CONSTRAINT curriculum_enrollments_archived_after_start CHECK (
        archived_on IS NULL OR archived_on >= started_on
    )
);

-- The list screen: an athlete's active curricula, most recently started first.
CREATE INDEX curriculum_enrollments_user_active_idx
    ON curriculum_enrollments (user_id, started_on DESC)
    WHERE archived_on IS NULL;

-- Postgres does not index the referencing side of a foreign key, so without
-- this the RESTRICT check above seq-scans on every curriculum delete — and
-- "how many athletes follow this syllabus" has no path at all.
CREATE INDEX curriculum_enrollments_curriculum_idx
    ON curriculum_enrollments (curriculum_id);
