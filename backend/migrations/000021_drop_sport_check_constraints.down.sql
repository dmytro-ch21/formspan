-- Restore the constraints as they were in 000006 and 000010.
--
-- NOTE: this hardcodes the vocabulary as of the time it was written. If the
-- registry has since gained a discipline, rows using it will already exist and
-- this will fail — correctly, because the constraint genuinely is wrong at
-- that point. That failure is the honest signal, not a bug in this file.
ALTER TABLE workouts ADD CONSTRAINT workouts_sport_valid CHECK (sport IN ('strength', 'running', 'bjj'));
ALTER TABLE sessions ADD CONSTRAINT sessions_sport_valid CHECK (sport IN ('strength', 'running', 'bjj'));
