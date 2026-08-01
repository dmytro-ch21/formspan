// Package featureflag holds server-controlled, global on/off switches —
// distinct from the per-user module toggles in profile_modules (see
// internal/platform/discipline and GET/PATCH /v1/modules), which are
// self-service. These are
// operator-controlled (canary rollouts, killswitches, hiding an
// in-development feature) and apply to every caller the same way.
//
// Global boolean flags only, no percentage rollout or per-user targeting —
// add that if a real use case shows up. Read-only for now: there's no
// write endpoint yet, flags are toggled via direct SQL until there's an
// actual reason (an admin-console screen, more than a handful of changes
// a month) to justify a backend admin-authorization concept and a write
// path.
package featureflag

import (
	"context"
	"time"
)

type Flag struct {
	Key         string    `json:"key"`
	Enabled     bool      `json:"enabled"`
	Description string    `json:"description"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Repository interface {
	List(ctx context.Context) ([]Flag, error)
}
