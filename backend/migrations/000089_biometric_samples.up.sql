-- Biometric samples and session metrics: N476/#821, the storage half of the
-- HealthKit/Health Connect integration researched in
-- docs/decisions/health-integration-design.md. `biometric`, not `health` --
-- that name is already `internal/modules/health`, operational telemetry, a
-- different domain that happens to share the word (design doc §6.3).
--
-- Two tables because they answer different questions, per §6.3:
--
-- `biometric_samples` is the raw record, one row per reading, source-agnostic
-- (a heart-rate sample, a resting-HR reading, a night's sleep duration, a
-- body-mass reading -- see biometric.MetricType). Nothing here is scoped to a
-- session; a session's heart-rate enrichment is derived FROM this table by
-- reading whatever falls in its started_at/ended_at window (design doc §2's
-- "window read"), never written directly against a session.
--
-- `session_metrics` is the derived per-session enrichment: average/peak HR,
-- a five-zone breakdown, one Edwards' TRIMP load number, and the
-- hr_source/sample_count honesty pair that says how much evidence backs the
-- rest of the row. Computed on demand from `biometric_samples`, not kept in
-- sync with it automatically -- same "derive on read, never let a cached
-- number go stale behind the log it was built from" stance session.Records
-- and running.DistanceRecords already take, for the identical reason: a
-- kept number would have to be retracted whenever the samples behind it
-- changed, and a stale one asserts a load the athlete didn't actually carry.
--
-- # Retention: indefinite -- resolved 2026-09-01
--
-- The design doc (§7, §10 item 5) flagged retention as unresolved and
-- legally blocking before the first write, since resting HR/sleep/HRV under
-- a user identity is GDPR Article 9 special-category health data. This
-- migration is the answer: biometric data is kept indefinitely, the same
-- stance already taken on every other piece of training history this
-- product keeps forever without a separate expiry job -- sessions, sets,
-- body-weight checkins. No special TTL, no scheduled deletion job, nothing
-- here that treats this table differently from `sessions` or
-- `body_checkins`. An athlete's account deletion (wherever that flow lives)
-- removes it exactly the way it removes everything else tied to user_id --
-- there is no bespoke deletion path for THIS table to build or maintain.
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS biometric_samples
(
    -- Client-generated, matching activities' idempotency pattern: a sync
    -- retry re-sends the same id and converges (ON CONFLICT DO NOTHING in
    -- Go) rather than duplicating or erroring.
    id              TEXT             PRIMARY KEY,
    user_id         TEXT             NOT NULL,

    -- 'heart_rate' | 'active_energy' | 'resting_heart_rate' | 'hrv_sdnn' |
    -- 'hrv_rmssd' | 'sleep_duration' | 'body_mass'. No CHECK, deliberately --
    -- validated in Go (biometric.MetricType), so a new reading type is a
    -- one-line Go change rather than a migration. Same stance 000021 took
    -- dropping the sport CHECKs and running_session_detail's `source` column
    -- takes on its own growing vocabulary.
    --
    -- hrv_sdnn and hrv_rmssd are separate values rather than one `hrv` type
    -- with a unit column ON PURPOSE -- design doc §5.4/§6.3: "making them
    -- the same enum value is how someone eventually compares them," which
    -- must never happen (Apple's SDNN and everyone else's rMSSD are not the
    -- same metric).
    metric_type     TEXT             NOT NULL,

    -- The device/vendor and the platform framework that surfaced it --
    -- 'apple_watch'/'oura'/'whoop'/'garmin'/'manual' and
    -- 'healthkit'/'health_connect'/'manual' respectively. Both validated in
    -- Go for the same reason metric_type is; kept as two separate columns
    -- rather than one because they are independent axes (§6.3: "a source
    -- change renders as a labelled discontinuity" on a trend chart -- that
    -- needs `source`, and dedup/provenance auditing needs `source_platform`
    -- too, per design doc §5.3).
    source          TEXT             NOT NULL,
    source_platform TEXT             NOT NULL,

    value           DOUBLE PRECISION NOT NULL,
    unit            TEXT             NOT NULL,

    -- When the reading was taken. For an interval reading (sleep_duration)
    -- this is the interval's START; period_end below is its end. NULL
    -- period_end means an instantaneous reading (heart_rate, body_mass) --
    -- most rows.
    measured_at     TIMESTAMPTZ      NOT NULL,
    period_end      TIMESTAMPTZ      CONSTRAINT biometric_samples_period_end_after_measured_at
                                      CHECK (period_end IS NULL OR period_end >= measured_at),

    created_at      TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- The window-read query (design doc §2): "every heart_rate sample for this
-- user between started_at and ended_at." metric_type before measured_at so
-- the same index also serves "every resting_heart_rate reading this user
-- has, most recent first" for a future trend surface (N481) without a
-- second index.
CREATE INDEX biometric_samples_user_metric_measured_idx
    ON biometric_samples (user_id, metric_type, measured_at);

CREATE TABLE IF NOT EXISTS session_metrics
(
    -- One row per session -- matches running_session_detail/
    -- bjj_session_details' shape exactly: shares the session's id rather
    -- than minting its own, since there is exactly one metrics row per
    -- session.
    session_id      TEXT             PRIMARY KEY,

    -- Denormalised so the composite owner FK below can exist -- same
    -- reasoning as running_session_detail.user_id (000014's argument): the
    -- FK is what makes "a session_metrics row can never belong to a
    -- different user than the session it names" a database-enforced
    -- invariant rather than an application-layer promise, which matters
    -- more here than almost anywhere else in this schema given what this
    -- table stores. NOT present in the design doc's original §6.3 sketch --
    -- a deliberate addition, matching the established per-session-detail
    -- convention rather than the sketch's simpler `references sessions(id)`.
    user_id         TEXT             NOT NULL,

    avg_hr_bpm      INTEGER,
    max_hr_bpm      INTEGER,
    active_kcal     INTEGER,
    trimp           DOUBLE PRECISION,

    -- {"1": minutes, ..., "5": minutes} -- Edwards' five zones. NOT NULL
    -- DEFAULT '{}': "no zone data yet" is a real, expected state (no HRmax
    -- was available, or no samples at all), and an empty object rather than
    -- a null lets a client iterate without a null check, matching
    -- running_session_detail's route_points/splits convention.
    time_in_zones   JSONB            NOT NULL DEFAULT '{}',

    -- 'workout' | 'window' | 'none' -- REQUIRED, and enforced with a real
    -- CHECK constraint rather than left to Go alone. Unlike metric_type/
    -- source above, this is not a vocabulary that grows: it is a small,
    -- stable, load-bearing honesty field (design doc §6.3: "never silently
    -- defaulted to a value implying more confidence than the data has"),
    -- the same stability profile `sessions.sport` has -- and that column
    -- keeps its own CHECK. Defence in depth: even a future bug in the Go
    -- layer's Compute cannot write a row claiming 'workout' or 'window'
    -- confidence past what this constraint allows, though the emptiness
    -- check (zero samples -> 'none') still lives in Go, since the database
    -- has no way to see sample_count's relationship to the samples table
    -- from a CHECK constraint alone.
    hr_source       TEXT             NOT NULL
                                      CONSTRAINT session_metrics_hr_source_valid
                                      CHECK (hr_source IN ('workout', 'window', 'none')),

    sample_count    INTEGER          NOT NULL DEFAULT 0,
    computed_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),

    -- Matches what the design doc already requires of the recommendation
    -- engine (§8): store the rule version alongside every derived output, so
    -- a later change to the TRIMP formula or the zone boundaries is
    -- detectable rather than silently reinterpreted as a fresher answer for
    -- an old computation.
    rule_version    INTEGER          NOT NULL,

    CONSTRAINT session_metrics_session_owner_fk
        FOREIGN KEY (session_id, user_id) REFERENCES sessions (id, user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);
