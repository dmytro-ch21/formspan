package llm

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	anthropicoption "github.com/anthropics/anthropic-sdk-go/option"
	openaioption "github.com/openai/openai-go/v3/option"
)

// F16 (#367): a provider outage must not cost the athlete their daily
// allowance.
//
// # Why this file does not use a fake Completer
//
// Every claim here is of the form "when the provider is unreachable, the
// transport reports X". A fake `Completer` can only return the error its author
// already believes the SDK returns, so a suite built on one confirms the
// author's belief and calls it evidence. This repo has the scar: every test of
// an external provider stubbed it with `httptest` returning 200, because that
// is what the author believed it did — green, thorough, mutation-tested, and
// confirming the wrong thing, with nothing for review to notice because the
// code and the tests agreed perfectly.
//
// So the transport failures below are REAL ONES. A closed TCP port is a real
// `connect: connection refused` off the real dialer; an unresolvable host is a
// real resolver failure; a cancelled context is a real cancellation. The SDK's
// own error path runs, unmocked, and `neverReachedProvider` is asked about the
// error the SDK actually produced rather than one written to match it.
//
// # What is still stubbed, and stated rather than hidden
//
// The HTTP-STATUS cases (401, 429, 503) use `httptest`, so they prove two
// things and not a third:
//
//   - PROVEN: each SDK turns an HTTP error status into its own `*Error` type
//     carrying `StatusCode`, and this package classifies that as unreachable.
//     Real HTTP, real SDK, real classification.
//   - NOT PROVEN, and not provable without spending money against the live
//     API: that a revoked key really produces 401, that an outage really
//     produces 5xx, and that neither is billed. Those rest on the providers'
//     documented behaviour. `TestLiveComplete` is where a real call would go.
//
// The status branch is the weaker half on purpose: everything in the issue's
// own reproduction — connection refused, DNS — lands in the transport half,
// which is the half that is genuinely measured here.

// closedPort returns an address nothing is listening on.
//
// Bound and released rather than guessed, so the port is one the kernel just
// confirmed was free — a hard-coded number is a test that passes until somebody
// runs a database on it.
func closedPort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("could not bind a port to then close it: %v", err)
	}
	addr := l.Addr().String()
	if err := l.Close(); err != nil {
		t.Fatalf("could not close the listener: %v", err)
	}
	// Prove the apparatus: if something is still accepting on this address the
	// "connection refused" below would come from somewhere else, and a test
	// that cannot fail for the right reason is not a test.
	if c, err := net.DialTimeout("tcp", addr, 250*time.Millisecond); err == nil {
		c.Close()
		t.Fatalf("%s still accepts connections — this test would prove nothing", addr)
	}
	return "http://" + addr
}

// completerAt builds each provider pointed at a base URL.
//
// Enumerated from the Provider constants rather than listed by hand, matching
// the other tests in this package: a third backend that forgets to classify its
// transport failures should fail here by name rather than ship a provider that
// quietly charges athletes for its own outages.
//
// `WithMaxRetries(0)` because the SDKs retry connection errors twice by
// default. The retries are correct in production and pure latency here — three
// dials and two backoffs to observe one refusal.
func completerAt(t *testing.T, p Provider, baseURL string) Completer {
	t.Helper()
	switch p {
	case ProviderOpenAI:
		return newOpenAI("test-key", "test-model",
			openaioption.WithBaseURL(baseURL), openaioption.WithMaxRetries(0))
	case ProviderAnthropic:
		return newAnthropic("test-key", "test-model",
			anthropicoption.WithBaseURL(baseURL), anthropicoption.WithMaxRetries(0))
	}
	t.Fatalf("provider %q has no test constructor — add one when you add the backend", p)
	return nil
}

// aRequest is a valid request, so nothing is rejected by `validate` before the
// transport is reached. That would make every case below pass for the wrong
// reason.
func aRequest() Request {
	return Request{
		System:     "you are a test",
		Prompt:     "hello",
		Schema:     map[string]any{"type": "object", "properties": map[string]any{}, "required": []string{}, "additionalProperties": false},
		SchemaName: "test",
		MaxTokens:  16,
	}
}

// A REAL refused connection. Nothing is listening; the dialer really fails.
func TestEveryProviderReportsAClosedPortAsUnreachable(t *testing.T) {
	for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
		t.Run(string(p), func(t *testing.T) {
			c := completerAt(t, p, closedPort(t))

			_, err := c.Complete(context.Background(), aRequest())

			if err == nil {
				t.Fatal("a call to a closed port succeeded")
			}
			if !errors.Is(err, ErrUnreachable) {
				t.Fatalf("connection refused reported as %v, not ErrUnreachable — "+
					"the athlete is charged a daily estimate for our provider being down (F16)", err)
			}
			// The whole point of the third sentinel: a caller that meters on
			// ErrUnavailable must not see one here.
			if errors.Is(err, ErrUnavailable) {
				t.Error("ErrUnreachable also satisfies ErrUnavailable, so every caller " +
					"metering on ErrUnavailable still charges for an outage")
			}
			if errors.Is(err, ErrRefused) {
				t.Error("an outage reported as a refusal — the client would be told to reword its input")
			}
		})
	}
}

// A REAL resolver failure. `.invalid` is reserved by RFC 2606 and can never be
// delegated, so this is a name that is guaranteed not to resolve rather than
// one that happens not to today.
func TestEveryProviderReportsAnUnresolvableHostAsUnreachable(t *testing.T) {
	for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
		t.Run(string(p), func(t *testing.T) {
			c := completerAt(t, p, "http://f16-provider-outage.invalid")

			_, err := c.Complete(context.Background(), aRequest())

			if err == nil {
				t.Fatal("a call to an unresolvable host succeeded")
			}
			// Guard against the apparatus rather than the code: a resolver that
			// times out instead of answering NXDOMAIN produces a DEADLINE, which
			// this package deliberately does not treat as unreachable. Without
			// this check such an environment would fail the assertion below and
			// read as a regression in the classifier.
			if errors.Is(err, context.DeadlineExceeded) {
				t.Skipf("the resolver timed out rather than failing (%v); this environment "+
					"cannot exercise the DNS case", err)
			}
			if !errors.Is(err, ErrUnreachable) {
				t.Fatalf("a DNS failure reported as %v, not ErrUnreachable (F16)", err)
			}
		})
	}
}

// An HTTP error status. Real HTTP and the real SDK; only the status is chosen
// here — see this file's header for what that does and does not prove.
func TestEveryProviderReportsAnAPIErrorStatusAsUnreachable(t *testing.T) {
	// One body per provider, in each one's documented error envelope, because
	// the OpenAI SDK unwraps `.error` from the body before building its `*Error`
	// and a body it cannot read yields a JSON error instead. A shape-free body
	// would make this test pass down a different path than production takes.
	bodies := map[Provider]string{
		ProviderOpenAI: `{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}`,
		ProviderAnthropic: `{"type":"error","error":{"type":"authentication_error",` +
			`"message":"invalid x-api-key"}}`,
	}
	for _, status := range []int{
		http.StatusUnauthorized,        // the revoked key from the issue
		http.StatusTooManyRequests,     // the provider's own rate limit
		http.StatusServiceUnavailable,  // the outage shape
		http.StatusInternalServerError, // the other outage shape
	} {
		for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
			t.Run(http.StatusText(status)+"/"+string(p), func(t *testing.T) {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(status)
					w.Write([]byte(bodies[p]))
				}))
				t.Cleanup(srv.Close)

				_, err := completerAt(t, p, srv.URL).Complete(context.Background(), aRequest())

				if err == nil {
					t.Fatalf("HTTP %d came back as a success", status)
				}
				if !errors.Is(err, ErrUnreachable) {
					t.Fatalf("HTTP %d reported as %v, not ErrUnreachable — no completion "+
						"exists on an error status, so metering it charges for nothing (F16)", status, err)
				}
				// The status must not leak the provider's body, which on a 4xx
				// is the response most likely to quote our prompt back.
				for _, leaked := range []string{"api-key", "API key", "invalid_api_key"} {
					if strings.Contains(err.Error(), leaked) {
						t.Errorf("the error text carries upstream body content (%q): %v", leaked, err)
					}
				}
			})
		}
	}
}

// The other half of the line, and the one that keeps the meter honest: a
// response that ARRIVED is still metered even though it was useless, because
// the model answered and we were billed.
func TestAnAnsweredButUselessResponseIsUnavailableNotUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"c","object":"chat.completion","created":1,` +
			`"model":"test-model","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":0}}`))
	}))
	t.Cleanup(srv.Close)

	_, err := completerAt(t, ProviderOpenAI, srv.URL).Complete(context.Background(), aRequest())

	if err == nil {
		t.Fatal("a 200 with no choices came back as a success")
	}
	if errors.Is(err, ErrUnreachable) {
		t.Fatal("a billed HTTP 200 classified as unreachable — that stops metering a call " +
			"the provider charged us for, which is the loop F16's fix must not reopen")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("want ErrUnavailable, got %v", err)
	}
}

// A cancelled call must keep costing the caller.
//
// This is the guard on the sharpest way to get F16's fix wrong, and there are
// two independent reasons it matters. Correctness: the caller may well have
// been billed in full — the model answered, nobody stayed to read it — which is
// the loop `context.WithoutCancel` on both Record calls was added to close.
// And adversarially: **a free cancellation is a free bypass of the entire
// quota** — fire, cancel at 50ms, repeat, and the row count never moves while
// the provider bills us for every one.
//
// See ErrUnreachable for the asymmetry this knowingly accepts: a genuine
// network timeout that never reached the provider is metered too, because by
// the time a deadline fires the two are indistinguishable.
func TestACancelledCallIsNotUnreachable(t *testing.T) {
	for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
		t.Run(string(p), func(t *testing.T) {
			started := make(chan struct{})
			// `release` rather than the request's own context, and the ordering
			// below is why. `httptest.Server.Close` blocks until every handler
			// has returned; a handler parked on `r.Context().Done()` returns
			// only once the server notices the client is gone, which it does
			// not reliably do for a request it has never written a byte of.
			// The first version of this test deadlocked exactly there and had
			// to be killed by the -timeout, which is a hang rather than a
			// result.
			release := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				// Hold the request open with no response, so the cancellation
				// lands while the call is genuinely in flight — which is when a
				// real athlete's phone would drop it.
				<-release
			}))
			// LIFO: registered second, so `close(release)` runs FIRST and the
			// handler is already unblocked by the time Close waits on it.
			t.Cleanup(srv.Close)
			t.Cleanup(func() { close(release) })

			ctx, cancel := context.WithCancel(context.Background())
			go func() {
				<-started
				cancel()
			}()

			_, err := completerAt(t, p, srv.URL).Complete(ctx, aRequest())

			if err == nil {
				t.Fatal("a cancelled call succeeded")
			}
			// Two apparatus checks, because without them the assertion below
			// passes for any failure at all.
			//
			// `errors.Is(err, context.Canceled)` is deliberately NOT one of
			// them: this package joins the upstream error with `%v` rather than
			// `%w`, on purpose — a raw SDK error must not stay reachable
			// through a chain a caller might unwrap and forward. So the
			// cancellation survives as text, and text is what there is to
			// check.
			if ctx.Err() != context.Canceled {
				t.Fatalf("the context was not cancelled (%v) — nothing here exercised cancellation", ctx.Err())
			}
			if !strings.Contains(err.Error(), "context canceled") {
				t.Fatalf("the call failed for some other reason (%v) — this test did not "+
					"exercise cancellation", err)
			}
			if errors.Is(err, ErrUnreachable) {
				t.Fatal("a cancelled call classified as unreachable — a caller can now spend " +
					"our tokens for free by hanging up in a loop")
			}
			// Positively, so "not unreachable" cannot be satisfied by some
			// third unmapped thing escaping the package.
			if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("a cancelled call is %v, which is neither sentinel — it reaches the "+
					"caller's default arm carrying SDK text", err)
			}
		})
	}
}

// The context check inside `neverReachedProvider` has to come BEFORE the
// `*url.Error` check, and this test exists because that ordering is currently
// REDUNDANT in practice.
//
// Measured above: both SDKs return `ctx.Err()` bare on a cancellation, so
// today the `*url.Error` arm is never reached for one and the ordering makes
// no observable difference. That is precisely the shape CLAUDE.md warns about
// — a guard whose outcome is redundant reads as dead code, and "the tests pass
// without it" is a persuasive argument for deleting something load-bearing.
// `http.Client.Do` wraps a mid-flight cancellation in `*url.Error` in other
// paths, and the day one of those reaches here, deleting the ordering silently
// stops metering every cancelled call — handing back the
// spend-somebody-else's-money loop that `context.WithoutCancel` was added to
// both Record calls to close.
//
// So the input is constructed rather than observed: this pins the classifier's
// rule, not the SDK's current behaviour, and it is honest about which it is.
func TestACancellationWrappedInAURLErrorIsStillNotUnreachable(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "a cancellation wrapped as a url.Error is NOT unreachable",
			err:  &url.Error{Op: "Post", URL: "https://api.example", Err: context.Canceled},
		},
		{
			name: "a deadline wrapped as a url.Error is NOT unreachable",
			err:  &url.Error{Op: "Post", URL: "https://api.example", Err: context.DeadlineExceeded},
		},
		{
			name: "a genuine dial failure IS unreachable",
			err:  &url.Error{Op: "Post", URL: "https://api.example", Err: errors.New("connect: connection refused")},
			want: true,
		},
		{
			// A 200 whose body could not be read: the model answered and we
			// were billed, so this must keep costing the caller.
			name: "a post-response failure is NOT unreachable",
			err:  errors.New("error reading response body: unexpected EOF"),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := neverReachedProvider(tc.err); got != tc.want {
				t.Fatalf("neverReachedProvider(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// The three sentinels have to stay distinct, or a caller's switch silently
// takes the wrong arm.
func TestTheThreeSentinelsAreDistinct(t *testing.T) {
	for _, pair := range []struct {
		name     string
		a, b     error
		wantSame bool
	}{
		{name: "unreachable is not refused", a: ErrUnreachable, b: ErrRefused},
		{name: "unreachable is not unavailable", a: ErrUnreachable, b: ErrUnavailable},
		{name: "refused is not unavailable", a: ErrRefused, b: ErrUnavailable},
	} {
		t.Run(pair.name, func(t *testing.T) {
			if errors.Is(pair.a, pair.b) || errors.Is(pair.b, pair.a) {
				t.Fatalf("%v and %v are not distinguishable by errors.Is", pair.a, pair.b)
			}
		})
	}
}

// A config error must still not wear a transport sentinel — the existing rule
// in provider_test.go, restated against the new one so it cannot be forgotten.
func TestAnImpossibleRequestIsNotReportedAsUnreachable(t *testing.T) {
	for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
		t.Run(string(p), func(t *testing.T) {
			req := aRequest()
			req.MaxTokens = 0
			_, err := completerAt(t, p, closedPort(t)).Complete(context.Background(), req)
			if err == nil {
				t.Fatal("MaxTokens=0 was accepted")
			}
			if errors.Is(err, ErrUnreachable) {
				t.Fatal("a config error reported as an outage — it would stop being metered " +
					"and stop being visible as the deploy problem it is")
			}
		})
	}
}

// A 5xx whose body is NOT the provider's JSON error envelope — HTML from a CDN,
// an empty body, plain text from a load balancer.
//
// # Why this test exists, and what it is really pinning
//
// This is the sharpest gap in the discriminator argument. It was found by
// review and then MEASURED rather than reasoned about. Both SDKs, on a status
// >= 400, read the body and hand it to their own unmarshaller — and **return
// the raw unmarshal error instead of their typed `*Error` if that fails**
// (`requestconfig.go`: `err = aerr.UnmarshalJSON(...); if err != nil { return
// err }`). A raw unmarshal error is neither an SDK `*Error` nor a `*url.Error`,
// so it would fall through `callFailure` to ErrUnavailable and **be metered**.
//
// That matters because **a real outage rarely answers with the provider's own
// JSON.** It answers with whatever the CDN or load balancer in front of them
// emits: an HTML 503 page, an empty body, `no healthy upstream`. So the exact
// shape F16 exists for is the shape most likely to miss the typed-error path.
//
// Measured: it does not miss it. Both SDKs' `apijson` decoder is lenient and
// does not error on garbage, so the typed `*Error` still comes back with its
// `StatusCode` set, and the classification holds.
//
// **So the classification rests on a third-party decoder's leniency, and
// nothing else in this repo would notice losing it.** An SDK bump that made
// that decoder strict would silently start metering every CDN-fronted outage
// again — no compile error, nothing else going red, and the symptom would be
// athletes quietly losing their allowance during exactly the incidents this
// change exists for. Hence a test on the property rather than a comment about
// it.
func TestAnOutageBodyThatIsNotTheProvidersJSONIsStillUnreachable(t *testing.T) {
	for _, body := range []struct {
		name        string
		contentType string
		payload     string
	}{
		{
			name: "an HTML page from a CDN", contentType: "text/html",
			payload: "<html><head><title>503 Service Unavailable</title></head>" +
				"<body><h1>503 Service Unavailable</h1></body></html>",
		},
		{name: "an empty body", contentType: "text/plain", payload: ""},
		{
			name: "plain text from a load balancer", contentType: "text/plain",
			payload: "no healthy upstream",
		},
		{
			name: "JSON with no error envelope", contentType: "application/json",
			payload: `{"message":"upstream connect error"}`,
		},
	} {
		for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
			t.Run(body.name+"/"+string(p), func(t *testing.T) {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", body.contentType)
					w.WriteHeader(http.StatusServiceUnavailable)
					w.Write([]byte(body.payload))
				}))
				t.Cleanup(srv.Close)

				_, err := completerAt(t, p, srv.URL).Complete(context.Background(), aRequest())

				if err == nil {
					t.Fatal("a 503 came back as a success")
				}
				if !errors.Is(err, ErrUnreachable) {
					t.Fatalf("a 503 carrying %s reported as %v, not ErrUnreachable — an "+
						"outage fronted by a CDN would be metered, which is the exact case "+
						"F16 exists for (%s)", body.name, err, p)
				}
			})
		}
	}
}
