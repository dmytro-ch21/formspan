package devengine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
)

// ShadowLog is the Phase 1 Dispatcher: it appends one JSON line per decision
// and touches nothing else — no code edits, no GitHub writes. The file is
// opened O_APPEND on every write so concurrent or restarted shadow processes
// interleave whole lines rather than corrupting each other; nothing ever
// rewrites or truncates it.
type ShadowLog struct {
	path string
}

func NewShadowLog(path string) *ShadowLog {
	return &ShadowLog{path: path}
}

func (s *ShadowLog) Dispatch(_ context.Context, d Decision) error {
	line, err := json.Marshal(d)
	if err != nil {
		return fmt.Errorf("marshal decision for #%d: %w", d.Issue, err)
	}
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	_, werr := f.Write(append(line, '\n'))
	cerr := f.Close()
	if werr != nil {
		return fmt.Errorf("append decision for #%d: %w", d.Issue, werr)
	}
	return cerr
}
