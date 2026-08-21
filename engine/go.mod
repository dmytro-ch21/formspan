// The VOLA dev engine — the AI-SDLC orchestrator (N135–N147).
//
// A SEPARATE module from backend/ on purpose, and the reason is the trust
// boundary: backend/Dockerfile builds every binary under backend/cmd/... into
// the image Railway deploys, so engine code under backend/cmd would ship
// inside the product API image by construction. This module is built and
// tested by CI (steps inside the Backend (Go) job) but is part of no deployed
// image, and it moves to the private vola-dev-engine repo once the GitHub
// organization and App exist (N145, #569).
//
// Dependencies are deliberately minimal: GitHub GraphQL over net/http, policy
// files via encoding/json (which is why .vola-agent/ is JSON, not YAML), and
// pgx for the engine's OWN Postgres (runstate) — a separate database from the
// product's, with its own embedded migrations.
module github.com/dmytro-ch21/vola/engine

go 1.26.1

require github.com/jackc/pgx/v5 v5.10.0

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/sync v0.17.0 // indirect
	golang.org/x/text v0.29.0 // indirect
)
