package devengine

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Gate is one executable check. Exactly one of Command/Check is set:
// Command invokes the REPO'S OWN command (never a reimplementation that can
// drift from what CI runs — the non-regression on this ticket), Check is a
// predicate over the run's inputs for the gates that are not commands at all
// (a clean tree is "this command's output is empty"; secrets-in-diff is a
// scan of the diff text).
type Gate struct {
	Name    string
	Command []string
	// Dir is the working directory relative to the repo root ("" = root).
	Dir string
	// RequireEmptyOutput: the command must exit 0 AND print nothing —
	// `git status --porcelain` is the canonical case.
	RequireEmptyOutput bool
	Check              func(GateInput) error
}

// GateInput carries what predicate gates inspect, plus the runner's
// deliberate environment grants.
type GateInput struct {
	RepoRoot     string
	Diff         string // unified diff text of the change under gate
	IssueBody    string
	TouchedPaths []string
	// ExtraEnv is the ONLY way a gate child receives anything beyond the
	// bare tool environment — command gates run the change-under-gate's own
	// code (its tests, its scripts), so the engine's credentials must never
	// be inherited into them. The runner grants what a gate needs explicitly
	// (e.g. a THROWAWAY database's DATABASE_URL for the migrate gate).
	ExtraEnv []string
}

// GateResult is one gate's own verdict — two failing gates are two
// distinguishable failures in the run record, never one opaque red.
type GateResult struct {
	Name     string
	Passed   bool
	Output   string // bounded tail of combined output
	ExitCode *int   // nil for predicate gates
}

// outputCap bounds what a gate contributes to the run record; the tail is
// kept because that is where test summaries and failures print.
const outputCap = 8 << 10

// alwaysGates is the floor every run gets regardless of what it touched.
// Order is execution order: the cheap structural refusals run before the
// expensive suite.
func alwaysGates() []Gate {
	return []Gate{
		{Name: "clean-tree", Command: []string{"git", "status", "--porcelain"}, RequireEmptyOutput: true},
		{Name: "acceptance-criteria", Check: func(in GateInput) error {
			if !HasAcceptanceCriteria(in.IssueBody) {
				return fmt.Errorf("the ticket has no acceptance criteria")
			}
			return nil
		}},
		{Name: "secrets-in-diff", Check: func(in GateInput) error {
			return scanDiffForSecrets(in.Diff)
		}},
		// `verify` IS the repo's lint/typecheck/targeted-test chain for every
		// app, so "lint/typecheck for touched apps" is not re-derived here —
		// re-deriving it is the drift this ticket's non-regression forbids.
		{Name: "verify", Command: []string{"pnpm", "run", "verify"}},
	}
}

// gateGroup pairs one gate_vocabulary key with its executable set. The
// registry is ONE ordered slice — selection iterates it directly, so there
// is no second hand-maintained key list to drift out of sync (review proved
// by mutation that a separate fixed list could silently strand a group).
type gateGroup struct {
	Key   string
	Gates []Gate
}

// groupGates maps the context map's gate_vocabulary onto executable sets.
// Keys must stay inside .vola-agent/context-map.json's gate_vocabulary — a
// test pins that, so a renamed group cannot silently strand its gates.
// Empty sets are deliberate placeholders: those groups add nothing beyond
// the always floor today.
func groupGates() []gateGroup {
	backendTests := Gate{Name: "backend-tests", Command: []string{"pnpm", "run", "test:api"}}
	return []gateGroup{
		{"backend", nil},
		{"backend-db", []Gate{backendTests}},
		{"migrations", []Gate{
			// cmd/migrate is the repo's real command, and its own guards
			// refuse gap/collision numbering and non-local targets. It reads
			// DATABASE_URL — which the env allowlist deliberately does NOT
			// inherit — so the runner must grant a THROWAWAY database via
			// ExtraEnv; without one this gate fails loudly rather than
			// migrating whatever the engine process happened to hold.
			{Name: "migrate-up", Command: []string{"go", "run", "./cmd/migrate", "up"}, Dir: "backend"},
			// Same command as backend-db's entry ON PURPOSE — same name, so
			// migrations + backend-db (or above-low risk) dedups to one run
			// of the suite instead of two.
			backendTests,
		}},
		{"mobile", nil},
		{"mobile-native", []Gate{
			// pnpm exec resolves the workspace's own expo from the lockfile;
			// bare npx on a tree without node_modules would FETCH an expo
			// unrelated to the lockfile and answer about the wrong toolchain.
			{Name: "expo-install-check", Command: []string{"pnpm", "--dir", "apps/mobile", "exec", "expo", "install", "--check"}},
			{Name: "expo-config", Command: []string{"pnpm", "--dir", "apps/mobile", "exec", "expo", "config", "--type", "public"}},
		}},
		{"offline-sync", nil},
		{"web", nil},
		{"admin", nil},
		{"api-contract", []Gate{
			{Name: "openapi-lint", Command: []string{"pnpm", "run", "lint:openapi"}},
		}},
		{"scripts", nil},
	}
}

// SelectGates picks the executable set for a run: the always floor, then the
// registry's groups in registry order, deduplicated by gate name. Risk
// participates directly: anything above low risk adds the isolated-DB
// backend suite even when no backend path was touched — a high-risk change
// is precisely the one whose blast radius the diff underestimates.
func SelectGates(groups []string, risk string) []Gate {
	selected := alwaysGates()
	seen := map[string]bool{}
	for _, g := range selected {
		seen[g.Name] = true
	}
	want := map[string]bool{}
	for _, g := range groups {
		want[g] = true
	}
	add := func(gates []Gate) {
		for _, g := range gates {
			if !seen[g.Name] {
				seen[g.Name] = true
				selected = append(selected, g)
			}
		}
	}
	for _, grp := range groupGates() {
		if want[grp.Key] {
			add(grp.Gates)
		}
		if grp.Key == "backend-db" && riskRank(risk) > riskRank("low") {
			add(grp.Gates)
		}
	}
	return selected
}

// gateEnvKeep is the bare tool environment a gate child receives. Everything
// else — GitHub tokens, LLM keys, any DATABASE_URL the engine holds — is
// withheld: command gates execute the change-under-gate's own code, and an
// inherited credential is readable by exactly the code being judged. The
// runner grants specifics through GateInput.ExtraEnv.
var gateEnvKeep = []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "GOPATH", "GOCACHE", "GOMODCACHE"}

func gateEnv(in GateInput) []string {
	env := []string{"CI=1"}
	for _, k := range gateEnvKeep {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return append(env, in.ExtraEnv...)
}

// RunGate executes one gate and reports its own result. Predicate gates
// never shell out; command gates run the repo's real command at repoRoot
// (or Dir under it) with the allowlisted environment.
func RunGate(ctx context.Context, repoRoot string, g Gate, in GateInput) GateResult {
	if g.Check != nil {
		if err := g.Check(in); err != nil {
			return GateResult{Name: g.Name, Passed: false, Output: err.Error()}
		}
		return GateResult{Name: g.Name, Passed: true}
	}
	if len(g.Command) == 0 {
		return GateResult{Name: g.Name, Passed: false, Output: "misconfigured gate: neither Command nor Check set"}
	}

	cmd := exec.CommandContext(ctx, g.Command[0], g.Command[1:]...)
	cmd.Dir = repoRoot
	if g.Dir != "" {
		cmd.Dir = filepath.Join(repoRoot, g.Dir)
	}
	cmd.Env = gateEnv(in)
	// Separate buffers: RequireEmptyOutput judges STDOUT alone, so a benign
	// stderr warning (git prints those for config quirks) cannot fail a
	// genuinely clean tree; the recorded output still carries both.
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	out := boundTail(stdout.String() + stderr.String())
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		return GateResult{Name: g.Name, Passed: false, Output: out + "\n" + err.Error()}
	}
	passed := code == 0 && (!g.RequireEmptyOutput || strings.TrimSpace(stdout.String()) == "")
	return GateResult{Name: g.Name, Passed: passed, Output: out, ExitCode: &code}
}

// boundTail keeps the last outputCap bytes, advanced to a rune boundary —
// a mid-rune cut would be invalid UTF-8, which Postgres REJECTS, so an
// unlucky cut would abort RecordGates at exactly the moment a gate produced
// a lot of output. This repo's tool output is full of em dashes.
func boundTail(out string) string {
	if len(out) <= outputCap {
		return out
	}
	cut := len(out) - outputCap
	for cut < len(out) && !utf8.RuneStart(out[cut]) {
		cut++
	}
	return out[cut:]
}

// secretPatterns match well-known credential shapes, each with a NAME so a
// hit can be reported without echoing one byte of the matched text into a
// run record. Only ADDED diff lines are scanned, so quoting an old secret in
// removed context cannot block the change that deletes it.
var secretPatterns = []struct {
	Label string
	Re    *regexp.Regexp
}{
	{"private key block", regexp.MustCompile(`-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`)},
	{"sk- API key", regexp.MustCompile(`\bsk-[A-Za-z0-9_\-]{20,}`)},
	{"sk_live/sk_test key", regexp.MustCompile(`\bsk_(live|test)_[A-Za-z0-9]{16,}`)},
	{"GitHub PAT", regexp.MustCompile(`\bghp_[A-Za-z0-9]{36}\b`)},
	{"GitHub fine-grained PAT", regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{22,}`)},
	{"AWS access key id", regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)},
	{"Slack token", regexp.MustCompile(`\bxox[baprs]-[A-Za-z0-9\-]{10,}`)},
	{"GitHub OAuth/app token", regexp.MustCompile(`\bgh[osu]_[A-Za-z0-9]{36}\b`)},
	// header.payload — two base64url segments starting with eyJ ("{" JSON).
	{"JWT", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}`)},
	{"connection string with embedded password", regexp.MustCompile(`\b(postgres(ql)?|mysql|redis|amqp|mongodb(\+srv)?)://[^:/\s]+:[^@\s]{4,}@`)},
	// The leading [A-Za-z0-9_-]* is load-bearing and was found MISSING by
	// review: `_` is a word character, so a bare \b failed on exactly the
	// likeliest shapes in this stack — CLERK_SECRET_KEY, GITHUB_ACCESS_TOKEN.
	{"quoted credential assignment", regexp.MustCompile(`(?i)[A-Za-z0-9_-]*(api[_-]?key|secret|password|token)[A-Za-z0-9_-]*\s*[:=]\s*["'][A-Za-z0-9+/_\-]{20,}["']`)},
	// The unquoted env-file shape, anchored to a whole assignment line so a
	// prose sentence containing "token = ..." cannot fire.
	{"env-style credential assignment", regexp.MustCompile(`(?i)^\+\s*(export\s+)?[A-Z0-9_]*(API_?KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*[A-Za-z0-9+/_.\-]{20,}\s*$`)},
}

// Accepted, deliberately: Railway tokens are bare UUID/hex and unmatchable
// without flagging every checksum in a lockfile; AWS *secret* access keys
// (the 40-char base64 half) are likewise indistinct without their AKIA id,
// which IS matched. Absence from this list is a decision, not an oversight.

// localConnRe exempts connection strings whose host is local: the repo's own
// README/CLAUDE.md carry `postgres://vola:vola_dev_only@localhost:5432/…`,
// and a password that only opens localhost (or the compose service name) is
// dev-only by construction — flagging it would block every edit to the
// local-dev docs. Measured against the real tree: this is the one pattern
// that fired on legitimate content.
var localConnRe = regexp.MustCompile(`@(localhost|127\.0\.0\.1|0\.0\.0\.0|postgres)([:/]|\b)`)

func scanDiffForSecrets(diff string) error {
	currentFile := ""
	for n, line := range strings.Split(diff, "\n") {
		if strings.HasPrefix(line, "+++ b/") {
			currentFile = strings.TrimPrefix(line, "+++ b/")
			continue
		}
		if !strings.HasPrefix(line, "+") || strings.HasPrefix(line, "+++") {
			continue
		}
		// `.example` templates are exactly where credential-SHAPED
		// placeholders legitimately live (CLERK_SECRET_KEY=sk_test_your_key_
		// here) — measured on the real tree, they were the only non-test
		// corpus hits. Real values do not belong there either, but that is a
		// review question, not a hard gate.
		if strings.HasSuffix(currentFile, ".example") {
			continue
		}
		for _, p := range secretPatterns {
			if p.Label == "connection string with embedded password" &&
				p.Re.MatchString(line) && localConnRe.MatchString(line) {
				continue
			}
			if p.Re.MatchString(line) {
				// The pattern label and diff line number only — never the
				// matched text, which would copy the secret into the record.
				return fmt.Errorf("added diff line %d matches a %s — remove it before dispatch", n+1, p.Label)
			}
		}
	}
	return nil
}
