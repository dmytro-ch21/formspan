package exercise

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// IdentifyHandler serves POST /v1/exercises/identify.
type IdentifyHandler struct {
	// identifier is nil when the deploy has no API key. Nil-CHECKED rather than
	// nil-guarded at construction, so an unconfigured deploy runs every other
	// exercise route normally instead of refusing to start.
	identifier Identifier
}

func NewIdentifyHandler(i Identifier) *IdentifyHandler {
	return &IdentifyHandler{identifier: i}
}

// maxIdentifyBody is generous enough for a 5 MB photo plus multipart overhead.
const maxIdentifyBody = 8 << 20

type identifyResponse struct {
	// Identification is a DRAFT. Named for what it is so no client reads it as
	// a selection — nothing here has been logged, chosen, or written.
	Identification Identification `json:"identification"`
}

// Identify turns a photograph of a machine into a ranked shortlist.
//
// **Never selects an exercise and never writes anything.** The response
// populates a picker the athlete taps. See `MaxCandidates` for why more than
// one candidate comes back — it is the only available mitigation for a
// confidently wrong answer, which is this feature's real failure mode.
func (h *IdentifyHandler) Identify(w http.ResponseWriter, r *http.Request) {
	if h.identifier == nil {
		// No API key on this deploy. 503 rather than 500: the request was fine
		// and the same request against a configured deploy would work.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"machine identification is not available")
		return
	}

	in, err := parseIdentifyRequest(w, r)
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	}
	if err := in.Validate(); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, identifyValidationMessage(err))
		return
	}

	id, err := h.identifier.Identify(r.Context(), in)
	if err != nil {
		// LOGGED here rather than inside the writer, because the wrapped
		// upstream text is the half that never reaches the client — and it
		// carries the provider request id somebody would need to raise a
		// support case. The convention is "log server-side, return a generic
		// message"; doing only the second half makes a provider outage
		// indistinguishable from a bad photo in the logs.
		httplog.FromContext(r.Context()).Error("exercise: identify failed", "err", err)
		writeIdentifyError(w, err)
		return
	}

	apihttp.WriteJSON(w, http.StatusOK, identifyResponse{Identification: id})
}

// writeIdentifyError maps this module's two sentinels onto statuses.
//
// The refusal is **422, not 400**, and the distinction is worth stating: the
// request was well-formed and was processed, and the answer is "I cannot tell
// what that is". A 400 would tell a client to fix its request, which is not the
// remedy — retaking the photo is.
func writeIdentifyError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrIdentifyRefused):
		apihttp.WriteError(w, http.StatusUnprocessableEntity, apihttp.CodeInvalidInput,
			"could not tell which machine that is — try a straighter shot of the whole machine")
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, identifyValidationMessage(err))
	default:
		// Everything else, including ErrIdentifyUnavailable. 503 rather than
		// 500 because a retry is the right advice, and the message is fixed —
		// the wrapped detail was logged above and must not reach the client.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"machine identification is unavailable right now")
	}
}

// identifyValidationMessage strips the sentinel prefix so a client sees the
// reason without the package name.
func identifyValidationMessage(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, ": "); i >= 0 {
		return msg[i+2:]
	}
	return msg
}

// parseIdentifyRequest reads the photo.
//
// **Multipart only, unlike nutrition's estimate.** That endpoint accepts JSON
// too because it has a text path — a description with no image — and forcing a
// multipart body for a sentence would be gratuitous. This one has no text path:
// a photograph is the entire input, and base64 inside JSON would inflate a 5 MB
// photo to 6.7 MB on the wire for nothing. Offering a JSON transport here would
// be an alternative spelling of the same request, and two ways to send one
// thing is two things to keep working.
func parseIdentifyRequest(w http.ResponseWriter, r *http.Request) (IdentifyInput, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxIdentifyBody)

	if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		return IdentifyInput{}, errors.New("send the photo as multipart/form-data with an \"image\" part")
	}
	if err := r.ParseMultipartForm(maxIdentifyBody); err != nil {
		return IdentifyInput{}, errors.New("could not read the upload")
	}

	file, _, err := r.FormFile("image")
	if err != nil {
		return IdentifyInput{}, errors.New("a photo is required in the \"image\" part")
	}
	defer file.Close()

	// LimitReader at the cap PLUS ONE, so an oversized upload is detected
	// rather than silently truncated into a valid-looking short image.
	raw, err := io.ReadAll(io.LimitReader(file, MaxIdentifyImageBytes+1))
	if err != nil {
		return IdentifyInput{}, errors.New("could not read the image")
	}
	if len(raw) > MaxIdentifyImageBytes {
		return IdentifyInput{}, fmt.Errorf("image is larger than %d bytes", MaxIdentifyImageBytes)
	}

	return IdentifyInput{
		Image: raw,
		// SNIFFED, never taken from the part's declared Content-Type. A header
		// is a claim the client makes; the magic number is evidence. A PDF
		// labelled image/jpeg would otherwise reach the vision API and be
		// rejected there, at our expense rather than the caller's.
		ImageMediaType: http.DetectContentType(raw),
	}, nil
}
