// devengine is the VOLA dev engine's entrypoint. Phase 1 (N137) is SHADOW
// MODE and that is all this binary can do: it polls the board, detects
// Todo → In Progress transitions, runs the dispatch preflight, and appends
// what it WOULD have done to a local JSONL decision log. It edits no code and
// writes nothing to GitHub — there is deliberately no flag that changes that.
//
//	go run ./cmd/devengine --policy-dir ../.vola-agent --log decisions.jsonl
//
// It is part of no deployed image (see go.mod for why it is not under
// backend/cmd) and moves to the private vola-dev-engine repo once the GitHub
// organization and App exist (N145).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dmytro-ch21/vola/engine/internal/devengine"
)

func main() {
	owner := flag.String("owner", "dmytro-ch21", "login owning the project")
	project := flag.Int("project", 2, "Projects v2 number")
	policyDir := flag.String("policy-dir", ".vola-agent", "path to the .vola-agent policy directory")
	logPath := flag.String("log", "devengine-decisions.jsonl", "append-only JSONL decision log")
	interval := flag.Duration("interval", 20*time.Second, "poll interval (15–30s per the design)")
	once := flag.Bool("once", false, "take one snapshot (baseline only) and exit — a connectivity/config check")
	flag.Parse()

	if err := run(*owner, *project, *policyDir, *logPath, *interval, *once); err != nil {
		log.Fatal(err)
	}
}

func run(owner string, project int, policyDir, logPath string, interval time.Duration, once bool) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := devengine.LoadConfig(policyDir)
	if err != nil {
		return fmt.Errorf("load policy: %w", err)
	}
	token, err := devengine.ResolveToken(ctx)
	if err != nil {
		return err
	}
	board := &devengine.GitHubBoard{Owner: owner, Number: project, Token: token}
	detector := devengine.NewDetector()
	sink := devengine.NewShadowLog(logPath)

	snapshot := func() error {
		items, err := board.Snapshot(ctx)
		if err != nil {
			return err
		}
		moved, commit := detector.Observe(items)
		for _, it := range moved {
			d := devengine.Preflight(it, cfg, time.Now(), "shadow-v0")
			if err := sink.Dispatch(ctx, d); err != nil {
				// No commit: the uncommitted transitions are re-detected next
				// poll. A duplicate line beats a lost one in an evidence log.
				return err
			}
			log.Printf("#%d %q: would_dispatch=%t risk=%s reasons=%v",
				d.Issue, d.Title, d.WouldDispatch, d.Risk, d.Reasons)
		}
		commit()
		return nil
	}

	if err := snapshot(); err != nil { // baseline
		return err
	}
	log.Printf("shadow mode: baseline taken (%s), polling every %s", logPath, interval)
	if once {
		return nil
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := snapshot(); err != nil {
				// An auth failure (401/403) never self-heals — exiting is the
				// honest state, and a supervisor or a human restart after
				// fixing the token is the recovery path.
				if errors.Is(err, devengine.ErrAuth) {
					return err
				}
				// Anything else is logged and retried, not fatal: the board
				// being briefly unreachable is the ordinary state of polling,
				// and shadow mode's job is to keep watching.
				log.Printf("poll failed (will retry): %v", err)
			}
		}
	}
}
