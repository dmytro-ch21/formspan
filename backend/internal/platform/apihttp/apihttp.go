// Package apihttp provides the shared JSON response and error conventions
// used by every HTTP handler. See docs/architecture/api-conventions.md for
// the full contract this implements.
package apihttp

import (
	"encoding/json"
	"net/http"
)

// Error codes are part of the public API contract (mirrored in
// contracts/public.openapi.yaml) — renaming one is a breaking change.
// Error messages are not: they're for humans and may reword between
// releases, so clients must not pattern-match on them.
const (
	CodeInvalidInput  = "invalid_input"
	CodeUnauthorized  = "unauthorized"
	CodeForbidden     = "forbidden"
	CodeNotFound      = "not_found"
	CodeAlreadyExists = "already_exists"
	CodeInternal      = "internal"
)

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WriteJSON writes v as the JSON response body with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// WriteError writes the standard {"error": {"code", "message"}} shape every
// error response uses.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message}})
}
