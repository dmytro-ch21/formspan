package devengine

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Fixture shape note, per the "a stub built from an assumption cannot falsify
// it" rule: these bodies mirror a REAL response captured from the live GitHub
// GraphQL API against the actual VOLA board (project 2, owner dmytro-ch21) on
// 2026-08-21 — the nesting (data.user.projectV2.items.nodes, fieldValueByName,
// content.__typename) is measured, not guessed. The live cross-check is
// repeatable with `go run ./cmd/devengine --once`.
const pageOne = `{"data":{"user":{"projectV2":{"items":{
  "pageInfo":{"hasNextPage":true,"endCursor":"CURSOR1"},
  "nodes":[
    {"fieldValueByName":{"name":"Todo"},
     "content":{"__typename":"Issue","number":558,"title":"N136 — policy contract",
       "body":"## Acceptance criteria\n- [ ] a thing\n",
       "assignees":{"nodes":[]},"labels":{"nodes":[{"name":"section: N"}]}}},
    {"fieldValueByName":{"name":"Todo"},
     "content":{"__typename":"DraftIssue","title":"an idea on a card"}}
  ]}}}}}`

const pageTwo = `{"data":{"user":{"projectV2":{"items":{
  "pageInfo":{"hasNextPage":false,"endCursor":null},
  "nodes":[
    {"fieldValueByName":{"name":"In Progress"},
     "content":{"__typename":"Issue","number":559,"title":"N137 — reconciler",
       "body":"b","assignees":{"nodes":[{"login":"dmytro-ch21"}]},"labels":{"nodes":[]}}}
  ]}}}}}`

func TestSnapshotPaginatesAndMapsItems(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("Authorization = %q", got)
		}
		var req struct {
			Variables map[string]any `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		if after, ok := req.Variables["after"]; ok {
			if after != "CURSOR1" {
				t.Errorf("after = %v, want CURSOR1", after)
			}
			w.Write([]byte(pageTwo))
			return
		}
		w.Write([]byte(pageOne))
	}))
	defer srv.Close()

	b := &GitHubBoard{Owner: "dmytro-ch21", Number: 2, Token: "tok", Endpoint: srv.URL}
	items, err := b.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2 (pagination not followed)", calls)
	}
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3", len(items))
	}
	if items[0].IssueNumber != 558 || items[0].Status != "Todo" || items[0].Labels[0] != "section: N" {
		t.Fatalf("item 0 mapped wrong: %+v", items[0])
	}
	if !items[1].IsDraft || items[1].IssueNumber != 0 {
		t.Fatalf("draft item not marked draft: %+v", items[1])
	}
	if items[2].Assignees[0] != "dmytro-ch21" || items[2].Status != "In Progress" {
		t.Fatalf("item 2 mapped wrong: %+v", items[2])
	}
}

func TestSnapshotReportsHTTPErrorsWithoutTheBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "secret-bearing detail", http.StatusBadGateway)
	}))
	defer srv.Close()
	b := &GitHubBoard{Owner: "o", Number: 1, Token: "tok", Endpoint: srv.URL}
	_, err := b.Snapshot(context.Background())
	if err == nil {
		t.Fatal("HTTP 502 did not error")
	}
	if got := err.Error(); got != "github graphql: HTTP 502" {
		t.Fatalf("error leaks response body or hides status: %q", got)
	}
}

func TestSnapshotErrorsOnNullUserOrProject(t *testing.T) {
	// A null user/projectV2 (typo'd owner or number, token that cannot read
	// the project) must be an ERROR, never an empty board: an empty board
	// reads exactly like health, and the engine would poll a void forever.
	for name, body := range map[string]string{
		"null user":    `{"data":{"user":null}}`,
		"null project": `{"data":{"user":{"projectV2":null}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Write([]byte(body))
			}))
			defer srv.Close()
			b := &GitHubBoard{Owner: "nobody", Number: 999, Token: "tok", Endpoint: srv.URL}
			_, err := b.Snapshot(context.Background())
			if err == nil {
				t.Fatal("null data decoded as an empty board with no error")
			}
		})
	}
}

func TestSnapshotMarksAuthFailuresAsErrAuth(t *testing.T) {
	// 401/403 never self-heals; the poll loop exits on ErrAuth instead of
	// retrying a dead credential every interval while looking alive.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	b := &GitHubBoard{Owner: "o", Number: 1, Token: "expired", Endpoint: srv.URL}
	_, err := b.Snapshot(context.Background())
	if !errors.Is(err, ErrAuth) {
		t.Fatalf("401 not classified as ErrAuth: %v", err)
	}
}

func TestSnapshotSurfacesGraphQLErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"data":null,"errors":[{"message":"Could not resolve to a User"}]}`))
	}))
	defer srv.Close()
	b := &GitHubBoard{Owner: "nobody", Number: 1, Token: "tok", Endpoint: srv.URL}
	_, err := b.Snapshot(context.Background())
	if err == nil {
		t.Fatal("GraphQL error did not surface — a 200 with an errors array reads as an empty board otherwise")
	}
}
