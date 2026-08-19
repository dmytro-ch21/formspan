package nutrition

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// EstimateHandler serves POST /v1/nutrition/estimate.
//
// Its own handler rather than a method on the nutrition Handler, because it
// depends on things nothing else in the module does — an upstream model and a
// spend meter — and wiring those into the type that serves the food log would
// mean every food read carries a dependency on an API key.
type EstimateHandler struct {
	estimator Estimator
	usage     EstimateUsageRepository
	// now is injectable so the quota window is testable without waiting a day.
	now func() time.Time
}

func NewEstimateHandler(est Estimator, usage EstimateUsageRepository) *EstimateHandler {
	return &EstimateHandler{estimator: est, usage: usage, now: time.Now}
}

// maxEstimateBody bounds the whole request.
//
// Generous enough for a 5 MB image plus its base64 and multipart overhead, and
// applied with MaxBytesReader so an oversized upload is refused as it arrives
// rather than after it has all been buffered.
const maxEstimateBody = 8 << 20

type estimateResponse struct {
	// Estimate is the DRAFT. The field is named for what it is so no client
	// reads it as a logged entry — nothing here has been written.
	Estimate Estimate `json:"estimate"`
	// Quota is what is left AFTER this call, so a client can show the count
	// without a second request and without computing it from the limit itself.
	Quota Quota `json:"quota"`
}

// Estimate turns a description or a photo into a draft.
//
// Never writes a food entry. The response populates the quick-add sheet and
// the athlete confirms — see estimate.go for why that separation is the whole
// design rather than an implementation detail.
func (h *EstimateHandler) Estimate(w http.ResponseWriter, r *http.Request) {
	userID, ok := callerID(w, r)
	if !ok {
		return
	}
	if h.estimator == nil {
		// No API key on this deploy. 503 rather than 500: the request was fine
		// and a retry against a configured deploy would work.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"meal estimation is not available")
		return
	}

	in, err := parseEstimateRequest(w, r)
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	}
	if err := in.Validate(); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, validationMessage(err))
		return
	}

	src := in.Source()
	now := h.now()

	// THE GATE, BEFORE ANY TOKEN IS SPENT. Checking after the call would meter
	// spend that has already happened, which is not a quota — it is a receipt.
	quota, err := CheckQuota(r.Context(), h.usage, userID, now)
	if err != nil {
		if errors.Is(err, ErrQuotaExhausted) {
			// No path in the message any more: there is one budget, and
			// naming the path would imply the other one is still available.
			msg := fmt.Sprintf("you have used all %d estimates for today", quota.Limit)
			if quota.ResetsAt != nil {
				// RELATIVE, not an RFC3339 instant. The client shows this
				// string as written, and the previous version rendered a UTC
				// timestamp — which west of Greenwich is both unreadable and
				// the wrong wall-clock DAY. A duration needs no timezone and
				// cannot be wrong about one.
				msg = fmt.Sprintf("%s — one more in %s", msg, humaniseWait(quota.ResetsAt.Sub(now)))
				// The machine-readable half. Conventions forbid clients
				// pattern-matching a message, so the reset has to leave here as
				// something other than prose or a client cannot act on it at
				// all. Retry-After is the standard spelling and needs no
				// contract change.
				w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds(quota.ResetsAt.Sub(now))))
			}
			apihttp.WriteError(w, http.StatusTooManyRequests, apihttp.CodeRateLimited, msg)
			return
		}
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "could not check your usage")
		return
	}

	est, usage, estErr := h.estimator.Estimate(r.Context(), in)

	// RECORDED WHETHER OR NOT IT WORKED, and deliberately not gated on estErr.
	// A refusal and an upstream error both cost tokens, so a meter that counted
	// only successes would let a caller loop on input the model keeps declining
	// and pay for every attempt.
	//
	// **`WithoutCancel`, not the request context.** The tokens are already
	// spent by this line, so a caller who disconnects mid-call would otherwise
	// escape the meter entirely — and a cancel-loop is exactly the
	// spend-somebody-else's-money shape the quota exists to bound. Found by
	// review.
	//
	// A failure to record is LOGGED and never fails the request: the athlete
	// should not lose a draft they have already paid for because the meter
	// write lost a race. The previous version discarded the error with `_ =`
	// while claiming middleware would log it, which was simply false — a meter
	// that silently stops metering is worse than one that errors.
	if err := h.usage.Record(context.WithoutCancel(r.Context()), EstimateRecord{
		UserID: userID, Source: src, Succeeded: estErr == nil,
		Model: est.Model, ItemCount: len(est.Items),
		// Recorded on the failure path too, and it is not zero there: a
		// refusal and a truncation are billed 200s. This is the whole point of
		// metering tokens rather than calls — see N49.
		Usage: usage,
	}); err != nil {
		httplog.FromContext(r.Context()).Error("nutrition: estimate not metered",
			"user_id", userID, "source", src, "err", err)
	}

	if estErr != nil {
		// LOGGED here, not inside writeEstimateError, because the wrapped
		// upstream text is the half that never reaches the client — and it
		// carries the provider request id somebody would need to raise a
		// support case. The convention is "log server-side, return a generic
		// message"; only the second half was being done, so a provider outage
		// on the one endpoint that costs money produced a stream of 502s with
		// no server-side detail at all.
		// No `model` field, deliberately. Every error path in Estimate returns a
		// ZERO Estimate, so `est.Model` here was always the empty string — a
		// field that reads as "the model is unknown" when it means "this code
		// never had it". The configured model is deploy config rather than
		// per-request data, and main.go logs it once at boot, which is where a
		// support case should read it from.
		httplog.FromContext(r.Context()).Error("nutrition: estimate failed",
			"user_id", userID, "source", src, "err", estErr)
		writeEstimateError(w, estErr)
		return
	}

	// Re-read rather than decrementing the number in hand: the athlete may be
	// logging from two devices, and a client-side subtraction would disagree
	// with the server the moment they are.
	after, err := h.usage.Quota(r.Context(), userID, now)
	if err != nil {
		// The pre-call figure would overstate `remaining` by one, since it does
		// not count the call just made, so it is adjusted by hand.
		//
		// NOT `NewQuota(src, quota.Used+1, quota.ResetsAt)` — that takes the
		// OLDEST call and adds the window itself, so passing an already-derived
		// `ResetsAt` would push the reset a further 24 hours out. I wrote that
		// first; the field names are close enough to swap without noticing.
		after = quota
		after.Used++
		if after.Remaining > 0 {
			after.Remaining--
		}
		httplog.FromContext(r.Context()).Warn("nutrition: quota re-read failed",
			"user_id", userID, "source", src, "err", err)
	}

	apihttp.WriteJSON(w, http.StatusOK, estimateResponse{Estimate: est, Quota: after})
}

// writeEstimateError maps the domain errors to status codes.
//
// A refusal is 422 rather than 400: the request was well-formed and the model
// simply could not read it as food, so the client's response is to ask for a
// better photo rather than to fix a field.
func writeEstimateError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrEstimateRefused):
		apihttp.WriteError(w, http.StatusUnprocessableEntity, apihttp.CodeInvalidInput,
			"could not read that as a meal — try describing it instead")
	case errors.Is(err, ErrInvalidInput):
		// 502, NOT 400 — and the distinction is the whole reason this case is
		// separate. The request was validated before a token was spent, so an
		// ErrInvalidInput reaching here can only have come from
		// ValidateEstimate: the MODEL returned an absurd magnitude, a NaN or a
		// nameless item. Answering 400 tells the athlete their request was
		// malformed when there is nothing in it to fix. Retryable, unlike a
		// refusal, because a garbled response is not deterministic.
		apihttp.WriteError(w, http.StatusBadGateway, apihttp.CodeInternal,
			"estimation returned something unusable — try again")
	case errors.Is(err, ErrEstimateUnavailable):
		// The wrapped upstream text is deliberately NOT forwarded: it can carry
		// request ids and prompt fragments, and no raw internal error reaches a
		// client here.
		apihttp.WriteError(w, http.StatusBadGateway, apihttp.CodeInternal,
			"estimation is temporarily unavailable")
	default:
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "could not estimate that meal")
	}
}

// validationMessage strips the error chain's prefixes so the client sees the
// human half without the package name.
func validationMessage(err error) string {
	msg := err.Error()
	for _, marker := range []string{"nutrition: invalid input: ", "nutrition: "} {
		if i := strings.LastIndex(msg, marker); i >= 0 {
			return msg[i+len(marker):]
		}
	}
	return msg
}

// parseEstimateRequest accepts both transports.
//
// JSON for the text path — the common case, and the one a client can send
// without building a multipart body. Multipart when there is an image, because
// base64 inside JSON would inflate a 5 MB photo to 6.7 MB on the wire for no
// benefit.
func parseEstimateRequest(w http.ResponseWriter, r *http.Request) (EstimateInput, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxEstimateBody)

	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		return parseMultipartEstimate(r)
	}
	return parseJSONEstimate(r)
}

type estimateBody struct {
	Description string `json:"description"`
	Meal        Meal   `json:"meal"`
}

func parseJSONEstimate(r *http.Request) (EstimateInput, error) {
	var body estimateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return EstimateInput{}, errors.New("invalid JSON body")
	}
	return EstimateInput{Description: body.Description, Meal: body.Meal}, nil
}

func parseMultipartEstimate(r *http.Request) (EstimateInput, error) {
	if err := r.ParseMultipartForm(maxEstimateBody); err != nil {
		return EstimateInput{}, errors.New("could not read the upload")
	}
	in := EstimateInput{
		Description: r.FormValue("description"),
		Meal:        Meal(r.FormValue("meal")),
	}

	file, _, err := r.FormFile("image")
	if err != nil {
		// No file part is legitimate — a multipart body carrying only a
		// description is the text path with a clumsy transport, not an error.
		return in, nil
	}
	defer file.Close()

	raw, err := io.ReadAll(io.LimitReader(file, MaxImageBytes+1))
	if err != nil {
		return EstimateInput{}, errors.New("could not read the image")
	}
	if len(raw) > MaxImageBytes {
		return EstimateInput{}, fmt.Errorf("image is larger than %d bytes", MaxImageBytes)
	}
	in.Image = raw
	// SNIFFED, never taken from the part's declared Content-Type. A header is a
	// claim the client makes; the magic number is evidence. Sending a PDF
	// labelled image/jpeg would otherwise reach the vision API and be rejected
	// there, at our expense rather than the caller's.
	in.ImageMediaType = http.DetectContentType(raw)
	return in, nil
}

// humaniseWait renders a duration the way somebody would say it.
//
// Deliberately coarse: this is the difference between "come back later" and
// "come back tomorrow", and a minute's precision on a 24-hour window is noise
// that reads as false precision.
func humaniseWait(d time.Duration) string {
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

// retryAfterSeconds is the header value: whole seconds, never below one, since
// a Retry-After of 0 invites the immediate retry the quota just refused.
func retryAfterSeconds(d time.Duration) int {
	if s := int(d.Seconds()); s > 0 {
		return s
	}
	return 1
}
