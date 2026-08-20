package migrateguard

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// newRepoFixture builds a real repository with a real "origin" remote, because
// the whole point of Verify is a comparison against origin/main and a stub of
// git would supply the very behaviour under test. Returns the migrations
// directory inside the work tree.
func newRepoFixture(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not available")
	}

	root := t.TempDir()
	origin := filepath.Join(root, "origin.git")
	work := filepath.Join(root, "work")

	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}

	if err := os.MkdirAll(origin, 0o755); err != nil {
		t.Fatal(err)
	}
	git(origin, "init", "--bare", "-b", "main")

	migrations := filepath.Join(work, "backend", "migrations")
	if err := os.MkdirAll(migrations, 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(migrations, "000001_first.up.sql"), "CREATE TABLE a ();\n")
	write(t, filepath.Join(migrations, "000001_first.down.sql"), "DROP TABLE a;\n")
	write(t, filepath.Join(migrations, "000002_second.up.sql"), "CREATE TABLE b ();\n")
	write(t, filepath.Join(migrations, "000002_second.down.sql"), "DROP TABLE b;\n")

	git(work, "init", "-b", "main")
	git(work, "add", ".")
	git(work, "commit", "-m", "migrations")
	git(work, "remote", "add", "origin", origin)
	git(work, "push", "-u", "origin", "main")

	return migrations
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestVerify_CleanCheckoutOfMainIsVerified(t *testing.T) {
	dir := newRepoFixture(t)

	got := Verify(context.Background(), dir)
	if !got.Verified {
		t.Fatalf("a clean checkout of origin/main was NOT verified: %v", got.Problems)
	}
	if got.Source != "origin/main" {
		t.Errorf("Source = %q, want origin/main", got.Source)
	}
	if !got.GitRan {
		t.Error("GitRan = false, so callers cannot tell 'no differences' from 'never looked'")
	}
	if len(got.NotOnMain) != 0 {
		t.Errorf("NotOnMain = %v, want empty", got.NotOnMain)
	}
}

// The incident itself: a branch carrying migrations that are not on main.
func TestVerify_UntrackedMigrationIsNotOnMain(t *testing.T) {
	dir := newRepoFixture(t)
	write(t, filepath.Join(dir, "000003_branch_only.up.sql"), "ALTER TABLE a ADD COLUMN c TEXT;\n")

	got := Verify(context.Background(), dir)
	if got.Verified {
		t.Fatal("a migration set carrying a file that is not on origin/main was verified")
	}
	if !got.NotOnMain["000003_branch_only.up.sql"] {
		t.Errorf("NotOnMain = %v, want the branch-only file", got.NotOnMain)
	}
	assertProblemMentions(t, got, "000003_branch_only.up.sql", "not on origin/main")
}

func TestVerify_ModifiedMigrationIsNotOnMain(t *testing.T) {
	dir := newRepoFixture(t)
	write(t, filepath.Join(dir, "000002_second.up.sql"), "CREATE TABLE b (x int);\n")

	got := Verify(context.Background(), dir)
	if got.Verified {
		t.Fatal("a migration set whose content differs from origin/main was verified")
	}
	if !got.NotOnMain["000002_second.up.sql"] {
		t.Errorf("NotOnMain = %v, want the modified file", got.NotOnMain)
	}
	assertProblemMentions(t, got, "000002_second.up.sql", "differs")
}

func TestVerify_MissingMigrationMeansTheCheckoutIsBehind(t *testing.T) {
	dir := newRepoFixture(t)
	if err := os.Remove(filepath.Join(dir, "000002_second.up.sql")); err != nil {
		t.Fatal(err)
	}

	got := Verify(context.Background(), dir)
	if got.Verified {
		t.Fatal("a migration set missing a file that is on origin/main was verified")
	}
	assertProblemMentions(t, got, "000002_second.up.sql", "behind")
}

func TestVerify_NoRepositoryAndNoAttestation(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "000001_first.up.sql"), "SELECT 1;\n")

	got := Verify(context.Background(), dir)
	if got.Verified {
		t.Fatal("a directory outside any git repository was verified")
	}
	if got.GitRan {
		t.Error("GitRan = true, but no comparison was possible")
	}
	assertProblemMentions(t, got, "not inside a git work tree")
}

// The deploy image: no git anywhere, and it must still be allowed, with no
// environment variable and nothing for an operator to set.
func TestVerify_BuildAttestationNeedsNoRepository(t *testing.T) {
	dir := t.TempDir()

	restore := BuildChannel
	BuildChannel = "deploy"
	t.Cleanup(func() { BuildChannel = restore })

	got := Verify(context.Background(), dir)
	if !got.Verified {
		t.Fatalf("the deploy image was refused: %v — this breaks the legitimate path", got.Problems)
	}
	if !strings.Contains(got.Source, "build attestation") {
		t.Errorf("Source = %q, want it to name the build attestation", got.Source)
	}
	if got.GitRan {
		t.Error("GitRan = true, but the deploy image has no git and must never need one")
	}
}

// Any other value is not the attestation. Guards against a future refactor
// making an empty or arbitrary stamp count.
func TestVerify_OnlyTheExactAttestationCounts(t *testing.T) {
	dir := t.TempDir()
	for _, value := range []string{"", "Deploy", "true", "1", "staging"} {
		restore := BuildChannel
		BuildChannel = value
		got := Verify(context.Background(), dir)
		BuildChannel = restore
		if got.Verified {
			t.Fatalf("BuildChannel=%q was accepted as a deploy attestation", value)
		}
	}
}

// A fetch that cannot run means origin/main might be stale, and a stale
// origin/main would call a migration that IS on main "not on main". Refusing is
// the only safe reading.
func TestVerify_FetchFailureIsRefusedRatherThanTrusted(t *testing.T) {
	dir := newRepoFixture(t)
	cmd := exec.Command("git", "remote", "set-url", "origin", filepath.Join(t.TempDir(), "does-not-exist.git"))
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git remote set-url: %v\n%s", err, out)
	}

	got := Verify(context.Background(), dir)
	if got.Verified {
		t.Fatal("a migration set was verified against an origin/main that could not be refreshed")
	}
	assertProblemMentions(t, got, "git fetch origin main")
}

func TestBlobHashMatchesGit(t *testing.T) {
	dir := newRepoFixture(t)
	path := filepath.Join(dir, "000001_first.up.sql")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "hash-object", path)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	want := strings.TrimSpace(string(out))
	if got := blobHash(content); got != want {
		t.Fatalf("blobHash = %s, git hash-object = %s", got, want)
	}
}

func assertProblemMentions(t *testing.T, p Provenance, substrings ...string) {
	t.Helper()
	joined := strings.Join(p.Problems, "\n")
	for _, s := range substrings {
		if !strings.Contains(joined, s) {
			t.Errorf("problems do not mention %q:\n%s", s, joined)
		}
	}
}

// The guard has no off switch, and this is the test that keeps it that way.
//
// An environment variable that disables it would be exported in a shell profile
// within a fortnight and the guard would become decoration — so the package
// reads no environment at all, and the only way to vouch for a migration set
// outside a repository is the link-time attestation.
//
// It walks the AST rather than grepping the text, because a grep also matches
// the PROSE: the comment in runGit explaining why it appends to the command's
// own environment named the forbidden call and turned this red. A test that
// cannot tell code from a comment about code gets weakened until it passes.
func TestPackageReadsNoEnvironmentVariables(t *testing.T) {
	forbidden := map[string]bool{"Getenv": true, "LookupEnv": true, "Environ": true}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0) // 0 = comments dropped
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		checked++
		ast.Inspect(file, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "os" || !forbidden[sel.Sel.Name] {
				return true
			}
			t.Errorf("%s calls os.%s. The guard must have no off switch; the only "+
				"provenance outside a repository is BuildChannel, set at link time.", name, sel.Sel.Name)
			return true
		})
	}
	if checked == 0 {
		t.Fatal("no non-test .go files were parsed, so this test measured nothing")
	}
}
