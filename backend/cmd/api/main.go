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

	"github.com/dmytro-ch21/vola/backend/internal/modules/activity"
	"github.com/dmytro-ch21/vola/backend/internal/modules/bjj"
	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/dmytro-ch21/vola/backend/internal/modules/featureflag"
	"github.com/dmytro-ch21/vola/backend/internal/modules/health"
	"github.com/dmytro-ch21/vola/backend/internal/modules/profile"
	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
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
	featureFlagHandler := featureflag.NewHandler(featureflag.NewPostgresRepository(pool))
	activityHandler := activity.NewHandler(activity.NewPostgresRepository(pool))
	exerciseHandler := exercise.NewHandler(exercise.NewPostgresRepository(pool), os.Getenv("MEDIA_BASE_URL"))
	workoutHandler := workout.NewHandler(workout.NewPostgresRepository(pool))
	techniqueHandler := technique.NewHandler(technique.NewPostgresRepository(pool))
	sessionHandler := session.NewHandler(session.NewPostgresRepository(pool))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/healthz", handleHealthz)
	mux.Handle("GET /v1/me", verifier.RequireAuth(http.HandlerFunc(handleMe)))
	// BJJ rank. Under /v1/bjj rather than /v1/profile because the data is
	// discipline-scoped — see the note at the top of profile.go. The screens
	// still show it inside the profile; that is a UI decision, not a
	// reason to put a belt on the account record every sport shares.
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
	mux.Handle("GET /v1/techniques", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.List)))
	// Registered before the wildcard for readability only — Go 1.22's mux
	// picks the more specific pattern regardless of order, so the literal
	// "rulesets" wins over "{techniqueID}" and there is no shadowing risk.
	mux.Handle("GET /v1/techniques/rulesets", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.Rulesets)))
	mux.Handle("GET /v1/techniques/positions", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.Positions)))
	mux.Handle("GET /v1/techniques/positions/{positionID}", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.GetPosition)))
	mux.Handle("GET /v1/techniques/{techniqueID}", verifier.RequireAuth(http.HandlerFunc(techniqueHandler.Get)))
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
	mux.Handle("GET /v1/records/pinned", verifier.RequireAuth(http.HandlerFunc(sessionHandler.PinnedExercises)))
	mux.Handle("PUT /v1/records/pinned", verifier.RequireAuth(http.HandlerFunc(sessionHandler.SetPinnedExercises)))
	mux.Handle("GET /v1/sessions/{sessionID}", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Get)))
	mux.Handle("PUT /v1/sessions/{sessionID}/sets", verifier.RequireAuth(http.HandlerFunc(sessionHandler.ReplaceSets)))
	mux.Handle("POST /v1/sessions/{sessionID}/finish", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Finish)))
	mux.Handle("PATCH /v1/sessions/{sessionID}", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Rename)))
	mux.Handle("DELETE /v1/sessions/{sessionID}", verifier.RequireAuth(http.HandlerFunc(sessionHandler.Delete)))
	mux.Handle("GET /v1/workouts", verifier.RequireAuth(http.HandlerFunc(workoutHandler.List)))
	mux.Handle("POST /v1/workouts", verifier.RequireAuth(http.HandlerFunc(workoutHandler.Create)))
	mux.Handle("GET /v1/workouts/{workoutID}", verifier.RequireAuth(http.HandlerFunc(workoutHandler.Get)))
	mux.Handle("PUT /v1/workouts/{workoutID}/items", verifier.RequireAuth(http.HandlerFunc(workoutHandler.ReplaceItems)))
	mux.Handle("DELETE /v1/workouts/{workoutID}", verifier.RequireAuth(http.HandlerFunc(workoutHandler.Delete)))
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
	if err := http.ListenAndServe(":"+port, httplog.Middleware(logger, recorder.Observe)(apihttp.Stack(withCORS(mux)))); err != nil {
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
