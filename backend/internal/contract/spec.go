// Package contract loads contracts/public.openapi.yaml and checks a real
// handler's JSON response against the schema the spec declares for that
// route — N168/#545.
//
// This is deliberately NOT a general OpenAPI/JSON-Schema validator. Most
// response schemas in this spec never set `additionalProperties: false` (ten
// hits in the whole file, none on the routes this package covers), which
// means a conformant JSON-Schema validator would silently ALLOW a handler
// that adds a field the spec never declared — exactly the drift this ticket
// exists to catch. So instead of pulling in a full validator (kin-openapi and
// friends), this package does the one thing the ticket actually asks for:
// walk a response body and a resolved schema together and report every
// field name that is present on one side and not the other. See
// docs/decisions/history.md's N168 entry for the fuller reasoning and the
// libraries considered.
package contract

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Schema is a deliberately small subset of what an OpenAPI/JSON-Schema
// schema can express — just enough to compare a real response's field set
// against the spec's. It does not track formats, enums, numeric bounds, or
// any of the rest: those are validity properties, not shape properties, and
// this package only ever asked "does the field set match".
type Schema struct {
	// Type is the JSON Schema "type" ("object", "array", "string", "number",
	// "integer", "boolean"), or "" when the node never says (which for our
	// purposes means "don't check structurally, just note it exists").
	Type string
	// Nullable mirrors OpenAPI's `nullable: true`. Diff never rejects a null
	// value regardless of this flag — see Diff's doc comment — but it is
	// still resolved and exposed for a caller that wants it.
	Nullable bool
	// Properties is populated when Type == "object": every field name the
	// spec declares for this schema, keyed by name.
	Properties map[string]*Schema
	// Required is the set of property names the spec's `required:` list
	// names for this schema.
	Required map[string]bool
	// Items is populated when Type == "array": the schema every element of
	// the array must satisfy.
	Items *Schema
}

// Spec is a parsed contracts/public.openapi.yaml, kept as a generic
// map[string]interface{} tree (via yaml.v3, which decodes YAML mappings into
// map[string]interface{} rather than map[interface{}]interface{} — the
// property this package leans on throughout) rather than a typed struct,
// because a typed struct would have to know the shape of every schema in the
// file up front. $ref resolution walks that tree directly.
type Spec struct {
	root map[string]interface{}
}

// Load reads and parses the OpenAPI document at path.
func Load(path string) (*Spec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("contract: reading spec %s: %w", path, err)
	}
	return LoadBytes(data)
}

// LoadBytes parses an already-read OpenAPI document. Split out from Load so
// tests can exercise the resolver against a small fixture document without
// touching the filesystem or the real (14,000+ line) spec.
func LoadBytes(data []byte) (*Spec, error) {
	var root map[string]interface{}
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("contract: parsing spec: %w", err)
	}
	return &Spec{root: root}, nil
}

// ResponseSchema resolves the schema the spec declares for the
// `application/json` body of one path+method+status — e.g.
// ResponseSchema("/profile", "GET", "200"). path must match a key under
// `paths:` in the spec exactly, including any `{param}` placeholders.
func (s *Spec) ResponseSchema(path, method, status string) (*Schema, error) {
	paths, ok := asMap(s.root["paths"])
	if !ok {
		return nil, fmt.Errorf("contract: spec has no paths section")
	}
	pathNode, ok := asMap(paths[path])
	if !ok {
		return nil, fmt.Errorf("contract: spec has no path %q", path)
	}
	opNode, ok := asMap(pathNode[strings.ToLower(method)])
	if !ok {
		return nil, fmt.Errorf("contract: spec path %q has no %s operation", path, method)
	}
	responses, ok := asMap(opNode["responses"])
	if !ok {
		return nil, fmt.Errorf("contract: %s %q declares no responses", method, path)
	}
	respNode, ok := asMap(responses[status])
	if !ok {
		return nil, fmt.Errorf("contract: %s %q declares no %q response", method, path, status)
	}
	if ref, ok := respNode["$ref"].(string); ok {
		target, err := s.resolveRef(ref)
		if err != nil {
			return nil, err
		}
		respNode = target
	}
	content, ok := asMap(respNode["content"])
	if !ok {
		return nil, fmt.Errorf("contract: %s %q's %q response declares no content", method, path, status)
	}
	appJSON, ok := asMap(content["application/json"])
	if !ok {
		return nil, fmt.Errorf("contract: %s %q's %q response declares no application/json content", method, path, status)
	}
	schemaNode, ok := asMap(appJSON["schema"])
	if !ok {
		return nil, fmt.Errorf("contract: %s %q's %q response declares no schema", method, path, status)
	}
	return s.resolveSchema(schemaNode, 0)
}

// maxRefDepth guards against a $ref cycle turning a typo into an infinite
// loop instead of a clear error. Nothing in this spec nests anywhere close
// to this deep — it exists purely as a backstop.
const maxRefDepth = 40

func (s *Spec) resolveSchema(node map[string]interface{}, depth int) (*Schema, error) {
	if depth > maxRefDepth {
		return nil, fmt.Errorf("contract: schema $ref nesting exceeded %d levels (a cycle?)", maxRefDepth)
	}
	if ref, ok := node["$ref"].(string); ok {
		target, err := s.resolveRef(ref)
		if err != nil {
			return nil, err
		}
		return s.resolveSchema(target, depth+1)
	}

	out := &Schema{
		Properties: map[string]*Schema{},
		Required:   map[string]bool{},
	}
	if t, ok := node["type"].(string); ok {
		out.Type = t
	}
	if nullable, ok := node["nullable"].(bool); ok {
		out.Nullable = nullable
	}
	if propsRaw, ok := asMap(node["properties"]); ok {
		for name, raw := range propsRaw {
			propNode, ok := asMap(raw)
			if !ok {
				continue
			}
			sub, err := s.resolveSchema(propNode, depth+1)
			if err != nil {
				return nil, fmt.Errorf("contract: property %q: %w", name, err)
			}
			out.Properties[name] = sub
		}
	}
	if reqRaw, ok := node["required"].([]interface{}); ok {
		for _, r := range reqRaw {
			if name, ok := r.(string); ok {
				out.Required[name] = true
			}
		}
	}
	if itemsRaw, ok := asMap(node["items"]); ok {
		sub, err := s.resolveSchema(itemsRaw, depth+1)
		if err != nil {
			return nil, fmt.Errorf("contract: items: %w", err)
		}
		out.Items = sub
	}
	// allOf is this spec's standard way to attach extra fields to a $ref
	// (e.g. NutritionEntry = NutritionMacros + its own object) and,
	// sometimes, to attach `nullable`/`description` to a bare $ref alongside
	// the ref itself (e.g. BjjStanding.current). Every branch's properties
	// and required set are unioned in, regardless of whether the schema
	// ALSO carries its own type/properties directly (both are read
	// independently above, not sequentially, so key order never matters).
	if allOfRaw, ok := node["allOf"].([]interface{}); ok {
		for i, entry := range allOfRaw {
			entryNode, ok := asMap(entry)
			if !ok {
				continue
			}
			sub, err := s.resolveSchema(entryNode, depth+1)
			if err != nil {
				return nil, fmt.Errorf("contract: allOf[%d]: %w", i, err)
			}
			if out.Type == "" {
				out.Type = sub.Type
			}
			if sub.Nullable {
				out.Nullable = true
			}
			for name, propSchema := range sub.Properties {
				out.Properties[name] = propSchema
			}
			for name := range sub.Required {
				out.Required[name] = true
			}
			if out.Items == nil {
				out.Items = sub.Items
			}
		}
	}
	return out, nil
}

// resolveRef resolves a local "#/a/b/c" reference by walking the spec's own
// tree. Deliberately generic rather than hardcoded to
// "#/components/schemas/*" — the spec also $refs components/responses and
// components/headers, and a generic walk needs no special-casing per kind.
func (s *Spec) resolveRef(ref string) (map[string]interface{}, error) {
	if !strings.HasPrefix(ref, "#/") {
		return nil, fmt.Errorf("contract: only local (#/...) refs are supported, got %q", ref)
	}
	var cur interface{} = s.root
	for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
		m, ok := asMap(cur)
		if !ok {
			return nil, fmt.Errorf("contract: cannot resolve ref %q: %q is not an object", ref, part)
		}
		next, ok := m[part]
		if !ok {
			return nil, fmt.Errorf("contract: cannot resolve ref %q: no key %q", ref, part)
		}
		cur = next
	}
	m, ok := asMap(cur)
	if !ok {
		return nil, fmt.Errorf("contract: ref %q does not resolve to an object", ref)
	}
	return m, nil
}

// asMap centralizes the "is this an object" check. yaml.v3 decodes YAML
// mappings into map[string]interface{} when the target is interface{} (its
// v2 predecessor produced map[interface{}]interface{} — this package leans
// on v3's behavior throughout, including in this function's signature).
func asMap(v interface{}) (map[string]interface{}, bool) {
	m, ok := v.(map[string]interface{})
	return m, ok
}
