-- N522/#934: session_metrics records the ACTUAL [start, end] window this
-- row's samples were queried from -- not the same thing as the owning
-- session's own started_at/ended_at, once ComputeSessionMetrics can be asked
-- to look somewhere else (see biometric.go's ValidateHRWindowOverride and
-- the Repository interface's own doc comment on ComputeSessionMetrics).
--
-- The incident this fixes: a post-hoc-logged BJJ session's started_at/ended_at
-- are computed from the duration the athlete typed and the moment they
-- tapped "Log it" -- not from when training actually happened. A plain
-- window read against those times can query a stretch of the day the watch
-- never saw anything unusual in, and report "no heart-rate data" for a
-- session real HR evidence exists for, nearby, in the same HealthKit store.
-- The mobile fix (lib/hrWindowFit.ts) widens the query, fits the athlete's
-- own logged duration against the real elevated-HR block it finds, and asks
-- ComputeSessionMetrics to use THAT window instead -- without ever touching
-- sessions.started_at/ended_at itself. "Heart rate corroborates a session,
-- it never replaces what the athlete logged."
--
-- Storing the window on EVERY row (not only overridden ones) is deliberate,
-- matching biometric.go's SessionMetrics.HRWindowStart/End doc comment: this
-- is exactly what would have made the incident immediately diagnosable
-- rather than invisible -- the session detail screen can now show precisely
-- what was queried, whether that matches the session's own logged time or
-- not.
--
-- NOT NULL, unlike 000090's hr_max_bpm/hr_max_source: those had no correct
-- historical value to infer for a pre-existing row (no client surface
-- existed yet to have computed one honestly). This column DOES have a
-- correct historical value for every existing row -- before this ticket,
-- ComputeSessionMetrics had no override parameter at all, so every row ever
-- written was computed from exactly its owning session's own
-- started_at/ended_at. The backfill below is not a guess.
SET lock_timeout = '3s';

ALTER TABLE session_metrics
    ADD COLUMN hr_window_start TIMESTAMPTZ,
    ADD COLUMN hr_window_end   TIMESTAMPTZ;

UPDATE session_metrics sm
SET hr_window_start = s.started_at,
    hr_window_end   = s.ended_at
FROM sessions s
WHERE sm.session_id = s.id
  AND s.ended_at IS NOT NULL;

-- backend-reviewer (N522 PR review) caught that `<` here is STRICTER than
-- sessions' own bound, `sessions_ends_after_start CHECK (ended_at IS NULL OR
-- ended_at >= started_at)` (000010) -- which allows a zero-duration session.
-- The no-override path in ComputeSessionMetrics sets hr_window_start/end to
-- exactly session.started_at/ended_at with no independent validation of its
-- own (ValidateHRWindowOverride is a no-op when both params are nil), so a
-- stricter bound here would (a) risk the migration itself failing outright
-- at deploy time against any already-existing zero-duration-session row,
-- since this ALTER validates existing data, and (b) start rejecting a
-- zero-duration session's metrics compute going forward with an opaque
-- 23514, which is a real behavior regression this ticket does not intend.
-- `<=` matches the sessions table's own long-standing bound exactly -- this
-- constraint is a NOT-NULL-and-sane-order guard, not a stricter invariant
-- than the one the owning session itself has always been allowed to have.
ALTER TABLE session_metrics
    ALTER COLUMN hr_window_start SET NOT NULL,
    ALTER COLUMN hr_window_end   SET NOT NULL,
    ADD CONSTRAINT session_metrics_hr_window_valid
        CHECK (hr_window_start <= hr_window_end);
