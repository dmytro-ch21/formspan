// Package activity is the unified "activity envelope" domain — one table
// for every sport/kind of logged activity (BJJ session, strength workout,
// nutrition entry, ...), distinguished by Kind with a flexible JSONB
// Details bag for whatever fields that kind needs. Deliberately generic
// rather than per-sport tables, matching the product's own vision; add a
// typed sub-model later only once a real need shows up for one.
package activity

import (
	"context"
	"encoding/json"
	"time"
)

type Activity struct {
	ID         string          `json:"id"`
	UserID     string          `json:"user_id"`
	Kind       string          `json:"kind"`
	OccurredAt time.Time       `json:"occurred_at"`
	Notes      *string         `json:"notes"`
	Details    json.RawMessage `json:"details,omitempty"`
	RequestID  string          `json:"request_id"`
	TraceID    string          `json:"trace_id"`
	CreatedAt  time.Time       `json:"created_at"`
}

// NewActivity is Create's input. The client supplies ID/Kind/OccurredAt/
// Notes/Details — ID is client-generated so offline-created activities can
// sync idempotently (retrying a sync with the same ID is a no-op, not a
// duplicate). UserID/RequestID/TraceID are stamped server-side from the
// authenticated caller and the current request's own correlation IDs —
// never trusted from the client.
type NewActivity struct {
	ID         string
	UserID     string
	Kind       string
	OccurredAt time.Time
	Notes      *string
	Details    json.RawMessage
	RequestID  string
	TraceID    string
}

// UserSummary is what admin's user-lookup screen shows: every user who's
// completed onboarding (has a profile), not just ones with activities.
type UserSummary struct {
	UserID         string     `json:"user_id"`
	DisplayName    *string    `json:"display_name"`
	ActivityCount  int        `json:"activity_count"`
	LastActivityAt *time.Time `json:"last_activity_at"`
}

type Repository interface {
	// Create is idempotent on in.ID — calling it again with the same ID
	// returns the original row rather than erroring, so offline-sync
	// retries are always safe.
	Create(ctx context.Context, in NewActivity) (*Activity, error)
	ListByUser(ctx context.Context, userID string) ([]Activity, error)
	ListUsers(ctx context.Context) ([]UserSummary, error)
}
