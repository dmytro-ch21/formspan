package objectstore

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

/*
The point of this file is that the presigner is hand-written (see the package
doc for why), so it has to be checked against something other than itself.

TestPresignGet_MatchesAWSPublishedVector is that check: AWS documents a worked
SigV4 example — same credentials, same bucket, same clock — and publishes the
signature it must produce. If the implementation drifts in any of the four
steps, that one hex string stops matching. Everything else here pins the
details that the vector happens not to exercise.
*/

// The credentials from AWS's own "Presign a GET object request" walkthrough.
// Not secrets: they are the example key pair the documentation uses, and they
// exist in this file only so the published signature is reproducible.
const (
	vectorAccessKey = "AKIAIOSFODNN7EXAMPLE"
	vectorSecretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
)

func vectorTime(t *testing.T) time.Time {
	t.Helper()
	// 2013-05-24T00:00:00Z — the walkthrough's clock.
	return time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)
}

func TestPresignGet_MatchesAWSPublishedVector(t *testing.T) {
	s := &Store{
		Endpoint:  "https://examplebucket.s3.amazonaws.com",
		Bucket:    "",
		AccessKey: vectorAccessKey,
		SecretKey: vectorSecretKey,
		Region:    "us-east-1",
	}
	// The vector signs `/test.txt` on a virtual-hosted bucket, so the bucket is
	// in the host and the canonical path is just the key. That is what an empty
	// Bucket expresses here; the leading slash comes from `presign`.
	raw, err := s.presign("GET", "test.txt", "", 86400*time.Second, vectorTime(t))
	if err != nil {
		t.Fatalf("presign: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	const want = "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
	if got := u.Query().Get("X-Amz-Signature"); got != want {
		t.Errorf("signature = %s, want %s (AWS's published vector — the four SigV4 steps have drifted)", got, want)
	}
}

func TestPresign_PathSeparatorsAreNotEscaped(t *testing.T) {
	// The likeliest way to ship a presigner that works on flat keys and breaks
	// on nested ones — and every key this module writes is nested.
	if got := escapePath("checkins/user_123/2026-08-08.jpg"); got != "checkins/user_123/2026-08-08.jpg" {
		t.Errorf("escapePath = %q, want the slashes left alone", got)
	}
	// A space inside a segment still has to be escaped.
	if got := escapePath("a b/c"); got != "a%20b/c" {
		t.Errorf("escapePath = %q, want the space escaped and the slash not", got)
	}
}

func TestEscapeRFC3986_SpaceIsPercent20NotPlus(t *testing.T) {
	// `url.QueryEscape` produces "+" here, which SigV4 rejects. The failure is
	// invisible until storage refuses an upload.
	if got := escapeRFC3986("a b"); got != "a%20b" {
		t.Errorf("escapeRFC3986(%q) = %q, want a%%20b", "a b", got)
	}
	// Tilde is unreserved and must NOT be escaped.
	if got := escapeRFC3986("a~b"); got != "a~b" {
		t.Errorf("escapeRFC3986(%q) = %q, want it left alone", "a~b", got)
	}
	// Slash is reserved in a query VALUE and must be escaped.
	if got := escapeRFC3986("a/b"); got != "a%2Fb" {
		t.Errorf("escapeRFC3986(%q) = %q, want the slash escaped", "a/b", got)
	}
}

func TestPresignPut_SignsContentType(t *testing.T) {
	s := testStore()
	raw, err := s.PresignPut("checkins/u/2026-08-08.jpg", "image/jpeg", time.Minute, time.Now())
	if err != nil {
		t.Fatalf("PresignPut: %v", err)
	}
	q := mustQuery(t, raw)
	// Signing content-type is what stops a slot requested for a photo being
	// used to store something else.
	if got := q.Get("X-Amz-SignedHeaders"); got != "content-type;host" {
		t.Errorf("SignedHeaders = %q, want content-type;host", got)
	}
}

func TestPresignGet_DoesNotSignContentType(t *testing.T) {
	// A GET sends no content-type, so signing one would make every read fail.
	s := testStore()
	raw, err := s.PresignGet("checkins/u/2026-08-08.jpg", time.Minute, time.Now())
	if err != nil {
		t.Fatalf("PresignGet: %v", err)
	}
	if got := mustQuery(t, raw).Get("X-Amz-SignedHeaders"); got != "host" {
		t.Errorf("SignedHeaders = %q, want host", got)
	}
}

func TestPresign_DifferentKeysDifferentSignatures(t *testing.T) {
	// Guards the mistake where the key never reaches the canonical request:
	// every URL would verify, and every athlete would presign the same object.
	s := testStore()
	at := time.Now()
	a, _ := s.PresignGet("checkins/u/a.jpg", time.Minute, at)
	b, _ := s.PresignGet("checkins/u/b.jpg", time.Minute, at)
	if mustQuery(t, a).Get("X-Amz-Signature") == mustQuery(t, b).Get("X-Amz-Signature") {
		t.Error("two different keys signed identically — the key is not reaching the canonical request")
	}
}

func TestPresign_RejectsUnusableExpiry(t *testing.T) {
	s := testStore()
	for _, d := range []time.Duration{0, -time.Second, MaxExpiry + time.Second} {
		if _, err := s.PresignGet("k", d, time.Now()); err == nil {
			t.Errorf("expiry %s was accepted; SigV4 caps presigned URLs at %s", d, MaxExpiry)
		}
	}
}

func TestPresign_RejectsEmptyKey(t *testing.T) {
	// An empty key presigns the BUCKET, which for a PUT is a request to write
	// an object named nothing and for a GET is a bucket listing.
	if _, err := testStore().PresignGet("  ", time.Minute, time.Now()); err == nil {
		t.Error("empty key was accepted")
	}
}

func TestNew_UnsetIsNilNotAnError(t *testing.T) {
	// Local dev and CI have no bucket. The feature degrades to "no photo".
	s, err := New(Config{})
	if err != nil {
		t.Fatalf("empty config errored: %v", err)
	}
	if s != nil {
		t.Error("empty config produced a store")
	}
}

func TestNew_PartialConfigIsAnError(t *testing.T) {
	// Three of four is somebody halfway through setting it up. Treating that
	// as "no storage" hides the mistake until a photo silently vanishes.
	_, err := New(Config{Endpoint: "https://x.r2.cloudflarestorage.com", Bucket: "b", AccessKey: "k"})
	if err == nil {
		t.Error("partial config was accepted")
	}
}

func TestNew_DefaultsRegionToAuto(t *testing.T) {
	// R2's S3 API requires the literal "auto"; getting it wrong fails every
	// signature with an error that names the region and not the cause.
	s, err := New(Config{Endpoint: "https://x.r2.cloudflarestorage.com", Bucket: "b", AccessKey: "k", SecretKey: "s"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if s.Region != "auto" {
		t.Errorf("Region = %q, want auto", s.Region)
	}
}

func TestPresign_NilStoreIsAnErrorNotAPanic(t *testing.T) {
	// Callers hold a *Store that is nil when storage is unconfigured, and the
	// photo paths are the ones most likely to be reached without checking.
	var s *Store
	if _, err := s.PresignGet("k", time.Minute, time.Now()); err != ErrNotConfigured {
		t.Errorf("err = %v, want ErrNotConfigured", err)
	}
	if _, err := s.PresignPut("k", "image/jpeg", time.Minute, time.Now()); err != ErrNotConfigured {
		t.Errorf("err = %v, want ErrNotConfigured", err)
	}
}

func TestPresign_URLCarriesTheBucketPath(t *testing.T) {
	s := testStore()
	raw, err := s.PresignGet("checkins/u/a.jpg", time.Minute, time.Now())
	if err != nil {
		t.Fatalf("PresignGet: %v", err)
	}
	if !strings.Contains(raw, "/vola-media/checkins/u/a.jpg?") {
		t.Errorf("url = %s, want the bucket and key in the path", raw)
	}
}

func testStore() *Store {
	return &Store{
		Endpoint:  "https://acct.r2.cloudflarestorage.com",
		Bucket:    "vola-media",
		AccessKey: vectorAccessKey,
		SecretKey: vectorSecretKey,
		Region:    "auto",
	}
}

func mustQuery(t *testing.T, raw string) url.Values {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return u.Query()
}
