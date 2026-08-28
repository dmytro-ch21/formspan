-- N431: a "no more after this time" cutoff on a daily tracker.
--
-- ## What this is for
--
-- Caffeine's own acceptance criterion is a warning line for when to stop
-- drinking coffee relative to sleep — "no more caffeine after N hours before
-- bed". There is no sleep model in this app today, and this ticket does not
-- add one: the simplest honest version, per the ticket itself, is a configured
-- cutoff CLOCK TIME on the tracker's own settings. An athlete who thinks in
-- "six hours before my 22:00 bedtime" computes 16:00 once, at authoring time,
-- and types that; the column only ever holds the result.
--
-- ## Why this is a column on `daily_trackers`, not a caffeine-only field
--
-- Every other distinguishing fact about a tracker — target, increment, unit,
-- the noun for one tap — is a value on the generic row, per the header of
-- `000068_create_daily_trackers.up.sql`: "there is one table of DEFINITIONS
-- ... and everything that distinguishes water from coffee from creatine is a
-- value in a column." A `caffeine_cutoff_minutes` column, or a branch on
-- `preset = 'caffeine'` anywhere in this module, would be exactly the
-- CoffeeCard `trackerCard.tsx`'s own header says never got built. Nothing
-- stops an athlete from putting the same cutoff on a late pre-workout
-- supplement tracker; the column does not know it was built for caffeine.
--
-- ## Minutes since local midnight, not a TIME
--
-- A plain integer 0..1439 rather than Postgres TIME, for the same reason the
-- client already renders every clock reading itself (`formatClock` in
-- `trackerModel.ts`): there is no timezone info anywhere else on this row, the
-- comparison is always against the ATHLETE's local wall clock, and a TIME
-- column would invite a naive comparison against `now()` in UTC. Minutes are
-- also what the client already works in nowhere else convert-worthy: no
-- ml/fl-oz-style unit preference applies to a clock reading.
--
-- ## NULL is "no cutoff configured", the same reading `target` already uses
--
-- Not configuring one is not zero and is not midnight. See the CHECK below —
-- 0 is a legal cutoff (midnight) and must be distinguishable from "the
-- athlete never set one".

SET lock_timeout = '3s';

ALTER TABLE daily_trackers
    ADD COLUMN cutoff_minutes SMALLINT
        CHECK (cutoff_minutes IS NULL OR cutoff_minutes BETWEEN 0 AND 1439);

COMMENT ON COLUMN daily_trackers.cutoff_minutes IS
    'Minutes since local midnight — a plain clock time with no cutoff-kind '
    'notion attached, e.g. 960 for 16:00. NULL means no cutoff is configured, '
    'a real state distinct from midnight (0). The client derives the warning '
    '("last at 15:40 — past your 16:00 cutoff") from this and the day''s last '
    'entry; nothing here knows the tracker it is attached to is caffeine.';
