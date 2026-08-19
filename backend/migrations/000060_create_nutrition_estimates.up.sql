-- Per-athlete usage of the AI estimate endpoint.
--
-- This exists for ONE reason: `POST /v1/nutrition/estimate` is the only route
-- in this API where a caller's loop spends real money. A photo is the dearer
-- path, but only by ~1.1x a text description on the shipped model -- not the
-- ~50x an earlier version of this comment claimed -- which is why the two are
-- counted apart, though the split is a precaution rather than the main cost
-- control. (The ratio moves with the model: it was ~1.4x on Haiku 4.5.)
--
-- WHY A ROW PER CALL RATHER THAN A COUNTER. A stored counter has to be reset,
-- and a reset is a scheduled job this repo does not have and should not grow
-- for this. Counting rows in a window needs no scheduler, survives a clock
-- change, and is the same shape `adherence` and `/v1/notifications` already
-- use — those derive from the rows themselves precisely so there is no second
-- number that can drift from the first.
--
-- WHY IT RECORDS FAILURES TOO. `succeeded` is stored rather than filtered on
-- write, because a refusal and an upstream error still cost tokens. A quota
-- that only counted successes would let a caller loop on input the model
-- keeps declining and pay for every attempt.
CREATE TABLE nutrition_estimates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT        NOT NULL,

    -- Which quota this call drew on. The two are counted separately so the
    -- dearer path cannot exhaust the cheap one -- an athlete who photographed
    -- five meals should still be able to type a sixth.
    source      TEXT        NOT NULL,

    -- Whether a draft came back. See the note above on why failures count.
    succeeded   BOOLEAN     NOT NULL,

    -- What the model returned, for answering a later quality question without
    -- guessing. NOT the athlete's input: the description is theirs and the
    -- photo bytes are never persisted at all -- they are forwarded to the API
    -- and discarded, which is what keeps this table free of a retention
    -- question and of anything a breach would expose.
    model       TEXT        NOT NULL DEFAULT '',
    item_count  INTEGER     NOT NULL DEFAULT 0,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT nutrition_estimates_source_valid CHECK (source IN ('text', 'photo'))
);

-- The quota query, and the only read this table has: count one athlete's calls
-- of one source since a cutoff. Ordered so the window scan is an index range
-- rather than a filter over everything they have ever done.
CREATE INDEX nutrition_estimates_quota_idx
    ON nutrition_estimates (user_id, source, created_at DESC);
