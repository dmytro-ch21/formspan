package exercise

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// IdentifyHandler serves POST /v1/exercises/identify.
type IdentifyHandler struct {
	// identifier is nil when the deploy has no API key. Nil-CHECKED rather than
	// nil-guarded at construction, so an unconfigured deploy runs every other
	// exercise route normally instead of refusing to start.
	identifier Identifier
	// usage is the persisted daily quota (N48).
	//
	// It lives HERE rather than in cmd/api beside the rate limiter, and that
	// placement is the point. N7's review found its spend gate structurally
	// correct — `limitIdentify` wrapped inside RequireAuth and outside the
	// handler — but UNTESTABLE: nothing asserted the route was actually wired
	// behind it, because the gate was in main.go and main.go has no test. A
	// gate on the handler is exercised by every test that calls the handler,
	// so "is the route behind the gate" stops being a question you have to
	// remember to ask.
	usage IdentifyUsageRepository
	// now is injectable so the quota window is testable without waiting a day.
	now func() time.Time
}

func NewIdentifyHandler(i Identifier, usage IdentifyUsageRepository) *IdentifyHandler {
	return &IdentifyHandler{identifier: i, usage: usage, now: time.Now}
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

	userID, ok := identifyCallerID(w, r)
	if !ok {
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

	// THE GATE, BEFORE ANY TOKEN IS SPENT. Checking after the call would meter
	// spend that has already happened, which is not a quota — it is a receipt.
	quota, err := CheckIdentifyQuota(r.Context(), h.usage, userID, h.now())
	if err != nil {
		if errors.Is(err, ErrIdentifyQuotaExhausted) {
			msg := fmt.Sprintf("you have used all %d machine identifications for today", quota.Limit)
			if quota.ResetsAt != nil {
				// RELATIVE, not an RFC3339 instant, and the phrasing matches
				// the nutrition gate deliberately — an athlete meets both caps
				// in one app, and two spellings of one idea read as two
				// different rules. A duration also needs no timezone and
				// therefore cannot be wrong about one, which a UTC timestamp
				// is for everyone west of Greenwich.
				msg = fmt.Sprintf("%s — one more in %s", msg, humaniseIdentifyWait(quota.ResetsAt.Sub(h.now())))
				// The machine-readable half: conventions forbid clients
				// pattern-matching a message, so the reset has to leave here as
				// something a client can act on. Same spelling nutrition uses.
				w.Header().Set("Retry-After", strconv.Itoa(identifyRetryAfterSeconds(quota.ResetsAt.Sub(h.now()))))
			}
			apihttp.WriteError(w, http.StatusTooManyRequests, apihttp.CodeRateLimited, msg)
			return
		}
		httplog.FromContext(r.Context()).Error("exercise: identify quota check failed", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal,
			"could not check your identification allowance")
		return
	}

	id, err := h.identifier.Identify(r.Context(), in)
	// RECORDED whether or not it worked, and BEFORE the error is written, so no
	// return path can skip the meter. A refusal and an outage both spent
	// tokens; a quota that counted only successes would let a caller loop on a
	// photo the model keeps declining and pay for every attempt.
	//
	// `context.WithoutCancel` because a client that hangs up mid-call has still
	// spent the money — metering must not be the thing a disconnect skips.
	if recErr := h.usage.Record(context.WithoutCancel(r.Context()), IdentifyRecord{
		UserID: userID, Succeeded: err == nil,
		Model: id.Model, CandidateCount: len(id.Candidates),
	}); recErr != nil {
		// Logged, never fatal: failing the request because the meter failed
		// would turn a bookkeeping outage into a feature outage, and the
		// athlete has already been charged for the call either way.
		httplog.FromContext(r.Context()).Error("exercise: record identification failed", "err", recErr)
	}
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

// humaniseIdentifyWait renders a duration the way a person says it.
//
// **A deliberate copy of nutrition's `humaniseWait`, and the third consumer
// should promote both this and `identifyRetryAfterSeconds` into
// `internal/platform/apihttp`** — that package already owns the 429's shape via
// WriteError, so it is where a shared quota response belongs.
//
// Copied rather than extracted HERE only because N49 is concurrently reworking
// the nutrition quotas, and moving a function out of `estimate_handler.go`
// during that would be a conflict bought for twenty lines. The risk being
// accepted is real and worth naming: this is athlete-facing copy about the same
// idea, so the two can drift into telling people different things about one
// rule. The phrasing is identical today; a change to either should change both.
func humaniseIdentifyWait(d time.Duration) string {
	if d < time.Minute {
		return "under a minute"
	}
	if d < time.Hour {
		m := int(d.Round(time.Minute).Minutes())
		if m == 1 {
			return "a minute"
		}
		// Rounding can carry a shade under an hour up to a flat 60, and
		// "60 minutes" is not how anybody says it.
		if m >= 60 {
			return "about an hour"
		}
		return fmt.Sprintf("%d minutes", m)
	}
	h := int(d.Round(time.Hour).Hours())
	if h <= 1 {
		return "about an hour"
	}
	return fmt.Sprintf("about %d hours", h)
}

// identifyRetryAfterSeconds is the header value: whole seconds, never below
// one, since a Retry-After of 0 invites the immediate retry the quota just
// refused.
func identifyRetryAfterSeconds(d time.Duration) int {
	if s := int(d.Seconds()); s > 0 {
		return s
	}
	return 1
}

// identifyCallerID reads the authenticated athlete from the request.
//
// The route sits behind RequireAuth, so a missing claim is a wiring mistake
// rather than a client one — but it is answered as 401 rather than trusted,
// because a quota keyed on an empty user id would meter every athlete into one
// shared bucket.
func identifyCallerID(w http.ResponseWriter, r *http.Request) (string, bool) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok || claims.UserID == "" {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "unauthorized")
		return "", false
	}
	return claims.UserID, true
}
