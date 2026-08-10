-- Competing, as a history — what you entered, in which division, and how it went.
--
-- # Why "contest" and not "competition"
--
-- **`competition` is already taken, and it means something else entirely.** In
-- this schema and in both clients it refers to IBJJF RULE LEGALITY — whether a
-- move is allowed for a belt and division, carried on `techniques.ibjjf_ruleset_id`
-- and surfaced as the Library's "Restricted in IBJJF competition". Naming this
-- table `competitions` would mean two unrelated concepts answer to one word in
-- the same repo, and `grep competition` would stop being useful the day it
-- landed.
--
-- `tournament` was the other candidate and reads better for BJJ, which is why
-- the athlete-facing copy uses it. It is wrong in the model: this table has to
-- hold a powerlifting meet and a 10k as well, and neither is a tournament. The
-- vocabulary split is the one `sessions` already uses — a neutral table, with
-- the sport's own word chosen in the client through `labelFor`.
--
-- # One row is one ENTRY, not one event
--
-- Gi and no-gi at the same tournament are two rows. Adult and master at the
-- same tournament are two rows. They share a name and a date and nothing else:
-- different division, different bracket, different result.
--
-- The alternative — a shared `events` entity that entries point at — needs
-- dedupe ("IBJJF Pans" vs "Pan Ams 2026"), a naming authority, and an admin
-- merge surface. That is precisely the cost `bjj_promotions` refuses for
-- academies, in the same words: not a foreign key until something asks "who
-- else was there". Nothing does yet.
--
-- # Why this is an event history, like promotions and unlike a column
--
-- Modelled on `000023_bjj_promotions`, which is worth reading first. Its
-- argument is that rank must be a history with the current state DERIVED,
-- because "a current-rank column and a promotion history are two sources for
-- one fact, and they drift". A competitive record is the same shape: the facts
-- are the entries, and "how did I do at brown belt in gi" is a query over them.
-- Nothing here caches an aggregate.
--
-- # Objective, and deliberately so
--
-- Everything in these two tables is externally verifiable: a bracket, a
-- placement, a referee's decision. That matters because
-- `internal/modules/session/basis.go` divides training numbers into measured,
-- modelled and reported — and a contest result is the strongest MEASURED
-- evidence this app holds. It is the one thing an athlete cannot talk
-- themselves into. Nothing in this table is a self-rating, and nothing
-- self-rated may ever be added to it; that belongs on the session it describes.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS contests
(
    -- Minted server-side, matching `bjj_promotions` and for its stated reason:
    -- client ids exist in this schema to make offline retries idempotent, and
    -- a contest result is entered at a desk with a connection. There is no
    -- outbox behind it, so a client id would buy nothing.
    id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id       TEXT NOT NULL,

    -- Which discipline this was. TEXT with no CHECK, the same call 000021 made
    -- when it dropped the sport CHECKs and 000023 made for belts: the
    -- vocabulary is validated in Go, so adding a sport is an enum edit rather
    -- than a migration.
    sport         TEXT NOT NULL,

    -- What it was called, as the athlete would say it. Free text for the same
    -- reason `bjj_promotions.academy` is: a shared entity needs dedupe and a
    -- naming authority, and nothing asks for one yet.
    name          TEXT NOT NULL,
    -- IBJJF, ADCC, USAPL, parkrun. Empty is normal — a local open mat
    -- tournament has no organisation worth naming.
    organisation  TEXT NOT NULL DEFAULT '',

    -- NULLABLE, on the same reasoning `bjj_promotions.promoted_on` gives:
    -- refusing an entry without a date would lose the fact to protect the
    -- metadata. Someone who remembers placing third in 2019 but not the month
    -- should still be able to record it; it simply cannot sit on a timeline.
    held_on       DATE,

    -- How the matches were scored: points | submission_only | ... Validated in
    -- Go. NOT called `ruleset` — see the naming note at the top, that word is
    -- spoken for by the technique library.
    format        TEXT NOT NULL DEFAULT '',

    -- NULL means "didn't say", which is a different fact from gi or no-gi and
    -- has to stay tellable. Same three-state convention as
    -- `bjj_session_details.gi`.
    gi            BOOLEAN,

    -- The division, as three independent free-text parts rather than one
    -- string. Split because the whole point of recording it is to be able to
    -- ask "how did I do at brown belt" without parsing prose, and because the
    -- three axes are genuinely independent: a masters purple middleweight
    -- varies on all three between entries. Empty is normal for a sport with no
    -- belts, no age brackets or no weight classes.
    division_belt   TEXT NOT NULL DEFAULT '',
    division_age    TEXT NOT NULL DEFAULT '',
    division_weight TEXT NOT NULL DEFAULT '',

    -- 1 = won it. NULL is NOT "did not place" — it is "not recorded", which is
    -- the ordinary state for a bracket that pays no places or an athlete who
    -- did not note it. A sport-wide "didn't place" is expressible by entering
    -- the matches and leaving this null; inventing a sentinel like 0 or 99
    -- would make every ORDER BY and every AVG wrong in a different way.
    placement     SMALLINT
                  CONSTRAINT contests_placement_positive CHECK (placement IS NULL OR placement > 0),

    -- How big the bracket was, which is what gives a placement its meaning:
    -- third of four and third of sixty-four are not the same result, and
    -- storing only the placement loses that permanently.
    entrants      SMALLINT
                  CONSTRAINT contests_entrants_positive CHECK (entrants IS NULL OR entrants > 0),

    note          TEXT NOT NULL DEFAULT '',

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A placement cannot exceed the field it was won in. Cheap to state here
    -- and impossible to get wrong later; the alternative is every reader
    -- defending against "2nd of 1".
    CONSTRAINT contests_placement_within_field
        CHECK (placement IS NULL OR entrants IS NULL OR placement <= entrants),

    -- What `contest_matches`'s composite owner FK points at. Declared here
    -- rather than as a later ALTER: a referenced unique constraint has to exist
    -- before the referencing table is created, and adding it afterwards fails
    -- the whole migration with "there is no unique constraint matching given
    -- keys" — which is exactly how this was found.
    CONSTRAINT contests_id_user_key UNIQUE (id, user_id)
);

-- The one query every screen runs: this athlete's entries, newest first.
-- `held_on DESC NULLS LAST` in the index rather than the query, so an undated
-- entry sorts to the end without the planner giving up on the index.
CREATE INDEX IF NOT EXISTS contests_user_held_idx
    ON contests (user_id, held_on DESC NULLS LAST);

-- The matches inside an entry.
--
-- A child table rather than six counter columns on `contests`
-- (wins_by_submission, losses_by_points, …). Counters are smaller and answer
-- "how many" — but they cannot answer "which submission", "against whom", or
-- "what keeps ending my matches", and those are the questions a competitive
-- record exists to answer. It is the same call `bjj_session_tags` makes: record
-- the event, derive the count.
--
-- It also means #11 can read a real evidence stream. An accomplishment worth
-- awarding ("first submission win in competition") is a row here, not an
-- increment nobody can look inside.
CREATE TABLE IF NOT EXISTS contest_matches
(
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    contest_id  TEXT NOT NULL,
    -- Denormalised so the composite owner FK below can exist, matching
    -- `session_sets` and `bjj_session_tags`. See 000014 for the full argument.
    user_id     TEXT NOT NULL,

    -- Order within the bracket, 1-based. Not a timestamp: nobody records the
    -- clock time of a quarter-final, and the order is what makes "lost in the
    -- final" different from "lost first match".
    position    SMALLINT NOT NULL
                CONSTRAINT contest_matches_position_positive CHECK (position > 0),

    -- won | lost. Validated in Go. A draw is deliberately not in the initial
    -- vocabulary — IBJJF brackets do not draw — and adding one is an enum edit
    -- because this is TEXT with no CHECK.
    result      TEXT NOT NULL,

    -- submission | points | advantage | penalty | decision | dq | walkover.
    -- The half that makes this table worth its cost: "lost on advantages" and
    -- "lost by armbar" are different findings and a counter cannot tell them
    -- apart. Empty means not recorded, which is normal for an entry logged
    -- from memory.
    method      TEXT NOT NULL DEFAULT '',

    -- The specific technique, when it was a submission and the athlete knows
    -- it. ON DELETE SET NULL, never CASCADE: retiring a technique from the
    -- shared library must not delete someone's record of having hit it — the
    -- same rule `bjj_session_tags.technique_id` follows.
    technique_id TEXT REFERENCES techniques (id) ON DELETE SET NULL,

    -- Free text. Not a foreign key to anything: opponents are not entities in
    -- this product and making them one would be a social graph nobody asked
    -- for.
    opponent    TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT contest_matches_contest_owner_fk
        FOREIGN KEY (contest_id, user_id) REFERENCES contests (id, user_id)
        ON DELETE CASCADE ON UPDATE CASCADE,

    -- One match per slot in one entry. Stops a double-submitted form silently
    -- doubling a competitive record, which is the kind of corruption nobody
    -- notices until the numbers are quoted.
    CONSTRAINT contest_matches_unique_position UNIQUE (contest_id, position)
);

-- Reading one entry's matches back, in bracket order.
CREATE INDEX IF NOT EXISTS contest_matches_contest_idx
    ON contest_matches (contest_id, position);

-- "What keeps ending my matches" — every match one athlete has had, by method.
-- Partial on `method <> ''` because an unrecorded method cannot appear in that
-- answer, and entries logged from memory will often have none.
CREATE INDEX IF NOT EXISTS contest_matches_user_method_idx
    ON contest_matches (user_id, method, result)
    WHERE method <> '';
