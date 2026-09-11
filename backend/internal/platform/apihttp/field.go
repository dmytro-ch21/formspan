package apihttp

import "encoding/json"

// Field distinguishes the three states a JSON key can be in, which `*T` cannot.
//
//	absent from the body   -> Set == false            -> column not touched
//	present and null       -> Set == true, Value nil  -> column set to NULL
//	present with a value   -> Set == true, Value set  -> column set to it
//
// The middle case is not academic, and this package has two independent
// witnesses to that:
//
//   - `tracker.Patch.Target` is nullable because coffee is a count with no
//     ceiling, so "clear my target" and "do not touch my target" are both
//     things a PATCH has to be able to say.
//   - nutrition's five LABEL macros (F37) are nullable because absence is a
//     fact about what we KNOW, never a fact about the food. Web omits them
//     entirely, so absent must mean "keep"; the phone sends all five on every
//     push as `number | null`, so its null is a statement — "no source gave us
//     a sodium figure" — and must clear. With `*float64` those two are the same
//     wire shape, and one of them silently wins.
//
// This lives in `platform` rather than in either module because a second copy
// of a three-state decoder is a second set of semantics waiting to drift from
// the first. It moved here from `internal/modules/tracker`, which still names
// it (as an alias) for its own callers.
type Field[T any] struct {
	Set   bool
	Value *T
}

// UnmarshalJSON runs only when the key is PRESENT in the object — that is the
// whole mechanism. encoding/json never calls it for an absent key, so `Set`
// stays false and the column stays out of the statement.
func (f *Field[T]) UnmarshalJSON(b []byte) error {
	f.Set = true
	if string(b) == "null" {
		f.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	f.Value = &v
	return nil
}

// MarshalJSON exists so a Patch can round-trip in tests and logs; an unset
// field marshals as null, which is lossy, and nothing depends on it.
func (f Field[T]) MarshalJSON() ([]byte, error) { return json.Marshal(f.Value) }

// Of builds a set field. For tests and for callers assembling a patch in Go.
func Of[T any](v T) Field[T] { return Field[T]{Set: true, Value: &v} }

// Null builds a field explicitly set to null.
func Null[T any]() Field[T] { return Field[T]{Set: true} }
