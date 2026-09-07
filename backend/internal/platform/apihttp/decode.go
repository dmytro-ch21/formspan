package apihttp

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// N164/#541: at least a dozen decode sites across the modules had no body
// size limit at all — a plain `json.NewDecoder(r.Body).Decode(&req)`, which
// buffers however many bytes a caller sends before rejecting anything about
// them. `http.MaxBytesReader` was already the fix in several places (see
// e.g. session's Rename/SetIntent/Reschedule before this file existed), just
// applied by hand at each call site with no shared enforcement of the two
// properties every one of them actually wants: a body capped BEFORE it is
// buffered, and EXACTLY one JSON value — a second, concatenated document
// silently ignored by a bare `Decode` call is as much an unbounded-input bug
// as no size cap at all, just measured in documents instead of bytes.
//
// errTrailingJSON is returned by DecodeJSONBody when the body decodes fine
// but has more than one JSON value in it.
var errTrailingJSON = errors.New("apihttp: request body must contain exactly one JSON value")

// DecodeJSONBody decodes exactly one JSON document from body into dst and
// rejects anything after it — the standard idiom for "decode exactly one
// value": Decode leaves the stream positioned right after the value it just
// read, so a second Decode call against a throwaway destination returns
// io.EOF for a clean body and something else (nil error, because it decoded
// a second value; or another decode error) when there is more to read.
//
// It does not bound body itself. Every production call site has a body that
// came from an http.Request, and should reach for DecodeJSON (or
// DecodeJSONError, for a caller that wants to translate the error itself)
// instead so the bound is never forgotten — this is exported separately only
// for the handful of callers that already wrapped the same request body in
// their own http.MaxBytesReader earlier in the same request (a second wrap
// would just be redundant, not wrong, but it would also be a second place to
// keep the byte count in sync) and for direct testing of the trailing-value
// check on its own.
func DecodeJSONBody(body io.Reader, dst any) error {
	return decodeExactlyOne(json.NewDecoder(body), dst)
}

// decodeExactlyOne is DecodeJSONBody's actual logic, factored out so it can
// take an already-constructed *json.Decoder.
func decodeExactlyOne(dec *json.Decoder, dst any) error {
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var trailing struct{}
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errTrailingJSON
		}
		return err
	}
	return nil
}

// DecodeJSONError wraps r.Body in http.MaxBytesReader(w, r.Body, maxBytes)
// and decodes exactly one JSON document into dst (see DecodeJSONBody). It
// does not write a response — see DecodeJSON's doc comment for the common
// case, which does, and reach for this instead only when a failure needs a
// message more specific than the generic ones WriteDecodeError writes (the
// session module's distanceMDecodeMessage, matched against the error this
// returns, is the example this exists for).
//
// maxBytes is deliberately a parameter, never a shared constant: pick it per
// call site from what that request actually carries. See
// docs/decisions/history.md's N164 entry for the reasoning behind each
// current call site's choice — a single number shared across every route
// would either starve a legitimately large payload (a workout template with
// many items, a full session's sets) or leave a small one (a rename, a
// single enum field) needlessly generous.
func DecodeJSONError(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	return DecodeJSONBody(r.Body, dst)
}

// DecodeJSON is the one-line call most handlers want: decode exactly one
// JSON document, capped at maxBytes, and on any failure write the standard
// {"error":{"code","message"}} response and return the underlying error, so
// the caller only needs
//
//	if err := apihttp.DecodeJSON(w, r, maxBytes, &req); err != nil {
//		return
//	}
//
// Two failure shapes are told apart, matching the convention
// biometric.PutSamples and running.PutDetail established for their own
// hand-rolled bounds (N502/#873): a body that hit maxBytes answers 413 with
// a message the caller can act on, everything else (malformed JSON, a type
// mismatch, a second concatenated document) answers 400 with this repo's
// long-standing generic "invalid JSON body". Neither ever echoes the raw
// decode error back to the client — it can quote arbitrary bytes from the
// request.
func DecodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	err := DecodeJSONError(w, r, maxBytes, dst)
	if err != nil {
		WriteDecodeError(w, err)
	}
	return err
}

// A note on DisallowUnknownFields, which this file deliberately does NOT
// wire up anywhere (N164/#541):
//
// The obvious, lowest-risk candidate was audited first: exercise's and
// technique's admin content-write endpoints (decodeExercise/decodeTechnique,
// both wired under RequireAdmin — a single client this repo builds and
// deploys itself, so an unrecognised field is far more likely a console bug
// than a forward-compatible extra field from some other caller). Trying it
// there — the real, mechanical audit the ticket's design guidance asks for,
// not a read of the client code — surfaced a genuine incompatibility rather
// than a theoretical one: both handlers have existing tests
// (TestCreateDerivesTheIDAndIgnoresAnyTheClientSends,
// TestTheRequestBodyCannotChooseTheActor) asserting, as a SECURITY property,
// that a body naming `id`, `source` or `actor` — fields the request struct
// omits on purpose because they are server-derived — is silently ignored
// rather than trusted. DisallowUnknownFields turns exactly that defensive
// design into a hard 400: sending the id you want ignored now fails the
// request instead of being ignored. Both tests went red the moment
// decodeExercise/decodeTechnique were switched over — see
// docs/decisions/history.md's N164 entry for the measurement.
//
// So even the single-controlled-client case does not clear the bar this
// ticket sets ("only where contract compatibility allows it") without first
// redesigning those structs (e.g. splitting a client-writable struct from a
// separate allowlist of consciously-ignored fields) — which is real,
// separate work, not a decode-layer change. Nothing in this API currently
// enables DisallowUnknownFields; N521/#918 tracks doing that redesign for
// these two endpoints if it turns out to be worth it.
//
// WriteDecodeError writes the standard response for an error returned by
// DecodeJSONError or DecodeJSONBody — see DecodeJSON's doc comment for the
// two shapes it distinguishes. Exported so a caller using DecodeJSONError
// for its own more-specific messages still has a one-line fallback for every
// case it doesn't special-case, rather than reimplementing the MaxBytesError
// check.
func WriteDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		WriteError(w, http.StatusRequestEntityTooLarge, CodeInvalidInput,
			"request body is too large")
		return
	}
	WriteError(w, http.StatusBadRequest, CodeInvalidInput, "invalid JSON body")
}
