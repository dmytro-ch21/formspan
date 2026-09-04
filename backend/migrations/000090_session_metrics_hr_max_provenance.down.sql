SET lock_timeout = '3s';

ALTER TABLE session_metrics
    DROP COLUMN IF EXISTS hr_max_source,
    DROP COLUMN IF EXISTS hr_max_bpm;
