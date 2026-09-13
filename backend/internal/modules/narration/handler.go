package narration

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// maxBody bounds the request. The field caps in narration.go are RUNE caps, so the
// worst legitimate request is 60 facts each at a 120-rune key, a 200-rune label and
// four 120-rune names, in 4-byte UTF-8 (an emoji or a non-Latin script), plus 12
// numbers and the JSON around them: about 3.5KB a fact, 210KB in all. 64KB, the
// first value, fit only ASCII and would have answered such a request with a
// confusing 413 before validation ran. Raised in review.
const maxBody = 256 << 10

// Handler serves `POST /v1/day/narration`.
type Handler struct {
	narrator Narrator
	usage    UsageRepository
	now      func() time.Time
}

func NewHandler(n Narrator, usage UsageRepository) *Handler {
	return &Handler{narrator: n, usage: usage, now: time.Now}
}

// Narration is the guarded result.
type Narration struct {
	Sentences []Sentence `json:"sentences"`
	// Dropped is how many sentences the server-side guard refused. The sentences
	// themselves are not returned or logged: they are model text about the
	// athlete's day, and dropping them is the end of them.
	Dropped int `json:"dropped"`
}

type narrationResponse struct {
	Narration Narration `json:"narration"`
	Quota     Quota     `json:"quota"`
}

// Narrate follows `bjj.DraftHandler.Draft`'s order, and for the same reasons:
// who is asking, whether the feature is configured, whether the request can
// succeed, whether there is quota, and only then the model.
func (h *Handler) Narrate(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "sign in to continue")
		return
	}
	// From the verified token, and from nowhere else. The body has no user field,
	// and the strict decode below refuses one if a client sends it.
	userID := claims.UserID

	if h.narrator == nil {
		// No API key on this deploy. 503 rather than 500: the same request works
		// against a configured deploy.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal, "narrating the day is not available")
		return
	}

	var in Input
	if err := apihttp.DecodeJSONStrict(w, r, maxBody, &in); err != nil {
		// The decoder has already written the 400, on every one of its error paths,
		// including "unknown field" for a `user_id` a client should not send. A
		// second WriteError here put two error bodies in one response; the
		// bad-input test caught it by parsing the body, not just the status.
		return
	}
	// Validated before the quota, so a request that cannot succeed never costs a narration.
	if err := in.Validate(); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, validationMessage(err))
		return
	}

	now := h.now()
	quota, err := CheckQuota(r.Context(), h.usage, userID, now)
	if err != nil {
		if errors.Is(err, ErrQuotaExhausted) {
			if quota.ResetsAt != nil {
				secs := int(math.Ceil(quota.ResetsAt.Sub(now).Seconds()))
				if secs < 1 {
					secs = 1
				}
				w.Header().Set("Retry-After", strconv.Itoa(secs))
			}
			apihttp.WriteError(w, http.StatusTooManyRequests, apihttp.CodeRateLimited,
				"today's narrations are used up; more become available later")
			return
		}
		httplog.FromContext(r.Context()).Error("narration: quota check failed", "user_id", userID, "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "could not check your usage")
		return
	}

	sentences, meta, narrErr := h.narrator.Narrate(r.Context(), in)

	// Nothing was spent when the provider never answered, so nothing is recorded
	// (F16, #367). The log carries the operational fact.
	if errors.Is(narrErr, ErrNarrationUnreachable) {
		httplog.FromContext(r.Context()).Error("narration: not metered, provider never answered", "user_id", userID, "err", narrErr)
		writeError(w, narrErr)
		return
	}

	verdict := Verdict{Kept: []Sentence{}, Dropped: []Dropped{}}
	if narrErr == nil {
		verdict = Guard(sentences, in.Facts)
	}
	kept := verdict.Kept
	if len(kept) > MaxSentences {
		kept = kept[:MaxSentences]
	}

	// Recorded whether or not it worked, and with `WithoutCancel`: the tokens are
	// already spent, so a client that disconnects mid-call must not escape the
	// meter. A failed write is logged, never fails the request.
	if err := h.usage.Record(context.WithoutCancel(r.Context()), Record{
		UserID: userID, Succeeded: narrErr == nil, Model: meta.Model,
		SentencesKept: len(kept), Usage: meta.Usage,
	}); err != nil {
		httplog.FromContext(r.Context()).Error("narration: not metered", "user_id", userID, "err", err)
	}

	if narrErr != nil {
		// The facts are NOT logged, on any path.
		httplog.FromContext(r.Context()).Error("narration: failed", "user_id", userID, "err", narrErr)
		writeError(w, narrErr)
		return
	}
	if len(verdict.Dropped) > 0 {
		reasons := make([]string, 0, len(verdict.Dropped))
		for _, d := range verdict.Dropped {
			reasons = append(reasons, d.Reason)
		}
		// Reasons only. The dropped text is model output about the athlete's day.
		httplog.FromContext(r.Context()).Warn("narration: guard dropped sentences",
			"user_id", userID, "dropped", len(verdict.Dropped), "reasons", reasons)
	}

	// Re-read rather than decremented: two devices would otherwise disagree.
	after, err := h.usage.Quota(r.Context(), userID, now)
	if err != nil {
		// Adjusted by hand. NOT `NewQuota(quota.Used+1, quota.ResetsAt)`, which
		// would add the window to an already-derived reset (bjj records the trap).
		after = quota
		after.Used++
		if after.Remaining > 0 {
			after.Remaining--
		}
		if after.ResetsAt == nil {
			resets := now.Add(QuotaWindow)
			after.ResetsAt = &resets
		}
		httplog.FromContext(r.Context()).Warn("narration: quota re-read failed", "user_id", userID, "err", err)
	}

	apihttp.WriteJSON(w, http.StatusOK, narrationResponse{
		Narration: Narration{Sentences: kept, Dropped: len(verdict.Dropped)},
		Quota:     after,
	})
}

// writeError maps the domain errors onto statuses. The code, not the message, is
// the contract: `unavailable` means nothing was spent, `internal` means the call
// completed and was charged.
func writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNarrationRefused):
		apihttp.WriteError(w, http.StatusUnprocessableEntity, apihttp.CodeInvalidInput,
			"could not narrate the day this time")
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, validationMessage(err))
	case errors.Is(err, ErrNarrationUnreachable):
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeUnavailable,
			"narrating the day is unavailable right now; this did not use any of today's narrations")
	default:
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"narrating the day is unavailable right now")
	}
}

// validationMessage strips the sentinel prefix so a client sees only the reason.
func validationMessage(err error) string {
	msg := err.Error()
	const marker = "narration: invalid input: "
	for i := 0; i+len(marker) <= len(msg); i++ {
		if msg[i:i+len(marker)] == marker {
			return msg[i+len(marker):]
		}
	}
	return "invalid input"
}
