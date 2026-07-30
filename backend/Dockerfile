# Builds every binary under cmd/* into /app/bin/. Railway services all use
# this same image; which binary actually runs is decided per-service by the
# start command in the matching railway/*.toml (see railway/api.toml).
FROM golang:1.26-alpine AS build

WORKDIR /src

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /app/bin/ ./cmd/...

FROM alpine:3.20

RUN apk add --no-cache ca-certificates && \
    addgroup -S app && adduser -S app -G app

COPY --from=build /app/bin/ /app/bin/
COPY migrations/ /app/migrations/

# The pre-deploy chain, as a script rather than a command string.
#
# Railway executes preDeployCommand as argv, and observably splits it on
# whitespace: "/app/bin/migrate up && /app/bin/seed" reached migrate as the
# extra arguments `&&` and `/app/bin/seed`, which it ignored -- so migrations
# ran, seed silently did not, and staging served an empty exercise catalog
# behind a green healthcheck.
#
# `sh -c '...'` would only fix that if Railway tokenises quotes like a shell,
# which the evidence above says it does not. A single-token command has no
# such dependency: whatever the splitting rules, there is nothing to split.
RUN printf '#!/bin/sh\nset -eu\n/app/bin/migrate up\n/app/bin/seed\n' \
      > /app/bin/predeploy && chmod +x /app/bin/predeploy

USER app
WORKDIR /app

# Overridden per-service by railway/*.toml's startCommand.
CMD ["/app/bin/api"]
