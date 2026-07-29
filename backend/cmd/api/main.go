package main

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/dmytro-ch21/formspan/backend/internal/modules/activity"
	"github.com/dmytro-ch21/formspan/backend/internal/modules/featureflag"
	"github.com/dmytro-ch21/formspan/backend/internal/modules/profile"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/auth"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/database"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/httplog"
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
	featureFlagHandler := featureflag.NewHandler(featureflag.NewPostgresRepository(pool))
	activityHandler := activity.NewHandler(activity.NewPostgresRepository(pool))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/healthz", handleHealthz)
	mux.Handle("GET /v1/me", verifier.RequireAuth(http.HandlerFunc(handleMe)))
	mux.Handle("GET /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Get)))
	mux.Handle("POST /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Create)))
	mux.Handle("PATCH /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Update)))
	mux.Handle("GET /v1/flags", verifier.RequireAuth(http.HandlerFunc(featureFlagHandler.List)))
	mux.Handle("POST /v1/activities", verifier.RequireAuth(http.HandlerFunc(activityHandler.Create)))
	mux.Handle("GET /v1/activities", verifier.RequireAuth(http.HandlerFunc(activityHandler.List)))
	mux.Handle("GET /v1/admin/users", verifier.RequireAdmin(http.HandlerFunc(activityHandler.AdminListUsers)))
	mux.Handle("GET /v1/admin/users/{userID}/activities", verifier.RequireAdmin(http.HandlerFunc(activityHandler.AdminListUserActivities)))

	logger.Info("api listening", "port", port)
	if err := http.ListenAndServe(":"+port, httplog.Middleware(logger)(withCORS(mux))); err != nil {
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
		if allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, traceparent")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
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
