// Package llm is the transport half of talking to a language model: pick a
// provider, send a prompt and a JSON schema, get raw JSON back.
//
// # What it is for
//
// N26 built this seam inside `nutrition` and it earned its shape there — a
// small per-provider `completer` with the prompt, schema, parse, validation and
// error vocabulary all sitting ABOVE it, so adding a backend meant one file
// with one method rather than a second copy of the rules. The comment there
// names the reason: doing it twice is "three chances for two backends to
// disagree".
//
// N33 is that second time. It dictates BJJ prose instead of a meal, but the
// shape is identical — prose (and optionally an image) in, schema-constrained
// JSON out, a draft the athlete confirms. Left in `nutrition` the interface was
// package-private and typed to `EstimateInput`, so N33's only options were to
// import the nutrition package for a food type or to write a second
// `anthropic.go`/`openai.go` pair.
//
// The extraction was deliberately deferred until N26 landed: with one consumer
// an interface is designed against a guess. It is deliberately done BEFORE N33
// writes any provider code, because the moment a second copy exists the cheap
// version of this stops being available.
//
// # What is here and what is not
//
// Here: choosing a provider, the two transport calls, structured-output
// plumbing, image handling, and normalising each provider's idea of "declined"
// onto one sentinel.
//
// NOT here, and this is the line that keeps the package honest — the prompt,
// the schema, the parse, the range checks and the domain error vocabulary all
// stay with the feature. A caller hands over a request and gets raw JSON; it
// does not get an opinion about whether the answer was any good. That is what
// stops two features' rules leaking into each other through a shared transport.
//
// Model DEFAULTS stay with the caller too. They are a per-feature judgement —
// N26 and N33 want different defaults on the same provider — so this package
// takes a model id and does not know what a good one is.
package llm

import (
	"context"
	"errors"
	"fmt"
	"net/url"
)

// ErrRefused means the provider declined to answer.
//
// A refusal is a successful call, and the distinction from ErrUnavailable is
// the one callers act on: a refusal was BILLED, so anything retrying it pays
// again.
//
// **It is not, however, deterministic, and this comment said it was until
// N118.** No Request carries a temperature, so both providers are called at
// their default sampling temperature and identical input does not imply
// identical output — measured in the field on the bjj dictation route, where a
// refused sentence was resent unchanged and drafted fine. The old claim came
// from the truncation case below, which RELIABLY RECURS — length is driven by
// what the model has to say rather than by one sampled token, so a retry
// truncates again in practice — and was generalised to every refusal without
// being checked.
//
// What survives is the instruction to callers, for the cost reason rather than
// the futility one: a metered caller must BOUND any retry of a refusal, because
// every attempt spends. Detecting one is per-provider and stays inside each
// implementation — Anthropic reports it as a stop reason on an HTTP 200, OpenAI
// as a `refusal` field on the message, and code ported between them without
// reading the API treats the other's refusal as an empty response and reports
// an outage.
//
// **Truncation maps here, not to ErrUnavailable**, and that is a decision
// rather than an accident: hitting the output cap mid-object is deterministic,
// so a retry produces the same truncation and bills the caller twice for it.
var ErrRefused = errors.New("llm: the provider declined the request")

// ErrUnavailable covers a call that REACHED the provider and came back
// unusable — an HTTP 200 with no choices, an empty body, a response whose
// envelope could not be read.
//
// It used to cover transport failures and upstream 5xxes as well. Those moved
// to ErrUnreachable below, and the line between the two is now the one a caller
// meters on: this sentinel means the model may well have answered and been
// billed for it, so the call still counts against whatever budget the caller
// keeps.
//
// Implementations must map their own errors onto these three and never return a
// raw upstream error: those carry request ids and prompt fragments, and this
// package's errors reach a client through the caller's error vocabulary.
var ErrUnavailable = errors.New("llm: the provider is unavailable")

// ErrUnreachable means the provider produced NO ANSWER, so nothing was billed
// for one.
//
// # Why a third sentinel rather than a flag on ErrUnavailable
//
// Every LLM-backed endpoint in this repo meters failures on purpose: a refusal
// costs tokens, so a caller that could loop on input the model keeps declining
// would spend our money doing it. But two sentinels forced one answer for two
// opposite situations. A connection refused, a DNS failure and a revoked key
// spend NOTHING, and charging the athlete a slice of their daily allowance for
// them means a provider outage locks them out of the feature for up to a day
// after service returns — punishing the user for our supplier's failure, on a
// request they did everything right on. That is F16 (#367).
//
// The knowledge needed to tell those apart exists only here. Above this package
// an error is an error; the HTTP status, or the absence of any HTTP response at
// all, is visible at the transport and nowhere else.
//
// # What maps here, exactly
//
//   - No HTTP response at all — connection refused, DNS failure, TLS failure.
//     Both SDKs return the `net/http` error unwrapped in this case ("Other
//     errors are not wrapped by this SDK"), which is what makes it detectable
//     rather than guessed at.
//
//     **A timeout belongs to this bullet only when the DIALER's own clock ran
//     out** — that arrives as a `*url.Error` wrapping an i/o timeout and does
//     not match `context.DeadlineExceeded`. A timeout driven by the request
//     CONTEXT is the opposite case and is metered; see the deadline note below.
//     An earlier draft of this bullet said "a dial timeout" flatly, which read
//     as covering both. Raised in review.
//
//   - Any HTTP error status the provider's API answered with — 401 on a revoked
//     key, 429, 500/503/529 during an outage. The API layer rejected or dropped
//     the request; no completion exists, and neither provider returns a usage
//     block on an error response.
//
// The name says "unreachable" and the second bullet stretches it — a 503 did
// reach the provider's front door. They are one sentinel because the CALLER's
// action is identical in both: do not meter it, and tell the client to try
// again. Splitting them would create a distinction no caller acts on.
//
// # The 4xx half is a deliberate loosening, and the usual argument does not cover it
//
// The consumers of this package justify not metering with "an outage is not
// something a caller induces with its input". That is true of a 5xx, a DNS
// failure and a refused connection. It is **not** strictly true of a 4xx: a
// client could in principle send something the provider rejects with a 400 and
// then retry it for free, which is a small version of the loop the metering
// exists to close.
//
// It is accepted rather than special-cased, on grounds worth stating with their
// real numbers rather than as "it is bounded" — because the bound is looser than
// that phrasing suggests, and an earlier draft of this comment did suggest it:
//
//   - A 4xx bills us no tokens, which is the thing the quota is denominated in.
//   - The input is already bounded server-side before a token is spent: body
//     size, image bytes and text length are all checked by the handler.
//   - Every route reaching here is authenticated.
//
// **What is NOT tight is the request rate.** `/v1/exercises/identify` has its
// own limiter (burst 20, one per 30 min). `/v1/nutrition/estimate` and
// `/v1/bjj/reflect/draft` have only the global default — **burst 120, then 2/s
// sustained** (`cmd/api/main.go`). So before this change a caller looping on an
// input the provider rejects was stopped by the daily quota after 25 calls;
// now that loop is capped only by the limiter, at roughly 170k unbilled
// provider requests a day. No tokens are spent, but our request-rate standing
// with the provider and our own ingest are. Raised in review, and it is a
// genuine judgement call rather than a free win.
//
// It is still the right trade, because the alternative charges an athlete for a
// revoked API KEY — our config error, on their allowance — which is the same
// indefensible shape F16 exists to remove. Metering 4xx while exempting 5xx,
// 429 and 401 is the cheaper middle position if the request-rate exposure ever
// matters; note that it would have to exempt 404 too, since a model-not-found
// is also our misconfiguration and not the athlete's doing.
//
// # What deliberately does NOT map here
//
//   - A refusal or a truncation. Both are billed HTTP 200s. They stay
//     ErrRefused and they stay metered — that is the loop-prevention property
//     this whole scheme exists for, and it is untouched.
//
//   - A CANCELLED or timed-out call. TWO independent reasons, and the second is
//     the one that would still hold if the first were somehow addressed:
//
//     1. Correctness. The request very likely reached the model and was billed
//     for an answer nobody stayed to read, and "the caller hangs up mid-call"
//     is precisely the spend-somebody-else's-money loop the meter was hardened
//     against in review.
//
//     2. Adversarial. **If cancellation were free, the quota would be trivially
//     defeatable**: fire a request, cancel at 50ms, repeat. The provider bills
//     us for every one and the athlete's row count never moves. A quota with a
//     free path around it is not a quota.
//
//     So `neverReachedProvider` checks the context errors FIRST and answers
//     false.
//
//     **The asymmetry this costs, stated so nobody files it as a bug.** A
//     genuine network timeout where the request never reached the provider is
//     metered too, and we cannot tell it apart from a cancellation that arrived
//     after the model had already answered — by the time the deadline fires,
//     the two are the same error. So an athlete on a bad connection can be
//     charged a unit nobody was billed for. That is deliberate: it is the
//     conservative direction (over-charging one unit, versus handing out a free
//     bypass of the whole cap), and it is bounded by the rolling 24-hour
//     window. Reversing it would be safe only with per-call evidence that the
//     provider never started work, which no response we get carries.
//
//   - A 200 whose body could not be read or parsed. The model answered; we
//     failed. ErrUnavailable, and metered, because it was billed.
var ErrUnreachable = errors.New("llm: the provider never answered")

// neverReachedProvider reports whether err means no HTTP response ever arrived.
//
// `*url.Error` is the discriminator, and it is exact rather than a heuristic:
// `http.Client.Do` wraps every failure it returns in one, and it returns an
// error ONLY when no response headers were received. Once headers are in, `Do`
// succeeds and any later failure — a body read, a JSON parse — comes back
// unwrapped by `*url.Error`. So this answers "the request never completed at
// the HTTP level", which is the question, instead of "some network-ish thing
// happened", which would also catch a body-read failure on a call that was
// billed in full.
//
// **The context check has to come first.** A cancelled request can surface as a
// `*url.Error` wrapping `context.Canceled`, and reading that as "never reached
// the provider" would stop metering exactly the cancel-loop the meter was
// hardened against.
func neverReachedProvider(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var urlErr *url.Error
	return errors.As(err, &urlErr)
}

// callFailure turns one provider's SDK error into this package's vocabulary.
//
// Shared rather than written twice, because two copies is two chances for the
// backends to disagree about whether an outage costs the athlete a meal
// estimate — the same reasoning that put the refusal and truncation branches
// under one rule. What each provider supplies is the half only it can know:
// `apiStatus`, the HTTP status its own SDK error type carries, or 0 when the
// SDK returned something that is not an API error at all.
//
// The upstream text is embedded for the caller's LOG, never for its client;
// every consumer writes a fixed message and logs this error, which is the
// convention in docs/architecture/api-conventions.md.
func callFailure(err error, apiStatus int) error {
	switch {
	case apiStatus >= 400:
		// Deliberately NOT the upstream text on this branch: an API error's
		// `Error()` renders the full response body, and a 4xx body is the one
		// most likely to quote the request back. The status is the whole
		// signal.
		return fmt.Errorf("%w: provider answered HTTP %d", ErrUnreachable, apiStatus)
	case neverReachedProvider(err):
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	default:
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
}

// There is a THIRD outcome, and this package deliberately has no error for it.
//
// A model can return HTTP 200, valid JSON, schema-conformant — and empty of
// anything useful. Measured: the dictation eval (#302) fed `gpt-5.6-luna` a
// dictation carrying an injected instruction, and it neither obeyed nor failed.
// It dumped the whole sentence into the free-text field and returned no tags,
// including for the real technique the athlete had reported. No refusal stop
// reason, no `message.refusal`, no `length` finish reason. At this layer that is
// a **successful call**, and both sentinels above are wrong for it.
//
// **Do not add an emptiness check here.** Emptiness is only legible against a
// schema and a domain, and the same shape means opposite things to different
// callers: an empty item list is the CORRECT answer for a photo of a wall, and
// an empty tag list is the CORRECT answer for "reminder to buy a mouthguard".
// A check in this package would have to be wrong for one of them to be right
// for the other — it would break nutrition's legitimate empty result in order
// to catch dictation's illegitimate one.
//
// Deciding whether a well-formed response is USABLE is the consumer's job, next
// to the schema that gives the fields meaning. This package's contract stops at
// "the provider answered, here is what it said". Raised by the session that ran
// the eval.

// Request is one call, described without reference to any provider.
type Request struct {
	// System is the instruction sent as the system prompt.
	System string
	// Prompt is the user turn.
	Prompt string
	// Schema is the JSON schema the response must satisfy.
	//
	// `map[string]any` rather than `any` because Anthropic's SDK demands the
	// concrete type at the call site; OpenAI's takes `any` and is happy with it.
	// Typing it loosely here would move a compile error into a type assertion
	// that fails at runtime, on the one path that costs money to reach.
	// Both backends enforce the schema strictly, which is why callers get raw
	// JSON back rather than free text.
	//
	// Both providers additionally demand `additionalProperties: false`
	// everywhere and every property listed in `required`. That is the happy
	// reason one schema serves both, and a schema that satisfies only one of
	// them will fail at the other provider rather than here.
	Schema map[string]any
	// SchemaName labels the schema. OpenAI requires one; Anthropic ignores it.
	// Provider-shaped rather than domain-shaped, so it lives on the request
	// instead of being invented inside the OpenAI implementation.
	SchemaName string

	// Image is optional; when set, ImageMediaType must be its MIME type.
	//
	// Sent BEFORE the text, because a leading image reads as the subject and
	// the text as its caption rather than the other way round.
	Image          []byte
	ImageMediaType string

	// MaxTokens caps the output.
	//
	// Required in practice on the OpenAI path, where the model bills for
	// reasoning tokens it never shows: output is most of the cost, and without
	// a cap a pathological input is bounded only by the model's own maximum on
	// the one endpoint where a request turns directly into money.
	MaxTokens int64
}

// Response is what came back.
type Response struct {
	// Raw is the model's JSON, unparsed. Callers own the parse, because they
	// own the schema.
	Raw string
	// Model is the id the provider reports having used, which is not always the
	// id that was asked for — an alias resolves to a dated snapshot. Worth
	// recording rather than echoing the request.
	Model string
	// Usage is what the call cost, in tokens.
	//
	// **Populated even when Complete returns ErrRefused**, because a refusal
	// and a truncation are HTTP 200s that were billed in full. A caller
	// metering spend has to see those or it under-counts exactly the traffic a
	// runaway client generates. It is empty only when the call never produced
	// a response at all — a transport failure, where there is genuinely
	// nothing to report rather than nothing to find.
	Usage Usage
}

// Usage is what one call cost, in tokens, normalised across providers.
//
// It exists because nothing in this system could previously answer "what did
// that cost". The nutrition estimate quotas were sized on an ASSUMED ~50x cost
// ratio between a photo call and a text one, which turned out to be ~1.1x when
// somebody finally measured by hand — and the plan to "replace the numbers with
// a week of production traffic" could not have worked, because no token count
// was recorded anywhere. See N49.
//
// # The normalisation that matters
//
// **The two providers disagree about whether cached tokens are inside the input
// count**, and taking either at face value makes the other's numbers wrong:
//
//   - OpenAI's `prompt_tokens` INCLUDES tokens served from cache;
//     `prompt_tokens_details.cached_tokens` says how many of them were.
//   - Anthropic's `input_tokens` EXCLUDES them; `cache_read_input_tokens` and
//     `cache_creation_input_tokens` are reported alongside and must be added
//     to get the comparable figure.
//
// InputTokens here is always the INCLUSIVE total, so the same number means the
// same thing on both. That is not a detail: on this prompt 1,334 of 1,337
// input tokens come back cached, so reading Anthropic's exclusive figure as if
// it were inclusive would report a ~1,300-token prompt as a 3-token one.
type Usage struct {
	// InputTokens is every token sent, cached ones included.
	InputTokens int64
	// OutputTokens is every token generated, reasoning included — reasoning is
	// billed as output, so excluding it would under-report the bill on exactly
	// the models where it dominates.
	OutputTokens int64
	// CachedInputTokens is the part of InputTokens served from the provider's
	// prompt cache, and therefore billed at a discount or not at all. The
	// difference between the list price and the real one.
	CachedInputTokens int64
	// ReasoningTokens is the part of OutputTokens spent thinking rather than
	// answering.
	//
	// Both providers report it: OpenAI as
	// `completion_tokens_details.reasoning_tokens`, Anthropic as
	// `usage.output_tokens_details.thinking_tokens`. An earlier version of this
	// comment claimed Anthropic did not, and left the field unmapped — which
	// would have written a confident `reasoning_tokens = 0` for every Anthropic
	// call, the exact zero-that-means-unknown this package's NULL rule exists
	// to prevent. Raised in review.
	ReasoningTokens int64
	// ImageTokens is the part of InputTokens the image accounted for, from the
	// provider's own accounting rather than from a guess.
	//
	// **A POINTER, so "not reported" and "reported as zero" stay different
	// things.** Nil means the provider said nothing; a zero value means it said
	// zero. Collapsing them into an int64 forced the repository to guess from
	// `> 0`, which made a genuine zero on a text call indistinguishable from an
	// unreported breakdown on a photo call — and the column comment then
	// documented a state no code path could produce. Raised in review.
	//
	// **Measured 2026-08-19: `gpt-5.6-luna` does not populate it**, and
	// Anthropic has no equivalent field at all, so on the shipped configuration
	// this is always nil. Kept because the field exists in the OpenAI response
	// shape and a model that fills it answers the photo cost question directly.
	//
	// Until then the image cost is obtained by DIFFERENCING InputTokens against
	// a text-only call: 1,348 without a picture against 2,620 with the 1080px
	// one the app actually sends, so ~1,272 tokens.
	ImageTokens *int64
}

// validate rejects a request that cannot succeed, before it costs anything.
//
// `MaxTokens` is the one that bites: zero is not "no cap", it is a cap of zero.
// The field is sent either way, so `max_completion_tokens: 0` fails every
// OpenAI call and Anthropic requires at least one — and both surface as
// `ErrUnavailable`, which is a config error wearing an outage's clothes. That is
// the exact shape `New`'s empty-model check exists to prevent, so it gets the
// same treatment one layer down.
//
// A plain error rather than a sentinel, deliberately: a caller translating the
// two sentinels will map this to its own "unavailable", which is the right
// STATUS, while the text carries the actual reason into the log.
func (r Request) validate() error {
	if r.MaxTokens <= 0 {
		return errors.New("llm: request needs a positive MaxTokens; zero is a cap of zero, not an absent one")
	}
	return nil
}

// Completer is one provider.
type Completer interface {
	Complete(ctx context.Context, req Request) (Response, error)
	// Name identifies the backend for logging and usage rows.
	Name() string
	// Model is the model id this completer was CONFIGURED with.
	//
	// Distinct from `Response.Model`, which is what the provider reports having
	// actually used — an alias resolves to a dated snapshot, so the two differ
	// routinely and both are worth having: this one answers "what did we ask
	// for", which is a config question, and that one answers "what replied".
	//
	// On the interface because a caller that resolved a model from its own
	// defaults otherwise has no way to confirm the resolution reached the
	// transport, and re-deriving it to check is the duplicated defaulting that
	// drifts and then misreports the very thing somebody is reading it to find.
	Model() string
}
