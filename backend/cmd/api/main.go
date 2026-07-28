package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"github.com/dmytro-ch21/formspan/backend/internal/modules/profile"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/auth"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/database"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	clerkIssuer := os.Getenv("CLERK_ISSUER")
	if clerkIssuer == "" {
		log.Fatal("CLERK_ISSUER must be set (see backend/.env.example)")
	}
	verifier, err := auth.NewVerifier(context.Background(), clerkIssuer)
	if err != nil {
		log.Fatalf("auth: %v", err)
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL must be set (see backend/.env.example)")
	}
	pool, err := database.NewPool(context.Background(), databaseURL)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer pool.Close()

	profileHandler := profile.NewHandler(profile.NewPostgresRepository(pool))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/healthz", handleHealthz)
	mux.Handle("GET /v1/me", verifier.RequireAuth(http.HandlerFunc(handleMe)))
	mux.Handle("GET /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Get)))
	mux.Handle("POST /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Create)))
	mux.Handle("PATCH /v1/profile", verifier.RequireAuth(http.HandlerFunc(profileHandler.Update)))

	log.Printf("api listening on :%s", port)
	if err := http.ListenAndServe(":"+port, withCORS(mux)); err != nil {
		log.Fatal(err)
	}
}

// withCORS allows the local web dev server to call the API from a different
// origin (localhost:3000 -> localhost:8080). Revisit this allowlist once
// staging/production domains exist.
func withCORS(next http.Handler) http.Handler {
	allowedOrigin := os.Getenv("WEB_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "http://localhost:3000"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
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
