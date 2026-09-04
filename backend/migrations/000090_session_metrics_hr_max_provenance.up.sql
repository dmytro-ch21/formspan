-- N483/#833: session_metrics records the HRmax VALUE used to derive that
-- row's zones/TRIMP, and whether it was ESTIMATED (220 - age) or OBSERVED
-- (the athlete's own recorded maximum) -- design doc §3's HRmax sequencing,
-- quoted directly:
--
--   "Never silently switch between them. Which HRmax produced a given
--   session's zones belongs in session_metrics alongside hr_source, for the
--   same reason."
--
-- Follow-up from N476/#821 (biometric.ComputeSessionMetrics, the module that
-- created session_metrics -- see 000089_biometric_samples.up.sql), flagged
-- by ac-verifier during that ticket's review rather than folded into it.
-- N476 already stored hr_source (how confidently the SAMPLES are grounded);
-- this migration stores the other half of the honesty pair the design doc
-- calls for -- how confidently the HRMAX that classified those samples into
-- zones is grounded.
--
-- Both columns NULLABLE, deliberately -- not because a legitimate computed
-- row can lack them (biometric.ComputeSessionMetrics always writes both
-- together whenever it writes a TRIMP at all -- see postgres.go and
-- trimp.go's Compute), but because no client (mobile/web) surface exists yet
-- to have written any session_metrics row at all (see biometric.go's package
-- doc: "No client (mobile/web) surface exists yet"). There is nothing to
-- backfill. A NULL on a row that already has a TRIMP means exactly one
-- thing -- "computed before N483 shipped" -- and reads that way on any
-- future audit; a NULL alongside a NULL TRIMP is the ordinary "couldn't
-- classify anything" case TRIMP/time_in_zones already cover.
--
-- No separate history table for past HRmax values: session_metrics is
-- already "derive on demand, never kept in sync automatically" (see
-- 000089's own table comment), and ComputeSessionMetrics UPSERTs exactly one
-- row per session_id. A recompute with a different HRmax simply overwrites
-- hr_max_bpm/hr_max_source along with everything else in that same row --
-- the row itself is the up-to-date record of what produced its current
-- numbers, and there was never a second copy of the old numbers to begin
-- with for a newer HRmax to silently clobber.
--
-- This migration is a pure ADD COLUMN and does not touch either of N476's
-- existing constraints on this table (session_metrics_hr_source_valid,
-- session_metrics_session_owner_fk).
SET lock_timeout = '3s';

ALTER TABLE session_metrics
    ADD COLUMN hr_max_bpm    DOUBLE PRECISION,
    -- 'estimated' | 'observed', or NULL on a pre-N483 row -- CHECKed for the
    -- identical reason hr_source is (000089's comment): a small, stable,
    -- two-value vocabulary that will not grow the way metric_type/source do,
    -- so defence-in-depth behind biometric.HRMaxSource.Valid() costs nothing
    -- and matters exactly as much here as it does for hr_source.
    ADD COLUMN hr_max_source TEXT
                              CONSTRAINT session_metrics_hr_max_source_valid
                              CHECK (hr_max_source IS NULL OR hr_max_source IN ('estimated', 'observed'));
