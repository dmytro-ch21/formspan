SET lock_timeout = '3s';

-- ONE envelope for sharing anything, rather than a share path per module.
--
-- Four private implementations of "share this" was the alternative, and the
-- third would already have diverged from the first. So the row says only WHAT
-- kind of thing, WHICH one, FROM whom, TO whom — and the module that owns that
-- kind knows how to duplicate it. The share module never imports the modules it
-- copies; they register a Copier in cmd/api/main.go instead, or every future
-- domain joins one dependency knot.
--
-- resource_id has NO foreign key, and cannot: it points at a different table
-- per resource_type. The cost is real and handled in code — a resource deleted
-- while a share is pending leaves a row pointing at nothing, so accepting one
-- resolves the source first and clears the share when it is gone, rather than
-- copying a ghost.
CREATE TABLE shares (
    id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    resource_type TEXT        NOT NULL,
    resource_id   TEXT        NOT NULL,

    -- The label the SENDER's copy carried at the moment they sent it. Stored,
    -- not resolved live, because this is a message: what it said when it was
    -- sent does not change afterwards. Note the copy is taken LIVE at accept
    -- time, so a sender who renames in between produces a card and a copy that
    -- disagree — the copy is right, and the card is a record of what was said.
    resource_label TEXT NOT NULL,

    from_user_id  TEXT        NOT NULL,
    to_user_id    TEXT        NOT NULL,

    -- Two states, not three. DECLINE IS DELETE, exactly as it is for friend
    -- requests: a stored "declined" either tells the sender their thing was
    -- rejected — social friction the app has no business manufacturing — or
    -- forces the API to lie about why nothing happened.
    status        TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'accepted')),

    -- What accepting produced, in the RECIPIENT's ownership.
    copied_resource_id TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at   TIMESTAMPTZ,

    CONSTRAINT shares_not_self CHECK (from_user_id <> to_user_id),

    -- Accepted IF AND ONLY IF a copy exists, spelled out per state rather than
    -- as a biconditional over a conjunction.
    --
    -- The biconditional was written first and is WEAKER than it reads: with
    -- `(status='accepted') = (copy IS NOT NULL AND accepted_at IS NOT NULL)`, a
    -- PENDING row carrying a copy id and a null accepted_at satisfies it — both
    -- sides are false — so "a copy recorded while still pending" stayed
    -- representable. Review proved it with a direct insert rather than by
    -- reading, which is the only way that class of mistake gets caught.
    --
    -- What this makes unrepresentable: an accepted share with no copy (the
    -- recipient said yes and got nothing), and a half-written accept of either
    -- shape. Double-copying is prevented separately, by the FOR UPDATE claim.
    CONSTRAINT shares_accepted_has_copy CHECK (
        (status = 'accepted'
             AND copied_resource_id IS NOT NULL AND accepted_at IS NOT NULL)
        OR (status = 'pending'
             AND copied_resource_id IS NULL AND accepted_at IS NULL)
    )
);

-- One PENDING share of a given thing between a given pair. Re-sending while
-- one is unanswered is the same message twice; the partial predicate is what
-- keeps re-sharing legal AFTER an accept, which is how an author sends an
-- updated version.
CREATE UNIQUE INDEX shares_pending_uniq
    ON shares (resource_type, resource_id, from_user_id, to_user_id)
    WHERE status = 'pending';

-- The inbox read: everything addressed to me, newest first.
CREATE INDEX shares_inbox_idx ON shares (to_user_id, created_at DESC);
-- NO index on from_user_id. Cancelling is a primary-key lookup and there is
-- no sent list yet, so it would be write amplification for a feature that does
-- not exist — this project has dropped exactly such an index once before
-- (000018). It arrives with the sent list, not in anticipation of it.
