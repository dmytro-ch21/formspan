SET lock_timeout = '3s';

ALTER TABLE session_metrics
    DROP CONSTRAINT IF EXISTS session_metrics_hr_window_valid,
    DROP COLUMN IF EXISTS hr_window_start,
    DROP COLUMN IF EXISTS hr_window_end;
