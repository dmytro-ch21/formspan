package migrateguard

import (
	"context"
	"crypto/sha1"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// BuildChannel is set at LINK time, by backend/Dockerfile, to "deploy".
//
// It is the deploy image's attestation that its migrations came from whatever
// ref the image was built from, and it is what keeps the legitimate path free:
// a real deploy sets no environment variable, answers no prompt, and has
// nothing to disable, because its binary already carries this. A developer's
// `go run ./cmd/migrate` never has it.
//
// There is deliberately NO environment variable that can stand in for this.
// Anything readable from a shell gets exported in a shell profile within a
// fortnight, and then the guard is decoration.
var BuildChannel = ""

// gitTimeout bounds the two git subprocesses. A fetch that hangs must not hang
// a deploy-shaped command.
var gitTimeout = 30 * time.Second

// Provenance is the answer to "do I know where these migration files came
// from?".
type Provenance struct {
	// Verified is true only when the migration set is known to be trustworthy.
	Verified bool
	// Source names how it was established: "build attestation" or
	// "origin/main".
	Source string
	// Problems lists, in operator-facing words, every reason it is not
	// verified. Empty when Verified.
	Problems []string
	// NotOnMain holds the filenames that differ from origin/main (extra or
	// modified). Meaningful only when git verification actually ran, which
	// GitRan reports.
	NotOnMain map[string]bool
	// GitRan reports whether the comparison against origin/main completed, so
	// callers can tell "no differences" from "never looked".
	GitRan bool
}

// Verify establishes whether the migration files in dir can be trusted.
//
// Order matters: the build attestation short-circuits, because the deploy
// container has no git and must never depend on one.
func Verify(ctx context.Context, dir string) Provenance {
	if BuildChannel == "deploy" {
		return Provenance{Verified: true, Source: "build attestation (this is the deploy image)"}
	}

	p := Provenance{NotOnMain: map[string]bool{}}

	if _, err := runGit(ctx, dir, "rev-parse", "--show-toplevel"); err != nil {
		p.Problems = append(p.Problems, fmt.Sprintf("%s is not inside a git work tree, and this binary carries no build attestation", dir))
		return p
	}

	// Fetch rather than trust whatever origin/main happens to point at. A
	// stale ref would call a migration that IS on main "not on main", which is
	// the one way this guard can misfire on the legitimate path.
	if out, err := runGit(ctx, dir, "fetch", "--quiet", "origin", "main"); err != nil {
		p.Problems = append(p.Problems, fmt.Sprintf("`git fetch origin main` failed, so origin/main cannot be trusted to be current: %v%s", err, indentOutput(out)))
		return p
	}
	if _, err := runGit(ctx, dir, "rev-parse", "--verify", "--quiet", "origin/main"); err != nil {
		p.Problems = append(p.Problems, "origin/main does not exist in this repository")
		return p
	}

	tree, err := migrationsOnMain(ctx, dir)
	if err != nil {
		p.Problems = append(p.Problems, fmt.Sprintf("could not read backend/migrations from origin/main: %v", err))
		return p
	}
	onDisk, err := hashDir(dir)
	if err != nil {
		p.Problems = append(p.Problems, fmt.Sprintf("could not read %s: %v", dir, err))
		return p
	}

	p.GitRan = true
	var extra, modified, missing []string
	for name, sum := range onDisk {
		mainSum, ok := tree[name]
		switch {
		case !ok:
			extra = append(extra, name)
			p.NotOnMain[name] = true
		case mainSum != sum:
			modified = append(modified, name)
			p.NotOnMain[name] = true
		}
	}
	for name := range tree {
		if _, ok := onDisk[name]; !ok {
			missing = append(missing, name)
		}
	}
	sort.Strings(extra)
	sort.Strings(modified)
	sort.Strings(missing)

	for _, n := range extra {
		p.Problems = append(p.Problems, n+" is not on origin/main")
	}
	for _, n := range modified {
		p.Problems = append(p.Problems, n+" differs from the copy on origin/main")
	}
	for _, n := range missing {
		p.Problems = append(p.Problems, n+" is on origin/main but missing here — this checkout is behind; run `git fetch origin && git rebase origin/main`")
	}

	if len(p.Problems) == 0 {
		p.Verified = true
		p.Source = "origin/main"
	}
	return p
}

// migrationsOnMain lists the migration files origin/main has, by basename,
// mapped to their blob hash.
func migrationsOnMain(ctx context.Context, dir string) (map[string]string, error) {
	prefix, err := runGit(ctx, dir, "rev-parse", "--show-prefix")
	if err != nil {
		return nil, err
	}
	repoPath := strings.TrimSpace(prefix)

	// --full-tree makes the pathspec relative to the repository root. Without
	// it git resolves it against the CURRENT directory — which is the
	// migrations directory itself, so `backend/migrations` would be looked for
	// inside `backend/migrations` and the listing would come back empty.
	out, err := runGit(ctx, dir, "ls-tree", "--full-tree", "-r", "-z", "origin/main", "--", repoPath)
	if err != nil {
		return nil, err
	}
	files := map[string]string{}
	for _, entry := range strings.Split(out, "\x00") {
		if entry == "" {
			continue
		}
		meta, path, ok := strings.Cut(entry, "\t")
		if !ok {
			continue
		}
		fields := strings.Fields(meta)
		if len(fields) != 3 || fields[1] != "blob" {
			continue
		}
		if !strings.HasSuffix(path, ".sql") {
			continue
		}
		files[filepath.Base(path)] = fields[2]
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("origin/main has no .sql files under %q", repoPath)
	}
	return files, nil
}

// hashDir hashes every .sql file in dir the way git would.
//
// Hashing what is ON DISK — rather than diffing the index — is deliberate:
// golang-migrate reads the working tree, so an untracked file and a modified
// tracked file have to be caught by the same mechanism. `git status` would
// report both, but only a content hash proves the bytes match.
func hashDir(dir string) (map[string]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := map[string]string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		files[e.Name()] = blobHash(b)
	}
	return files, nil
}

// blobHash reproduces `git hash-object`: sha1 over "blob <len>\x00" + content.
//
// Computed here rather than shelled out to, so it cannot be perturbed by
// gitattributes filters and so it is testable without a repository.
func blobHash(content []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(content))
	h.Write(content)
	return fmt.Sprintf("%x", h.Sum(nil))
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)

	// `git fetch` spawns children (git-remote-https, ssh, credential helpers)
	// that inherit the output pipes, so killing the parent at the deadline is
	// not enough: CombinedOutput blocks until those pipes close. WaitDelay
	// makes the timeout unconditional.
	cmd.WaitDelay = 5 * time.Second

	// And an https remote with no cached credentials would otherwise sit in a
	// terminal prompt until the deadline. Fail fast instead — an unverifiable
	// set is a refusal either way, and 30 seconds of silence looks like a hang.
	// cmd.Environ(), not os.Environ(): this package reads no environment of its
	// own, and the test that enforces that greps for the call by name.
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0")

	out, err := cmd.CombinedOutput()
	return string(out), err
}

func indentOutput(out string) string {
	out = strings.TrimSpace(out)
	if out == "" {
		return ""
	}
	return "\n           " + strings.ReplaceAll(out, "\n", "\n           ")
}
