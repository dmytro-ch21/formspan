package biometric

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func validSample() Sample {
	return Sample{
		ID:             "s1",
		MetricType:     MetricHeartRate,
		Source:         SourceAppleWatch,
		SourcePlatform: PlatformHealthKit,
		Value:          150,
		Unit:           "bpm",
		MeasuredAt:     time.Now(),
	}
}

func TestSample_Validate_HappyPath(t *testing.T) {
	if err := validSample().Validate(); err != nil {
		t.Fatalf("valid sample rejected: %v", err)
	}
}

func TestSample_Validate_RejectsEmptyID(t *testing.T) {
	s := validSample()
	s.ID = ""
	if err := s.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("empty id: want ErrInvalidInput, got %v", err)
	}
}

func TestSample_Validate_RejectsOverlongID(t *testing.T) {
	s := validSample()
	s.ID = strings.Repeat("x", maxSampleIDLength+1)
	if err := s.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("overlong id: want ErrInvalidInput, got %v", err)
	}
}

func TestSample_Validate_AcceptsIDAtTheLengthLimit(t *testing.T) {
	s := validSample()
	s.ID = strings.Repeat("x", maxSampleIDLength)
	if err := s.Validate(); err != nil {
		t.Errorf("id exactly at the limit: want nil, got %v", err)
	}
}

func TestSample_Validate_RejectsUnknownMetricType(t *testing.T) {
	s := validSample()
	s.MetricType = "not_a_real_metric"
	if err := s.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("unknown metric_type: want ErrInvalidInput, got %v", err)
	}
}

func TestSample_Validate_RejectsUnknownSource(t *testing.T) {
	s := validSample()
	s.Source = "some_unlisted_vendor"
	if err := s.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("unknown source: want ErrInvalidInput, got %v", err)
	}
}

func TestSample_Validate_RejectsUnknownSourcePlatform(t *testing.T) {
	s := validSample()
	s.SourcePlatform = "some_other_platform"
	if err := s.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("unknown source_platform: want ErrInvalidInput, got %v", err)
	}
}

func TestSample_Validate_RejectsEmptyUnit(t *testing.T) {
	s := validSample()
	s.Unit = ""
	if err := s.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("empty unit: want ErrInvalidInput, got %v", err)
	}
}

func TestSample_Validate_RejectsZeroMeasuredAt(t *testing.T) {
	s := validSample()
	s.MeasuredAt = time.Time{}
	if err := s.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("zero measured_at: want ErrInvalidInput, got %v", err)
	}
}

func TestSample_Validate_AcceptsNilPeriodEnd(t *testing.T) {
	s := validSample()
	s.PeriodEnd = nil
	if err := s.Validate(); err != nil {
		t.Errorf("nil period_end (instantaneous reading): want nil, got %v", err)
	}
}

func TestSample_Validate_RejectsPeriodEndBeforeMeasuredAt(t *testing.T) {
	s := validSample()
	before := s.MeasuredAt.Add(-time.Minute)
	s.PeriodEnd = &before
	if err := s.Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("period_end before measured_at: want ErrInvalidInput, got %v", err)
	}
}

func TestSample_Validate_AcceptsPeriodEndEqualToMeasuredAt(t *testing.T) {
	s := validSample()
	end := s.MeasuredAt
	s.PeriodEnd = &end
	if err := s.Validate(); err != nil {
		t.Errorf("period_end == measured_at: want nil, got %v", err)
	}
}

func TestSample_Validate_AcceptsPeriodEndAfterMeasuredAt(t *testing.T) {
	s := validSample()
	end := s.MeasuredAt.Add(8 * time.Hour) // e.g. a night's sleep_duration
	s.PeriodEnd = &end
	if err := s.Validate(); err != nil {
		t.Errorf("period_end after measured_at: want nil, got %v", err)
	}
}

// TestMetricType_VO2Max_WireValueAndAcceptance pins the literal wire string
// N477/#822's mobile client writes ("vo2_max") and checks a real Sample
// carrying it clears Validate — a generic "every MetricTypes() value is
// Valid()" loop would pass even if this constant's string were wrong, since
// Valid() checks membership in the very slice the loop reads from.
func TestMetricType_VO2Max_WireValueAndAcceptance(t *testing.T) {
	if MetricVO2Max != "vo2_max" {
		t.Fatalf("MetricVO2Max = %q, want \"vo2_max\"", MetricVO2Max)
	}
	s := validSample()
	s.MetricType = MetricVO2Max
	s.Unit = "ml/(kg*min)"
	if err := s.Validate(); err != nil {
		t.Errorf("vo2_max sample rejected: %v", err)
	}
}

func TestMetricTypes_EveryValueValidatesItself(t *testing.T) {
	for _, m := range MetricTypes() {
		if !m.Valid() {
			t.Errorf("%q from MetricTypes() is not Valid()", m)
		}
	}
}

func TestSources_EveryValueValidatesItself(t *testing.T) {
	for _, s := range Sources() {
		if !s.Valid() {
			t.Errorf("%q from Sources() is not Valid()", s)
		}
	}
}

func TestSourcePlatforms_EveryValueValidatesItself(t *testing.T) {
	for _, p := range SourcePlatforms() {
		if !p.Valid() {
			t.Errorf("%q from SourcePlatforms() is not Valid()", p)
		}
	}
}

func TestHRSources_EveryValueValidatesItself(t *testing.T) {
	for _, s := range HRSources() {
		if !s.Valid() {
			t.Errorf("%q from HRSources() is not Valid()", s)
		}
	}
}

func TestHRSource_RejectsUnknownValue(t *testing.T) {
	if HRSource("bogus").Valid() {
		t.Error(`HRSource("bogus").Valid() = true, want false`)
	}
	if HRSource("").Valid() {
		t.Error(`HRSource("").Valid() = true, want false -- must never silently default`)
	}
}
