-- N126/#520: a planned session gets a time, so Today can say when.
--
-- ## What was missing
--
-- `plans` carried only `day` — which calendar square, never which moment on
-- it. So the reference Today design (`UP NEXT — Today • 7:00 PM`) could only
-- ever be dishonest: there is no time to show, and inventing one to match a
-- mockup is displaying data the athlete never gave us. #487 deliberately kept
-- this out and filed it here instead. See docs/decisions/history.md's N126
-- entry for the fuller reasoning on all three decisions below.
--
-- ## A time, not a slot
--
-- Considered a Morning/Midday/Evening enum instead of a real clock value.
-- Rejected: the sharpest thing Today can say about a plan is whether it is
-- behind the athlete or still ahead of them, and only a real time answers
-- that with any precision — comparing "now" against "Evening" still leaves
-- the athlete guessing when Evening starts. A slot and a real time both sort,
-- so sorting does not decide between them; being able to say "in 40 minutes"
-- does.
--
-- ## Minutes since local midnight, not a Postgres TIME
--
-- The identical decision `000079_tracker_cutoff.up.sql` already made for
-- exactly this category of value, and for the identical reason: there is no
-- timezone information anywhere else on this row, the comparison an athlete
-- cares about is always against their own local wall clock, and a TIME
-- column invites exactly the naive `now()`-in-UTC comparison that reasoning
-- exists to prevent. A plain SMALLINT also sorts correctly with nothing more
-- than ORDER BY, which is the other half of this ticket's acceptance
-- criteria.
--
-- ## Whose timezone
--
-- Wall-clock, unzoned, exactly like `day` itself: "7pm" means 7pm wherever
-- the athlete is standing that day, not an instant translated from
-- wherever the server or the device happened to be when it was typed. There
-- is deliberately no conversion anywhere on this column's read or write path
-- — see plan.go's ValidTimeOfDayMinutes and postgres.go's Create/Update,
-- neither of which ever calls time.Local or constructs a zoned time.Time.
--
-- ## NULL is "no time given", not midnight
--
-- Every plan on `main` today has no time at all, and that must stay a real,
-- renderable state forever — not a default that quietly claims a false
-- precision. NULL is that state, distinct from 0 (00:00, a real planned
-- midnight session), matching `daily_trackers.cutoff_minutes`'s own rule.

SET lock_timeout = '3s';

ALTER TABLE plans
    ADD COLUMN time_of_day_minutes SMALLINT
        CONSTRAINT plans_time_of_day_minutes_range
        CHECK (time_of_day_minutes IS NULL OR time_of_day_minutes BETWEEN 0 AND 1439);

COMMENT ON COLUMN plans.time_of_day_minutes IS
    'Minutes since LOCAL midnight, wall-clock, no timezone attached — e.g. '
    '1140 for 7:00 PM. The athlete''s own local time on the day in question, '
    'never converted through any zone (matching plans.day). NULL means no '
    'time was given, a real state distinct from midnight (0), matching '
    'daily_trackers.cutoff_minutes''s identical rule.';
