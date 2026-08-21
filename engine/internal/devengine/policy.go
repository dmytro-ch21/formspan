package devengine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Policy mirrors .vola-agent/policy.json — the half the dispatcher needs.
// scripts/check-agent-policy.py owns validation; the engine only refuses to
// start on files it cannot parse, so the two never disagree about validity.
type Policy struct {
	Version                   int    `json:"version"`
	BaseBranch                string `json:"base_branch"`
	MaxCIFixAttempts          int    `json:"max_ci_fix_attempts"`
	MaxRuntimeMinutes         int    `json:"max_runtime_minutes"`
	RequireCleanTree          bool   `json:"require_clean_tree"`
	RequireAcceptanceCriteria bool   `json:"require_acceptance_criteria"`
	AutoMerge                 struct {
		Enabled     bool     `json:"enabled"`
		AllowedRisk []string `json:"allowed_risk"`
	} `json:"auto_merge"`
	HumanGate struct {
		Paths  []string `json:"paths"`
		Labels []string `json:"labels"`
	} `json:"human_gate"`
}

// RiskRules mirrors .vola-agent/risk-rules.json.
type RiskRules struct {
	Version     int        `json:"version"`
	DefaultRisk string     `json:"default_risk"`
	RaiseOnly   bool       `json:"raise_only"`
	Rules       []RiskRule `json:"rules"`
}

type RiskRule struct {
	Risk   string   `json:"risk"`
	Reason string   `json:"reason"`
	Paths  []string `json:"paths"`
	Labels []string `json:"labels"`
}

// ContextMap mirrors .vola-agent/context-map.json.
type ContextMap struct {
	Version        int            `json:"version"`
	GateVocabulary []string       `json:"gate_vocabulary"`
	Entries        []ContextEntry `json:"entries"`
}

type ContextEntry struct {
	Paths []string `json:"paths"`
	Docs  []string `json:"docs"`
	Traps []string `json:"traps"`
	Gates []string `json:"gates"`
}

// Config is the loaded .vola-agent directory.
type Config struct {
	Policy     Policy
	RiskRules  RiskRules
	ContextMap ContextMap
}

// LoadConfig reads the three JSON policy files from dir. It fails on any
// missing or unparsable file rather than defaulting: a dispatcher running on
// half a policy is worse than one that refuses to start.
func LoadConfig(dir string) (Config, error) {
	var cfg Config
	if err := readJSON(filepath.Join(dir, "policy.json"), &cfg.Policy); err != nil {
		return cfg, err
	}
	if err := readJSON(filepath.Join(dir, "risk-rules.json"), &cfg.RiskRules); err != nil {
		return cfg, err
	}
	if err := readJSON(filepath.Join(dir, "context-map.json"), &cfg.ContextMap); err != nil {
		return cfg, err
	}
	if !cfg.RiskRules.RaiseOnly {
		// Belt to the validator's braces: even if a stale or hand-edited file
		// reaches us, the engine will not run under a policy that permits
		// lowering a human-set risk.
		return cfg, fmt.Errorf("risk-rules.json: raise_only must be true")
	}
	return cfg, nil
}

func readJSON(path string, into any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, into); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

// riskRank orders risk levels so "raise" has a meaning. Unknown levels rank
// highest: an unrecognised risk is treated as the most cautious reading, and
// the policy validator keeps unknowns out of the checked-in files anyway.
func riskRank(risk string) int {
	switch risk {
	case "low":
		return 0
	case "medium":
		return 1
	case "high":
		return 2
	default:
		return 3
	}
}

// ClassifyRisk starts from the ticket's explicit risk (or the default when
// absent) and applies matching rules, RAISING ONLY — a rule can never lower
// what a human wrote on the ticket. A rule matches by label intersection or
// by any touched path falling under one of its path patterns (which is how a
// present migration raises risk: `backend/migrations/**` matches the new
// file). Before a diff exists, touched is empty and only labels can match.
func ClassifyRisk(explicit string, labels, touched []string, rules RiskRules) string {
	risk := explicit
	if risk == "" {
		risk = rules.DefaultRisk
	}
	for _, rule := range rules.Rules {
		if !labelsIntersect(labels, rule.Labels) && !pathsIntersect(touched, rule.Paths) {
			continue
		}
		if riskRank(rule.Risk) > riskRank(risk) {
			risk = rule.Risk
		}
	}
	return risk
}

func pathsIntersect(touched, patterns []string) bool {
	for _, pattern := range patterns {
		for _, p := range touched {
			if PathMatches(pattern, p) {
				return true
			}
		}
	}
	return false
}

func labelsIntersect(have, want []string) bool {
	for _, w := range want {
		for _, h := range have {
			if strings.EqualFold(h, w) {
				return true
			}
		}
	}
	return false
}

// PlanContext selects the context-map entries relevant to a ticket before any
// code exists: an entry applies when one of its path prefixes appears in the
// ticket's ## Scope section (the half of the ticket contract that claims
// ownership; the whole body only when no Scope section exists). Docs, traps
// and gates are deduplicated, preserving map order.
func PlanContext(body string, cm ContextMap) ContextPlan {
	body = ScopeSection(body)
	var plan ContextPlan
	seenDoc := map[string]bool{}
	seenTrap := map[string]bool{}
	seenGate := map[string]bool{}
	for _, entry := range cm.Entries {
		if !entryMentioned(body, entry) {
			continue
		}
		for _, d := range entry.Docs {
			if !seenDoc[d] {
				seenDoc[d] = true
				plan.Docs = append(plan.Docs, d)
			}
		}
		for _, t := range entry.Traps {
			if !seenTrap[t] {
				seenTrap[t] = true
				plan.Traps = append(plan.Traps, t)
			}
		}
		for _, g := range entry.Gates {
			if !seenGate[g] {
				seenGate[g] = true
				plan.Gates = append(plan.Gates, g)
			}
		}
	}
	return plan
}

func entryMentioned(body string, entry ContextEntry) bool {
	for _, p := range entry.Paths {
		prefix := globPrefix(p)
		if prefix != "" && strings.Contains(body, prefix) {
			return true
		}
	}
	return false
}

// globPrefix returns the literal path before any glob character — the same
// rule scripts/check-agent-policy.py uses, so both sides read one pattern
// the same way.
func globPrefix(pattern string) string {
	i := strings.IndexAny(pattern, "*?[")
	if i < 0 {
		return pattern
	}
	return strings.TrimRight(pattern[:i], "/")
}
