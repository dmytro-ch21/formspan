package apihttp

import (
	"io"
	"net/http"
	"time"
)

// The status an upload gets told about, and the 256 KiB cliff that used to eat it.
//
// # What was measured (2026-08-26, live against staging)
//
// `POST /v1/nutrition/estimate` with a multipart body, unauthenticated so the
// server answers 401 before reading a byte of it:
//
//	200 KB body -> 401 received, upload completed  (size_upload 205003)
//	240 KB body -> 401 received, upload completed  (size_upload 245963)
//	250 KB body -> 401 received, upload completed  (size_upload 256203)
//	256 KB body -> curl exit 92, upload cut at     262347
//	260 KB body -> curl exit 92, upload cut at     261898
//	512 KB body -> curl exit 92, upload cut at     261898
//
// A sharp cliff at 262144 bytes, which is `net/http`'s own
// `maxPostHandlerReadBytes`: when a handler returns having left the request
// body unread, the server drains up to 256 KiB to keep the connection usable
// and, past that, gives up and closes. The response has been written by then —
// but a client that is *still uploading* has its connection torn out from
// under it, and what it surfaces is a transport failure, not the status.
//
// # Why that matters here rather than being a curiosity
//
// This is the failure N92 (#433) has been reported for three times. The phone
// classifies a dead request by asking `/v1/healthz` whether VOLA is reachable
// (`apps/mobile/lib/authedFetch.ts`); the probe is a tiny GET, so it sails
// through, and the app correctly concludes *the route is fine and this request
// died* — `RequestDroppedError`, rendered as **"That didn't get through."**
// That is exactly the sentence the athlete reported.
//
// So every promise #433 makes about copy is void above 256 KiB on the photo
// path. The 503 that must read as "not switched on yet" and the 429 that must
// name its reset are both *written correctly by the server and never received*.
// `estimateCopy.test.ts` asserts the wording and cannot see this, because the
// status never arrives to be worded.
//
// A 1080px JPEG at quality 0.8 — what `food/describe.tsx` uploads — straddles
// this line, and that is measured rather than asserted. Encoding two synthetic
// extremes at exactly the client's settings (1080x1440, quality 80):
//
//	plate, smooth and blurred     39,328 bytes   0.15x the cliff   under
//	label, dense small text      324,701 bytes   1.24x the cliff   over
//
// An 8.3x spread from content alone. Synthetic images bracket the range rather
// than predict any particular photo — but the direction is not in doubt, and it
// matches the report exactly: the athlete's PLATE photos work and their LABEL
// photos do not, on one phone, one network, one code path.
//
// **That asymmetry is itself the evidence that something answers early**, which
// is worth spelling out because it is the load-bearing inference here. Walk the
// path and ask what is sensitive to body size at all:
//
//   - the client's 45s deadline — would raise `TimeoutError` ("VOLA took too
//     long to answer"), a different sentence from the one reported;
//   - `MaxImageBytes` (5 MB) and `maxEstimateBody` (8 MB) — both far above
//     either figure, and both refuse AFTER the body has been read, so their 400
//     is delivered cleanly;
//   - this cliff.
//
// Only the third produces a dead request with no status, and only above 256 KiB.
// So a photo path that works small and fails large says the server is answering
// before it reads the body. **It does not say which status** — that is the part
// still not established, and `health.recordRejectionsOn` exists to capture it
// the next time it happens.
//
// # The fix, and its bounds
//
// Read whatever the handler left behind before the server gets to decide
// whether to close. Draining costs almost nothing: the bytes are already in
// flight, the client has already paid to send them, and they go to
// io.Discard. It is what `net/http` is already trying to do — this only
// removes the 256 KiB ceiling on trying.
//
// Two bounds, because an unbounded drain is a way to be held open:
//
//   - **maxDrainBytes** caps what will be read. Routes that accept an upload
//     already wrap their body in `http.MaxBytesReader`, which stops well below
//     this; the cap is for routes that do not.
//
//   - **drainDeadline** caps how long. There is no `ReadTimeout` on this
//     server, so without it a client that sends its body one byte per minute
//     would hold the goroutine for as long as it liked.
//
//     **This bound was a silent no-op when first written, and that is worth
//     keeping rather than quietly fixing.** `http.NewResponseController` walks
//     `Unwrap() http.ResponseWriter`, and `httplog.statusRecorder` embedded the
//     interface without implementing that method — so `SetReadDeadline`
//     returned `feature not supported` for every request in production.
//     Measured, not reasoned about: nil on a bare handler, "feature not
//     supported" through the real middleware chain. Nothing would ever have
//     reported it, because the refusal is a RETURN VALUE and the call below
//     discards it on purpose. `httplog` grew the `Unwrap` and a test that goes
//     red without it; the discard here stays, because a `httptest.Recorder` in
//     a unit test legitimately cannot set a deadline and failing the drain over
//     it would be worse than the drain being unbounded in a test.
//
// Neither bound needs to be generous. Failing to finish the drain leaves
// exactly the behaviour that exists today — the connection closes — so the
// worst case of a bound being too tight is the bug, not a new one.
const (
	// Large enough for the biggest body any route accepts (nutrition's
	// `maxEstimateBody`, 8 MB), so a legitimate upload is always fully drained
	// and always gets its status.
	maxDrainBytes = 8 << 20
	// Long enough for that body over gym wifi, short enough not to be a
	// parking space.
	drainDeadline = 10 * time.Second
)

// DrainRequestBody reads any unread request body once the handler is done, so
// the response the handler already wrote can actually reach a client that is
// still uploading. See the block comment above for the measurement.
//
// A no-op for the overwhelming majority of requests: a GET has no body, and a
// handler that read its body leaves nothing behind. It earns its place only on
// the path where a request is refused before its body was wanted — which is
// every 401, every 429 from the rate limiter, and every 400 from a parse that
// gave up on the first byte.
func DrainRequestBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Sequential, NOT deferred, and the difference is a wasted 8 MB read.
		//
		// The first draft deferred this so it would run on a panic too,
		// reasoning that a panic should not "poison the connection". That
		// rationale is simply wrong: `net/http` recovers a handler panic and
		// closes the connection regardless, so draining there reads up to the
		// cap off a socket that is about to be discarded. Corrected in review.
		//
		// A panic therefore skips the drain, which costs nothing — the
		// connection was never going to be reused.
		next.ServeHTTP(w, r)
		drain(w, r)
	})
}

func drain(w http.ResponseWriter, r *http.Request) {
	if r.Body == nil || r.Method == http.MethodGet || r.Method == http.MethodHead {
		return
	}
	// Best-effort, and the error is discarded on purpose: a `httptest`
	// recorder genuinely cannot set a deadline, and failing a drain over that
	// would break every unit test that exercises this stack. The cost of the
	// discard is that a wrapper without `Unwrap` disables the bound in silence
	// — which is exactly what happened — so the guarantee lives in
	// `TestTheDrainsDeadlineSurvivesTheProductionMiddlewareStack` instead,
	// which asserts through the assembly `cmd/api` actually builds.
	//
	// `http.NewResponseController` never returns nil, so there is no nil check
	// here; the first draft had one and it was dead code.
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(drainDeadline))
	// Errors are the normal case and are deliberately discarded: a body past
	// its route's own MaxBytesReader returns one on every read, which is
	// precisely the "stop here" this wants. What matters is that we tried
	// before net/http decided to close.
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, maxDrainBytes))
}
