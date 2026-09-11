package main

import "testing"

// N174 (#551): with no flags devengine must not know a board. A non-empty
// flag default is an override, so a literal here would silently win over
// policy.json's board block — which is exactly what the old defaults did.
func TestFlagsDefaultToNoBoard(t *testing.T) {
	o, err := parseFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if o.owner != "" || o.project != 0 {
		t.Fatalf("flag defaults name a board (owner %q, project %d); they must be empty so policy.json's board is used", o.owner, o.project)
	}
}

func TestFlagsStillOverride(t *testing.T) {
	o, err := parseFlags([]string{"--owner", "someone", "--project", "3"})
	if err != nil {
		t.Fatal(err)
	}
	if o.owner != "someone" || o.project != 3 {
		t.Fatalf("got owner %q, project %d; want someone, 3", o.owner, o.project)
	}
}
