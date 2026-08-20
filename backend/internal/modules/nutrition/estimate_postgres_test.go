package nutrition

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// usageFor builds a metering repository and cleans up after itself.
//
// Its own cleanup rather than reusing repoFor's, because that one deletes the
// food-log tables and this table is not among them — an estimate row left
// behind would inflate the next run's quota count and fail a boundary test
// for reasons nothing in that test could explain.
func usageFor(t *testing.T, userIDs ...string) *PostgresEstimateUsage {
	t.Helper()
	pool := testPool(t)
	t.Cleanup(func() {
		for _, u := range userIDs {
			if _, err := pool.Exec(context.Background(),
				`DELETE FROM nutrition_estimates WHERE user_id = $1`, u); err != nil {
				t.Errorf("cleanup %s: %v", u, err)
			}
		}
	})
	return NewPostgresEstimateUsage(pool)
}

func TestQuotaCountsOnlyTheCallerAndOnlyTheirPath(t *testing.T) {
	// TWO USERS AND BOTH PATHS, because a single-user single-path test passes
	// against three different bugs: a missing user_id filter, a missing source
	// filter, and both at once. Each would only show as somebody else's
	// spending counting against this athlete's cap.
	usage := usageFor(t, "est_a", "est_b")
	ctx := context.Background()
	now := time.Now()

	for i := 0; i < 3; i++ {
		mustRecord(t, usage, EstimateRecord{UserID: "est_a", Source: SourceText, Succeeded: true})
	}
	mustRecord(t, usage, EstimateRecord{UserID: "est_a", Source: SourcePhoto, Succeeded: true})
	// Another athlete, hammering both paths.
	for i := 0; i < 9; i++ {
		mustRecord(t, usage, EstimateRecord{UserID: "est_b", Source: SourceText, Succeeded: true})
		mustRecord(t, usage, EstimateRecord{UserID: "est_b", Source: SourcePhoto, Succeeded: true})
	}

	// BOTH paths count toward one budget now: 3 text + 1 photo = 4. The other
	// athlete's 18 calls must not appear.
	q, err := usage.Quota(ctx, "est_a", now)
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 4 {
		t.Fatalf("used = %d, want 4 (3 text + 1 photo) — either another athlete's calls are counting, or a source filter survived the move to one budget", q.Used)
	}
	if q.Limit != DailyEstimates {
		t.Fatalf("limit = %d, want %d", q.Limit, DailyEstimates)
	}
}

func TestFailedCallsCountTowardTheQuota(t *testing.T) {
	// They cost tokens. A meter that counted only successes would let a caller
	// loop on input the model keeps declining and pay for every attempt —
	// which is the exact scenario the quota exists to bound.
	usage := usageFor(t, "est_fail")
	ctx := context.Background()

	mustRecord(t, usage, EstimateRecord{UserID: "est_fail", Source: SourceText, Succeeded: false})
	mustRecord(t, usage, EstimateRecord{UserID: "est_fail", Source: SourceText, Succeeded: false})

	q, err := usage.Quota(ctx, "est_fail", time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 2 {
		t.Fatalf("used = %d, want 2 — failures are not being counted", q.Used)
	}
}

func TestCallsOlderThanTheWindowStopCounting(t *testing.T) {
	// The window is rolling, so this is asserted by moving `now` rather than
	// by waiting a day — which is the whole reason `now` is a parameter.
	usage := usageFor(t, "est_window")
	ctx := context.Background()

	mustRecord(t, usage, EstimateRecord{UserID: "est_window", Source: SourceText, Succeeded: true})

	inWindow, err := usage.Quota(ctx, "est_window", time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if inWindow.Used != 1 {
		t.Fatalf("used = %d just after recording, want 1", inWindow.Used)
	}

	later := time.Now().Add(QuotaWindow + time.Hour)
	aged, err := usage.Quota(ctx, "est_window", later)
	if err != nil {
		t.Fatalf("quota later: %v", err)
	}
	if aged.Used != 0 {
		t.Fatalf("used = %d a day later, want 0 — the window is not rolling off", aged.Used)
	}
	if aged.ResetsAt != nil {
		t.Fatal("resets_at set with an empty window")
	}
}

func TestTheGateRefusesAtTheLimitAndReportsWhy(t *testing.T) {
	usage := usageFor(t, "est_cap")
	ctx := context.Background()
	now := time.Now()

	// Filled with a MIX, because one budget means the mix is what exhausts it.
	// Filling it with photos alone would pass against an implementation that
	// still counted per source.
	for i := 0; i < DailyEstimates; i++ {
		src := SourcePhoto
		if i%2 == 0 {
			src = SourceText
		}
		mustRecord(t, usage, EstimateRecord{UserID: "est_cap", Source: src, Succeeded: true})
	}

	q, err := CheckQuota(ctx, usage, "est_cap", now)
	if err == nil {
		t.Fatal("allowed a call at the cap")
	}
	// The quota is returned ALONGSIDE the error so the handler can say when
	// one more becomes available rather than only that the answer is no.
	if q.ResetsAt == nil {
		t.Fatal("no resets_at on an exhausted quota — the client cannot say when to try again")
	}
	// **The reversal, asserted.** Under the old split the text path would
	// still have been open here; under one budget it is not, and an athlete
	// must not be told otherwise.
	if _, err := CheckQuota(ctx, usage, "est_cap", now); err == nil {
		t.Fatal("a second path was allowed past an exhausted combined budget")
	}
}

// **The loop the header exists for: exhaust the quota, read `Retry-After`, wait
// exactly that long, retry — and be ADMITTED rather than refused a second
// time.** (F15.)
//
// The table beside `retryAfterSeconds` pins the arithmetic; this pins what the
// arithmetic is FOR, against the real `created_at > since` window executed by
// Postgres rather than against a restatement of it in Go. Nothing here derives
// its expectation from the function under test.
//
// Nothing sleeps, either. Both the handler's clock and the quota's `now` are
// parameters, so "the client waited N seconds" is expressed by moving `now`
// forward by N — which is also the only way to test a 24-hour window at all.
func TestObeyingRetryAfterExactlyIsAdmitted(t *testing.T) {
	const userID = "est_retry_after"
	usage := usageFor(t, userID)
	ctx := context.Background()

	for i := 0; i < DailyEstimates; i++ {
		mustRecord(t, usage, EstimateRecord{UserID: userID, Source: SourceText, Succeeded: true})
	}

	// The reset instant comes from the DATABASE — `MIN(created_at)` plus the
	// window — so the remainder constructed below straddles the real row that
	// has to age out, not a timestamp this test invented.
	seed, err := usage.Quota(ctx, userID, time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if seed.ResetsAt == nil {
		t.Fatal("no resets_at at the cap — nothing to advertise")
	}

	// **A FRACTIONAL remainder is the only input that discriminates.** 1.5
	// seconds floors to 1 and ceils to 2; at any whole number of seconds the
	// two roundings agree and this test would pass against the exact bug it
	// exists to catch.
	const remainder = 1500 * time.Millisecond
	// Asserted rather than trusted to the comment above. The apparatus check
	// further down catches this constant drifting DOWN to a whole second, but
	// not up: at 2.0s exactly, truncation and the ceiling agree and every
	// assertion below passes against the bug. This is the guard for that half.
	if remainder%time.Second == 0 {
		t.Fatalf("remainder %s is a whole number of seconds — flooring and ceiling agree there, so this test no longer discriminates", remainder)
	}
	now := seed.ResetsAt.Add(-remainder)

	h := NewEstimateHandler(&fakeEstimator{out: goodEstimate()}, usage)
	h.now = func() time.Time { return now }

	w := callAs(t, h, userID, `{"description":"two eggs"}`)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d at the cap, want 429", w.Code)
	}
	advertised, err := strconv.Atoi(w.Header().Get("Retry-After"))
	if err != nil {
		t.Fatalf("Retry-After = %q, want a whole number of seconds: %v", w.Header().Get("Retry-After"), err)
	}
	if advertised != 2 {
		t.Fatalf("Retry-After = %d with %s left in the window, want 2 — the ceiling, not the floor", advertised, remainder)
	}

	// **Apparatus check, and it has to come first.** One second is what the
	// truncating version advertised, and it must still be refused. If this ever
	// starts passing, the remainder has lost its fractional part and the
	// assertion below has stopped straddling the boundary — at which point it
	// would go green against truncation and prove nothing.
	h.now = func() time.Time { return now.Add(time.Second) }
	if short := callAs(t, h, userID, `{"description":"two eggs"}`); short.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d one second short of the reset, want 429 — this test is no longer on the boundary", short.Code)
	}

	// The claim: the athlete waited exactly as long as they were told to.
	h.now = func() time.Time { return now.Add(time.Duration(advertised) * time.Second) }
	if obeyed := callAs(t, h, userID, `{"description":"two eggs"}`); obeyed.Code != http.StatusOK {
		t.Fatalf("status %d after waiting the advertised %ds, want 200 — the header sent a well-behaved client straight back into a refusal: %s",
			obeyed.Code, advertised, obeyed.Body.String())
	}
}

func mustRecord(t *testing.T, usage *PostgresEstimateUsage, rec EstimateRecord) {
	t.Helper()
	if err := usage.Record(context.Background(), rec); err != nil {
		t.Fatalf("record: %v", err)
	}
}

// **NULL is not zero, and here the difference decides whether the re-tune is
// honest.**
//
// A call that never reached the provider spent nothing and must record NULL. A
// `DEFAULT 0` — or writing 0 from Go — would put confident zeros into the exact
// dataset the caps are about to be derived from, dragging any average cost
// toward zero precisely as it is used to justify a new number. Same rule this
// schema already applies to `nutrition_foods.fibre_g`: an unstated figure is
// not a claim of none.
func TestUsageIsNullWhenNoCallReachedTheProvider(t *testing.T) {
	const userID = "est_usage_null"
	repo := usageFor(t, userID)
	ctx := context.Background()

	if err := repo.Record(ctx, EstimateRecord{
		UserID: userID, Source: SourceText, Succeeded: false,
		// Zero Usage — validation rejected the input before any call.
	}); err != nil {
		t.Fatal(err)
	}

	var in, out, img *int64
	err := repo.pool.QueryRow(ctx, `
		SELECT input_tokens, output_tokens, image_tokens
		FROM nutrition_estimates WHERE user_id = $1`, userID).Scan(&in, &out, &img)
	if err != nil {
		t.Fatal(err)
	}
	if in != nil || out != nil || img != nil {
		t.Fatalf("unmetered call recorded in=%v out=%v image=%v, want all NULL — a zero here reads as 'this call was free'", in, out, img)
	}
}

func TestUsageIsPersistedWhenTheProviderAnswered(t *testing.T) {
	const userID = "est_usage_stored"
	repo := usageFor(t, userID)
	ctx := context.Background()

	if err := repo.Record(ctx, EstimateRecord{
		UserID: userID, Source: SourcePhoto, Succeeded: true, Model: "gpt-5.6-luna",
		Usage: Usage{
			InputTokens: 1837, OutputTokens: 726,
			CachedInputTokens: 1334, ReasoningTokens: 448, ImageTokens: int64Ptr(500),
		},
	}); err != nil {
		t.Fatal(err)
	}

	var in, out, cached, reasoning, img int64
	err := repo.pool.QueryRow(ctx, `
		SELECT input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, image_tokens
		FROM nutrition_estimates WHERE user_id = $1`, userID).
		Scan(&in, &out, &cached, &reasoning, &img)
	if err != nil {
		t.Fatal(err)
	}
	if in != 1837 || out != 726 || cached != 1334 || reasoning != 448 || img != 500 {
		t.Fatalf("stored in=%d out=%d cached=%d reasoning=%d image=%d — want the measured figures", in, out, cached, reasoning, img)
	}
}

// A provider that does not break the image out (Anthropic) must record NULL
// rather than 0 for it, or "not reported" becomes "the image was free" — and
// the photo-vs-text ratio is the one number this whole task turns on.
func TestUnreportedImageTokensAreNullNotZero(t *testing.T) {
	const userID = "est_usage_noimage"
	repo := usageFor(t, userID)
	ctx := context.Background()

	if err := repo.Record(ctx, EstimateRecord{
		UserID: userID, Source: SourcePhoto, Succeeded: true,
		// A real Anthropic photo call: input and output measured, no image
		// breakdown available.
		Usage: Usage{InputTokens: 1837, OutputTokens: 726},
	}); err != nil {
		t.Fatal(err)
	}

	var img *int64
	var in int64
	if err := repo.pool.QueryRow(ctx,
		`SELECT image_tokens, input_tokens FROM nutrition_estimates WHERE user_id = $1`,
		userID).Scan(&img, &in); err != nil {
		t.Fatal(err)
	}
	if img != nil {
		t.Fatalf("image_tokens = %d, want NULL — the provider did not report a breakdown, which is not the same as a free image", *img)
	}
	if in != 1837 {
		t.Fatalf("input_tokens = %d — the rest of the usage must still be recorded", in)
	}
}
