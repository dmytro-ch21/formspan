package nutrition

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
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
	quota, err := CheckQuota(r.Context(), h.usage, userID, src, now)
	if err != nil {
		if errors.Is(err, ErrQuotaExhausted) {
			msg := fmt.Sprintf("you have used all %d %s estimates for today", quota.Limit, src)
			if quota.ResetsAt != nil {
				msg = fmt.Sprintf("%s — one more is available %s",
					msg, quota.ResetsAt.UTC().Format(time.RFC3339))
			}
			apihttp.WriteError(w, http.StatusTooManyRequests, apihttp.CodeRateLimited, msg)
			return
		}
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "could not check your usage")
		return
	}

	est, estErr := h.estimator.Estimate(r.Context(), in)

	// RECORDED WHETHER OR NOT IT WORKED, and deliberately not gated on estErr.
	// A refusal and an upstream error both cost tokens, so a meter that counted
	// only successes would let a caller loop on input the model keeps declining
	// and pay for every attempt. A failure to record is logged by the caller's
	// middleware and never fails the request — the athlete should not lose a
	// draft they have already paid for because the meter write lost a race.
	_ = h.usage.Record(r.Context(), EstimateRecord{
		UserID: userID, Source: src, Succeeded: estErr == nil,
		Model: est.Model, ItemCount: len(est.Items),
	})

	if estErr != nil {
		writeEstimateError(w, estErr)
		return
	}

	// Re-read rather than decrementing the number in hand: the athlete may be
	// logging from two devices, and a client-side subtraction would disagree
	// with the server the moment they are.
	after, err := h.usage.Quota(r.Context(), userID, src, now)
	if err != nil {
		after = quota
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
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, validationMessage(err))
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
