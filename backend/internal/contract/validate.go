package contract

import (
	"encoding/json"
	"fmt"
	"sort"
)

// Diff decodes body as JSON and reports every way it diverges from schema:
//
//   - a field present in the response but not declared anywhere in the
//     schema's `properties` — the "added a field without updating the spec"
//     direction of N168's mutation-check;
//   - a field the schema's `required` list names that is missing from the
//     response — the "removed a required field" direction;
//
// recursively, through nested objects and array items. It intentionally does
// NOT check value types, formats, or enum membership: this package's whole
// reason for existing is that most schemas in contracts/public.openapi.yaml
// don't set `additionalProperties: false`, so a real JSON-Schema validator
// would let the added-field case through — see spec.go's package doc. A nil
// slice return means the response's field set matches the spec's.
//
// Malformed JSON is reported as an error, not a diff — the response failing
// to parse at all is a different, louder problem than a shape mismatch.
func Diff(schema *Schema, body []byte) ([]string, error) {
	var decoded interface{}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, fmt.Errorf("contract: response body is not valid JSON: %w", err)
	}
	var problems []string
	diffValue(schema, decoded, "$", &problems)
	sort.Strings(problems)
	return problems, nil
}

func diffValue(schema *Schema, value interface{}, path string, problems *[]string) {
	if schema == nil {
		return
	}
	// A null value is never flagged, regardless of Schema.Nullable — see
	// Diff's doc comment. Distinguishing "legitimately nullable" from
	// "the spec forgot nullable: true" would need type-checking machinery
	// this package deliberately doesn't have, and it isn't what N168 asks
	// for: the acceptance criteria are about field NAMES, not null-safety.
	if value == nil {
		return
	}

	switch schema.Type {
	case "object":
		obj, ok := value.(map[string]interface{})
		if !ok {
			*problems = append(*problems, fmt.Sprintf("%s: spec says object, response has %s", path, jsonKind(value)))
			return
		}
		if len(schema.Properties) > 0 {
			for key := range obj {
				if _, declared := schema.Properties[key]; !declared {
					*problems = append(*problems, fmt.Sprintf(
						"%s.%s: present in the response but not declared in contracts/public.openapi.yaml", path, key))
				}
			}
		}
		for name := range schema.Required {
			if _, present := obj[name]; !present {
				*problems = append(*problems, fmt.Sprintf(
					"%s.%s: required by contracts/public.openapi.yaml but missing from the response", path, name))
			}
		}
		for name, sub := range schema.Properties {
			if v, present := obj[name]; present {
				diffValue(sub, v, path+"."+name, problems)
			}
		}
	case "array":
		arr, ok := value.([]interface{})
		if !ok {
			*problems = append(*problems, fmt.Sprintf("%s: spec says array, response has %s", path, jsonKind(value)))
			return
		}
		if schema.Items != nil {
			for i, item := range arr {
				diffValue(schema.Items, item, fmt.Sprintf("%s[%d]", path, i), problems)
			}
		}
	default:
		// A scalar (string/number/integer/boolean) or an unresolved/unset
		// type: no children to recurse into, and this package doesn't check
		// scalar types themselves (see Diff's doc comment).
	}
}

func jsonKind(v interface{}) string {
	switch v.(type) {
	case map[string]interface{}:
		return "an object"
	case []interface{}:
		return "an array"
	case string:
		return "a string"
	case float64:
		return "a number"
	case bool:
		return "a boolean"
	default:
		return fmt.Sprintf("%T", v)
	}
}
