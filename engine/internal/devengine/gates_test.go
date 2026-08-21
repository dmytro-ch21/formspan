package devengine

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func gateNames(gates []Gate) []string {
	out := make([]string, len(gates))
	for i, g := range gates {
		out[i] = g.Name
	}
	return out
}

func TestTheAlwaysFloorIsExactlyTheseGates(t *testing.T) {
	// The registry floor, pinned by name so dropping a gate from the always
	// set turns this red (the ticket's mutation-check criterion).
	want := []string{"clean-tree", "acceptance-criteria", "secrets-in-diff", "verify"}
	got := gateNames(alwaysGates())
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("always floor = %v, want %v", got, want)
	}
}

func TestSelectionByGroupAndRisk(t *testing.T) {
	cases := []struct {
		name    string
		groups  []string
		risk    string
		include []string
		exclude []string
	}{
		{"low risk, no groups: floor only", nil, "low",
			[]string{"verify"}, []string{"backend-tests", "expo-install-check", "openapi-lint"}},
		{"backend-db adds the isolated suite", []string{"backend-db"}, "low",
			[]string{"backend-tests"}, nil},
		{"migrations adds migrate-up and the shared suite", []string{"migrations"}, "low",
			[]string{"migrate-up", "backend-tests"}, nil},
		{"mobile-native adds the expo gates", []string{"mobile-native"}, "low",
			[]string{"expo-install-check", "expo-config"}, nil},
		{"api-contract adds openapi lint", []string{"api-contract"}, "low",
			[]string{"openapi-lint"}, nil},
		{"medium risk forces the backend suite with no backend paths", nil, "medium",
			[]string{"backend-tests"}, nil},
		{"high risk likewise", nil, "high",
			[]string{"backend-tests"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			names := gateNames(SelectGates(tc.groups, tc.risk))
			for _, want := range tc.include {
				if !contains(names, want) {
					t.Fatalf("missing %q in %v", want, names)
				}
			}
			for _, not := range tc.exclude {
				if contains(names, not) {
					t.Fatalf("unexpected %q in %v", not, names)
				}
			}
		})
	}
}

func TestSelectionNeverDuplicatesAGate(t *testing.T) {
	// backend-db requested AND risk high both add backend-tests — once.
	names := gateNames(SelectGates([]string{"backend-db", "migrations"}, "high"))
	seen := map[string]int{}
	for _, n := range names {
		seen[n]++
		if seen[n] > 1 {
			t.Fatalf("gate %q selected twice: %v", n, names)
		}
	}
}

func TestGroupKeysStayInsideTheRealGateVocabulary(t *testing.T) {
	cfg, err := LoadConfig("../../../.vola-agent")
	if err != nil {
		t.Fatalf(".vola-agent not readable from the repo root: %v", err)
	}
	vocab := map[string]bool{}
	for _, v := range cfg.ContextMap.GateVocabulary {
		vocab[v] = true
	}
	seen := map[string]bool{}
	for _, grp := range groupGates() {
		if !vocab[grp.Key] {
			t.Fatalf("gate group %q is not in context-map.json's gate_vocabulary — the map could never select it", grp.Key)
		}
		if seen[grp.Key] {
			t.Fatalf("gate group %q appears twice in the registry", grp.Key)
		}
		seen[grp.Key] = true
	}
	// And the registry covers the WHOLE vocabulary, so a new vocabulary
	// entry cannot be silently unselectable (the drift review proved a
	// second key list could hide).
	for _, v := range cfg.ContextMap.GateVocabulary {
		if !seen[v] {
			t.Fatalf("vocabulary entry %q has no registry group — its gates could never run", v)
		}
	}
}

func TestCommandGatesInvokeRealRepoScripts(t *testing.T) {
	// The non-regression: gates run the repo's own commands, so every
	// `pnpm run X` a gate names must be a script that actually exists in the
	// root package.json — a renamed script goes red here, not in a live run.
	raw, err := os.ReadFile("../../../package.json")
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	all := alwaysGates()
	for _, grp := range groupGates() {
		all = append(all, grp.Gates...)
	}
	for _, g := range all {
		if len(g.Command) >= 3 && g.Command[0] == "pnpm" && g.Command[1] == "run" {
			if _, ok := pkg.Scripts[g.Command[2]]; !ok {
				t.Fatalf("gate %q invokes `pnpm run %s`, which is not a script in package.json", g.Name, g.Command[2])
			}
		}
	}
}

func TestRunGateExecutesAndCapturesPerGate(t *testing.T) {
	ctx := context.Background()
	pass := RunGate(ctx, t.TempDir(), Gate{Name: "ok", Command: []string{"sh", "-c", "echo hi"}}, GateInput{})
	if !pass.Passed || !strings.Contains(pass.Output, "hi") || pass.ExitCode == nil || *pass.ExitCode != 0 {
		t.Fatalf("pass gate = %+v", pass)
	}
	fail := RunGate(ctx, t.TempDir(), Gate{Name: "bad", Command: []string{"sh", "-c", "echo broken >&2; exit 3"}}, GateInput{})
	if fail.Passed || *fail.ExitCode != 3 || !strings.Contains(fail.Output, "broken") {
		t.Fatalf("fail gate = %+v", fail)
	}
	// Two failing gates are two distinguishable results — name + own output.
	fail2 := RunGate(ctx, t.TempDir(), Gate{Name: "bad2", Command: []string{"sh", "-c", "echo other >&2; exit 4"}}, GateInput{})
	if fail.Name == fail2.Name || fail.Output == fail2.Output {
		t.Fatalf("two failures are not distinguishable: %+v vs %+v", fail, fail2)
	}
}

func TestRequireEmptyOutputFailsOnOutputEvenAtExitZero(t *testing.T) {
	// The clean-tree shape: `git status --porcelain` exits 0 with a dirty
	// tree; the OUTPUT is the failure.
	r := RunGate(context.Background(), t.TempDir(),
		Gate{Name: "dirty", Command: []string{"sh", "-c", "echo M file.go"}, RequireEmptyOutput: true}, GateInput{})
	if r.Passed {
		t.Fatal("non-empty output passed a RequireEmptyOutput gate")
	}
}

func TestGateOutputIsTailBounded(t *testing.T) {
	r := RunGate(context.Background(), t.TempDir(),
		Gate{Name: "big", Command: []string{"sh", "-c", "yes filler | head -3000; echo THE-TAIL"}}, GateInput{})
	if len(r.Output) > outputCap {
		t.Fatalf("output not bounded: %d bytes", len(r.Output))
	}
	if !strings.Contains(r.Output, "THE-TAIL") {
		t.Fatal("the tail (where failures print) was not the part kept")
	}
}

func TestSecretsGateCatchesAPlantedKeyWithoutEchoingIt(t *testing.T) {
	// Constructed at runtime so no credential-shaped literal sits in source.
	fake := "sk-" + strings.Repeat("a", 24)
	diff := "--- a/x\n+++ b/x\n+const key = \"" + fake + "\"\n"
	in := GateInput{Diff: diff}
	var g Gate
	for _, cand := range alwaysGates() {
		if cand.Name == "secrets-in-diff" {
			g = cand
		}
	}
	if g.Name == "" {
		t.Fatal("secrets-in-diff gate not found in the always floor")
	}
	r := RunGate(context.Background(), t.TempDir(), g, in)
	if r.Passed {
		t.Fatal("a planted key passed the secrets gate")
	}
	if strings.Contains(r.Output, fake) {
		t.Fatalf("the gate echoed the secret into the run record: %q", r.Output)
	}

	// A secret on a REMOVED line must not block the change deleting it.
	removed := GateInput{Diff: "--- a/x\n+++ b/x\n-const key = \"" + fake + "\"\n"}
	if r := RunGate(context.Background(), t.TempDir(), g, removed); !r.Passed {
		t.Fatalf("a removed secret blocked its own deletion: %+v", r)
	}
	// An ordinary diff passes.
	clean := GateInput{Diff: "--- a/x\n+++ b/x\n+const retries = 3\n"}
	if r := RunGate(context.Background(), t.TempDir(), g, clean); !r.Passed {
		t.Fatalf("clean diff failed: %+v", r)
	}
}

func TestOtherSecretShapesAreCaught(t *testing.T) {
	shapes := []string{
		"-----BEGIN PRIVATE KEY-----",
		"ghp_" + strings.Repeat("A", 36),
		"AKIA" + strings.Repeat("Z", 16),
		"xoxb-" + strings.Repeat("1", 12),
		"password = \"" + strings.Repeat("x", 24) + "\"",
	}
	for _, s := range shapes {
		if err := scanDiffForSecrets("+" + s + "\n"); err == nil {
			t.Fatalf("shape not caught: %.20q…", s)
		}
	}
}

func TestGateChildrenGetTheAllowlistedEnvOnly(t *testing.T) {
	// A command gate runs the change-under-gate's own code; an inherited
	// credential is readable by exactly the code being judged.
	t.Setenv("LEAKME_ENGINE_SECRET", "super-sensitive")
	r := RunGate(context.Background(), t.TempDir(),
		Gate{Name: "env", Command: []string{"sh", "-c", `printf "%s" "$LEAKME_ENGINE_SECRET"`}}, GateInput{})
	if !r.Passed || r.Output != "" {
		t.Fatalf("engine env leaked into a gate child: %+v", r)
	}
	granted := RunGate(context.Background(), t.TempDir(),
		Gate{Name: "env2", Command: []string{"sh", "-c", `printf "%s" "$GRANTED"`}},
		GateInput{ExtraEnv: []string{"GRANTED=yes"}})
	if granted.Output != "yes" {
		t.Fatalf("ExtraEnv grant did not reach the child: %+v", granted)
	}
}

func TestUnderscoreJoinedCredentialNamesAreCaught(t *testing.T) {
	// Review measured the original \b boundary MISSING these — `_` is a word
	// character, and CLERK_SECRET_KEY is this stack's actual auth provider.
	for _, line := range []string{
		`CLERK_SECRET_KEY="abcdefghij1234567890abcd"`,
		`GITHUB_ACCESS_TOKEN = "abcdefghij1234567890abcd"`,
		"OPENAI_API_KEY=" + strings.Repeat("k", 24),
		"export STRIPE_SECRET=" + strings.Repeat("s", 24),
	} {
		if err := scanDiffForSecrets("+" + line + "\n"); err == nil {
			t.Fatalf("underscore-joined credential missed: %.30q…", line)
		}
	}
}

func TestJWTAndConnectionStringShapesAreCaught(t *testing.T) {
	jwt := "eyJ" + strings.Repeat("a", 16) + ".eyJ" + strings.Repeat("b", 16) + ".sig"
	for _, line := range []string{
		"const session = \"" + jwt + "\"",
		"url := \"postgres://vola:realpassword@db.internal:5432/vola\"",
	} {
		if err := scanDiffForSecrets("+" + line + "\n"); err == nil {
			t.Fatalf("shape missed: %.40q…", line)
		}
	}
	// The repo's own placeholder-credential compose URL shape must NOT fire
	// on ordinary prose lines without an embedded password.
	if err := scanDiffForSecrets("+see postgres://localhost:5432/vola for details\n"); err != nil {
		t.Fatalf("passwordless URL flagged: %v", err)
	}
}

func TestMisconfiguredGateFailsInsteadOfPanicking(t *testing.T) {
	r := RunGate(context.Background(), t.TempDir(), Gate{Name: "empty"}, GateInput{})
	if r.Passed || !strings.Contains(r.Output, "misconfigured") {
		t.Fatalf("empty gate = %+v", r)
	}
}

func TestLocalConnectionStringsAreExemptRemoteOnesAreNot(t *testing.T) {
	// The repo's own docs carry the compose URL; a localhost password is
	// dev-only by construction. A remote host with a password stays caught.
	if err := scanDiffForSecrets("+DATABASE_URL='postgres://vola:vola_dev_only@localhost:5432/vola'\n"); err != nil {
		t.Fatalf("localhost connection string flagged: %v", err)
	}
	if err := scanDiffForSecrets("+url = \"postgres://vola:realpass@db.railway.internal:5432/vola\"\n"); err == nil {
		t.Fatal("remote connection string with password missed")
	}
}

func TestExampleTemplatesAreExemptFromTheSecretsGate(t *testing.T) {
	line := "CLERK_SECRET_KEY=sk_test_" + strings.Repeat("x", 20)
	inExample := "+++ b/apps/web/.env.example\n+" + line + "\n"
	if err := scanDiffForSecrets(inExample); err != nil {
		t.Fatalf(".env.example placeholder flagged: %v", err)
	}
	inCode := "+++ b/apps/web/src/config.ts\n+" + line + "\n"
	if err := scanDiffForSecrets(inCode); err == nil {
		t.Fatal("the same line outside a template was missed")
	}
}
