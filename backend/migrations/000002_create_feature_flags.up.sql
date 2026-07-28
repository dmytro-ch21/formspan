CREATE TABLE feature_flags (
    key TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    description TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (key, enabled, description) VALUES
    ('new_recommendation_engine', FALSE, 'Deterministic recommendation-rule engine v2 — off until the ruleset is validated against the v1 baseline.'),
    ('bjj_technique_video_upload', FALSE, 'Lets athletes attach a video clip to a technique library entry.');
