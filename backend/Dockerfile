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
# Railway executes preDeployCommand as argv and does not run it through a
# shell: "/app/bin/migrate up && /app/bin/seed" ran migrations and never ran
# seed, leaving staging with an empty exercise catalog behind a green
# healthcheck.
#
# Specifically, migrate exited 0 from a clean `up`. Since cmd/migrate rejects
# anything but exactly one argument, it cannot have received `&&` and the seed
# path and ignored them — Railway dropped them during parsing. How it handles
# quotes is still unobserved, so `sh -c '...'` would be a fix resting on an
# assumption. A single token has nothing to split and no such dependency.
RUN printf '#!/bin/sh\nset -eu\n/app/bin/migrate up\n/app/bin/seed\n' \
      > /app/bin/predeploy && chmod +x /app/bin/predeploy

USER app
WORKDIR /app

# Overridden per-service by railway/*.toml's startCommand.
CMD ["/app/bin/api"]
