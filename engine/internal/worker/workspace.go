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
// The ephemeral database is owned by a per-run, non-superuser Postgres role
// created and dropped alongside it (N187/#603) — not the admin role with
// only the database name swapped. Verified empirically against this
// project's own Postgres image before writing this: a role with zero
// explicit grants CAN still open a bare connection to vola_test (Postgres
// grants CONNECT to PUBLIC by default, and revoking it from one named role
// does not override that — ACL checks are additive, not subtractive), but
// it CANNOT read, write, or create anything DURABLE there (table/schema
// privileges are NOT PUBLIC by default). PUBLIC does also default to
// TEMPORARY, so a session can create a temp object that dies with it —
// harmless to that database's real data, but it can hold a connection open
// under this role, which Teardown accounts for (see there). So the honest
// claim is: a worker cannot touch any pre-existing database's real data or
// schema, but a per-role connect-only probe against the shared server is
// not fully closable without revoking PUBLIC's server-wide grant —
// invasive to a resource other sessions constantly use, and out of scope
// here.
//
// RunSandboxed (N188/#604) closes the gap this paragraph used to describe as
// open: everything ABOVE narrows what a worker process is HANDED (its env,
// the clone's contents, the database it can reach); none of it stops a
// process from reading a path it was never handed at all, because a bare
// `exec.Command` inherits its host user's full filesystem view regardless of
// its own environment. RunSandboxed runs a command inside a container whose
// ONLY visible host path is this workspace's own directory — a path outside
// it does not exist in the sandboxed process's mount namespace, not merely
// "isn't in Env()". See sandbox.go for the mechanism and its own tests for
// the attempted-escape proof.
//
// What is still open, deliberately, and named rather than absorbed:
// network egress from inside the sandbox is Docker's ordinary default
// (reachable to the internet and, via host.docker.internal, to the host's
// own ports) — NOT restricted to a specific allowlist of legitimate hosts,
// which needs an application-level policy that does not exist yet (see this
// package's history entry and its tracking ticket). And nothing outside this
// package's own tests calls RunSandboxed yet — devengine.RunGate still
// shells out directly on the host, unwired to the sandbox the same way the
// rest of this package has been unwired since N141: there is still no live
// dispatcher (blocked on N145) to wire it into.
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
	"sort"
	"strings"
	"sync/atomic"
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
	// AdminDBURL is a Postgres SERVER connection used to CREATE the run's
	// ephemeral database AND role, and to DROP both afterward. The worker
	// itself never receives this URL or its credentials — it is handed a
	// connection string for the per-run role instead (see Workspace.DBURL).
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
	DBRole  string // the per-run Postgres role that owns DBName; dropped at Teardown
	DBURL   string // connects as DBRole, never as the admin role
	runner  *Runner
	dropped bool

	// mountVerified caches RunSandboxed's mount pre-flight check (see
	// sandbox.go): the property it checks — whether this host's Docker
	// actually shares ws.Dir — is fixed for this workspace's whole
	// lifetime, so repeat calls skip the extra container after the first
	// one succeeds. Atomic because RunSandboxed makes no promise about
	// being called from one goroutine only.
	mountVerified atomic.Bool
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

		ws.DBRole = fmt.Sprintf("engine_role_%d_%s", runID, hex.EncodeToString(raw[:]))
		password, err := randomHex(16)
		if err != nil {
			os.RemoveAll(ws.Dir)
			return nil, fmt.Errorf("provision: generate role password: %w", err)
		}
		// NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION: a run's role can
		// do everything inside the one database it owns and nothing that
		// reaches outside it. The role name and password are both generated
		// above from fixed prefixes + hex, so neither can carry injection;
		// quoted anyway.
		if _, err := conn.Exec(ctx, fmt.Sprintf(
			`CREATE ROLE %q LOGIN PASSWORD %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
			ws.DBRole, quoteLiteral(password))); err != nil {
			os.RemoveAll(ws.Dir)
			return nil, fmt.Errorf("provision: create role: %w", err)
		}
		// From here on, a failure must not leak the role: every later step
		// gets ws (and its already-created role) torn down before returning,
		// the same discipline the store.RecordProvisioning branch below
		// already followed. Found in review — the two branches this
		// replaces only removed the clone directory, leaving a cluster-
		// global role or database behind that AuditResidue could never see,
		// because no *Workspace ever reached a caller able to run it.
		if _, err := conn.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %q`, ws.DBName)); err != nil {
			cleanupErr := dropRole(ctx, conn, ws.DBRole)
			os.RemoveAll(ws.Dir)
			return nil, provisionErr("create db", err, cleanupErr)
		}
		// Ownership, not a grant: the role gets full control of its OWN
		// database (needed to apply migrations) and, by omission, nothing
		// anywhere else — a fresh role has no table/schema privileges on any
		// pre-existing database by default (only CONNECT, which PUBLIC
		// already grants and which an explicit per-role REVOKE cannot
		// override; see the package doc).
		if _, err := conn.Exec(ctx, fmt.Sprintf(`ALTER DATABASE %q OWNER TO %q`, ws.DBName, ws.DBRole)); err != nil {
			cleanupErr := dropDatabaseAndRole(ctx, conn, ws.DBName, ws.DBRole)
			os.RemoveAll(ws.Dir)
			return nil, provisionErr("assign db ownership", err, cleanupErr)
		}
		dbURL, err := roleConnectionURL(r.AdminDBURL, ws.DBRole, password, ws.DBName)
		if err != nil {
			// AdminDBURL failed to parse here even though it parsed fine at
			// the pgx.Connect call above — pgx accepts key=value DSNs this
			// function does not, so this is reachable, and the alternative
			// (return the admin URL unchanged) would hand the worker admin
			// credentials pointed at the admin's own database. Fail closed.
			cleanupErr := dropDatabaseAndRole(ctx, conn, ws.DBName, ws.DBRole)
			os.RemoveAll(ws.Dir)
			return nil, provisionErr("build role connection url", err, cleanupErr)
		}
		ws.DBURL = dbURL
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

// MigrateBackend applies the product's own backend migrations — the exact
// .up.sql files checked out inside THIS workspace's clone, at the recorded
// base SHA — against the run's ephemeral database, so a gate that needs
// schema (go test against the backend, a functional test) has one. Applied
// directly via pgx rather than by shelling out to backend/cmd/migrate: that
// tool's own safety guard already treats our database as local (same
// host/port as the admin connection, only the name and role differ) and
// would apply cleanly, but reaching a second Go module's build from inside
// this one buys no isolation — the .sql files are the source of truth
// either way, and applying them directly means no caller needs `go`
// resolvable on PATH just to hand a gate a schema.
//
// Uses the SIMPLE query protocol, not the default extended/prepared-
// statement one: a migration file is one or more full statements, including
// dollar-quoted function bodies, and the extended protocol refuses more than
// one command per Parse/Bind cycle.
//
// Two consequences worth knowing, found in review: this writes no
// schema_migrations row, so a future gate that itself runs
// backend/cmd/migrate (or `migrate status`) against this same database would
// see version 0 over a fully-applied schema rather than the real version —
// fine for a consumer that only reads the schema (go test, a functional
// test), wrong for one that also runs migrate. And each file's statements
// execute in one implicit transaction under the simple protocol, so a
// migration using CREATE INDEX CONCURRENTLY (which cannot run inside a
// transaction) would fail here even though golang-migrate itself has the
// same restriction — parity holds today because no migration in this repo
// uses it, not because this function does anything to guarantee it.
func (ws *Workspace) MigrateBackend(ctx context.Context) error {
	if ws.DBURL == "" {
		return fmt.Errorf("migrate: no ephemeral database provisioned for this workspace")
	}
	dir := filepath.Join(ws.Dir, "backend", "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("migrate: read migrations dir: %w", err)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".up.sql") {
			files = append(files, e.Name())
		}
	}
	// NNNNNN_ prefixes are fixed-width, so lexical order is numeric order —
	// the same property backend/cmd/migrate itself relies on.
	sort.Strings(files)
	if len(files) == 0 {
		return fmt.Errorf("migrate: no .up.sql files found in %s", dir)
	}

	cfg, err := pgx.ParseConfig(ws.DBURL)
	if err != nil {
		return fmt.Errorf("migrate: parse database url: %w", err)
	}
	cfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("migrate: connect: %w", err)
	}
	defer conn.Close(ctx)

	for _, name := range files {
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("migrate: read %s: %w", name, err)
		}
		if _, err := conn.Exec(ctx, string(content)); err != nil {
			return fmt.Errorf("migrate: apply %s: %w", name, err)
		}
	}
	return nil
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
// database dropped (WITH FORCE, so a leaked connection cannot wedge it),
// then the per-run role dropped — in that order, since a role that still
// owns a database cannot be dropped. Artifacts retained via RetainArtifact
// survive by construction — they live outside the workspace.
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
			} else if _, err := conn.Exec(ctx,
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, ws.DBRole); err != nil {
				// A role can still hold a connection elsewhere on the server
				// (PUBLIC grants CONNECT and TEMPORARY by default — see the
				// package doc), and DROP ROLE refuses a role with a live
				// session holding a temp object. Terminate first so Teardown
				// doesn't fail on a role the change-under-test is still
				// using, rather than only on one it created durable objects
				// in (which WITH (FORCE) above already can't reach, since
				// that only applies to ws.DBName's own connections).
				if firstErr == nil {
					firstErr = err
				}
			} else if _, err := conn.Exec(ctx, fmt.Sprintf(`DROP ROLE IF EXISTS %q`, ws.DBRole)); err != nil {
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
		if ws.DBRole != "" {
			var roleCount int
			if err := conn.QueryRow(ctx,
				`SELECT count(*) FROM pg_roles WHERE rolname = $1`, ws.DBRole).Scan(&roleCount); err != nil {
				return fmt.Errorf("audit: %w", err)
			}
			if roleCount != 0 {
				residue = append(residue, "per-run role still exists: "+ws.DBRole)
			}
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

// roleConnectionURL builds the run's own connection string: the admin URL's
// host, port and query parameters, but authenticating as the per-run role
// and pointed at the per-run database — never the admin role's credentials.
// Parsed with net/url rather than string-split so it doesn't mis-handle
// userinfo containing "@" or unescaped "/", IPv6 hosts, or a URL with no
// path. Returns an error rather than falling back to adminURL unchanged on a
// parse failure: pgx.Connect accepts key=value DSN syntax this function does
// not, so AdminDBURL parsing successfully at connect time does not guarantee
// it parses here too, and handing a caller admin credentials pointed at the
// admin's own database — silently, on the one path meant to prevent exactly
// that — would be the staging-outage failure class this project has already
// paid for once. Found in review; the caller must fail the whole
// provisioning attempt on this error, not just this call.
func roleConnectionURL(adminURL, role, password, db string) (string, error) {
	u, err := url.Parse(adminURL)
	if err != nil {
		return "", fmt.Errorf("parse admin url: %w", err)
	}
	u.User = url.UserPassword(role, password)
	u.Path = "/" + db
	return u.String(), nil
}

// quoteLiteral renders s as a single-quoted SQL string literal, doubling any
// embedded quote. This is a correct literal-quoter only under Postgres's
// default standard_conforming_strings=on (true for this project's image),
// where a plain '...' literal never interprets backslashes — it does NOT
// also escape backslashes, which would be wrong under that mode without
// switching to E'...' syntax. The passwords this guards are always our own
// generated hex (see randomHex), which contains neither a quote nor a
// backslash, so the distinction is moot in practice; callers must not reuse
// this for content that isn't known to be hex.
func quoteLiteral(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// dropRole drops a role this Provision attempt already created, on the
// admin connection already in hand — best-effort cleanup for a failure
// partway through provisioning, before any *Workspace exists for a caller
// to Teardown or audit.
func dropRole(ctx context.Context, conn *pgx.Conn, role string) error {
	_, err := conn.Exec(ctx, fmt.Sprintf(`DROP ROLE IF EXISTS %q`, role))
	return err
}

// dropDatabaseAndRole is dropRole's counterpart once the database also
// exists — database first, since a role that still owns a database cannot
// be dropped (the same ordering Teardown uses).
func dropDatabaseAndRole(ctx context.Context, conn *pgx.Conn, db, role string) error {
	var errs []error
	if _, err := conn.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS %q WITH (FORCE)`, db)); err != nil {
		errs = append(errs, fmt.Errorf("drop db: %w", err))
	}
	if err := dropRole(ctx, conn, role); err != nil {
		errs = append(errs, fmt.Errorf("drop role: %w", err))
	}
	return errors.Join(errs...)
}

// provisionErr reports a provisioning failure alongside whether the
// best-effort cleanup for it also failed — a cleanup error must never be
// swallowed silently, or a caller reading only "provision failed" would have
// no way to know a role or database was left behind for AuditResidue (which
// never runs here, since no *Workspace exists yet) to have caught.
func provisionErr(step string, err, cleanupErr error) error {
	if cleanupErr != nil {
		return fmt.Errorf("provision: %s: %w (cleanup also failed: %v)", step, err, cleanupErr)
	}
	return fmt.Errorf("provision: %s: %w", step, err)
}

// randomHex returns n random bytes, hex-encoded — used for the per-run
// role's password, which must never contain characters a connection URL or
// a SQL literal would need to escape.
func randomHex(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
