// N150/#554: a worker that is genuinely KILLED (SIGKILL, an OOM, the host
// itself dying) runs neither Teardown nor AuditResidue — both live in the
// SAME process that called Provision, and nothing catches a signal that
// cannot be caught. Provision's own database+role-per-run mechanism
// (workspace.go) already gives every run an ephemeral, uniquely-named
// Postgres database and role on the shared server named by Runner.AdminDBURL
// — never the shared vola_test, never a human's vola_test_<branch> — so the
// residue a crash can leave behind is always identifiable by name alone.
// This file is what actually removes it once nobody is left alive to call
// Teardown.
//
// The TTL clock lives IN THE NAME, not in a side table. ephemeralResourceName
// (used by Provision for both DBName and DBRole) already encodes a fixed
// prefix and the run id; this adds the UTC creation second as a third
// segment — the Postgres-object equivalent of labelling a Docker container
// with a creation timestamp and a fleet-recognizable tag, which is how this
// same package's sandbox/egress code already names ITS OWN disposable
// resources (see egressResidue's prefix-matching). No new state store to
// keep in sync with reality is needed, and — the property that matters here
// — it survives the owning process's death by construction: the name is
// what Postgres itself is already tracking in pg_database/pg_roles, so a
// process that never gets to write anywhere still leaves a fully legible
// timestamp behind.
package worker

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// ephemeralResourceName renders the one naming convention every ephemeral
// database and role Provision creates shares: a fixed prefix ("engine_run"
// or "engine_role"), the run id, the UTC creation second, and a random hex
// suffix (the same one DBName and DBRole for one workspace always share, so
// Sweep can recover a role's name from its database's, and vice versa).
func ephemeralResourceName(prefix string, runID int64, createdAt time.Time, suffix string) string {
	return fmt.Sprintf("%s_%d_%d_%s", prefix, runID, createdAt.UTC().Unix(), suffix)
}

// ephemeralNamePattern matches ephemeralResourceName's own output. Anything
// that does NOT match — a hand-created database, vola_test, a human's
// vola_test_<branch>, another tool's naming scheme entirely — is left
// strictly alone by every function in this file: Sweep only ever touches
// what it can positively identify as its own, by construction, not by
// excluding a denylist of names it happens to know about today.
var ephemeralNamePattern = regexp.MustCompile(`^(engine_run|engine_role)_(\d+)_(\d+)_([0-9a-f]+)$`)

// ephemeralIdentity is the (runID, createdAt, suffix) triple a matching name
// encodes — the same triple whichever of the two prefixes it came from,
// since Provision always mints a database and its role together from one
// suffix and one createdAt.
type ephemeralIdentity struct {
	runID     int64
	createdAt time.Time
	suffix    string
}

func (id ephemeralIdentity) dbName() string {
	return ephemeralResourceName("engine_run", id.runID, id.createdAt, id.suffix)
}

func (id ephemeralIdentity) roleName() string {
	return ephemeralResourceName("engine_role", id.runID, id.createdAt, id.suffix)
}

// parseEphemeralName recovers kind ("engine_run" or "engine_role") and the
// identity a name encodes. ok is false for anything not shaped like our own
// convention, including a malformed near-miss — a name that merely LOOKS
// close is treated exactly like one that shares nothing with it, since a
// false positive here is a sweep dropping something it does not actually
// understand.
func parseEphemeralName(name string) (kind string, id ephemeralIdentity, ok bool) {
	m := ephemeralNamePattern.FindStringSubmatch(name)
	if m == nil {
		return "", ephemeralIdentity{}, false
	}
	runID, err := strconv.ParseInt(m[2], 10, 64)
	if err != nil {
		return "", ephemeralIdentity{}, false
	}
	epoch, err := strconv.ParseInt(m[3], 10, 64)
	if err != nil {
		return "", ephemeralIdentity{}, false
	}
	return m[1], ephemeralIdentity{runID: runID, createdAt: time.Unix(epoch, 0).UTC(), suffix: m[4]}, true
}

// SweepResult is what one Sweep call did (or, with dryRun, would do).
type SweepResult struct {
	DroppedDatabases []string
	DroppedRoles     []string
	// Errors is best-effort, mirroring Teardown's own style: one resource's
	// drop failing (a stray connection DROP DATABASE ... WITH (FORCE) can't
	// evict, say) is recorded here rather than aborting the rest of the
	// sweep — one stubborn leak must never hide every other one behind it.
	Errors []error
}

// Sweep finds every ephemeral database and role Provision could have
// created (matching ephemeralNamePattern, on the server adminURL connects
// to) whose ENCODED creation time is at or before cutoff, and removes them —
// regardless of whether the process that created them is still alive. This
// is the mechanism a crashed worker's leaked ephemeral Postgres needs:
// Teardown and AuditResidue both require a live *Workspace in the process
// that called Provision, and a killed process has neither.
//
// dryRun reports what WOULD be removed without removing anything — the
// CLI's own --dry-run flag, and also how a caller can safely enumerate
// candidates on a server it does not want to mutate yet (see cmd/sweepephemeral).
//
// Sweep never touches a database or role that does not match
// ephemeralNamePattern. On the shared local Postgres this project's own
// fleet convention has every worktree connect to, that is the whole safety
// property: vola_test and every vola_test_<branch> a human created are
// simply invisible to the regex Sweep queries with, not merely absent from
// some exclusion list.
func Sweep(ctx context.Context, adminURL string, cutoff time.Time, dryRun bool) (SweepResult, error) {
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return SweepResult{}, fmt.Errorf("sweep: connect: %w", err)
	}
	defer conn.Close(ctx)

	staleDBs, err := staleEphemeral(ctx, conn,
		`SELECT datname FROM pg_database WHERE datname ~ '^engine_run_[0-9]+_[0-9]+_[0-9a-f]+$'`,
		"engine_run", cutoff)
	if err != nil {
		return SweepResult{}, fmt.Errorf("sweep: list databases: %w", err)
	}
	staleRoles, err := staleEphemeral(ctx, conn,
		`SELECT rolname FROM pg_roles WHERE rolname ~ '^engine_role_[0-9]+_[0-9]+_[0-9a-f]+$'`,
		"engine_role", cutoff)
	if err != nil {
		return SweepResult{}, fmt.Errorf("sweep: list roles: %w", err)
	}

	var result SweepResult
	handledRole := map[string]bool{}
	// Database first, same ordering as Teardown — a role that still owns a
	// database cannot be dropped.
	for db, id := range staleDBs {
		if dryRun {
			result.DroppedDatabases = append(result.DroppedDatabases, db)
		} else if _, err := conn.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS %q WITH (FORCE)`, db)); err != nil {
			result.Errors = append(result.Errors, fmt.Errorf("drop database %s: %w", db, err))
			continue
		} else {
			result.DroppedDatabases = append(result.DroppedDatabases, db)
		}

		role := id.roleName()
		if _, isStale := staleRoles[role]; !isStale {
			// The matching role is either already gone, still fresh (should
			// not happen — Provision mints both from the same createdAt —
			// but nothing here should ASSUME that invariant holds forever),
			// or was never created (a Provision failure between CREATE
			// DATABASE and ALTER DATABASE OWNER, an edge Provision's own
			// cleanup already guards for in-process). Either way, there is
			// no stale role by this name to drop.
			continue
		}
		if dryRun {
			result.DroppedRoles = append(result.DroppedRoles, role)
			handledRole[role] = true
			continue
		}
		if err := dropStaleRole(ctx, conn, role); err != nil {
			result.Errors = append(result.Errors, err)
			continue
		}
		result.DroppedRoles = append(result.DroppedRoles, role)
		handledRole[role] = true
	}

	// A role whose database is already gone — CREATE ROLE succeeded, CREATE
	// DATABASE never ran before the process died — is the killed-process
	// counterpart of the SAME partial-failure shape Provision's own
	// dropRole cleanup already guards against for the same-process case
	// (see workspace.go). It still needs removing on its own.
	for role := range staleRoles {
		if handledRole[role] {
			continue
		}
		if dryRun {
			result.DroppedRoles = append(result.DroppedRoles, role)
			continue
		}
		if err := dropStaleRole(ctx, conn, role); err != nil {
			result.Errors = append(result.Errors, err)
			continue
		}
		result.DroppedRoles = append(result.DroppedRoles, role)
	}

	return result, nil
}

// dropStaleRole mirrors Teardown's own role removal: terminate first,
// because PUBLIC's default CONNECT+TEMPORARY grant (see workspace.go's
// package doc) lets a role hold a session on some OTHER database even after
// its own is gone, and DROP ROLE refuses a role with a live session holding
// a temp object.
func dropStaleRole(ctx context.Context, conn *pgx.Conn, role string) error {
	if _, err := conn.Exec(ctx,
		`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, role); err != nil {
		return fmt.Errorf("terminate sessions for role %s: %w", role, err)
	}
	if _, err := conn.Exec(ctx, fmt.Sprintf(`DROP ROLE IF EXISTS %q`, role)); err != nil {
		return fmt.Errorf("drop role %s: %w", role, err)
	}
	return nil
}

// staleEphemeral runs query (a single-column SELECT of names already
// narrowed to kind's own shape by the caller's own regex, as a coarse,
// cheap pre-filter) and returns every result whose PARSED creation time is
// at or before cutoff, keyed by its own name. Re-checked against
// parseEphemeralName rather than trusted from the SQL filter alone — the
// SQL regex and ephemeralNamePattern must never be allowed to drift apart
// silently, and parsing here is what would notice.
func staleEphemeral(ctx context.Context, conn *pgx.Conn, query, kind string, cutoff time.Time) (map[string]ephemeralIdentity, error) {
	rows, err := conn.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]ephemeralIdentity{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		gotKind, id, ok := parseEphemeralName(name)
		if !ok || gotKind != kind {
			continue
		}
		if id.createdAt.After(cutoff) {
			continue // still within the TTL — not this sweep's business
		}
		out[name] = id
	}
	return out, rows.Err()
}
