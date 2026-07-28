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

USER app
WORKDIR /app

# Overridden per-service by railway/*.toml's startCommand.
CMD ["/app/bin/api"]
