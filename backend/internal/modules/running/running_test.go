package running

import (
	"strings"
	"testing"
)

func TestSourceValid(t *testing.T) {
	for _, s := range Sources() {
		if !s.Valid() {
			t.Fatalf("%q from Sources() reported invalid", s)
		}
	}
	if Source("watch").Valid() {
		t.Fatal("unknown source reported valid")
	}
}

func ptr[T any](v T) *T { return &v }

func TestSessionDetailValidate(t *testing.T) {
	cases := []struct {
		name    string
		detail  SessionDetail
		wantErr bool
	}{
		{
			name:   "minimal manual entry",
			detail: SessionDetail{Source: SourceManual},
		},
		{
			name: "full phone GPS run",
			detail: SessionDetail{
				Source:          SourcePhoneGPS,
				DistanceM:       ptr(5000.0),
				DurationSeconds: ptr(1500),
				ElevationGainM:  ptr(42.0),
				AvgPaceSecPerKm: ptr(300.0),
				RoutePoints: []RoutePoint{
					{Lat: 40.7128, Lng: -74.0060},
					{Lat: 40.7130, Lng: -74.0062, ElevationM: ptr(12.5)},
				},
				Splits: []Split{
					{DistanceM: 1000, DurationSeconds: 300},
					{DistanceM: 1000, DurationSeconds: 305},
				},
			},
		},
		{
			name:    "unknown source",
			detail:  SessionDetail{Source: "watch"},
			wantErr: true,
		},
		{
			name:    "negative distance",
			detail:  SessionDetail{Source: SourceManual, DistanceM: ptr(-1.0)},
			wantErr: true,
		},
		{
			name:    "negative duration",
			detail:  SessionDetail{Source: SourceManual, DurationSeconds: ptr(-1)},
			wantErr: true,
		},
		{
			name:    "negative elevation gain",
			detail:  SessionDetail{Source: SourceManual, ElevationGainM: ptr(-1.0)},
			wantErr: true,
		},
		{
			name:    "negative pace",
			detail:  SessionDetail{Source: SourceManual, AvgPaceSecPerKm: ptr(-1.0)},
			wantErr: true,
		},
		{
			name: "latitude out of range",
			detail: SessionDetail{
				Source:      SourcePhoneGPS,
				RoutePoints: []RoutePoint{{Lat: 91, Lng: 0}},
			},
			wantErr: true,
		},
		{
			name: "longitude out of range",
			detail: SessionDetail{
				Source:      SourcePhoneGPS,
				RoutePoints: []RoutePoint{{Lat: 0, Lng: 181}},
			},
			wantErr: true,
		},
		{
			name: "split with zero distance",
			detail: SessionDetail{
				Source: SourceManual,
				Splits: []Split{{DistanceM: 0, DurationSeconds: 300}},
			},
			wantErr: true,
		},
		{
			name: "split with zero duration",
			detail: SessionDetail{
				Source: SourceManual,
				Splits: []Split{{DistanceM: 1000, DurationSeconds: 0}},
			},
			wantErr: true,
		},
		{
			name: "too many route points",
			detail: SessionDetail{
				Source:      SourcePhoneGPS,
				RoutePoints: make([]RoutePoint, MaxRoutePoints+1),
			},
			wantErr: true,
		},
		{
			name: "too many splits",
			detail: SessionDetail{
				Source: SourceManual,
				Splits: make([]Split, MaxSplits+1),
			},
			wantErr: true,
		},
		{
			name: "healthkit import with a uuid",
			detail: SessionDetail{
				Source:        SourceHealthKit,
				DistanceM:     ptr(5000.0),
				HealthKitUUID: ptr("6D0D0F5F-8B4A-4E2D-9B1A-3C7E9F1A2B3C"),
			},
		},
		{
			name:    "empty healthkit uuid",
			detail:  SessionDetail{Source: SourceManual, HealthKitUUID: ptr("")},
			wantErr: true,
		},
		{
			name: "healthkit uuid at the length ceiling",
			detail: SessionDetail{
				Source:        SourceHealthKit,
				HealthKitUUID: ptr(strings.Repeat("a", maxHealthKitUUIDLength)),
			},
		},
		{
			name: "healthkit uuid over the length ceiling",
			detail: SessionDetail{
				Source:        SourceHealthKit,
				HealthKitUUID: ptr(strings.Repeat("a", maxHealthKitUUIDLength+1)),
			},
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.detail.Validate()
			if tc.wantErr && err == nil {
				t.Fatal("Validate() = nil, want an error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("Validate() = %v, want nil", err)
			}
		})
	}
}
