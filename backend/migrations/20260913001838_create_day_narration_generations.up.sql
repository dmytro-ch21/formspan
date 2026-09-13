-- Per-athlete metering of the day-narration endpoint (N570, #1131).
--
-- `POST /v1/day/narration` joins `/v1/nutrition/estimate`, `/v1/exercises/identify`
-- and `/v1/bjj/reflect/draft` as a route where a caller's loop spends real money,
-- and it is metered the same way, for the reasons 000064 gives.
--
-- A ROW PER CALL, NOT A COUNTER. A counter needs a scheduled reset this repo
-- does not have. Counting rows in a rolling window needs none.
--
-- FAILURES ARE RECORDED. A refusal costs tokens, so a quota that counted only
-- successes would let a caller loop on facts the model keeps declining.
-- `succeeded` is stored, never filtered on write. A call that never reached the
-- provider (no answer at all) writes no row: nothing was spent.
--
-- TOKENS ARE NULLABLE, AND NULL IS NOT ZERO. The rule is 000067's: NULL means no
-- call produced usage, and a number means the provider reported one, including
-- on a billed refusal. Any analysis filters `WHERE input_tokens IS NOT NULL`.
-- These columns are what N570's last part measures the per-athlete cost from.
--
-- WHAT IS NOT HERE, DELIBERATELY: the facts the phone sent and the sentences
-- that came back. They describe the athlete's own day, forwarded to the model
-- provider and discarded, so this table carries no retention question and
-- nothing a breach would expose.
CREATE TABLE day_narration_generations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             TEXT        NOT NULL,
    succeeded           BOOLEAN     NOT NULL,
    model               TEXT        NOT NULL DEFAULT '',
    -- Sentences returned after the server-side guard. Zero is meaningful: every
    -- sentence the model wrote was dropped, which is worth being able to count.
    sentences_kept      INTEGER     NOT NULL DEFAULT 0 CHECK (sentences_kept >= 0),
    input_tokens        INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens       INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
    reasoning_tokens    INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The quota query, and this table's only read: one athlete's calls since a cutoff.
CREATE INDEX day_narration_generations_quota_idx
    ON day_narration_generations (user_id, created_at DESC);
