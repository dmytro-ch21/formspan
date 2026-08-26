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
	"errors"
	"time"
)

// ErrAlreadyExists means the client-generated activity ID is already in use
// by a *different* user. A same-user repeat is an idempotent retry, not this.
var ErrAlreadyExists = errors.New("activity: id already exists for another user")

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

// UserSummary is what admin's user-lookup screen shows.
//
// It used to be `activity_count` and `last_activity_at` — both read from
// `activities`, a table with **no writer**. The in-app form that used it was
// removed, and nothing replaced it, so every row showed 0 and null while real
// training sat in `sessions` and `session_sets`, invisible. Staging today: 0
// activities, 2 sessions, 36 sets.
//
// The counts below come from `sessions`, which is the only table that records
// something a user actually did. Nothing new is written to produce them —
// they are aggregates over rows that already exist, which is the whole answer
// to "track the important things without bloating the database".
//
// What this deliberately does NOT claim: "active" here means *logged
// training*, not *opened the app*. No read path leaves a trace, so someone
// browsing daily looks identical to a churned account. Naming the field
// `LastSessionAt` rather than `LastSeenAt` keeps that honest.
type UserSummary struct {
	UserID      string  `json:"user_id"`
	DisplayName *string `json:"display_name"`
	// Sessions logged, all time.
	SessionCount int `json:"session_count"`
	// The most recent session start — the best "is this account alive" signal
	// that exists without adding a write path.
	LastSessionAt *time.Time `json:"last_session_at"`
	// Sets logged, all time. Distinguishes someone who started two sessions
	// and abandoned them from someone who trained twice.
	SetCount int `json:"set_count"`
	// Disciplines this user has switched ON, resolved through the registry so
	// an absent row reads as the default rather than as "off".
	Modules []string `json:"modules"`
	// When they joined.
	CreatedAt *time.Time `json:"created_at"`
	// HasAvatar is the admin console's whole answer to "is there an image to
	// look at, or a moderation report about". No URL here — this endpoint is
	// RequireAdmin, not RequireAuth, and profile.Handler's presigning lives on
	// the profile module; an admin who needs to actually SEE the avatar looks
	// at the account in the app, or asks for the presigned link from support
	// tooling that has it. This boolean is what makes "Remove avatar" a real
	// button rather than a dead one on every account.
	HasAvatar bool `json:"has_avatar"`
}

// UserDetail is one athlete's admin page: the same summary row, plus the
// sessions behind it.
//
// The page it feeds used to render `activities` and nothing else, so it was
// permanently, misleadingly empty — "No activities for this user ID. Either
// they haven't logged any yet, or the ID is wrong." was shown to operators
// looking at accounts with real training in them.
type UserDetail struct {
	User UserSummary `json:"user"`
	// Newest first, capped — see maxDetailSessions. An admin screen needs
	// enough to answer "what have they been doing", not the whole history.
	RecentSessions []SessionSummary `json:"recent_sessions"`
}

// SessionSummary is one training session as the admin console shows it.
//
// Deliberately NOT the full session with its sets: the question here is
// "what did this person do, and did it finish", which needs a count, not 36
// rows of weights. Anyone needing the detail has the athlete-facing API.
type SessionSummary struct {
	ID        string    `json:"id"`
	Sport     string    `json:"sport"`
	Name      string    `json:"name"`
	StartedAt time.Time `json:"started_at"`
	// Nil means still in progress — which, at a week old, is itself a finding.
	EndedAt  *time.Time `json:"ended_at"`
	SetCount int        `json:"set_count"`
}

type Repository interface {
	// Create is idempotent on in.ID — calling it again with the same ID
	// returns the original row rather than erroring, so offline-sync
	// retries are always safe.
	Create(ctx context.Context, in NewActivity) (*Activity, error)
	ListByUser(ctx context.Context, userID string) ([]Activity, error)
	ListUsers(ctx context.Context) ([]UserSummary, error)
	// GetUser is the per-athlete admin view. Returns ErrNotFound only when NO
	// TABLE knows the id — a user with sessions but no profile row resolves
	// normally, same as in ListUsers. An operator pasting a wrong id must be
	// told it is wrong rather than shown a convincing page of zeroes; an
	// operator looking up a real athlete who never onboarded must not be.
	GetUser(ctx context.Context, userID string) (*UserDetail, error)
}

// ErrNotFound means no table knows that user id — not merely that they have
// no profile row. Someone who trained without completing onboarding exists.
var ErrNotFound = errors.New("activity: user not found")
