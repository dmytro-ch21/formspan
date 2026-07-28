CREATE TABLE profiles (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    date_of_birth DATE,
    sex TEXT CHECK (sex IS NULL OR sex IN ('male', 'female')),
    bjj_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    strength_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    nutrition_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    running_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
