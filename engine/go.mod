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
// Deliberately dependency-free: GitHub GraphQL over net/http, policy files
// via encoding/json (which is why .vola-agent/ is JSON, not YAML).
module github.com/dmytro-ch21/vola/engine

go 1.26.1
