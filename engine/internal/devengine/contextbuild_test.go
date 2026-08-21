package devengine

import (
	"reflect"
	"strings"
	"testing"
)

func TestBuildContextMapsTouchedPaths(t *testing.T) {
	cm := testConfig(t).ContextMap
	bc := BuildContext([]string{"apps/mobile/lib/db.ts", "contracts/public.openapi.yaml"}, cm)
	if !reflect.DeepEqual(bc.Traps, []string{"T5", "T6"}) {
		t.Fatalf("traps = %v", bc.Traps)
	}
	if !reflect.DeepEqual(bc.Gates, []string{"mobile", "offline-sync", "api-contract"}) {
		t.Fatalf("gates = %v", bc.Gates)
	}
	if len(bc.Unmapped) != 0 || bc.DefaultApplied {
		t.Fatalf("fully mapped diff reported unmapped=%v default=%t", bc.Unmapped, bc.DefaultApplied)
	}
	// Shared docs are deduplicated.
	count := 0
	for _, d := range bc.Docs {
		if d == "docs/architecture/api-conventions.md" {
			count++
		}
	}
	if count > 1 {
		t.Fatalf("doc duplicated: %v", bc.Docs)
	}
}

func TestBuildContextIsDeterministicUnderInputOrder(t *testing.T) {
	cm := testConfig(t).ContextMap
	a := BuildContext([]string{"apps/mobile/lib/db.ts", "backend/internal/x.go", "contracts/a.yaml"}, cm)
	b := BuildContext([]string{"contracts/a.yaml", "apps/mobile/lib/db.ts", "backend/internal/x.go"}, cm)
	// Output order is ENTRY order, so shuffling the touched list changes
	// nothing but Unmapped's own ordering (none here).
	if !reflect.DeepEqual(a.Docs, b.Docs) || !reflect.DeepEqual(a.Traps, b.Traps) || !reflect.DeepEqual(a.Gates, b.Gates) {
		t.Fatalf("input order changed output:\n%+v\n%+v", a, b)
	}
	c := BuildContext([]string{"apps/mobile/lib/db.ts", "backend/internal/x.go", "contracts/a.yaml"}, cm)
	if !reflect.DeepEqual(a, c) {
		t.Fatalf("same input twice differed:\n%+v\n%+v", a, c)
	}
}

func TestUnmappedPathsAreRecordedNeverSilent(t *testing.T) {
	cm := testConfig(t).ContextMap
	bc := BuildContext([]string{"apps/mobile/lib/db.ts", "assets/brand/logo.svg"}, cm)
	if !reflect.DeepEqual(bc.Unmapped, []string{"assets/brand/logo.svg"}) {
		t.Fatalf("unmapped = %v", bc.Unmapped)
	}
	if bc.DefaultApplied {
		t.Fatal("default applied although an entry matched")
	}
}

func TestWhollyUnmappedDiffGetsTheDefinedDefault(t *testing.T) {
	cm := testConfig(t).ContextMap
	bc := BuildContext([]string{"assets/brand/logo.svg"}, cm)
	if !bc.DefaultApplied {
		t.Fatal("no default applied — an empty context reads like 'no rules apply here'")
	}
	if !reflect.DeepEqual(bc.Docs, DefaultDocs) {
		t.Fatalf("docs = %v, want the defined default", bc.Docs)
	}
	if !reflect.DeepEqual(bc.Unmapped, []string{"assets/brand/logo.svg"}) {
		t.Fatalf("unmapped = %v", bc.Unmapped)
	}
}

func TestEmptyTouchedListGetsTheDefaultToo(t *testing.T) {
	// touched == [] was the one input that produced a wholly empty,
	// unrecorded context; it now trips the default like any no-match diff.
	bc := BuildContext(nil, testConfig(t).ContextMap)
	if !bc.DefaultApplied || !reflect.DeepEqual(bc.Docs, DefaultDocs) {
		t.Fatalf("empty touched produced %+v, want the default", bc)
	}
}

func TestBuildContextAgainstTheRealMap(t *testing.T) {
	// The checked-in map, not a fixture — Fatal rather than Skip on absence,
	// per the repo's silent-skip rule.
	cfg, err := LoadConfig("../../../.vola-agent")
	if err != nil {
		t.Fatalf(".vola-agent not readable from the repo root: %v", err)
	}
	bc := BuildContext([]string{
		"backend/internal/modules/profile/postgres.go",
		"apps/mobile/lib/sessionStore.ts",
	}, cfg.ContextMap)
	if !contains(bc.Traps, "T10") {
		t.Fatalf("profile projection trap T10 not selected: %v", bc.Traps)
	}
	if !contains(bc.Traps, "T6") {
		t.Fatalf("sync trap T6 not selected: %v", bc.Traps)
	}
	if !contains(bc.Gates, "offline-sync") {
		t.Fatalf("gates = %v", bc.Gates)
	}
}

func TestAssembleReadsDocsAndTrapsAndNothingBulk(t *testing.T) {
	cfg, err := LoadConfig("../../../.vola-agent")
	if err != nil {
		t.Fatalf(".vola-agent not readable: %v", err)
	}
	bc := BuildContext([]string{"backend/internal/modules/profile/postgres.go"}, cfg.ContextMap)
	got, err := Assemble("../../..", bc)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got["docs/architecture/api-conventions.md"]; !ok {
		t.Fatalf("api-conventions not assembled: %v", keys(got))
	}
	trap, ok := got["trap:T10"]
	if !ok || !strings.Contains(trap, "T10") || !strings.Contains(trap, "projection") {
		t.Fatalf("trap:T10 text wrong or missing: %.80q", trap)
	}
	// The non-goal, asserted on the assembled set itself.
	for k := range got {
		if k == "CLAUDE.md" || k == "docs/decisions/history.md" {
			t.Fatalf("bulk file %q in the assembled context", k)
		}
	}
}

func TestAssembleRefusesForbiddenBulkFiles(t *testing.T) {
	// Even if a future context-map lists CLAUDE.md, Assemble errors rather
	// than including it — the non-goal is structural, not conventional.
	// Review walked THREE alias spellings through the original exact-string
	// compare (and one clean out of the repo root), so every alias form is a
	// regression case now.
	for _, doc := range []string{
		"CLAUDE.md",
		"docs/decisions/history.md",
		"./CLAUDE.md",
		"docs/decisions/../decisions/history.md",
		"../../../CLAUDE.md",
		"/etc/hosts",
	} {
		if _, err := Assemble("../../..", BuiltContext{Docs: []string{doc}}); err == nil {
			t.Fatalf("%q was assembled", doc)
		}
	}
}

func TestAssembleErrorsOnAMissingTrap(t *testing.T) {
	bc := BuiltContext{Traps: []string{"T9999"}}
	if _, err := Assemble("../../..", bc); err == nil {
		t.Fatal("a pointer to a nonexistent trap was silently dropped")
	}
}

func TestTrapTextExtractsOneBullet(t *testing.T) {
	tasks := "## T — Traps\n\n- [x] **T1** — first trap text. — done\n- [ ] **T2** — second trap text.\n\n- [ ] **T3** — third.\n"
	if got := TrapText(tasks, "T1"); !strings.Contains(got, "first trap") || strings.Contains(got, "second") {
		t.Fatalf("T1 = %q", got)
	}
	if got := TrapText(tasks, "T2"); !strings.Contains(got, "second trap") || strings.Contains(got, "third") {
		t.Fatalf("T2 = %q", got)
	}
	if got := TrapText(tasks, "T9"); got != "" {
		t.Fatalf("nonexistent trap returned %q", got)
	}
	// T1 must not match T10 — the id is bold-delimited.
	if got := TrapText("- [ ] **T10** — ten.\n", "T1"); got != "" {
		t.Fatalf("T1 matched inside T10: %q", got)
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
