package devengine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ErrAuth marks an HTTP 401/403 from GitHub: a revoked or under-scoped token.
// It never self-heals, so the poll loop exits on it instead of retrying a
// dead credential every interval while looking alive.
var ErrAuth = errors.New("authentication failed")

// GitHubBoard reads a Projects v2 board over GraphQL. It is the polling
// BoardSource — the "temporary path" the design names: a user-owned project
// emits no usable projects_v2_item webhooks, so until the org project and
// GitHub App exist (N145) the engine asks every interval. The webhook gateway
// (N146) replaces this type, not its interface.
type GitHubBoard struct {
	Owner  string // user login owning the project
	Number int    // project number (the /projects/N in the URL)
	Token  string
	HTTP   *http.Client
	// Endpoint overrides the GraphQL URL in tests; empty means api.github.com.
	Endpoint string
}

// Token resolution: GITHUB_TOKEN if set, else `gh auth token`, so the shadow
// binary runs on any machine where gh is signed in without new credentials.
func ResolveToken(ctx context.Context) (string, error) {
	if t := os.Getenv("GITHUB_TOKEN"); t != "" {
		return t, nil
	}
	out, err := exec.CommandContext(ctx, "gh", "auth", "token").Output()
	if err != nil {
		return "", fmt.Errorf("no GITHUB_TOKEN and `gh auth token` failed: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

const boardQuery = `
query($owner: String!, $number: Int!, $after: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            __typename
            ... on Issue {
              number
              title
              body
              assignees(first: 10) { nodes { login } }
              labels(first: 20) { nodes { name } }
            }
          }
        }
      }
    }
  }
}`

// User and ProjectV2 are POINTERS on purpose: a null `user` or `projectV2`
// (typo'd owner/number, or a token that cannot read the project) must decode
// as "not found" and error — a value struct decodes it as an empty board,
// which reads exactly like health: `--once` prints "baseline taken" and the
// engine polls a void forever. Found in review; the connectivity check could
// not fail on the most likely misconfiguration.
type graphQLResponse struct {
	Data struct {
		User *struct {
			ProjectV2 *struct {
				Items struct {
					PageInfo struct {
						HasNextPage bool   `json:"hasNextPage"`
						EndCursor   string `json:"endCursor"`
					} `json:"pageInfo"`
					Nodes []itemNode `json:"nodes"`
				} `json:"items"`
			} `json:"projectV2"`
		} `json:"user"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

type itemNode struct {
	FieldValueByName *struct {
		Name string `json:"name"`
	} `json:"fieldValueByName"`
	Content *struct {
		Typename  string `json:"__typename"`
		Number    int    `json:"number"`
		Title     string `json:"title"`
		Body      string `json:"body"`
		Assignees struct {
			Nodes []struct {
				Login string `json:"login"`
			} `json:"nodes"`
		} `json:"assignees"`
		Labels struct {
			Nodes []struct {
				Name string `json:"name"`
			} `json:"nodes"`
		} `json:"labels"`
	} `json:"content"`
}

func (g *GitHubBoard) Snapshot(ctx context.Context) ([]Item, error) {
	var items []Item
	after := ""
	for {
		page, next, err := g.page(ctx, after)
		if err != nil {
			return nil, err
		}
		items = append(items, page...)
		if next == "" {
			return items, nil
		}
		after = next
	}
}

func (g *GitHubBoard) page(ctx context.Context, after string) ([]Item, string, error) {
	vars := map[string]any{"owner": g.Owner, "number": g.Number}
	if after != "" {
		vars["after"] = after
	}
	body, err := json.Marshal(map[string]any{"query": boardQuery, "variables": vars})
	if err != nil {
		return nil, "", err
	}
	endpoint := g.Endpoint
	if endpoint == "" {
		endpoint = "https://api.github.com/graphql"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+g.Token)
	req.Header.Set("Content-Type", "application/json")

	client := g.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		// An auth failure never self-heals, so callers treat it as fatal
		// rather than retrying it at full rate forever.
		return nil, "", fmt.Errorf("github graphql: HTTP %d: %w", resp.StatusCode, ErrAuth)
	}
	if resp.StatusCode != http.StatusOK {
		// Status text only — the body of a GitHub error can carry request
		// details that do not belong in a decision log.
		return nil, "", fmt.Errorf("github graphql: HTTP %d", resp.StatusCode)
	}
	var parsed graphQLResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, "", fmt.Errorf("github graphql: %w", err)
	}
	if len(parsed.Errors) > 0 {
		return nil, "", fmt.Errorf("github graphql: %s", parsed.Errors[0].Message)
	}
	if parsed.Data.User == nil || parsed.Data.User.ProjectV2 == nil {
		return nil, "", fmt.Errorf(
			"github graphql: user %q or project %d not found — check --owner/--project and that the token can read the project",
			g.Owner, g.Number)
	}

	var items []Item
	for _, n := range parsed.Data.User.ProjectV2.Items.Nodes {
		items = append(items, n.toItem())
	}
	page := parsed.Data.User.ProjectV2.Items.PageInfo
	if page.HasNextPage {
		return items, page.EndCursor, nil
	}
	return items, "", nil
}

func (n itemNode) toItem() Item {
	it := Item{}
	if n.FieldValueByName != nil {
		it.Status = n.FieldValueByName.Name
	}
	// A draft project item's content is a DraftIssue (or absent): no number,
	// no issue behind it. Everything that is not an Issue is a draft to the
	// dispatcher — it cannot be claimed, tested or closed.
	if n.Content == nil || n.Content.Typename != "Issue" {
		it.IsDraft = true
		if n.Content != nil {
			it.Title = n.Content.Title
		}
		return it
	}
	it.IssueNumber = n.Content.Number
	it.Title = n.Content.Title
	it.Body = n.Content.Body
	for _, a := range n.Content.Assignees.Nodes {
		it.Assignees = append(it.Assignees, a.Login)
	}
	for _, l := range n.Content.Labels.Nodes {
		it.Labels = append(it.Labels, l.Name)
	}
	return it
}
