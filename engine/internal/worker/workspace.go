// Package worker is the Phase-2 isolation runner: every engine run happens
// in a DISPOSABLE environment — a fresh clone of a recorded base SHA on its
// own branch, an ephemeral Postgres the worker itself creates, an
// allowlisted environment, and budgets — and the environment is destroyed
// after the run, with a self-audit proving no residue.
//
// Two rules from the repo's own history are structural here:
//   - The primary checkout is NEVER touched (one agent, one worktree), and
//     the shared vola_test is NEVER a worker database: a worker migrates
//     only databases it created, because an unmerged migration reaching a
//     shared database has cost this project an afternoon and a staging
//     environment.
//   - A fresh clone FROM GIT is what keeps gitignored secrets out:
//     backend/.env.staging.local and friends live only in working trees,
//     never in history, so a clone cannot contain them by construction. A
//     credentialed RepoURL (the GitHub-App form, https://x-access-token:
//     <token>@github.com/...) is scrubbed from the clone's remote before
//     Provision returns, so the token git would otherwise persist verbatim
//     into .git/config never reaches the workspace either.
//
// What this package does NOT provide: a process sandbox. Isolation here is
// an explicit environment allowlist plus git-clone provenance, not a
// container or chroot — a worker process runs as this host's own user and
// can, like any process that user runs, read files by absolute path (its
// own HOME, another working tree, whatever the host user can reach). The
// credential surface this package closes is "handed to the worker" (env,
// clone contents, clone remote config); it is not "unreachable by any means
// from a worker's own code". Real filesystem/process sandboxing is tracked
// separately (see the history entry this package's introduction links to)
// rather than silently assumed here.
package worker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dmytro-ch21/vola/engine/internal/runstate"
)

// Runner provisions and destroys workspaces.
type Runner struct {
	// RepoURL is the clone source (a local path in tests, the real remote
	// in production).
	RepoURL string
	// WorkRoot holds workspaces and retained artifacts. Workspaces are
	// removed at teardown; ArtifactsDir survives.
	WorkRoot string
	// AdminDBURL is a Postgres SERVER connection used to CREATE and DROP the
	// run's ephemeral database. The worker is handed a DERIVED URL with only
	// the database name swapped (see replaceDBName) — same host, same role,
	// same password. That is a known limitation, not a full grant: the
	// worker cannot reach vola_test or staging by NAME (they're different
	// databases), but it authenticates as the same Postgres role that can,
	// on any server where that role has broader rights than "connect to my
	// own database". Real isolation needs a per-run, least-privilege role,
	// which this phase does not create.
	AdminDBURL string
}

// Workspace is one run's disposable environment.
type Workspace struct {
	RunID   int64
	Issue   int
	Dir     string
	Branch  string
	BaseSHA string // recorded at provision; the clone is checked out AT it
	DBName  string
	DBURL   string
	runner  *Runner
	dropped bool
}

var slugRe = regexp.MustCompile(`[^a-z0-9-]+`)

// Provision creates the workspace: clone at EXACTLY baseSHA (recorded, never
// "whatever HEAD is now"), branch agent/<issue>-<slug>, and an ephemeral
// database named for the run. baseSHA must be an explicit commit — the
// caller records it (typically origin/main's head at decision time) so the
// run is reproducible and the stale-base breaker has something to compare.
//
// store and owner make that recording DURABLE, not just a struct field: if
// store is non-nil, the base SHA and branch are written into agent_runs
// under the caller's lease (runstate.Store.RecordProvisioning) before
// Provision returns — so the fact survives a process restart and is
// visible to anything reading the run directly, not only to whoever holds
// this *Workspace. store may be nil for callers that only need the
// filesystem/database half (tests exercising those in isolation); owner is
// ignored when store is nil.
func (r *Runner) Provision(ctx context.Context, runID int64, issue int, slug, baseSHA string, store *runstate.Store, owner string) (*Workspace, error) {
	if baseSHA == "" {
		return nil, fmt.Errorf("provision: baseSHA must be recorded explicitly — cloning \"whatever HEAD is current\" is the drift this field exists to prevent")
	}
	slug = strings.Trim(slugRe.ReplaceAllString(strings.ToLower(slug), "-"), "-")
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	ws := &Workspace{
		RunID:   runID,
		Issue:   issue,
		Dir:     filepath.Join(r.WorkRoot, fmt.Sprintf("run-%d-%s", runID, hex.EncodeToString(raw[:]))),
		Branch:  fmt.Sprintf("agent/%d-%s", issue, slug),
		BaseSHA: baseSHA,
		DBName:  fmt.Sprintf("engine_run_%d_%s", runID, hex.EncodeToString(raw[:])),
		runner:  r,
	}

	if err := runGit(ctx, "", "clone", "--quiet", r.RepoURL, ws.Dir); err != nil {
		os.RemoveAll(ws.Dir) // defensive: a cancelled clone can leave a partial directory nobody else will ever Teardown
		return nil, fmt.Errorf("provision: clone: %w", err)
	}
	if err := runGit(ctx, ws.Dir, "checkout", "--quiet", "-b", ws.Branch, baseSHA); err != nil {
		os.RemoveAll(ws.Dir)
		return nil, fmt.Errorf("provision: checkout %s at %.12s: %w", ws.Branch, baseSHA, err)
	}
	// git persists whatever clone URL it was given, verbatim, into
	// .git/config — a credentialed RepoURL would otherwise sit readable in
	// the workspace despite never appearing in Env(). Scrub it before
	// anything else touches this directory.
	if err := runGit(ctx, ws.Dir, "remote", "set-url", "origin", stripCredentials(r.RepoURL)); err != nil {
		os.RemoveAll(ws.Dir)
		return nil, fmt.Errorf("provision: scrub remote credentials: %w", err)
	}

	if r.AdminDBURL != "" {
		conn, err := pgx.Connect(ctx, r.AdminDBURL)
		if err != nil {
			os.RemoveAll(ws.Dir)
			return nil, fmt.Errorf("provision: admin connect: %w", err)
		}
		defer conn.Close(ctx)
		// The name is generated above from a fixed prefix + integers + hex,
		// so it cannot carry injection; quoted anyway.
		if _, err := conn.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %q`, ws.DBName)); err != nil {
			os.RemoveAll(ws.Dir)
			return nil, fmt.Errorf("provision: create db: %w", err)
		}
		ws.DBURL = replaceDBName(r.AdminDBURL, ws.DBName)
	}

	if store != nil {
		if err := store.RecordProvisioning(ctx, runID, owner, baseSHA, ws.Branch); err != nil {
			ws.Teardown(ctx)
			return nil, fmt.Errorf("provision: record base SHA: %w", err)
		}
	}
	return ws, nil
}

// stripCredentials removes an embedded password from a clone URL before it
// is persisted into the workspace's remote config. GitHub App installation
// tokens are commonly embedded this way (https://x-access-token:<token>@
// github.com/...), and git writes remote.origin.url verbatim regardless of
// transport — verified against a local file:// remote carrying fake
// userinfo, which git clones successfully while ignoring the credentials
// for the transport and still recording them in .git/config. Usernames are
// left alone (an SSH remote's "git@host" is not a secret, and neither is
// the GitHub App convention's literal "x-access-token"); only a password
// component is cleared, and only when the URL parses with one — a bare
// local path or scp-style SSH remote has none and is returned unchanged.
func stripCredentials(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.User == nil {
		return rawURL
	}
	if _, hasPassword := u.User.Password(); !hasPassword {
		return rawURL
	}
	u.User = url.User(u.User.Username())
	return u.String()
}

// Env is the WHOLE environment a worker process receives: the bare tool
// allowlist plus the run's own ephemeral database. Nothing else — no GitHub
// token, no LLM keys, no engine DATABASE_URL — because worker processes
// execute the change-under-test's own code. Grants beyond this are the
// caller's explicit, per-gate decision (GateInput.ExtraEnv).
var envKeep = []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "GOPATH", "GOCACHE", "GOMODCACHE"}

func (ws *Workspace) Env() []string {
	env := []string{"CI=1"}
	for _, k := range envKeep {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	if ws.DBURL != "" {
		env = append(env,
			"DATABASE_URL="+ws.DBURL,
			"TEST_DATABASE_URL="+ws.DBURL)
	}
	return env
}

// Budget bounds one run. Wall time is enforced by the context the caller
// derives from Deadline; tokens are counted by the caller as model calls
// return. Check names WHICH budget was exceeded — a Blocked reason that
// does not name the budget is one nobody can decide about.
type Budget struct {
	MaxWall   time.Duration
	MaxTokens int
}

func (b Budget) Check(elapsed time.Duration, tokens int) error {
	if b.MaxWall > 0 && elapsed > b.MaxWall {
		return fmt.Errorf("run exceeded the %s wall-time budget (used %s) — decide whether the ticket needs splitting or the budget raising", b.MaxWall, elapsed.Round(time.Second))
	}
	if b.MaxTokens > 0 && tokens > b.MaxTokens {
		return fmt.Errorf("run exceeded the %d-token budget (used %d) — decide whether the ticket needs splitting or the budget raising", b.MaxTokens, tokens)
	}
	return nil
}

// EnforceBudget checks the run's time/token budget and, on an overrun,
// records the reason as a step and moves the run straight to Blocked — so
// the acceptance criterion ("budget exceeded → Blocked, budget named") is
// wired to a real transition rather than left as a Check() error nobody
// calls. Any non-terminal state may move to Blocked (see runstate's state
// machine), so this is safe to call from wherever the caller notices the
// overrun.
func EnforceBudget(ctx context.Context, store *runstate.Store, runID int64, owner string, b Budget, elapsed time.Duration, tokens int) error {
	err := b.Check(elapsed, tokens)
	if err == nil {
		return nil
	}
	if stepErr := store.AppendStep(ctx, runID, owner, "budget", "", err.Error(), nil); stepErr != nil {
		return stepErr
	}
	if trErr := store.Transition(ctx, runID, owner, runstate.Blocked); trErr != nil {
		// A run already at a terminal state (BLOCKED from a prior overrun,
		// or FAILED/CANCELLED) refuses this edge — that is not a failure of
		// enforcement, it is enforcement having already happened. Only a
		// real infrastructure error (lease lost, connection failure) should
		// mask the budget reason; an illegal transition should not.
		if !errors.Is(trErr, runstate.ErrIllegalTransition) {
			return trErr
		}
	}
	return err
}

// RetainArtifact copies one file out of the workspace into the survivor
// directory (WorkRoot/artifacts/run-<id>/), so teardown can be total without
// losing the run's evidence. Returns the retained path — the `ref` a caller
// records in agent_artifacts.
func (ws *Workspace) RetainArtifact(name string, content []byte) (string, error) {
	dir := filepath.Join(ws.runner.WorkRoot, "artifacts", fmt.Sprintf("run-%d", ws.RunID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, filepath.Base(name))
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// Teardown destroys the environment: workspace directory removed, ephemeral
// database dropped (WITH FORCE, so a leaked connection cannot wedge it).
// Artifacts retained via RetainArtifact survive by construction — they live
// outside the workspace.
func (ws *Workspace) Teardown(ctx context.Context) error {
	var firstErr error
	if err := os.RemoveAll(ws.Dir); err != nil {
		firstErr = err
	}
	if ws.runner.AdminDBURL != "" && !ws.dropped {
		conn, err := pgx.Connect(ctx, ws.runner.AdminDBURL)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
		} else {
			defer conn.Close(ctx)
			if _, err := conn.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS %q WITH (FORCE)`, ws.DBName)); err != nil {
				if firstErr == nil {
					firstErr = err
				}
			} else {
				ws.dropped = true
			}
		}
	}
	return firstErr
}

// AuditResidue is the post-run self-audit the acceptance criteria require:
// it VERIFIES the teardown rather than trusting it, returning an error that
// names every piece of residue. A cleanup that quietly failed would
// otherwise accumulate exactly the nine-trees-four-dirty state the worktree
// rules were written from.
func (ws *Workspace) AuditResidue(ctx context.Context) error {
	var residue []string
	if _, err := os.Stat(ws.Dir); err == nil {
		residue = append(residue, "workspace directory still exists: "+ws.Dir)
	} else if !os.IsNotExist(err) {
		// Any other stat failure (permissions, a transient I/O error) is not
		// proof of removal — an audit that reads it as "clean" would trust
		// exactly the thing it exists to verify.
		return fmt.Errorf("audit: cannot verify workspace removal: %w", err)
	}
	if ws.runner.AdminDBURL != "" {
		conn, err := pgx.Connect(ctx, ws.runner.AdminDBURL)
		if err != nil {
			return fmt.Errorf("audit: cannot verify database drop: %w", err)
		}
		defer conn.Close(ctx)
		var n int
		if err := conn.QueryRow(ctx,
			`SELECT count(*) FROM pg_database WHERE datname = $1`, ws.DBName).Scan(&n); err != nil {
			return fmt.Errorf("audit: %w", err)
		}
		if n != 0 {
			residue = append(residue, "ephemeral database still exists: "+ws.DBName)
		}
	}
	if len(residue) > 0 {
		return fmt.Errorf("residue after teardown: %s", strings.Join(residue, "; "))
	}
	return nil
}

func runGit(ctx context.Context, dir string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// replaceDBName swaps the database (path) segment of a Postgres URL,
// leaving userinfo, host, port and query parameters untouched. Parsed with
// net/url rather than string-split so it doesn't mis-handle userinfo
// containing "@" or unescaped "/", IPv6 hosts, or a URL with no path —
// shapes a naive split got wrong. Requires AdminDBURL to be genuine
// postgres://... URL syntax; a key=value DSN is out of scope.
func replaceDBName(rawURL, db string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		// Should not happen for the postgres:// URLs this project uses. No
		// caller checks this return for an error, so there is nothing safer
		// to do than hand back the input unchanged — callers should not be
		// building an AdminDBURL that fails to parse in the first place.
		return rawURL
	}
	u.Path = "/" + db
	return u.String()
}
