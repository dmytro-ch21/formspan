-- Matching 000034 and 000025, which both take an FK onto a hot catalog table:
-- a lock wait behind a long-running read should fail fast rather than queue
-- behind it and block every writer that arrives after.
SET lock_timeout = '3s';

-- A SEQUENCE is a chain: what a class actually taught, in the order it flows.
--
-- The feature exists because of a specific failure. A beginners' class ran
-- closed guard top -> standing break -> knee cut -> side control -> knee on
-- belly -> armbar, and the athlete could record six unrelated technique tags
-- and nothing that said they connect. The connection IS the lesson — "knee cut
-- from a broken closed guard" is a different thing to learn than "knee cut",
-- and the library models it nowhere.
--
-- WHY NOT `curriculum_items`, WHICH IS ALSO AN ORDERED TECHNIQUE LIST:
-- because the two orders mean different things and would silently merge.
-- A curriculum's order is PEDAGOGICAL — learn this before that, over months,
-- and reordering it changes advice. A sequence's order is CAUSAL — this move
-- puts you where the next one starts, and reordering it produces something
-- that does not work on the mat. Same column shape, opposite semantics; 000034
-- makes the identical argument for why it did not reuse `workout_items`.
--
-- They also differ in size and lifetime. A curriculum is 10-30 items worked for
-- a season and carries completion criteria. A sequence is 3-6 steps, is
-- finished the moment it is written down, and has no notion of mastery — the
-- mastery of its parts is already tracked per technique.
--
-- SHARING IS BY COPY, WHICH IS WHY THERE IS NO `visibility` COLUMN AND NO
-- SHARE COLUMNS OF ANY KIND.
--
-- `curricula` and `workouts` share by making one row publicly readable; every
-- reader sees the author's later edits. That is wrong here. A sequence is a
-- record of what a class taught, so a recipient must get an independent
-- snapshot that does not change under them when the author revises theirs.
-- The share path therefore INSERTs a new row owned by the recipient rather
-- than widening who may read this one.
--
-- Crucially that mechanism is NOT this table's business and is not modelled
-- here. Sharing is being built once, generically, over every ownable thing in
-- the app — plans, workouts, curricula, sequences — as a separate `shares`
-- envelope plus a per-module copier. A `shared_with` column here would be the
-- fourth private implementation of the same idea and would have to be undone.
-- All this table owes that system is a stable id and an owner, which it has.
CREATE TABLE bjj_sequences (
    -- SERVER-GENERATED, same reasoning as 000034 and 000023: a sequence is
    -- authored at a desk against a catalog the client had to fetch anyway, so
    -- there is no offline creation to make idempotent, and a client-chosen id
    -- would let a caller probe for existing ones by watching inserts conflict.
    id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

    -- NULL means VOLA-authored reference content, exactly as in curricula and
    -- workouts. Nothing seeds this table yet; the column is here so that the
    -- day a "fundamental chains" set ships it does not need a migration that
    -- also has to decide what to do with rows already written.
    owner_user_id     TEXT,

    -- Which deploy or console wrote an ownerless row. Added NOW while the
    -- table is empty, for the reason 000034 spells out: a later
    -- `ADD COLUMN source DEFAULT 'seed'` hands every already-authored row to
    -- the deploy to clobber.
    source            TEXT        NOT NULL DEFAULT 'user',

    name              TEXT        NOT NULL,
    description       TEXT        NOT NULL DEFAULT '',

    -- Where the chain BEGINS, and the reason a sequence reads as a chain
    -- rather than a list.
    --
    -- The first step's technique already carries its own `position`, so this
    -- looks redundant. It is not: `techniques.position` is 16 free-text values
    -- at a different grain ("Guard - Top", "Side Control - Bottom") than the 11
    -- curated `positions` rows the glossary renders, and the clients relate the
    -- two by prefix match. Storing the curated id here means the opening node
    -- of the chain is the same kind of thing as every node after it, so one
    -- renderer draws the whole line.
    --
    -- ON DELETE SET NULL, NOT CASCADE. `UpsertPositions` already prunes rows
    -- absent from positions.json, so a position genuinely can disappear —
    -- and losing the name of where a chain starts must not delete the
    -- athlete's record of the chain. Same reasoning as
    -- `bjj_session_tags.technique_id`, and deliberately the opposite of the
    -- step FK below.
    start_position_id TEXT REFERENCES positions (id) ON DELETE SET NULL,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- An owned row is the athlete's; an ownerless one is content. Copied from
    -- 000034: without it a user-created row could claim source = 'seed' and be
    -- picked up by whatever a future seed prunes.
    CONSTRAINT bjj_sequences_source_valid CHECK (source IN ('seed', 'admin', 'user')),
    CONSTRAINT bjj_sequences_source_matches_owner CHECK (
        (owner_user_id IS NULL) = (source <> 'user')
    )
);

-- The only read path that exists: "my sequences". There is deliberately no
-- public-browse index, because there is no public browse — see the sharing
-- note above.
CREATE INDEX bjj_sequences_owner_idx ON bjj_sequences (owner_user_id);


-- The steps, in order, and the half of the model that carries the graph.
--
-- THE ONE IDEA WORTH THE MIGRATION: a step records both the technique AND
-- WHERE IT LEAVES YOU. That second half is authored here rather than read from
-- `techniques.to_position`, and the reason is measured — 000029 populated
-- `to_position` for 191 of 634 techniques and documents at length why the rest
-- cannot be derived without inventing data. Deriving the chain would therefore
-- render most sequences with holes in them.
--
-- Authoring it also runs the debt down rather than around: every sequence
-- written is a human asserting a real transition, so this table accumulates
-- exactly the evidence `to_position` is missing. Harvesting it back into the
-- library is not done here and is not automatic — a single athlete's assertion
-- is not library-grade — but the data will exist to review.
CREATE TABLE bjj_sequence_steps (
    id                  BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sequence_id         TEXT    NOT NULL REFERENCES bjj_sequences (id) ON DELETE CASCADE,

    -- ON DELETE CASCADE, following `curriculum_items.technique_id` and for the
    -- same reason: a step that cannot say what to practise names nothing.
    --
    -- BUT NOTE THE SHARPER CONSEQUENCE HERE, because the order is causal. A
    -- curriculum losing an item is a shorter list. A sequence losing a MIDDLE
    -- step is a chain that silently claims step 2 leads to step 4, which is a
    -- statement about the mat that is now false. Nothing deletes techniques
    -- today (`cmd/seed` upserts and never prunes, and there is no
    -- DELETE /v1/admin/techniques), so this is a latent hazard rather than a
    -- live one — but if techniques ever gain a prune, this FK needs revisiting
    -- before that ships, not after.
    technique_id        TEXT    NOT NULL REFERENCES techniques (id) ON DELETE CASCADE,

    -- `sort_order`, NOT `position` — 000034's warning applies verbatim: one
    -- join away, `bjj_session_tags.position` means "Half Guard", and two
    -- columns named `position` meaning an ordinal and a place would sit in one
    -- statement.
    sort_order          INTEGER NOT NULL,

    -- Where this step leaves you, and therefore where the next one starts.
    --
    -- NULL means NOT RECORDED or ENDS THE EXCHANGE — a submission finishes the
    -- chain and leaves you in no position at all. That ambiguity is tolerated
    -- deliberately rather than split into two columns: the technique's own
    -- `function = 'finish'` already distinguishes the two cases, so a second
    -- column would encode the same fact twice and could disagree with it.
    -- 000028 made exactly this argument against `category` carrying the where
    -- half a second time.
    --
    -- ON DELETE SET NULL, matching `start_position_id`, and for the same
    -- reason: a pruned position must not take the athlete's chain with it.
    ends_at_position_id TEXT REFERENCES positions (id) ON DELETE SET NULL,

    -- "the way our coach does it", "he was defending the knee here". The step
    -- is a pointer into a shared library; this is the only place the athlete's
    -- own class lives.
    notes               TEXT    NOT NULL DEFAULT '',

    -- Two steps cannot share a slot. `curriculum_items` has no such constraint
    -- and does not need one — a reading list with two items at index 3 renders
    -- in some order and nothing is wrong. Here the order IS the content, so an
    -- ambiguous one is a corrupt sequence, and the replace-all write path below
    -- makes a duplicate cheap to introduce by accident.
    CONSTRAINT bjj_sequence_steps_unique_slot UNIQUE (sequence_id, sort_order)
);

-- NO EXPLICIT INDEX HERE, and the reason is one line up: the UNIQUE constraint
-- on (sequence_id, sort_order) is already backed by a btree on exactly those
-- columns in that order. A second `CREATE INDEX` over the same pair is a
-- duplicate Postgres will happily build and then maintain on every step insert,
-- for nothing — migration 000018 dropped an index from `techniques` for being
-- unused, and this one would have been worse: not merely unused but redundant.
-- The constraint's index serves the join, the ordering, and the step_count
-- subquery alike.
