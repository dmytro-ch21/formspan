-- Running session detail: the GPS track, splits, elevation and pace a run
-- has and a lift or a mat session do not.
--
-- # Why a companion table and not columns on `sessions`
--
-- A running session IS a session — `sport = 'running'`, a real row in
-- `sessions` — for the same reason a BJJ session is (see 000025): training
-- history, the consistency grid, active days and the cross-sport load
-- currency all read `sessions`, and a run that lived somewhere else would be
-- invisible to every one of them. This table hangs off that row rather than
-- widening it, because a route/splits/pace pack of columns is meaningless to
-- a squat or a roll and a shared table that carries every discipline's
-- specifics ends up carrying all of them badly — the same reasoning
-- `bjj_session_details` was built on.
--
-- # Why JSONB for the track and splits, not child tables
--
-- `bjj_session_tags` is a separate table because the technique funnel, the
-- position heatmap and gap detection all need to query it ACROSS sessions —
-- "every event for this technique", "every tag at this position". Nothing
-- here has that shape: a route point or a split is only ever read or written
-- as part of ITS OWN session's detail, never aggregated across sessions.
-- With no cross-session query to serve, a child table buys nothing and costs
-- real overhead — a two-hour run's track can be on the order of a thousand
-- points, which is a thousand round trips inside one transaction on every
-- save if stored as rows. JSONB stores the whole track and split list as one
-- value alongside the rest of the detail row, matching how the
-- Repository.PutDetail contract already treats them: replaced wholesale on
-- every write, never merged, never queried piecemeal.
--
-- # Why not the composite owner FK alone
--
-- Same stance as `bjj_session_details`: `(session_id, user_id)` referencing
-- `sessions (id, user_id)` is a backstop against a race (a session deleted
-- between the ownership check and the write), not the authorization itself.
-- The Go layer still checks ownership AND sport explicitly, because the FK
-- says nothing about sport and does not fire at all on the upsert's
-- DO UPDATE path — see running/postgres.go's PutDetail for the full
-- argument, which is verbatim the one that motivated bjj's own WHERE clause.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS running_session_detail
(
    -- Shares the session's id rather than minting its own — there is
    -- exactly one detail row per session, so a separate key could only let
    -- the two disagree. Matches bjj_session_details.session_id.
    session_id          TEXT             PRIMARY KEY,

    -- Denormalised so the composite owner FK below can exist. See 000014
    -- for the full argument; bjj_session_details does the same.
    user_id             TEXT             NOT NULL,

    -- The GPS track, in recording order: [{lat, lng, elevation_m,
    -- recorded_at}, ...]. Empty array (never null) for a manual entry or an
    -- imported summary with no track — a real run, not an error. Validated
    -- in Go (coordinate ranges, a point-count ceiling), not by a CHECK —
    -- same stance 000025 took on BJJ's `kind` vocabulary: a shape this rich
    -- is not worth expressing as SQL.
    route_points        JSONB            NOT NULL DEFAULT '[]',

    -- The distance-based splits, in order: [{distance_m, duration_seconds},
    -- ...]. Empty array (never null) when the client sends no splits.
    splits               JSONB            NOT NULL DEFAULT '[]',

    -- Total climb in metres. Nullable: a manual entry or a flat route may
    -- have none.
    elevation_gain_m     DOUBLE PRECISION CONSTRAINT running_session_detail_elevation_gain_non_negative
                                          CHECK (elevation_gain_m IS NULL OR elevation_gain_m >= 0),

    -- Average pace in seconds per kilometre, over the whole run. Nullable —
    -- see the Go type's doc comment for why this module does not compute it
    -- from distance/duration itself.
    avg_pace_sec_per_km  DOUBLE PRECISION CONSTRAINT running_session_detail_pace_non_negative
                                          CHECK (avg_pace_sec_per_km IS NULL OR avg_pace_sec_per_km >= 0),

    -- The run's own distance and duration. Nullable: an in-progress or
    -- otherwise incomplete detail row is still a legal state to PUT (see
    -- Validate — only the ranges are enforced, not presence).
    distance_m           DOUBLE PRECISION CONSTRAINT running_session_detail_distance_non_negative
                                          CHECK (distance_m IS NULL OR distance_m >= 0),
    duration_seconds     INTEGER          CONSTRAINT running_session_detail_duration_non_negative
                                          CHECK (duration_seconds IS NULL OR duration_seconds >= 0),

    -- phone_gps | healthkit | manual. No CHECK, deliberately: this
    -- vocabulary is validated in Go, so a fourth source later is an enum
    -- edit rather than a migration — same stance 000021 took dropping the
    -- sport CHECKs and 000025 took on BJJ's `kind`.
    source               TEXT             NOT NULL,

    created_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),

    CONSTRAINT running_session_detail_session_owner_fk
        FOREIGN KEY (session_id, user_id) REFERENCES sessions (id, user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);
