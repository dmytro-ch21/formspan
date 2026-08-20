-- What each estimate call actually cost, in tokens.
--
-- # Why this exists
--
-- Nothing in this system could answer "what did that call cost". The daily caps
-- in `quota.go` were sized against an ASSUMED ~50x cost ratio between a photo
-- call and a text one; measured by hand it is ~1.1x on the shipped model. The
-- plan recorded against N49 was to replace those numbers with "a week of
-- production traffic" — and a week of it would have produced call COUNTS and
-- nothing else, because `nutrition_estimates` records `source`, `succeeded`,
-- `model` and `item_count` and no measure of spend at all. The re-tune would
-- have been the same guess, taken a week later with more confidence.
--
-- Both providers return usage on every call and the transport was discarding
-- it. This is the measuring apparatus, added before the caps are touched.
--
-- # NULL is not zero, and here it is doing real work
--
-- Every column is NULLABLE WITH NO DEFAULT, deliberately. A `DEFAULT 0` would
-- backfill every pre-existing row with a confident zero, and then the first
-- query anybody writes — an average cost per call — would silently include
-- hundreds of rows claiming a call cost nothing, dragging the figure toward
-- zero exactly as it is being used to justify a new cap. That is the same
-- mistake this schema already refuses on `nutrition_foods.fibre_g`: an
-- unstated number is not a claim of none.
--
-- So: NULL means "this call predates metering", 0 means "metered, and it was
-- genuinely zero". Any analysis must filter `WHERE input_tokens IS NOT NULL`,
-- and a row that fails to is visibly wrong rather than quietly low.
--
-- # Why not a separate table
--
-- One row per call already exists here and usage is one-to-one with it. A side
-- table would need the same key, the same retention answer, and a join on the
-- only query this table has.

SET lock_timeout = '3s';

ALTER TABLE nutrition_estimates
    -- Every token sent, INCLUDING the cached portion. Normalised in
    -- `llm.Usage` because the two providers disagree about whether cached
    -- tokens are inside their input count — OpenAI includes them, Anthropic
    -- does not — and this column is always the inclusive figure.
    ADD COLUMN input_tokens INTEGER
        CHECK (input_tokens IS NULL OR input_tokens >= 0),

    -- Every token generated, INCLUDING reasoning, because reasoning is billed
    -- as output. On a reasoning model this is most of the bill.
    ADD COLUMN output_tokens INTEGER
        CHECK (output_tokens IS NULL OR output_tokens >= 0),

    -- The part of input_tokens served from the provider's prompt cache, and so
    -- billed at a discount or not at all. The gap between list price and real
    -- price: measured at 1,334 of 1,337 input tokens on this prompt, because
    -- the system prompt and schema are byte-identical for every athlete.
    ADD COLUMN cached_input_tokens INTEGER
        CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),

    -- The part of output_tokens spent thinking rather than answering. Zero
    -- where the provider does not report it, which is not the same as a model
    -- that reasoned for free.
    ADD COLUMN reasoning_tokens INTEGER
        CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),

    -- The part of input_tokens the image accounted for, from the provider's
    -- own accounting rather than from a guess.
    --
    -- **This is the column N49 exists to fill**, and on the shipped model it is
    -- always NULL: `gpt-5.6-luna` does not populate the field and Anthropic has
    -- no equivalent, so the image cost is currently obtained by DIFFERENCING
    -- input against a text-only call (~1,272 tokens at the 1080px the app
    -- sends).
    --
    -- NULL and 0 are told apart by field PRESENCE in the provider response, not
    -- by value. An earlier version of this comment said 0 meant "no image was
    -- sent" — a state the writer could not produce, because it inferred
    -- presence from `> 0` and so wrote NULL for a text call too. Raised in
    -- review; the transport carries a pointer now.
    ADD COLUMN image_tokens INTEGER
        CHECK (image_tokens IS NULL OR image_tokens >= 0);

COMMENT ON COLUMN nutrition_estimates.input_tokens IS
    'Inclusive of cached tokens. NULL means the call predates metering (N49); '
    '0 means metered and genuinely zero. Filter IS NOT NULL before averaging.';

COMMENT ON COLUMN nutrition_estimates.image_tokens IS
    'What the photograph cost, from the provider. NULL means the provider '
    'reported no breakdown at all -- which on the shipped model is every call, '
    'so expect this column to be entirely NULL until a model fills it. 0 means '
    'the provider reported zero. The two are told apart by field PRESENCE in '
    'the response, not by value.';


-- The quota query lost its `source` predicate when the two caps became one
-- budget, and the existing index cannot serve the new shape.
--
-- `nutrition_estimates_quota_idx` leads `(user_id, source, created_at DESC)`.
-- With `source` no longer filtered, it sits BETWEEN the two columns that still
-- are, so the window can no longer be a range scan — the planner falls back to
-- reading every row the athlete has ever produced and filtering by date. That
-- is unbounded in an athlete's history, on a query that runs before every
-- estimate call, and no correctness test would notice: the count comes out
-- right either way.
--
-- The old index is KEPT rather than replaced. It still serves the per-source
-- analysis this table exists to make possible — the photo-to-text mix is a real
-- question even now that it no longer decides who gets stopped.
CREATE INDEX nutrition_estimates_user_window_idx
    ON nutrition_estimates (user_id, created_at DESC);

COMMENT ON INDEX nutrition_estimates_user_window_idx IS
    'Serves the combined-budget quota window (user_id, created_at). The older '
    'nutrition_estimates_quota_idx leads with source and cannot range-scan '
    'this shape. See internal/modules/nutrition/estimate_postgres.go.';
