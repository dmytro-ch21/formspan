-- What the athlete is deliberately working on right now.
--
-- The point is that this is SHORT and changes every few weeks. It exists to
-- collapse a redundancy rather than add a feature: the reflection wizard was
-- capturing the same live event twice — once per-technique on the drilled step
-- and once per-category in the live grid — and the fix is not a convention for
-- reading them, it is one capture path. A focus technique's chip becomes a row
-- IN the live grid, so there is no second place to record it.
--
-- It also decides where technique-level detail is worth its cost. Naming a
-- technique means searching a 466-entry library; across the whole catalog that
-- data is mostly noise, across the three-to-five things you are developing it
-- is the most valuable evidence there is.
CREATE TABLE IF NOT EXISTS bjj_focus
(
    user_id      TEXT    NOT NULL,

    -- CASCADE, unlike bjj_session_tags.technique_id, which is SET NULL.
    -- The difference is deliberate: evidence that you drilled something must
    -- survive the library retiring it, but an intention to work on a technique
    -- that no longer exists is not worth keeping.
    technique_id TEXT    NOT NULL REFERENCES techniques (id) ON DELETE CASCADE,

    -- Display order, client-supplied. A focus list is ranked by the athlete,
    -- not by us.
    position     INTEGER NOT NULL,

    -- When this technique JOINED the list, which is what makes "you have been
    -- on this five weeks, consider rotating" answerable. Set on insert and
    -- never touched by a re-save — see the upsert in SetFocus, which updates
    -- `position` only. Reordering the list must not reset the clock on every
    -- entry, or the one signal this column exists for is destroyed by the most
    -- ordinary edit there is.
    started_on   DATE    NOT NULL DEFAULT CURRENT_DATE,

    PRIMARY KEY (user_id, technique_id)
);

-- The only read: one athlete's list, in their order.
CREATE INDEX IF NOT EXISTS bjj_focus_user_position_idx
    ON bjj_focus (user_id, position, technique_id);
