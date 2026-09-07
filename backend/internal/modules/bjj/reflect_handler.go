package bjj

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// DraftHandler serves POST /v1/bjj/reflect/draft.
//
// Its own handler rather than a method on SessionHandler, because it depends on
// things nothing else in this module does — an upstream model and a spend meter
// — and wiring those into the type that serves the session detail would mean
// every reflection read carries a dependency on an API key.
type DraftHandler struct {
	// drafter is nil when the deploy has no API key. Nil-CHECKED rather than
	// nil-guarded at construction, so an unconfigured deploy runs every other
	// bjj route normally instead of refusing to start.
	drafter Drafter
	usage   DraftUsageRepository
	// now is injectable so the quota window is testable without waiting a day.
	now func() time.Time
}

func NewDraftHandler(d Drafter, usage DraftUsageRepository) *DraftHandler {
	return &DraftHandler{drafter: d, usage: usage, now: time.Now}
}

// maxDictationBody bounds the whole request.
//
// Text only — there is no image path and no audio path, because transcription
// happens on the device's own keyboard. 64 KB is far above `MaxDictationRunes`
// even at four bytes a rune plus JSON overhead, and it exists so a caller
// cannot make the server buffer a megabyte before the rune check refuses it.
const maxDictationBody = 64 << 10

type draftRequest struct {
	Dictation string `json:"dictation"`
}

type draftResponse struct {
	// Draft is a DRAFT. The field is named for what it is so no client reads it
	// as a session — nothing here has been written, and the confirmed version
	// goes back through PUT /v1/bjj/sessions/{sessionID} like any other.
	Draft Draft `json:"draft"`
	// Quota is what is left AFTER this call, so a client can show the count
	// without a second request and without computing it from the limit itself.
	Quota DraftQuota `json:"quota"`
}

// Draft turns a dictated reflection into a draft the athlete confirms.
//
// **Never writes a session and never writes a tag.** See reflect.go for why
// that separation is the design rather than an implementation detail.
func (h *DraftHandler) Draft(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "sign in to continue")
		return
	}
	userID := claims.UserID

	if h.drafter == nil {
		// No API key on this deploy. 503 rather than 500: the request was fine
		// and the same request against a configured deploy would work.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"drafting a reflection is not available")
		return
	}

	in, err := parseDraftRequest(w, r)
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	}
	// Validated HERE as well as inside the drafter, so a request that cannot
	// succeed never reaches the quota check and therefore never costs an
	// athlete one of their ten for a typo.
	if err := in.Validate(); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, draftValidationMessage(err))
		return
	}

	now := h.now()

	// THE GATE, BEFORE ANY TOKEN IS SPENT. Checking after the call would meter
	// spend that has already happened, which is not a quota — it is a receipt.
	quota, err := CheckDraftQuota(r.Context(), h.usage, userID, now)
	if err != nil {
		if errors.Is(err, ErrDraftQuotaExhausted) {
			msg := fmt.Sprintf("you have used all %d reflection drafts for today", quota.Limit)
			if quota.ResetsAt != nil {
				// RELATIVE, not an RFC3339 instant, for the reason nutrition's
				// equivalent records: the client shows this string as written,
				// and a UTC timestamp west of Greenwich is both unreadable and
				// the wrong wall-clock DAY.
				msg = fmt.Sprintf("%s — one more in %s", msg, humaniseDraftWait(quota.ResetsAt.Sub(now)))
				// The machine-readable half. Conventions forbid a client
				// pattern-matching a message, so the reset has to leave here as
				// something other than prose or the client cannot act on it.
				w.Header().Set("Retry-After", strconv.Itoa(draftRetryAfterSeconds(quota.ResetsAt.Sub(now))))
			}
			apihttp.WriteError(w, http.StatusTooManyRequests, apihttp.CodeRateLimited, msg)
			return
		}
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "could not check your usage")
		return
	}

	draft, draftErr := h.drafter.Draft(r.Context(), in)

	// RECORDED WHETHER OR NOT IT WORKED, and deliberately not gated on
	// draftErr. A refusal and an upstream error both cost tokens, so a meter
	// that counted only successes would let a caller loop on input the model
	// keeps declining and pay for every attempt.
	//
	// **`WithoutCancel`, not the request context.** The tokens are already spent
	// by this line, so a caller who disconnects mid-call would otherwise escape
	// the meter entirely — and a cancel-loop is exactly the
	// spend-somebody-else's-money shape the quota exists to bound.
	//
	// A failure to record is LOGGED and never fails the request: the athlete
	// should not lose a draft they have already paid for because the meter
	// write lost a race.
	//
	// **A transport failure that spent NOTHING is no longer charged.** This
	// block used to say the opposite and file the consequence as F16; #367 is
	// that fix. A refused connection, a DNS failure, a revoked key or an
	// upstream 5xx never reached a token, and charging one of the athlete's ten
	// for it meant a provider outage locked them out for the rest of the day
	// after service returned — with the 503's own advice to retry doing the
	// burning.
	//
	// The loop-prevention property is intact: a REFUSAL still meters, and a
	// refusal is the input-determined failure a caller could otherwise sit in.
	// An outage is not induced by anyone's dictation — cleanly true of a 5xx and
	// a dead connection, only mostly true of a provider 4xx, which
	// `llm.ErrUnreachable` states as a deliberate loosening rather than leaving
	// implied here.
	//
	// Nothing is written on this path rather than a row marked unmetered —
	// `bjj_reflection_drafts` records calls that happened, and this one did
	// not. The log line carries the operational fact.
	if errors.Is(draftErr, ErrDraftUnreachable) {
		httplog.FromContext(r.Context()).Error("bjj: reflection draft not metered, provider never answered",
			"user_id", userID, "err", draftErr)
		writeDraftError(w, draftErr)
		return
	}

	if err := h.usage.RecordDraft(context.WithoutCancel(r.Context()), DraftRecord{
		UserID: userID, Succeeded: draftErr == nil,
		Model: draft.Model, TagCount: len(draft.Tags),
	}); err != nil {
		httplog.FromContext(r.Context()).Error("bjj: reflection draft not metered",
			"user_id", userID, "err", err)
	}

	if draftErr != nil {
		// LOGGED here rather than inside the writer, because the wrapped
		// upstream text is the half that never reaches the client — and it
		// carries the provider request id somebody would need to raise a support
		// case.
		//
		// **The dictation is NOT logged**, on any path. It is the athlete's own
		// speech about their training and sometimes their body; a log line is
		// the one place it would come to rest after this handler deliberately
		// stores it nowhere.
		httplog.FromContext(r.Context()).Error("bjj: reflection draft failed",
			"user_id", userID, "err", draftErr)
		writeDraftError(w, draftErr)
		return
	}

	// Re-read rather than decrementing the number in hand: the athlete may have
	// the app open on two devices, and a client-side subtraction would disagree
	// with the server the moment they do.
	after, err := h.usage.DraftQuota(r.Context(), userID, now)
	if err != nil {
		// The pre-call figure would overstate `remaining` by one, since it does
		// not count the call just made, so it is adjusted by hand.
		//
		// NOT `NewDraftQuota(quota.Used+1, quota.ResetsAt)` — that takes the
		// OLDEST call and adds the window itself, so passing an already-derived
		// `ResetsAt` would push the reset a further 24 hours out. The field
		// names are close enough to swap without noticing; nutrition's
		// equivalent records the same trap.
		after = quota
		after.Used++
		if after.Remaining > 0 {
			after.Remaining--
		}
		if after.ResetsAt == nil {
			// The pre-call figure had nothing in the window, so it carried no
			// reset — but this call is now in it, and it is the oldest, so it
			// ages out a window from now. Leaving it nil would report
			// `used: 1, resets_at: null`, which contradicts the field's own
			// contract ("null when nothing is used") on the one path a client
			// cannot check for itself.
			//
			// When `Used` was already non-zero the stale value is exact rather
			// than approximate: a new call never changes when the OLDEST one
			// ages out.
			resets := now.Add(DraftQuotaWindow)
			after.ResetsAt = &resets
		}
		httplog.FromContext(r.Context()).Warn("bjj: draft quota re-read failed",
			"user_id", userID, "err", err)
	}

	apihttp.WriteJSON(w, http.StatusOK, draftResponse{Draft: draft, Quota: after})
}

// writeDraftError maps the domain errors onto statuses.
//
// A refusal is **422, not 400**: the request was well-formed and was processed,
// and the answer is "I could not read that as a session". A 400 would tell the
// client to fix its request, and there is nothing in the request to correct.
//
// **The 422's message no longer recommends rewording, and that is N118.** It
// used to read "try saying what happened in plainer terms", which does two
// wrong things at once: it tells the athlete they spoke badly, and it names a
// remedy that is not the remedy. The report it was filed from — *"I first got
// an error that it's not articulated correctly and then I just resent again"* —
// is a refusal reversing itself on the identical sentence, which is what you
// would expect from a provider called at its default sampling temperature.
// `llm.Request` has no temperature field, so that is how both providers are
// called.
//
// Nothing here promises a retry will work, because it may not: a TRUNCATED
// response maps onto the same sentinel and really is deterministic. The message
// states what happened and leaves the client to choose, which is what the
// mobile app now does with a single bounded retry.
func writeDraftError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrDraftRefused):
		apihttp.WriteError(w, http.StatusUnprocessableEntity, apihttp.CodeInvalidInput,
			"could not turn that into a session this time — the same words may well work on another try")
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, draftValidationMessage(err))
	case errors.Is(err, ErrDraftUnreachable):
		// Same 503 as the default arm below, and a DIFFERENT code — which is
		// the whole change here. `internal` says we are broken; `unavailable`
		// says our provider is, and only the second is a retry instruction the
		// client can act on without matching a prose message the conventions
		// forbid it from matching. Before this an outage, an unconfigured
		// deploy and an unmapped bug all arrived as `internal`.
		//
		// The message says the draft was not charged, because otherwise the
		// athlete assumes it was and stops trying.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeUnavailable,
			"drafting a reflection is unavailable right now — this one did not use any of your daily drafts")
	default:
		// Everything else, including ErrDraftUnavailable. 503 rather than 500
		// because a retry is the right advice, and the message is fixed — the
		// wrapped detail was logged above and must not reach the client.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeInternal,
			"drafting a reflection is unavailable right now")
	}
}

// draftValidationMessage strips the sentinel prefix so a client sees the reason
// without the package name.
func draftValidationMessage(err error) string {
	msg := err.Error()
	for _, marker := range []string{"bjj: invalid input: ", "bjj: "} {
		if i := strings.LastIndex(msg, marker); i >= 0 {
			return msg[i+len(marker):]
		}
	}
	return msg
}

// parseDraftRequest reads the sentence.
//
// **JSON only, unlike nutrition's estimate.** That endpoint accepts multipart
// because it has a photo path; this one never will — transcription happens on
// the device's own keyboard, so the server only ever sees text, and offering a
// second transport would be an alternative spelling of the same request.
func parseDraftRequest(w http.ResponseWriter, r *http.Request) (DictationInput, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxDictationBody)

	var body draftRequest
	if err := apihttp.DecodeJSONBody(r.Body, &body); err != nil {
		// The decoder's own text can name a byte offset in the athlete's speech,
		// so it is not forwarded.
		return DictationInput{}, errors.New("invalid JSON body")
	}
	return DictationInput{Dictation: body.Dictation}, nil
}

// humaniseDraftWait renders a duration the way somebody would say it.
//
// Deliberately coarse: this is the difference between "come back later" and
// "come back tomorrow", and a minute's precision on a 24-hour window is false
// precision.
func humaniseDraftWait(d time.Duration) string {
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

// draftRetryAfterSeconds is the header value: whole seconds, never below one.
//
// **ROUNDED UP, and that is the contract rather than a preference.**
// `docs/architecture/api-conventions.md` promises a `Retry-After` "rounded up so
// that obeying it exactly succeeds", and `internal/platform/ratelimit` honours
// it with `roundUpSecond`. Truncating instead is a real bug and not a cosmetic
// one: the window is `created_at > since`, so a client that waits exactly the
// advertised number of seconds is still INSIDE the window by the fractional
// part, gets a second 429, and learns that obeying the header does not work.
//
// Never below one for the same family of reason — a `Retry-After: 0` invites the
// immediate retry the quota just refused.
//
// (This was copied from `nutrition.retryAfterSeconds` before the rounding rule
// was checked, so it inherited the truncation and was fixed here first. That
// one is fixed too as of F15, and pinned by its own test; the two now agree.)
func draftRetryAfterSeconds(d time.Duration) int {
	if d <= 0 {
		return 1
	}
	s := int((d + time.Second - 1) / time.Second)
	if s < 1 {
		return 1
	}
	return s
}
