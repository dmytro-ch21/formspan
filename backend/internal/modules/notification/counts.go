package notification

import (
	"context"
	"fmt"
)

// Counts is the whole implementation: ask everything registered, in order,
// and hand back what they say.
//
// Not a PostgresRepository, because this package owns no table and touches no
// pool. The counting SQL lives in the module that owns the rows, which is what
// keeps this one from importing them.
type Counts struct {
	reg Registry
}

func NewCounts(reg Registry) *Counts { return &Counts{reg: reg} }

func (c *Counts) Pending(ctx context.Context, userID string) (map[string]int, error) {
	out := make(map[string]int, len(c.reg))
	for key, counter := range c.reg {
		n, err := counter.PendingCount(ctx, userID)
		if err != nil {
			// The whole request fails. See Repository.Pending: a zero that
			// means "could not check" is the one wrong answer this endpoint
			// must never give.
			return nil, fmt.Errorf("notification: count %s: %w", key, err)
		}
		out[key] = n
	}
	return out, nil
}
