-- Separate what a technique DOES from where it happens.
--
-- WHY: `techniques.category` is not one axis, it is two fused together.
-- "Takedown" means advance-at-standing; "Pass" means advance-at-guard-top;
-- "Sweep" means reverse-at-guard-bottom. The where half is already recorded
-- in `position`, so the category column encodes it a second time — and two
-- columns carrying the same fact can disagree. They happen not to today
-- (checked: zero takedowns off Standing, zero sweeps from a top position,
-- zero passes from the bottom), which is exactly why this is cheap to do now
-- and expensive later.
--
-- The consequence of the fusion is that the library cannot answer the
-- question the whole taxonomy exists to answer: "what are all the ways to
-- advance from here" spans three categories, and "what are all the ways to
-- escape" spans two. `function` collapses the nine categories onto the five
-- things a technique can actually do:
--
--   advance  -- takedowns, guard passes, mount transitions, back takes
--   reverse  -- sweeps and reversals: bottom becomes top
--   escape   -- pin escapes, submission defence, guard retention and recovery
--   control  -- pins, rides, grip and frame systems, structural entries
--   finish   -- submissions
--
-- WHY NOT REPLACE `category`: because it is not wrong, it is colloquial.
-- "Sweep" is what a coach says out loud; "reverse-at-guard-bottom" is not.
-- The Library keeps showing the familiar word and gains a queryable axis
-- underneath it. Dropping `category` would also silently rewrite the belt
-- filter and every client that groups by it, for no gain.
--
-- WHY NULLABLE, AND WHY NO CHECK: four rows are movement fundamentals —
-- breakfalls, a shoulder roll, grappling stance — which have no noun and no
-- verb. They are content in the library, not techniques, and forcing them
-- into one of the five would make the taxonomy assert something false. NULL
-- says "this does not apply" rather than guessing.
--
-- No CHECK constraint on the vocabulary, per the convention migration 000021
-- established when it dropped the sport CHECKs: an enumerated set that will
-- grow is validated in Go, where adding a value is a code change and not a
-- migration. The seed refuses to load an unknown function, which is the
-- enforcement that actually runs.
SET lock_timeout = '3s';

ALTER TABLE techniques
    ADD COLUMN function TEXT;

-- Answers "every way to advance from side control" without scanning. The
-- library is small enough that this is not urgent today; it is here because
-- the read that motivated the column is exactly (position, function).
CREATE INDEX IF NOT EXISTS techniques_position_function_idx
    ON techniques (position, function);
