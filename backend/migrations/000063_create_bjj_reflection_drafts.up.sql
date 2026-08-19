-- Per-athlete usage of the dictated-reflection endpoint.
--
-- This exists for ONE reason: `POST /v1/bjj/reflect/draft` is, with
-- `/v1/nutrition/estimate` and `/v1/exercises/identify`, one of the few routes
-- in this API where a caller's loop spends real money. See
-- `DailyReflectionDrafts` for what a call actually costs, measured rather than
-- assumed -- the answer is unusual: the request is eight times the size of a
-- meal estimate's and about a third of the price, because the 542-technique
-- catalog in the prompt is byte-identical on every call and therefore cached.
--
-- WHY A ROW PER CALL RATHER THAN A COUNTER. A stored counter has to be reset,
-- and a reset is a scheduled job this repo does not have and should not grow
-- for this. Counting rows in a window needs no scheduler, survives a clock
-- change, and is the same shape `nutrition_estimates` and `/v1/notifications`
-- already use.
--
-- WHY IT RECORDS FAILURES TOO. `succeeded` is stored rather than filtered on
-- write, because a refusal and an upstream error still cost tokens. A quota
-- that only counted successes would let a caller loop on input the model keeps
-- declining and pay for every attempt.
--
-- WHAT IS NOT HERE, DELIBERATELY: the dictation. It is the athlete's own speech
-- about their training and sometimes their body, it is forwarded to the model
-- and discarded, and it is never persisted anywhere in this stack -- which is
-- what keeps this table free of a retention question and of anything a breach
-- would expose. Nor is the draft: a draft nobody confirmed is not a record of
-- anything, and storing it would create a second history that disagrees with
-- the sessions table.
CREATE TABLE bjj_reflection_drafts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    TEXT        NOT NULL,

    -- Whether a draft came back. See the note above on why failures count.
    succeeded  BOOLEAN     NOT NULL,

    -- What the model returned, for answering a later quality question without
    -- guessing which tier produced a bad draft.
    model      TEXT        NOT NULL DEFAULT '',

    -- How many tags the draft carried. Zero is meaningful and not missing data:
    -- it is the well-formed-but-empty answer N37 measured, where the model
    -- returns valid JSON containing nothing at all.
    tag_count  INTEGER     NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The quota query, and the only read this table has: count one athlete's calls
-- since a cutoff. Ordered so the window scan is an index range rather than a
-- filter over everything they have ever dictated.
CREATE INDEX bjj_reflection_drafts_quota_idx
    ON bjj_reflection_drafts (user_id, created_at DESC);
