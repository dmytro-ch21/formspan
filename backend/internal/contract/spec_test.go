package contract

import "testing"

// fixtureSpec is a tiny, self-contained OpenAPI document — deliberately NOT
// the real contracts/public.openapi.yaml. These tests are about the
// resolver/differ MECHANISM (ref resolution, allOf merging, required-field
// tracking, recursion into arrays), and a fixture lets them assert against a
// known-fixed shape rather than whatever public.openapi.yaml happens to
// contain today. The real spec is exercised separately, in
// internal/contract/contract_test.go, against real handlers.
const fixtureSpec = `
openapi: 3.0.3
info: { title: fixture, version: "1.0.0" }
paths:
  /widgets/{id}:
    get:
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
  /gadgets/{id}:
    get:
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Gadget" }
components:
  schemas:
    Widget:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
        tags:
          type: array
          items: { type: string }
    GadgetBase:
      type: object
      required: [id]
      properties:
        id: { type: string }
    Gadget:
      allOf:
        - $ref: "#/components/schemas/GadgetBase"
        - type: object
          required: [label]
          properties:
            label: { type: string }
            widgets:
              type: array
              items: { $ref: "#/components/schemas/Widget" }
`

func mustLoadFixture(t *testing.T) *Spec {
	t.Helper()
	s, err := LoadBytes([]byte(fixtureSpec))
	if err != nil {
		t.Fatalf("LoadBytes: %v", err)
	}
	return s
}

func TestResponseSchema_ResolvesRefAndRequired(t *testing.T) {
	s := mustLoadFixture(t)
	schema, err := s.ResponseSchema("/widgets/{id}", "GET", "200")
	if err != nil {
		t.Fatalf("ResponseSchema: %v", err)
	}
	if schema.Type != "object" {
		t.Fatalf("Type = %q, want %q", schema.Type, "object")
	}
	if !schema.Required["id"] || !schema.Required["name"] {
		t.Fatalf("Required = %v, want id and name", schema.Required)
	}
	if schema.Required["tags"] {
		t.Fatalf("Required = %v, tags should not be required", schema.Required)
	}
	if _, ok := schema.Properties["tags"]; !ok {
		t.Fatalf("Properties = %v, missing tags", schema.Properties)
	}
	if schema.Properties["tags"].Type != "array" || schema.Properties["tags"].Items.Type != "string" {
		t.Fatalf("tags schema = %+v, want array of string", schema.Properties["tags"])
	}
}

func TestResponseSchema_UnknownPathErrors(t *testing.T) {
	s := mustLoadFixture(t)
	if _, err := s.ResponseSchema("/nope", "GET", "200"); err == nil {
		t.Fatal("want an error for an undeclared path, got nil")
	}
}

func TestResponseSchema_AllOfMergesRequiredAndProperties(t *testing.T) {
	// This is the mechanism Gadget and, in the real spec, NutritionEntry and
	// BjjStanding.current all depend on — merging a $ref branch's fields
	// with a sibling inline-object branch's fields into one schema.
	s := mustLoadFixture(t)
	schema, err := s.ResponseSchema("/gadgets/{id}", "GET", "200")
	if err != nil {
		t.Fatalf("ResponseSchema: %v", err)
	}
	if !schema.Required["id"] || !schema.Required["label"] {
		t.Fatalf("Required = %v, want id (from the $ref branch) and label (from the inline branch)", schema.Required)
	}
	if _, ok := schema.Properties["id"]; !ok {
		t.Fatal("Properties missing id from the $ref branch")
	}
	if _, ok := schema.Properties["label"]; !ok {
		t.Fatal("Properties missing label from the inline branch")
	}
}

func TestDiff_NoProblemsOnAMatchingBody(t *testing.T) {
	s := mustLoadFixture(t)
	schema, err := s.ResponseSchema("/widgets/{id}", "GET", "200")
	if err != nil {
		t.Fatalf("ResponseSchema: %v", err)
	}
	problems, err := Diff(schema, []byte(`{"id":"w1","name":"Widget","tags":["a","b"]}`))
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(problems) != 0 {
		t.Fatalf("problems = %v, want none", problems)
	}
}

// TestDiff_CatchesAnAddedField is the "add a field to a handler's JSON
// response without updating the spec" direction of N168's acceptance
// criteria, at the unit level — contract_test.go repeats this against a
// REAL handler.
func TestDiff_CatchesAnAddedField(t *testing.T) {
	s := mustLoadFixture(t)
	schema, err := s.ResponseSchema("/widgets/{id}", "GET", "200")
	if err != nil {
		t.Fatalf("ResponseSchema: %v", err)
	}
	problems, err := Diff(schema, []byte(`{"id":"w1","name":"Widget","secret_internal_id":"x"}`))
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(problems) == 0 {
		t.Fatal("want a problem for the undeclared field secret_internal_id, got none")
	}
	found := false
	for _, p := range problems {
		if p == "$.secret_internal_id: present in the response but not declared in contracts/public.openapi.yaml" {
			found = true
		}
	}
	if !found {
		t.Fatalf("problems = %v, want one naming secret_internal_id", problems)
	}
}

// TestDiff_CatchesAMissingRequiredField is the other direction: "remove a
// field the spec requires".
func TestDiff_CatchesAMissingRequiredField(t *testing.T) {
	s := mustLoadFixture(t)
	schema, err := s.ResponseSchema("/widgets/{id}", "GET", "200")
	if err != nil {
		t.Fatalf("ResponseSchema: %v", err)
	}
	problems, err := Diff(schema, []byte(`{"id":"w1"}`))
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(problems) == 0 {
		t.Fatal("want a problem for the missing required field name, got none")
	}
	found := false
	for _, p := range problems {
		if p == "$.name: required by contracts/public.openapi.yaml but missing from the response" {
			found = true
		}
	}
	if !found {
		t.Fatalf("problems = %v, want one naming name", problems)
	}
}

func TestDiff_RecursesIntoArrayItems(t *testing.T) {
	s := mustLoadFixture(t)
	schema, err := s.ResponseSchema("/gadgets/{id}", "GET", "200")
	if err != nil {
		t.Fatalf("ResponseSchema: %v", err)
	}
	// A widget nested inside the gadget's own widgets array, missing its
	// required `name` — must be caught at the nested path, not silently
	// skipped because it's inside an array.
	body := `{"id":"g1","label":"Gadget","widgets":[{"id":"w1"}]}`
	problems, err := Diff(schema, []byte(body))
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	want := "$.widgets[0].name: required by contracts/public.openapi.yaml but missing from the response"
	found := false
	for _, p := range problems {
		if p == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("problems = %v, want %q", problems, want)
	}
}

func TestDiff_NullIsNeverFlagged(t *testing.T) {
	// A schema field with a null value must never be reported as either
	// "wrong type" or "missing" — see Diff's doc comment on why this
	// package doesn't attempt nullable-vs-not enforcement.
	s := mustLoadFixture(t)
	schema, err := s.ResponseSchema("/widgets/{id}", "GET", "200")
	if err != nil {
		t.Fatalf("ResponseSchema: %v", err)
	}
	problems, err := Diff(schema, []byte(`{"id":"w1","name":null,"tags":null}`))
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(problems) != 0 {
		t.Fatalf("problems = %v, want none (name/tags are present, just null)", problems)
	}
}
