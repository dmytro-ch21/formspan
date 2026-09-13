package narration

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func goodInput() Input {
	return Input{Facts: []Fact{
		{Key: "food-eaten:2026-09-12", Kind: "food-eaten", Label: "Eaten today: 1,840 kcal across 3 entries", Numbers: []string{"1840", "3"}},
		{Key: "logged:s9", Kind: "logged", Label: "5x5 Day logged", Names: []string{"5x5 Day"}},
	}}
}

func TestValidateAcceptsAWellFormedDay(t *testing.T) {
	if err := goodInput().Validate(); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestValidateRefusesWhatCannotSucceed(t *testing.T) {
	long := strings.Repeat("x", MaxLabelRunes+1)
	cases := []struct {
		name   string
		mutate func(*Input)
		want   string
	}{
		{"no facts", func(in *Input) { in.Facts = nil }, "nothing to narrate"},
		{"a missing key", func(in *Input) { in.Facts[0].Key = " " }, "has no key"},
		{"a duplicate key", func(in *Input) { in.Facts[1].Key = in.Facts[0].Key }, "appears twice"},
		{"an unknown kind", func(in *Input) { in.Facts[0].Kind = "horoscope" }, "unknown kind"},
		{"an empty label", func(in *Input) { in.Facts[0].Label = "" }, "has no label"},
		{"an over-long label", func(in *Input) { in.Facts[0].Label = long }, "longer than"},
		{"a malformed number", func(in *Input) { in.Facts[0].Numbers = []string{"1,840"} }, "malformed number"},
		{"a number to two decimals", func(in *Input) { in.Facts[0].Numbers = []string{"82.43"} }, "malformed number"},
		{"an empty name", func(in *Input) { in.Facts[1].Names = []string{""} }, "empty or over-long name"},
		{"a label stating a number it does not back", func(in *Input) { in.Facts[0].Numbers = []string{"3"} }, "label states a number"},
		{"too many facts", func(in *Input) {
			f := in.Facts[0]
			in.Facts = nil
			for i := 0; i <= MaxFacts; i++ {
				g := f
				g.Key = f.Key + strings.Repeat("x", i)
				in.Facts = append(in.Facts, g)
			}
		}, "more than"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := goodInput()
			c.mutate(&in)
			err := in.Validate()
			if !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want ErrInvalidInput containing %q, got %v", c.want, err)
			}
		})
	}
}

func TestValidateDoesNotReadANamesDigitsAsTheLabelsNumbers(t *testing.T) {
	in := Input{Facts: []Fact{{Key: "logged:s1", Kind: "logged", Label: "5K run logged", Names: []string{"5K run"}}}}
	if err := in.Validate(); err != nil {
		t.Fatalf("a name with a digit should not need backing: %v", err)
	}
}

func TestNewQuotaClampsAndDerivesTheReset(t *testing.T) {
	q := NewQuota(DailyNarrations+2, nil)
	if q.Remaining != 0 || q.Allowed() || q.ResetsAt != nil || q.Limit != DailyNarrations {
		t.Fatalf("got %+v", q)
	}
	oldest := time.Date(2026, 9, 12, 8, 0, 0, 0, time.UTC)
	q = NewQuota(1, &oldest)
	if q.Remaining != DailyNarrations-1 || !q.Allowed() || !q.ResetsAt.Equal(oldest.Add(QuotaWindow)) {
		t.Fatalf("got %+v", q)
	}
}

func TestNormaliseMatchesThePhonesSpelling(t *testing.T) {
	for raw, want := range map[string]string{"1,840": "1840", "82.40": "82.4", "09": "9", "3": "3", "0.5": "0.5"} {
		if got := normalise(raw); got != want {
			t.Errorf("normalise(%q) = %q, want %q", raw, got, want)
		}
	}
}
