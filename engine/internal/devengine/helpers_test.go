package devengine

import (
	"os"
	"path/filepath"
	"testing"
)

func copyTestdata(t *testing.T, dst string) {
	t.Helper()
	entries, err := os.ReadDir("testdata/vola-agent")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join("testdata/vola-agent", e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func overwrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func rm(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
}
