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
)

// ErrRefused means the provider declined to answer.
//
// A refusal is a successful call, and the distinction from ErrUnavailable is
// the one callers act on: a refusal will happen again for the same input, so
// nothing should retry it. Detecting one is per-provider and stays inside each
// implementation — Anthropic reports it as a stop reason on an HTTP 200, OpenAI
// as a `refusal` field on the message, and code ported between them without
// reading the API treats the other's refusal as an empty response and reports
// an outage.
//
// **Truncation maps here, not to ErrUnavailable**, and that is a decision
// rather than an accident: hitting the output cap mid-object is deterministic,
// so a retry produces the same truncation and bills the caller twice for it.
var ErrRefused = errors.New("llm: the provider declined the request")

// ErrUnavailable covers everything else — transport failure, an empty body, an
// upstream 5xx.
//
// Implementations must map their own errors onto these two and never return a
// raw upstream error: those carry request ids and prompt fragments, and this
// package's errors reach a client through the caller's error vocabulary.
var ErrUnavailable = errors.New("llm: the provider is unavailable")

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
