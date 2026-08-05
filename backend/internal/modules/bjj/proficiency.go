package bjj

import (
	"context"
	"time"
)

// Proficiency is one technique's accumulated evidence.
//
// NOT A SCORE, and deliberately not. `docs/decisions/bjj-tracking-design.md`
// rules out asking anyone to rate their triangle 1–5 — people are bad at it,
// it goes stale, and it produces a number with no provenance. What this
// returns is the facts: drilled it twelve times, went for it three times in
// rolling, landed it twice. A reader can form a judgement from that and can
// always see what the judgement rests on.
type Proficiency struct {
	TechniqueID string `json:"technique_id"`
	// Name/Position/Category come from the shared library. They are here so a
	// client can render the list without a second fetch and a join of its own.
	Name     string `json:"name"`
	Position string `json:"position"`
	Category string `json:"category"`

	// The funnel. Drilled is practice; Attempted is went-for-it-and-missed;
	// Scored is landed it live. ATTEMPTED AND SCORED ARE DISJOINT — see the
	// migration — so Attempted+Scored is how often it was tried, and the
	// drilled→tried drop-off is the number the whole design is built around.
	Drilled   int `json:"drilled"`
	Attempted int `json:"attempted"`
	Scored    int `json:"scored"`
	// Conceded is this technique done TO the athlete. Nothing writes it today
	// (no client can author a technique-tagged conceded row) but the API
	// accepts one, so it is reported rather than silently dropped.
	Conceded int `json:"conceded"`
	// Defended is them going for it and the athlete stopping them — the
	// mirror of Attempted, and the half a roadmap's defensive criterion is
	// counted from. Reported alongside Conceded so the pair reads as one
	// exchange seen from both ends rather than as two unrelated tallies.
	Defended int `json:"defended"`

	// Sessions is how many separate sessions contributed, which is the
	// honesty check on every number above: twelve reps in one class is not
	// the same evidence as twelve reps across six weeks.
	Sessions int       `json:"sessions"`
	LastSeen time.Time `json:"last_seen"`
}

// Tried is how often the technique was attempted live at all.
func (p Proficiency) Tried() int { return p.Attempted + p.Scored }

// ProficiencySummary is the top-level funnel — the three numbers that are
// actually actionable before you look at any individual technique.
type ProficiencySummary struct {
	// Techniques is how many distinct techniques have any evidence at all.
	Techniques int `json:"techniques"`
	// Drilled is how many were ever drilled; TriedLive how many of those were
	// ever taken into a live round; Landed how many ever worked.
	//
	// These are COUNTS OF TECHNIQUES, not counts of reps. "You have drilled 34
	// techniques and taken 6 of them into a roll" is a finding. "You have done
	// 210 reps" is a statistic.
	Drilled   int `json:"drilled"`
	TriedLive int `json:"tried_live"`
	Landed    int `json:"landed"`
}

// SummariseProficiency folds the rows into the headline funnel.
//
// A pure function over the list rather than a second aggregate query: it
// cannot disagree with the rows the client is shown, which a separate
// COUNT(*) with its own WHERE clause eventually would. It is also the half
// worth testing, and this way it is testable without a database.
func SummariseProficiency(rows []Proficiency) ProficiencySummary {
	var s ProficiencySummary
	for _, p := range rows {
		s.Techniques++
		if p.Drilled > 0 {
			s.Drilled++
		}
		if p.Tried() > 0 {
			s.TriedLive++
		}
		if p.Scored > 0 {
			s.Landed++
		}
	}
	return s
}

// maxProficiencyRows bounds the list.
//
// Every list endpoint has a ceiling — `apihttp.ConditionalGet` buffers the
// whole response body to hash it, so peak memory per in-flight request is
// bounded by the largest response the API can produce, and that is only true
// if nothing is unbounded.
//
// It cannot bind today: the GROUP BY is on technique_id, which has an FK to
// `techniques`, so the row count is capped by the library — 466 entries. A
// client CANNOT reach this by inventing ids, as an earlier version of this
// comment claimed; the FK rejects them as invalid input.
//
// The only way it ever binds is the LIBRARY growing past 500, at which point
// the funnel starts truncating silently — no pagination, no error, and the
// summary folds from the truncated rows so it under-reports in step. That is
// pinned by a test asserting the catalog stays under this number, which is the
// version of this guard that can actually fail.
const maxProficiencyRows = 500

// ProficiencyRepository is the read side of the technique funnel.
type ProficiencyRepository interface {
	// ListProficiency returns one row per technique the athlete has evidence
	// for, most-evidence first.
	ListProficiency(ctx context.Context, userID string) ([]Proficiency, error)
}
