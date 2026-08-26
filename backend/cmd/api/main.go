package main

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	// The history endpoint resolves the caller's IANA timezone to bucket
	// sessions into calendar days. The runtime image is alpine with only
	// ca-certificates — no tzdata — so without this every request naming a
	// real zone would fail to load it and 400. Embedding costs ~450KB and
	// survives a future base-image change; `apk add tzdata` would not.
	_ "time/tzdata"

	"github.com/dmytro-ch21/vola/backend/internal/modules/accomplishment"
	"github.com/dmytro-ch21/vola/backend/internal/modules/activity"
	"github.com/dmytro-ch21/vola/backend/internal/modules/bjj"
	"github.com/dmytro-ch21/vola/backend/internal/modules/body"
	"github.com/dmytro-ch21/vola/backend/internal/modules/contest"
	"github.com/dmytro-ch21/vola/backend/internal/modules/curriculum"
	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/dmytro-ch21/vola/backend/internal/modules/featureflag"
	"github.com/dmytro-ch21/vola/backend/internal/modules/feed"
	"github.com/dmytro-ch21/vola/backend/internal/modules/food"
	"github.com/dmytro-ch21/vola/backend/internal/modules/friend"
	"github.com/dmytro-ch21/vola/backend/internal/modules/health"
	"github.com/dmytro-ch21/vola/backend/internal/modules/notification"
	"github.com/dmytro-ch21/vola/backend/internal/modules/nutrition"
	"github.com/dmytro-ch21/vola/backend/internal/modules/plan"
	"github.com/dmytro-ch21/vola/backend/internal/modules/profile"
	"github.com/dmytro-ch21/vola/backend/internal/modules/sequence"
	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
	"github.com/dmytro-ch21/vola/backend/internal/modules/sessioncard"
	"github.com/dmytro-ch21/vola/backend/internal/modules/share"
	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
	"github.com/dmytro-ch21/vola/backend/internal/modules/theme"
	"github.com/dmytro-ch21/vola/backend/internal/modules/tracker"
	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
	"github.com/dmytro-ch21/vola/backend/internal/platform/objectstore"
	"github.com/dmytro-ch21/vola/backend/internal/platform/ratelimit"
)

func main() {
	logger := httplog.New()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	clerkIssuer := os.Getenv("CLERK_ISSUER")
	if clerkIssuer == "" {
		logger.Error("CLERK_ISSUER must be set (see backend/.env.example)")
		os.Exit(1)
	}
	adminUserIDs := strings.Split(os.Getenv("ADMIN_USER_IDS"), ",")
	verifier, err := auth.NewVerifier(context.Background(), clerkIssuer, adminUserIDs)
	if err != nil {
		logger.Error("auth: init verifier", "err", err)
		os.Exit(1)
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		logger.Error("DATABASE_URL must be set (see backend/.env.example)")
		os.Exit(1)
	}
	pool, err := database.NewPool(context.Background(), databaseURL)
	if err != nil {
		logger.Error("database: connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	profileHandler := profile.NewHandler(profile.NewPostgresRepository(pool))
	bjjRepo := bjj.NewPostgresRepository(pool)
	bjjHandler := bjj.NewHandler(bjjRepo)
	bjjSessionHandler := bjj.NewSessionHandler(bjjRepo)
	bjjProficiencyHandler := bjj.NewProficiencyHandler(bjjRepo)
	bjjPositionHandler := bjj.NewPositionHandler(bjjRepo)
	bjjFocusHandler := bjj.NewFocusHandler(bjjRepo)
	accomplishmentHandler := accomplishment.NewHandler(accomplishment.NewPostgresRepository(pool))
	contestHandler := contest.NewHandler(contest.NewPostgresRepository(pool))
	curriculumHandler := curriculum.NewHandler(curriculum.NewPostgresRepository(pool))
	// RATE LIMITS. Six features shipped recording "no rate limiting" as a
	// residual; this is that, once, in the platform layer.
	//
	// The DEFAULT budget hangs off the verifier, so every authenticated route
	// carries it without any route saying so — see UseLimiter for why that
	// placement rather than sixty explicit call sites.
	//
	// The numbers are an opening position, not a measurement. They are picked
	// against two known shapes: the mobile outbox pushes one request per
	// pending row with no batching, so a week offline is a long burst of
	// legitimate writes; and /v1/notifications is polled on every client
	// navigation. Burst 120 covers both outright, then 2/second sustained.
	// Every rejection is logged with its policy name, which is the only way
	// these get tuned from evidence rather than from another guess.
	defaultLimiter := ratelimit.New(ratelimit.Policy{
		Name: "default", Burst: 120, Every: 500 * time.Millisecond,
	}, nil)
	verifier.UseLimiter(defaultLimiter, ratelimit.Reject)

	// One entry per athlete who has ever called the API, held for the life of
	// the process, is a slow leak — bounded by real accounts rather than by
	// anything an attacker picks, but a ceiling of "everyone we ever had" is
	// still a ceiling worth not having. Sweeping drops only FULL buckets, so
	// it can never hand somebody a fresh burst by forgetting them.

	// Tighter budgets for the two writes that put something in ANOTHER
	// person's inbox — the abuse the residuals kept naming. A friend request
	// survives a decline being a delete, so re-sending is unbounded by
	// design; a share is unbounded once the resource differs.
	//
	// Sized against real use rather than against the attack: an athlete sends
	// a handful of friend requests ever, and sharing one sequence to a squad
	// of fifteen is ordinary, so shares get the deeper bucket.
	byUser := func(r *http.Request) (string, bool) {
		claims, ok := auth.ClaimsFromContext(r.Context())
		if !ok {
			return "", false
		}
		return claims.UserID, true
	}
	friendRequestLimiter := ratelimit.New(ratelimit.Policy{
		Name: "friend_request", Burst: 10, Every: 6 * time.Minute,
	}, nil)
	shareLimiter := ratelimit.New(ratelimit.Policy{
		Name: "share", Burst: 30, Every: 2 * time.Minute,
	}, nil)
	// The machine-identification limit is the TIGHTEST here, and it is a spend
	// bound rather than an abuse bound. Every call is a vision request against
	// a billed endpoint (~$0.005), and unlike the other two the cost lands on
	// us rather than on somebody's inbox. 20 in 30 minutes is far above real
	// use — an athlete photographs a machine they cannot identify, taps a
	// candidate, and is done — and far below a loop.
	//
	// KEPT alongside the persisted daily quota that N48 added, not replaced by
	// it. The two answer different questions: this bounds the BURST (a client
	// bug cannot spend the whole day's allowance in one second), and the quota
	// in `exercise.CheckIdentifyQuota` bounds the DAY and survives a restart.
	//
	// The note that used to sit here — that this was deliberately weaker than
	// nutrition's persisted quota, a proportionate first cut with the gap
	// recorded rather than implied — was accurate, and N48 is that deferral
	// coming due. What made it urgent was the in-memory half: every deploy
	// handed every athlete a fresh burst of 20, so the ceiling lifted on
	// exactly the days we ship most.
	identifyLimiter := ratelimit.New(ratelimit.Policy{
		Name: "exercise_identify", Burst: 20, Every: 30 * time.Minute,
	}, nil)
	limitFriendRequests := ratelimit.Middleware(friendRequestLimiter, byUser)
	limitShares := ratelimit.Middleware(shareLimiter, byUser)
	limitIdentify := ratelimit.Middleware(identifyLimiter, byUser)

	// ALL THREE, not just the default. The two tight maps are smaller — only
	// athletes who ever sent a request or a share — but "smaller leak" is
	// still the leak this sweeper exists to not have, and review pointed out
	// that sweeping one of three quietly reads as sweeping all of them.
	sweepable := []*ratelimit.Limiter{defaultLimiter, friendRequestLimiter, shareLimiter, identifyLimiter}
	go func() {
		for range time.Tick(10 * time.Minute) {
			for _, l := range sweepable {
				if n := l.Sweep(30 * time.Minute); n > 0 {
					logger.Info("ratelimit: swept idle buckets", "policy", l.PolicyName(), "dropped", n, "remaining", l.Len())
				}
			}
		}
	}()

	sessionCardHandler := sessioncard.NewHandler(sessioncard.NewPostgresRepository(pool))
	sequenceRepo := sequence.NewPostgresRepository(pool)
	friendRepo := friend.NewPostgresRepository(pool)
	workoutRepo := workout.NewPostgresRepository(pool)
	sequenceHandler := sequence.NewHandler(sequenceRepo)
	friendHandler := friend.NewHandler(friendRepo)

	// THE SHARE REGISTRY. This is the only place that knows both that
	// "sequence" is a shareable kind of thing and which module owns it — the
	// share package never imports sequence, and sequence never imports share.
	// Adding a shareable domain is one line here plus Describe/CopyTo on its
	// repository; nothing in the share module changes, which is the entire
	// reason it was built generically instead of four times.
	//
	// "workout" is the line that claim was making a promise about, and it cost
	// exactly what was advertised: two methods on the workout repository and a
	// key here. No new endpoint, no second inbox, no change in this package.
	//
	// The KEY IS WIRE FORMAT: it is stored in shares.resource_type and sent by
	// clients, so renaming one orphans every stored row of that type.
	shareRegistry := share.Registry{
		"sequence": sequenceRepo,
		"workout":  workoutRepo,
	}
	shareRepo := share.NewPostgresRepository(pool, shareRegistry, friendRepo)
	shareHandler := share.NewHandler(shareRepo, shareRegistry)

	// WHAT IS WAITING FOR YOU. Same registry shape as the share copiers above,
	// and the same reason: the notification module imports neither of these,
	// so a future source that has something waiting is one line here.
	//
	// The keys are WIRE FORMAT — clients switch on them to decide which badge
	// to draw, so renaming one silently drops a badge rather than failing.
	// The friends' feed. It imports neither `friend` nor `session` — the friend
	// repo satisfies a consumer-side `feed.Friends` interface declared over
	// there, the same inversion the share registry uses.
	//
	// NOT registered with the notification counts below, and that is structural
	// rather than an omission: those count what is WAITING on you, cleared by
	// answering the pending row. A feed item is not answerable, so it would
	// need a read/unread flag — the second source of truth that module was
	// built to avoid.
	feedHandler := feed.NewHandler(feed.NewPostgresRepository(pool, friendRepo))

	notificationHandler := notification.NewHandler(notification.NewCounts(notification.Registry{
		"friend_requests": friendRepo,
		"shares":          shareRepo,
	}))
	featureFlagHandler := featureflag.NewHandler(featureflag.NewPostgresRepository(pool))
	activityHandler := activity.NewHandler(activity.NewPostgresRepository(pool))
	exerciseRepo := exercise.NewPostgresRepository(pool)
	exerciseHandler := exercise.NewHandler(exerciseRepo, os.Getenv("MEDIA_BASE_URL"))
	exerciseContentHandler := exercise.NewContentHandler(exerciseRepo)
	workoutHandler := workout.NewHandler(workoutRepo)
	techniqueRepo := technique.NewPostgresRepository(pool)
	// Fatal rather than degraded: the round map is embedded content, so a
	// failure here means the binary itself is wrong, and a process that boots
	// and serves a glossary with no map would look like a feature that has not
	// shipped yet.
	roundMap, err := technique.LoadRoundMap()
	if err != nil {
		logger.Error("round map failed to load", "err", err)
		os.Exit(1)
	}
	techniqueHandler := technique.NewHandler(techniqueRepo, roundMap)
	techniqueContentHandler := technique.NewContentHandler(techniqueRepo)
	sessionHandler := session.NewHandler(session.NewPostgresRepository(pool))
	planHandler := plan.NewHandler(plan.NewPostgresRepository(pool))
	themeHandler := theme.NewHandler(theme.NewPostgresRepository(pool))

	// Private object storage for check-in photos. Nil when unconfigured, which
	// is a supported state — local dev and CI have no bucket, and the photo
	// endpoints then say so rather than failing. A PARTIAL config is fatal
	// here, on purpose: three of four values set is somebody halfway through
	// setting it up, and starting anyway hides it until a photo vanishes.
	photoStore, err := objectstore.New(objectstore.Config{
		Endpoint:  os.Getenv("R2_ENDPOINT"),
		Bucket:    os.Getenv("R2_BUCKET"),
		AccessKey: os.Getenv("R2_ACCESS_KEY_ID"),
		SecretKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
	})
	if err != nil {
		logger.Error("object storage misconfigured", "error", err)
		os.Exit(1)
	}
	bodyHandler := body.NewHandler(body.NewPostgresRepository(pool), photoStore)
	nutritionRepo := nutrition.NewPostgresRepository(pool)
	nutritionHandler := nutrition.NewHandler(nutritionRepo)
	trackerHandler := tracker.NewHandler(tracker.NewPostgresRepository(pool))
	// The AI estimate endpoint. `NewEstimator` returns nil on an empty key and
	// the handler serves 503 for that, so a deploy without the selected
	// provider's key runs every other nutrition route normally rather than
	// refusing to start — this is the only feature in the API that needs one.
	//
	// Which model drafts a meal is CONFIG, not code. `ESTIMATE_PROVIDER` picks
	// the backend and `ESTIMATE_MODEL` overrides its default, so trying a
	// different model is an env change and a restart rather than a deploy —
	// which is the point, since the only way to know whether a model holds up
	// on portion confidence is to run it against real meals.
	//
	// The key is read from the variable the RESOLVED provider names, so the two
	// cannot drift apart. Reading the wrong one yields a 503 that looks like an
	// outage and is really a missing env var.
	estimateProvider := nutrition.Provider(os.Getenv("ESTIMATE_PROVIDER"))
	if estimateProvider == "" {
		estimateProvider = nutrition.DefaultProvider
	}
	estimateKey := ""
	if env := estimateProvider.APIKeyEnv(); env != "" {
		estimateKey = os.Getenv(env)
	}
	// Nil-safe: NewEstimator returns the Estimator INTERFACE, so an absent key
	// is a true nil rather than a non-nil interface wrapping a nil pointer.
	mealEstimator, err := nutrition.NewEstimator(nutrition.EstimatorConfig{
		Provider: estimateProvider,
		Model:    os.Getenv("ESTIMATE_MODEL"),
		APIKey:   estimateKey,
	})
	if err != nil {
		// A typo in ESTIMATE_PROVIDER fails the boot rather than silently
		// falling back, which would bill the wrong account and read as the
		// config having been applied.
		logger.Error("nutrition: estimator config", "err", err)
		os.Exit(1)
	}
	// Logged ONCE, here, because which model drafts a meal is deploy config
	// rather than per-request data — and because the per-request failure log
	// deliberately does not carry it. This is the line a support case reads to
	// find out what was actually running, and the line that shows an
	// ESTIMATE_MODEL typo took effect (an unknown model id is not rejected at
	// boot; it fails on the first call).
	if mealEstimator == nil {
		logger.Info("nutrition: estimation disabled", "reason", "no "+estimateProvider.APIKeyEnv())
	} else {
		logger.Info("nutrition: estimation enabled",
			"provider", string(estimateProvider),
			"model", nutrition.ResolveModel(estimateProvider, os.Getenv("ESTIMATE_MODEL")))
	}
	estimateHandler := nutrition.NewEstimateHandler(
		mealEstimator,
		nutrition.NewPostgresEstimateUsage(pool),
		// N114's reuse lookup. The same repository the food log uses, handed
		// over through a one-method port so this handler cannot write anything
		// — see `nutrition.SavedFoodFinder`.
		nutritionRepo,
	)

	// Machine identification (N7). Same nil-safe shape as the estimator above:
	// `NewIdentifier` returns the Identifier INTERFACE, so a deploy without the
	// provider's key gets a genuinely nil interface and every other exercise
	// route runs normally. Returning a concrete pointer here would produce a
	// NON-nil interface holding nil, the handler's nil check would read false,
	// and the first request would panic on a nil receiver.
	//
	// Its own provider and model env vars rather than sharing the estimate's:
	// model tier is a per-feature judgement, and N26 and this want different
	// answers from the same provider — see `DefaultIdentifyModels`.
	identifyProvider := exercise.Provider(os.Getenv("IDENTIFY_PROVIDER"))
	if identifyProvider == "" {
		identifyProvider = exercise.DefaultIdentifyProvider
	}
	identifyKey := ""
	if env := identifyProvider.APIKeyEnv(); env != "" {
		identifyKey = os.Getenv(env)
	}
	machineIdentifier, err := exercise.NewIdentifier(exercise.IdentifierConfig{
		Provider: identifyProvider,
		Model:    os.Getenv("IDENTIFY_MODEL"),
		APIKey:   identifyKey,
	})
	if err != nil {
		// A bad provider name or an empty shortlist is a CONFIG error, and it
		// fails the boot rather than degrading to 503. A typo'd provider that
		// silently disabled the feature would look exactly like "no key set",
		// which is the state it is most likely to be confused with.
		logger.Error("exercise: identifier config", "err", err)
		os.Exit(1)
	}
	if machineIdentifier == nil {
		logger.Info("exercise: machine identification disabled", "reason", "no "+identifyProvider.APIKeyEnv())
	} else {
		logger.Info("exercise: machine identification enabled",
			"provider", string(identifyProvider),
			"model", exercise.ResolveIdentifyModel(identifyProvider, os.Getenv("IDENTIFY_MODEL")))
	}
	// The quota repository is always real, even on a deploy with no API key:
	// `machineIdentifier` may be nil and the handler nil-checks it, but a nil
	// usage repository would panic on the first call rather than refuse it.
	identifyUsage := exercise.NewPostgresIdentifyUsage(pool)
	identifyHandler := exercise.NewIdentifyHandler(machineIdentifier, identifyUsage)
	// The food catalog: text search, coverage, and barcode lookup.
	//
	// The barcode resolver is wired unconditionally because Open Food Facts
	// needs no key — unlike the estimator above, which is why that one is
	// nil-checked and this one is not. What it DOES need is a real
	// User-Agent: Open Food Facts rate-limits anonymous clients harder, so
	// FOOD_LOOKUP_USER_AGENT identifies this deploy. An empty value falls back
	// to a sensible default rather than sending Go's, because a lookup that
	// only fails in production is the worst way to learn this.
	//
	// Passing nil here instead would be a supported state, not a broken one:
	// the coverage endpoint reports `barcode.enabled: false` and lookups
	// return 503 `unavailable` rather than 404, so a client can tell "this
	// build cannot look packets up" from "this packet is unknown".
	foodHandler := food.NewHandler(food.NewService(
		food.NewPostgresRepository(pool),
		food.NewOpenFoodFacts(os.Getenv("FOOD_LOOKUP_USER_AGENT")),
		logger,
	))

	// Dictated reflections (N33). The third feature on `internal/platform/llm`
	// and the third to pick its own tier — and the only one whose tier is chosen
	// against a published measurement rather than a judgement, because N37 ran
	// the whole eval corpus through both OpenAI tiers first. See
	// `bjj.DefaultDraftModels` for the numbers.
	//
	// Same nil-safe shape as the two above: `NewDrafter` returns the Drafter
	// INTERFACE, so a deploy without the provider's key gets a genuinely nil
	// interface and every other bjj route runs normally.
	reflectProvider := bjj.Provider(os.Getenv("REFLECT_PROVIDER"))
	if reflectProvider == "" {
		reflectProvider = bjj.DefaultDraftProvider
	}
	reflectKey := ""
	if env := reflectProvider.APIKeyEnv(); env != "" {
		reflectKey = os.Getenv(env)
	}
	reflectionDrafter, err := bjj.NewDrafter(bjj.DrafterConfig{
		Provider: reflectProvider,
		Model:    os.Getenv("REFLECT_MODEL"),
		APIKey:   reflectKey,
	})
	if err != nil {
		// A bad provider name or an unloadable technique catalog is a CONFIG
		// error and fails the boot rather than degrading to 503, for the reason
		// the identifier records: a typo that silently disabled the feature
		// looks exactly like the state it is most likely to be confused with.
		logger.Error("bjj: reflection drafter config", "err", err)
		os.Exit(1)
	}
	if reflectionDrafter == nil {
		logger.Info("bjj: reflection drafting disabled", "reason", "no "+reflectProvider.APIKeyEnv())
	} else {
		logger.Info("bjj: reflection drafting enabled",
			"provider", string(reflectProvider),
			"model", bjj.ResolveDraftModel(reflectProvider, os.Getenv("REFLECT_MODEL")))
	}
	reflectHandler := bjj.NewDraftHandler(reflectionDrafter, bjj.NewPostgresDraftUsage(pool))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/healthz", handleHealthz)
	mux.Handle("GET /v1/me", verifier.RequireAuth(http.HandlerFunc(handleMe)))
	// BJJ rank. Under /v1/bjj rather than /v1/profile because the data is
	// discipline-scoped — see the note at the top of profile.go. The screens
	// still show it inside the profile; that is a UI decision, not a
	// reason to put a belt on the account record every sport shares.
	// Body check-ins: what the athlete weighs and measures, and the phase they
	// are measuring against. Under /v1/body rather than /v1/profile because a
	// measurement is an event on a day, not a field on the account.
	mux.Handle("GET /v1/body/checkins", verifier.RequireAuth(http.HandlerFunc(bodyHandler.ListCheckins)))
	// PUT, keyed on the day: the client names the resource and sending it twice
	// is the same as sending it once, which is what makes an offline check-in
	// safe to retry.
	mux.Handle("PUT /v1/body/checkins/{date}", verifier.RequireAuth(http.HandlerFunc(bodyHandler.SaveCheckin)))
	mux.Handle("DELETE /v1/body/checkins/{date}", verifier.RequireAuth(http.HandlerFunc(bodyHandler.DeleteCheckin)))
	mux.Handle("POST /v1/body/checkins/{date}/photo", verifier.RequireAuth(http.HandlerFunc(bodyHandler.PhotoUploadURL)))
	mux.Handle("GET /v1/body/phases", verifier.RequireAuth(http.HandlerFunc(bodyHandler.ListPhases)))
	mux.Handle("POST /v1/body/phases", verifier.RequireAuth(http.HandlerFunc(bodyHandler.CreatePhase)))
	mux.Handle("POST /v1/body/phases/{id}/end", verifier.RequireAuth(http.HandlerFunc(bodyHandler.EndPhase)))

	// Nutrition. Entries and foods are addressed by a CLIENT-GENERATED UUID and
	// written with PUT, which is what makes an offline push idempotent: sending
	// the same row twice is the same as sending it once.
	//
	// Not `PUT /v1/nutrition/days/{date}` replacing a whole day, which is how
	// sessions handle sets. A day accrues from several contexts and commonly
	// from two devices at once — a phone logging lunch while web corrects
	// breakfast — and under day-replace the second write deletes the first.
	// Worse, a day-replace outbox has to queue a whole-day snapshot, and
	// replaying one captured before another device's entry synced silently
	// drops it. That is the T5-T8 family already in TASKS.md.
	mux.Handle("GET /v1/nutrition/entries", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.ListEntries)))
	mux.Handle("PUT /v1/nutrition/entries/{id}", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.SaveEntry)))
	mux.Handle("DELETE /v1/nutrition/entries/{id}", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.DeleteEntry)))
	mux.Handle("GET /v1/nutrition/days", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.Days)))
	// Computes a DRAFT and writes nothing. Rate-limited per athlete on top of
	// the global limiter, because this is the one route where a loop costs
	// real money rather than CPU.
	mux.Handle("POST /v1/nutrition/estimate", verifier.RequireAuth(http.HandlerFunc(estimateHandler.Estimate)))
	// The shared catalog, distinct from /v1/nutrition/foods above — that one is
	// the athlete's OWN saved foods, this one is the catalog everybody
	// searches. Both are needed and neither replaces the other.
	//
	// `coverage` and `barcode/{barcode}` are declared before `{id}` for
	// readability only; Go's ServeMux resolves by specificity, so a literal
	// segment beats a wildcard regardless of registration order.
	mux.Handle("GET /v1/nutrition/catalog", verifier.RequireAuth(http.HandlerFunc(foodHandler.Search)))
	mux.Handle("GET /v1/nutrition/catalog/coverage", verifier.RequireAuth(http.HandlerFunc(foodHandler.Coverage)))
	mux.Handle("GET /v1/nutrition/catalog/barcode/{barcode}", verifier.RequireAuth(http.HandlerFunc(foodHandler.Barcode)))
	mux.Handle("GET /v1/nutrition/catalog/{id}", verifier.RequireAuth(http.HandlerFunc(foodHandler.Get)))
	mux.Handle("GET /v1/nutrition/foods", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.ListFoods)))
	mux.Handle("PUT /v1/nutrition/foods/{id}", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.SaveFood)))
	mux.Handle("DELETE /v1/nutrition/foods/{id}", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.DeleteFood)))

	// Daily trackers. One generic model — water is a seeded preset of it, not a
	// route of its own, and coffee (N77) and an athlete's own tracker (N78) are
	// the same endpoints with different rows.
	//
	// `/entries` is declared before `/{trackerID}` for readability only; Go's
	// mux resolves by specificity, not by registration order.
	mux.Handle("GET /v1/trackers", verifier.RequireAuth(http.HandlerFunc(trackerHandler.List)))
	mux.Handle("POST /v1/trackers", verifier.RequireAuth(http.HandlerFunc(trackerHandler.Create)))
	mux.Handle("GET /v1/trackers/entries", verifier.RequireAuth(http.HandlerFunc(trackerHandler.ListEntries)))
	// The catalogue of trackers an athlete can turn on, and the switch. Without
	// these a preset shipping `Default: false` (coffee, N77) reaches nobody.
	//
	// A SEPARATE top-level path rather than `/v1/trackers/presets/{presetKey}`,
	// and not for taste: that pattern and `/v1/trackers/{trackerID}/restore`
	// overlap on `/v1/trackers/presets/restore` with neither more specific than
	// the other, which is a registration-time PANIC in Go's ServeMux — the whole
	// API failing to start, at boot, on a route nobody would ever call. The
	// catalogue is a different resource from an athlete's trackers anyway.
	mux.Handle("GET /v1/tracker-presets", verifier.RequireAuth(http.HandlerFunc(trackerHandler.ListPresets)))
	mux.Handle("POST /v1/tracker-presets/{presetKey}", verifier.RequireAuth(http.HandlerFunc(trackerHandler.AddPreset)))
	mux.Handle("PATCH /v1/trackers/{trackerID}", verifier.RequireAuth(http.HandlerFunc(trackerHandler.Update)))
	// DELETE archives; DELETE ...?purge=true destroys, entries and all. One
	// route rather than two, so a client cannot call the wrong one — see the
	// handler.
	mux.Handle("DELETE /v1/trackers/{trackerID}", verifier.RequireAuth(http.HandlerFunc(trackerHandler.Archive)))
	mux.Handle("POST /v1/trackers/{trackerID}/restore", verifier.RequireAuth(http.HandlerFunc(trackerHandler.Restore)))
	mux.Handle("PUT /v1/trackers/{trackerID}/entries/{entryID}", verifier.RequireAuth(http.HandlerFunc(trackerHandler.LogEntry)))
	mux.Handle("DELETE /v1/trackers/{trackerID}/entries/{entryID}", verifier.RequireAuth(http.HandlerFunc(trackerHandler.DeleteEntry)))
	// Literal before wildcard, which Go 1.22's mux resolves by specificity
	// rather than declaration order — the same shape /v1/sessions/suggestions
	// and /v1/curricula/working already rely on. Ordered this way for readers.
	mux.Handle("GET /v1/nutrition/targets/suggested", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.Suggested)))
	// Literal before wildcard, same as `suggested` above: Go 1.22's ServeMux
	// prefers the more specific pattern, so neither is shadowed by
	// `targets/{date}`.
	mux.Handle("GET /v1/nutrition/targets/adjustment", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.Adjustment)))
	mux.Handle("GET /v1/nutrition/targets", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.ListTargets)))
	mux.Handle("PUT /v1/nutrition/targets/{date}", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.SaveTarget)))
	mux.Handle("DELETE /v1/nutrition/targets/{date}", verifier.RequireAuth(http.HandlerFunc(nutritionHandler.DeleteTarget)))
	mux.Handle("GET /v1/bjj/standing", verifier.RequireAuth(http.HandlerFunc(bjjHandler.GetStanding)))
	mux.Handle("POST /v1/bjj/promotions", verifier.RequireAuth(http.HandlerFunc(bjjHandler.CreatePromotion)))
	mux.Handle("PATCH /v1/bjj/promotions/{promotionID}", verifier.RequireAuth(http.HandlerFunc(bjjHandler.UpdatePromotion)))
	mux.Handle("DELETE /v1/bjj/promotions/{promotionID}", verifier.RequireAuth(http.HandlerFunc(bjjHandler.DeletePromotion)))
	// The BJJ half of a session. The session itself is created through
	// POST /v1/sessions like any other sport — these only carry what a mat
	// session has and a barbell session does not, exactly as
	// PUT /v1/sessions/{id}/sets carries what a strength session has.
	mux.Handle("PUT /v1/bjj/sessions/{sessionID}", verifier.RequireAuth(http.HandlerFunc(bjjSessionHandler.PutDetail)))
	mux.Handle("GET /v1/bjj/sessions/{sessionID}", verifier.RequireAuth(http.HandlerFunc(bjjSessionHandler.GetDetail)))
	// The technique funnel, read across every session. Under /v1/bjj because
	// it is discipline-scoped evidence, not a property of the account.
	mux.Handle("GET /v1/bjj/proficiency", verifier.RequireAuth(http.HandlerFunc(bjjProficiencyHandler.List)))
	// The position map — where the athlete scores and where they get stuck.
	// The third view `bjj_session_tags` was shaped for, and the last one to be
	// read back: every tag has carried a position since the table was written.
	mux.Handle("GET /v1/bjj/positions", verifier.RequireAuth(http.HandlerFunc(bjjPositionHandler.List)))
	// What the athlete is deliberately working on. Read by the reflection
	// wizard (mobile) and set from the analytical surface (web), per the
	// platform split: choosing a focus for the next few weeks is planning.
	mux.Handle("GET /v1/bjj/focus", verifier.RequireAuth(http.HandlerFunc(bjjFocusHandler.Get)))
	mux.Handle("PUT /v1/bjj/focus", verifier.RequireAuth(http.HandlerFunc(bjjFocusHandler.Set)))

	// Say what happened and have it fill the chips (N33). A DRAFT comes back;
	// nothing is logged until the athlete confirms it and PUTs it through
	// /v1/bjj/sessions/{sessionID} above, which is the same draft-then-confirm
	// rule as the meal estimate and the barcode scan.
	//
	// Not rate-limited by the in-memory limiter the identify route uses: this
	// one carries nutrition's persisted per-athlete quota instead, which
	// survives a restart and reports a remaining count the client can show. The
	// gate runs inside the handler because it has to run BEFORE the model call
	// and its refusal needs the quota's own numbers in the message.
	mux.Handle("POST /v1/bjj/reflect/draft", verifier.RequireAuth(http.HandlerFunc(reflectHandler.Draft)))

	// What the athlete has actually achieved on the mat and in competition,
	// DERIVED from evidence that already exists -- contests and the tag stream
	// -- and stored nowhere. Under /v1/bjj because the mat half reads
	// jiu-jitsu's own evidence table, matching /v1/bjj/proficiency and
	// /v1/bjj/positions; the competition half filters `contests` to this sport,
	// since that table also holds a powerlifting meet and a 10k.
	//
	// Read-only, with no write verb anywhere: an accomplishment that could be
	// granted by hand would stop being evidence of anything, and would make
	// every other one a claim rather than a fact.
	mux.Handle("GET /v1/bjj/accomplishments", verifier.RequireAuth(http.HandlerFunc(accomplishmentHandler.List)))

	// The competitive record: what you entered, in which division, and how it
	// went.
	//
	// Under /v1/contests rather than /v1/bjj/contests because the table is not
	// BJJ-specific and was designed not to be -- it has to hold a powerlifting
	// meet and a 10k, which is exactly why the schema takes the neutral word
	// while the client says "tournament" through `labelFor`. Only today's
	// content is jiu-jitsu.
	//
	// PUT rather than PATCH for the update, which is the one shape decision
	// visible from outside. The matches travel WITH the entry and replace
	// wholesale -- the same call `curriculum` makes for phases and items, in
	// its words "the two replace together" -- so a partial update would have to
	// say what sending no matches means, and either answer is a trap: "leave
	// them alone" makes clearing a bracket impossible, "clear them" deletes a
	// record on a request that never mentioned it. PUT has one meaning.
	mux.Handle("GET /v1/contests", verifier.RequireAuth(http.HandlerFunc(contestHandler.List)))
	mux.Handle("POST /v1/contests", verifier.RequireAuth(http.HandlerFunc(contestHandler.Create)))
	mux.Handle("GET /v1/contests/{contestID}", verifier.RequireAuth(http.HandlerFunc(contestHandler.Get)))
	mux.Handle("PUT /v1/contests/{contestID}", verifier.RequireAuth(http.HandlerFunc(contestHandler.Update)))
	mux.Handle("DELETE /v1/contests/{contestID}", verifier.RequireAuth(http.HandlerFunc(contestHandler.Delete)))

	// Curricula and the roadmaps built on them. Under /v1/curricula rather than
	// /v1/bjj/curricula because the sharing model is the workouts one and the
	// shape is not BJJ-specific -- only today's content is.
	//
	// Enrollment is a SUBRESOURCE, not a flag on the curriculum: PUT and DELETE
	// on .../enrollment say who is acting (the caller, always) without the
	// request body being able to name somebody else.
	mux.Handle("GET /v1/curricula", verifier.RequireAuth(http.HandlerFunc(curriculumHandler.List)))
	mux.Handle("POST /v1/curricula", verifier.RequireAuth(http.HandlerFunc(curriculumHandler.Create)))
	// BEFORE the {curriculumID} pattern in the file, though the mux does not
	// care: Go 1.22+ routing prefers the more specific literal segment, so
	// /v1/curricula/working can never be read as an id. Ordered this way for
	// the reader, not the router.
	mux.Handle("GET /v1/curricula/working", verifier.RequireAuth(http.HandlerFunc(curriculumHandler.Working)))
	mux.Handle("GET /v1/curricula/{curriculumID}", verifier.RequireAuth(http.HandlerFunc(curriculumHandler.Get)))
	mux.Handle("PATCH /v1/curricula/{curriculumID}", verifier.RequireAuth(http.HandlerFunc(curriculumHandler.Update)))
	mux.Handle("DELETE /v1/curricula/{curriculumID}", verifier.RequireAuth(http.HandlerFunc(curriculumHandler.Delete)))
	mux.Handle("PUT /v1/curricula/{curriculumID}/enrollment", verifier.RequireAuth(http.HandlerFunc(curriculumHandler.Enroll)))
	// Leaving a roadmap also withdraws its claim on the focus list. The wrapper
	// is the only place that knows those two facts belong together — see
	// enrollment.go for why it is here and not inside either module.
	mux.Handle("DELETE /v1/curricula/{curriculumID}/enrollment",
		verifier.RequireAuth(releaseRoadmapFocus(bjjRepo, http.HandlerFunc(curriculumHandler.Archive))))

	// Sequences: the chain a class actually taught, in the order it flows.
	//
	// Under /v1/sequences rather than /v1/bjj/sequences, matching curricula:
	// the shape is an ordered list of library references and is not
	// BJJ-specific -- only today's content is.
	//
	// NO /v1/sequences/{id}/share HERE, deliberately. Sharing is one capability
	// over every ownable thing in the app and gets its own /v1/shares surface;
	// a per-resource share verb would be the fourth private implementation of
	// one idea and would have to be undone.
	// The share card's numbers. Under the session it describes rather than a
	// top-level /v1/cards, because it is a projection of one session and has
	// no life without it.
	mux.Handle("GET /v1/sessions/{sessionID}/card", verifier.RequireAuth(http.HandlerFunc(sessionCardHandler.Get)))

	mux.Handle("GET /v1/sequences", verifier.RequireAuth(http.HandlerFunc(sequenceHandler.List)))
	mux.Handle("POST /v1/sequences", verifier.RequireAuth(http.HandlerFunc(sequenceHandler.Create)))
	mux.Handle("GET /v1/sequences/{sequenceID}", verifier.RequireAuth(http.HandlerFunc(sequenceHandler.Get)))
	mux.Handle("PATCH /v1/sequences/{sequenceID}", verifier.RequireAuth(http.HandlerFunc(sequenceHandler.Update)))
	// POST, not PUT: it CREATES a sequence, and calling it twice gives you two
	// copies rather than one — which is the honest semantics for "copy this
	// again" and the reason it is not idempotent.
	mux.Handle("POST /v1/sequences/{sequenceID}/copy", verifier.RequireAuth(http.HandlerFunc(sequenceHandler.Copy)))
	mux.Handle("DELETE /v1/sequences/{sequenceID}", verifier.RequireAuth(http.HandlerFunc(sequenceHandler.Delete)))

	// Username lookup — the first athlete-to-athlete read, and the reason it
	// is authenticated: handle enumeration was accepted with the username
	// design, but at signed-in speed, not anonymous-scraper speed.
	mux.Handle("GET /v1/users/{username}", verifier.RequireAuth(http.HandlerFunc(profileHandler.Lookup)))

	// The social graph. Everything is addressed by USERNAME — user ids never
	// cross the wire in either direction — and every repository method scopes
	// itself to the caller, so there is no unscoped read for a handler to
	// misuse. DELETE covers decline, cancel and unfriend alike: all three are
	// "this relationship, gone", and the caller's UI knows which it offered.
	// What your training partners have been doing. ONE route and one verb:
	// the feed row is the whole of what a friend may see, so a
	// `GET /v1/feed/{id}` would be a second, wider path to the data this
	// module exists to keep narrow.
	mux.Handle("GET /v1/feed", verifier.RequireAuth(http.HandlerFunc(feedHandler.List)))
	mux.Handle("GET /v1/friends", verifier.RequireAuth(http.HandlerFunc(friendHandler.Friends)))
	mux.Handle("GET /v1/friends/requests", verifier.RequireAuth(http.HandlerFunc(friendHandler.Pending)))
	mux.Handle("POST /v1/friends/requests", verifier.RequireAuth(limitFriendRequests(http.HandlerFunc(friendHandler.Send))))
	mux.Handle("POST /v1/friends/requests/{username}/accept", verifier.RequireAuth(http.HandlerFunc(friendHandler.Accept)))
	mux.Handle("DELETE /v1/friends/{username}", verifier.RequireAuth(http.HandlerFunc(friendHandler.Remove)))

	// Sharing: one surface for every shareable type, addressed by handle.
	mux.Handle("POST /v1/shares", verifier.RequireAuth(limitShares(http.HandlerFunc(shareHandler.Create))))
	mux.Handle("GET /v1/shares/inbox", verifier.RequireAuth(http.HandlerFunc(shareHandler.Inbox)))
	mux.Handle("GET /v1/notifications", verifier.RequireAuth(http.HandlerFunc(notificationHandler.Pending)))
	mux.Handle("GET /v1/shares/sent", verifier.RequireAuth(http.HandlerFunc(shareHandler.Sent)))
	mux.Handle("POST /v1/shares/{id}/accept", verifier.RequireAuth(http.HandlerFunc(shareHandler.Accept)))
	mux.Handle("DELETE /v1/shares/{id}", verifier.RequireAuth(http.HandlerFunc(shareHandler.Delete)))
	mux.Handle("GET /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Get)))
	mux.Handle("POST /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Create)))
	mux.Handle("PATCH /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Update)))
	// The discipline registry merged with this user's toggles. Everything
	// discipline-shaped in both clients renders from this one response.
	mux.Handle("GET /v1/modules", verifier.RequireAuth(http.HandlerFunc(profileHandler.Modules)))
	mux.Handle("PATCH /v1/modules", verifier.RequireAuth(http.HandlerFunc(profileHandler.SetModules)))
	mux.Handle("GET /v1/flags", verifier.RequireAuth(http.HandlerFunc(featureFlagHandler.List)))
	mux.Handle("POST /v1/activities", verifier.RequireAuth(http.HandlerFunc(activityHandler.Create)))
	mux.Handle("GET /v1/activities", verifier.RequireAuth(http.HandlerFunc(activityHandler.List)))
	mux.Handle("GET /v1/profile/exercise-units", verifier.RequireAuth(http.HandlerFunc(profileHandler.ExerciseUnits)))
	mux.Handle("PUT /v1/profile/exercise-units/{exerciseID}", verifier.RequireAuth(http.HandlerFunc(profileHandler.SetExerciseUnit)))
	mux.Handle("GET /v1/exercises", verifier.RequireAuth(http.HandlerFunc(exerciseHandler.List)))
	mux.Handle("GET /v1/exercises/{exerciseID}", verifier.RequireAuth(http.HandlerFunc(exerciseHandler.Get)))
	// POST rather than GET because the photo is the request body, and BEFORE
	// the {exerciseID} route would matter if this were a GET — it is not, so
	// there is no shadowing question. Rate-limited on top of the default
	// policy: every call is a billed vision request.
	mux.Handle("POST /v1/exercises/identify",
		verifier.RequireAuth(limitIdentify(http.HandlerFunc(identifyHandler.Identify))))
	mux.Handle("GET /v1/techniques", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.List)))
	// Registered before the wildcard for readability only — Go 1.22's mux
	// picks the more specific pattern regardless of order, so the literal
	// "rulesets" wins over "{techniqueID}" and there is no shadowing risk.
	mux.Handle("GET /v1/techniques/rulesets", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.Rulesets)))
	mux.Handle("GET /v1/techniques/positions", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.Positions)))
	mux.Handle("GET /v1/techniques/positions/{positionID}", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.GetPosition)))
	mux.Handle("GET /v1/techniques/{techniqueID}", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.Get)))
	// Authoring the catalog from the admin console, so adding a technique is
	// not a deploy. Under /v1/admin and RequireAdmin — this writes shared
	// reference content that every athlete's library and every training record
	// points at.
	mux.Handle("GET /v1/admin/techniques/positions", verifier.RequireAdmin(http.HandlerFunc(techniqueContentHandler.Positions)))
	mux.Handle("GET /v1/admin/techniques", verifier.RequireAdmin(http.HandlerFunc(techniqueContentHandler.List)))
	mux.Handle("POST /v1/admin/techniques", verifier.RequireAdmin(http.HandlerFunc(techniqueContentHandler.Create)))
	mux.Handle("PATCH /v1/admin/techniques/{techniqueID}", verifier.RequireAdmin(http.HandlerFunc(techniqueContentHandler.Update)))
	// POST rather than PATCH: publishing is an action, not a field, and the
	// edit path must not be able to change visibility by accident.
	mux.Handle("POST /v1/admin/techniques/{techniqueID}/publish", verifier.RequireAdmin(http.HandlerFunc(techniqueContentHandler.Publish)))
	mux.Handle("GET /v1/admin/techniques/{techniqueID}/revisions", verifier.RequireAdmin(http.HandlerFunc(techniqueContentHandler.Revisions)))
	// POST, not PUT: restoring APPENDS a revision rather than replacing state,
	// so it is not idempotent — two restores of the same revision produce two
	// entries in the history, which is the honest record of what happened.
	mux.Handle("POST /v1/admin/techniques/{techniqueID}/revisions/{revision}/restore", verifier.RequireAdmin(http.HandlerFunc(techniqueContentHandler.Restore)))
	mux.Handle("GET /v1/admin/exercises/vocabularies", verifier.RequireAdmin(http.HandlerFunc(exerciseContentHandler.Vocabularies)))
	mux.Handle("GET /v1/admin/exercises", verifier.RequireAdmin(http.HandlerFunc(exerciseContentHandler.List)))
	mux.Handle("POST /v1/admin/exercises", verifier.RequireAdmin(http.HandlerFunc(exerciseContentHandler.Create)))
	mux.Handle("PATCH /v1/admin/exercises/{exerciseID}", verifier.RequireAdmin(http.HandlerFunc(exerciseContentHandler.Update)))
	mux.Handle("POST /v1/admin/exercises/{exerciseID}/publish", verifier.RequireAdmin(http.HandlerFunc(exerciseContentHandler.Publish)))
	mux.Handle("GET /v1/admin/exercises/{exerciseID}/revisions", verifier.RequireAdmin(http.HandlerFunc(exerciseContentHandler.Revisions)))
	mux.Handle("POST /v1/admin/exercises/{exerciseID}/revisions/{revision}/restore", verifier.RequireAdmin(http.HandlerFunc(exerciseContentHandler.Restore)))
	mux.Handle("GET /v1/sessions", verifier.RequireAuth(http.HandlerFunc(sessionHandler.List)))
	mux.Handle("POST /v1/sessions", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Create)))
	// Registered before the {sessionID} pattern is irrelevant to net/http's
	// mux (literal segments beat wildcards), but kept adjacent for reading.
	mux.Handle("GET /v1/sessions/suggestions", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Suggestions)))
	// Literal path, so Go 1.22 routing prefers it over /v1/sessions/{sessionID}.
	mux.Handle("GET /v1/sessions/history", verifier.RequireAuth(http.HandlerFunc(sessionHandler.History)))
	// Records are derived from sessions, so they're served by that module —
	// but they're their own noun to a client, so they get their own path.
	mux.Handle("GET /v1/records", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Records)))
	mux.Handle("GET /v1/records/{exerciseID}/history", verifier.RequireAuth(http.HandlerFunc(sessionHandler.LoadHistory)))
	mux.Handle("GET /v1/records/pinned", verifier.RequireAuth(http.HandlerFunc(sessionHandler.PinnedExercises)))
	mux.Handle("PUT /v1/records/pinned", verifier.RequireAuth(http.HandlerFunc(sessionHandler.SetPinnedExercises)))
	mux.Handle("GET /v1/sessions/{sessionID}", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Get)))
	mux.Handle("PUT /v1/sessions/{sessionID}/sets", verifier.RequireAuth(http.HandlerFunc(sessionHandler.ReplaceSets)))
	mux.Handle("POST /v1/sessions/{sessionID}/finish", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Finish)))
	mux.Handle("PATCH /v1/sessions/{sessionID}", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Rename)))
	mux.Handle("DELETE /v1/sessions/{sessionID}", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Delete)))

	// The training plan — what the athlete INTENDS to train, as opposed to
	// /v1/workouts (the template) and /v1/sessions (what happened). Kept a
	// separate resource rather than a field on either, because it is the only
	// one of the three that is dated *and* not yet performed; see the module
	// doc comment and migration 000029.
	mux.Handle("GET /v1/plans", verifier.RequireAuth(http.HandlerFunc(planHandler.List)))
	mux.Handle("POST /v1/plans", verifier.RequireAuth(http.HandlerFunc(planHandler.Create)))
	mux.Handle("PATCH /v1/plans/{planID}", verifier.RequireAuth(http.HandlerFunc(planHandler.Update)))
	mux.Handle("DELETE /v1/plans/{planID}", verifier.RequireAuth(http.HandlerFunc(planHandler.Delete)))

	// Weekly training themes. PUT rather than POST on the week itself: a week
	// holds at most one theme and the caller names the week, so there is
	// nothing to allocate and no id to hand back.
	mux.Handle("GET /v1/themes", verifier.RequireAuth(http.HandlerFunc(themeHandler.List)))
	mux.Handle("GET /v1/themes/{weekStart}", verifier.RequireAuth(http.HandlerFunc(themeHandler.Get)))
	mux.Handle("PUT /v1/themes/{weekStart}", verifier.RequireAuth(http.HandlerFunc(themeHandler.Set)))
	mux.Handle("DELETE /v1/themes/{weekStart}", verifier.RequireAuth(http.HandlerFunc(themeHandler.Delete)))
	mux.Handle("GET /v1/workouts", verifier.RequireAuth(http.HandlerFunc(workoutHandler.List)))
	mux.Handle("POST /v1/workouts", verifier.RequireAuth(http.HandlerFunc(workoutHandler.Create)))
	mux.Handle("GET /v1/workouts/{workoutID}", verifier.RequireAuth(http.HandlerFunc(workoutHandler.Get)))
	mux.Handle("PUT /v1/workouts/{workoutID}/items", verifier.RequireAuth(http.HandlerFunc(workoutHandler.ReplaceItems)))
	mux.Handle("PATCH /v1/workouts/{workoutID}", verifier.RequireAuth(http.HandlerFunc(workoutHandler.Rename)))
	mux.Handle("DELETE /v1/workouts/{workoutID}", verifier.RequireAuth(http.HandlerFunc(workoutHandler.Delete)))
	// POST and not idempotent, matching sequences: copying twice gives you two
	// copies, which is the honest reading of "copy this again".
	mux.Handle("POST /v1/workouts/{workoutID}/copy", verifier.RequireAuth(http.HandlerFunc(workoutHandler.Copy)))
	mux.Handle("GET /v1/admin/users", verifier.RequireAdmin(http.HandlerFunc(activityHandler.AdminListUsers)))
	mux.Handle("GET /v1/admin/users/{userID}", verifier.RequireAdmin(http.HandlerFunc(activityHandler.AdminGetUser)))
	mux.Handle("GET /v1/admin/users/{userID}/activities", verifier.RequireAdmin(http.HandlerFunc(activityHandler.AdminListUserActivities)))
	mux.Handle("GET /v1/admin/users/{userID}/bjj/standing", verifier.RequireAdmin(http.HandlerFunc(bjjHandler.AdminGetStanding)))

	healthRepo := health.NewPostgresRepository(pool)
	healthHandler := health.NewHandler(healthRepo)
	mux.Handle("POST /v1/client-errors", verifier.RequireAuth(http.HandlerFunc(healthHandler.Report)))
	mux.Handle("GET /v1/admin/health", verifier.RequireAdmin(http.HandlerFunc(healthHandler.AdminList)))

	// A successful request past this is a symptom worth a row. Two seconds
	// because this API's slowest legitimate call is a full 524-entry catalog
	// read, which is comfortably under it — so anything crossing the line is
	// genuinely unusual rather than a busy afternoon.
	//
	// Overridable because the right value is environment-specific: a shared
	// Railway instance and a laptop with a local Postgres do not agree on what
	// "slow" means.
	slowRequestAfter := 2 * time.Second
	if raw := os.Getenv("SLOW_REQUEST_MS"); raw != "" {
		if ms, convErr := strconv.Atoi(raw); convErr == nil && ms > 0 {
			slowRequestAfter = time.Duration(ms) * time.Millisecond
		} else {
			logger.Warn("ignoring unparseable SLOW_REQUEST_MS", "value", raw)
		}
	}
	recorder := health.NewRecorder(healthRepo, slowRequestAfter, logger)

	logger.Info("api listening", "port", port, "slow_request_ms", slowRequestAfter.Milliseconds())
	// The chain lives in `apihttp.Assemble`, not inline here, so a test can
	// build the real one — see that function for why, and for the two bugs
	// that were invisible while it was assembled at this call site.
	if err := http.ListenAndServe(":"+port, apihttp.Assemble(logger, recorder.Observe, withCORS(mux))); err != nil {
		logger.Error("server exited", "err", err)
		os.Exit(1)
	}
}

// withCORS allows local web dev servers to call the API from different
// origins (localhost:3000 for apps/web, localhost:8081 for the Expo web
// preview). WEB_ORIGIN is comma-separated; only origins actually in the
// list get echoed back, never a wildcard. Revisit this allowlist once
// staging/production domains exist. Note: CORS is a browser-only concern —
// it doesn't apply to native iOS/Android requests at all, only web previews.
func withCORS(next http.Handler) http.Handler {
	raw := os.Getenv("WEB_ORIGIN")
	if raw == "" {
		raw = "http://localhost:3000,http://localhost:8081"
	}
	allowed := make(map[string]bool)
	for _, origin := range strings.Split(raw, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			allowed[origin] = true
		}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		// Outside the allowlist check on purpose: a response to a request with
		// no/disallowed Origin varies on Origin just as much, and a cache that
		// stored it without saying so could later hand it to an allowed origin
		// with no Access-Control-Allow-Origin on it.
		w.Header().Add("Vary", "Origin")
		if allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		// `If-None-Match` is NOT a CORS-safelisted request header, so without it
		// here the browser's preflight rejects every conditional request the
		// fetch layer tries to make. The middleware would keep working for
		// native clients and be dead code for the web app.
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, traceparent, If-None-Match")
		// Response headers a browser is allowed to *read*.
		//
		// Without this the trace correlation is one-way: the clients send a
		// `traceparent` and the API echoes one back along with `x-request-id`,
		// but JS can only read CORS-safelisted headers, so `response.headers`
		// simply doesn't contain them. No error, no warning — the ids are
		// invisible to the very code that would log them, which is most of the
		// point of stamping them. Native clients are unaffected, so this is
		// invisible until someone tries to surface a request id in the web app.
		//
		// `ETag` is the same trap and the reason conditional GET needs it: the
		// browser's own HTTP cache revalidates without any of this, but code
		// that wants to hold a validator itself cannot read one it is not
		// exposed. Note `Content-Encoding` is safelisted already.
		w.Header().Set("Access-Control-Expose-Headers", "traceparent, x-request-id, ETag")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	// The one route that opts out of conditional GET, and the only one where
	// caching is actively wrong. Its body is a constant, so its ETag would be
	// constant forever — a prober sending If-None-Match would get 304 for the
	// life of the deployment, and a checker asserting `status == 200` would
	// report unhealthy with nothing wrong. A liveness probe wants proof the
	// server produced a response, not proof it hasn't changed.
	//
	// `no-store` also removes the one response that RFC 9111 §3.5 does NOT
	// protect from shared caches: this route carries no Authorization, so
	// without it a CDN with a default TTL could keep serving `{"status":"ok"}`
	// for a dead API. Setting it here rather than in the middleware because it
	// is a property of what this endpoint MEANS, not of the transport.
	w.Header().Set("Cache-Control", "no-store")
	apihttp.WriteJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "api",
	})
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	apihttp.WriteJSON(w, http.StatusOK, map[string]string{
		"user_id": claims.UserID,
	})
}
