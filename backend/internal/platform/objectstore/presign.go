// Package objectstore presigns S3-compatible URLs, so a client can upload to
// and read from private object storage without the bytes ever passing through
// this API.
//
// # Why this is hand-written and not the AWS SDK
//
// The obvious move is `aws-sdk-go-v2`, and it was weighed. This module needs
// exactly one thing from it — a SigV4 presigned URL — and pulling the SDK in
// costs a dozen modules in `go.mod` for a backend that today has four direct
// dependencies and no web framework by deliberate choice. The algorithm is
// fully specified, is a few HMACs over a canonical string, and — the part that
// makes this a reasonable call rather than a brave one — is **exactly testable
// against the vectors AWS publishes**, which `presign_test.go` does.
//
// Note what is NOT being hand-rolled: no primitive is invented, no key
// exchange happens, and nothing here decides who may do what. It is
// HMAC-SHA256 from the standard library, applied in a documented order.
//
// # Why presigning at all
//
// Progress photos are the most sensitive thing this product stores. Two
// consequences follow, and both are why they cannot live the way the exercise
// catalog's media does:
//
//   - **The catalog bucket is public-read on purpose** — the images are
//     identical for everyone, so a CDN-cacheable public URL is exactly right.
//     A photo of one athlete's body is the opposite of that.
//   - **The bytes must not flow through this API.** Proxying uploads would put
//     multi-megabyte bodies through a Go process sized for JSON, and would make
//     the API the thing that falls over when somebody has bad signal.
//
// So the client asks for a short-lived signed URL and talks to storage
// directly. The API's only job is deciding *whether* to hand one out, which is
// the job it should have.
//
// # Unset is a supported state
//
// With no credentials configured, `New` returns nil and every caller degrades
// to "no photo" rather than failing. Local dev and CI have no bucket, exactly
// as `MEDIA_BASE_URL` already assumes.
package objectstore

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// ErrNotConfigured is returned by presign calls on a nil store. Callers check
// for a nil *Store instead; this exists so a mistaken call is loud.
var ErrNotConfigured = errors.New("objectstore: not configured")

// UnsignedPayload tells S3 not to expect a payload hash in the signature.
//
// Required for presigned URLs: the signature is computed before the body
// exists, so there is nothing to hash. The literal string is part of the
// protocol, not a placeholder.
const UnsignedPayload = "UNSIGNED-PAYLOAD"

// MaxExpiry is the ceiling SigV4 itself imposes on a presigned URL: seven days.
const MaxExpiry = 7 * 24 * time.Hour

// Store holds the credentials and endpoint for one bucket.
//
// R2 has no meaningful regions, and its S3 API requires the literal region
// "auto" — which is why Region is a field with a documented default rather
// than a constant: the same code presigns against real S3 in a test.
type Store struct {
	Endpoint  string // e.g. https://<account>.r2.cloudflarestorage.com
	Bucket    string
	AccessKey string
	SecretKey string
	Region    string
}

// Config is the environment's view of a store. All fields empty means "no
// object storage", which is a supported configuration.
type Config struct {
	Endpoint  string
	Bucket    string
	AccessKey string
	SecretKey string
	Region    string
}

// New returns a Store, or nil when object storage is not configured.
//
// **Nil rather than an error on the empty config**, because unset is the normal
// state in local dev and CI. It DOES error on a partial config: three of four
// values present is somebody halfway through setting it up, and silently
// behaving as though storage were absent would hide the mistake until a photo
// vanished.
func New(c Config) (*Store, error) {
	set := 0
	for _, v := range []string{c.Endpoint, c.Bucket, c.AccessKey, c.SecretKey} {
		if strings.TrimSpace(v) != "" {
			set++
		}
	}
	if set == 0 {
		return nil, nil
	}
	if set < 4 {
		return nil, fmt.Errorf(
			"objectstore: partially configured — endpoint, bucket, access key and secret are all required (%d of 4 set)", set)
	}
	region := c.Region
	if region == "" {
		region = "auto" // R2's required literal
	}
	return &Store{
		Endpoint:  strings.TrimRight(c.Endpoint, "/"),
		Bucket:    c.Bucket,
		AccessKey: c.AccessKey,
		SecretKey: c.SecretKey,
		Region:    region,
	}, nil
}

// PresignPut returns a URL the client may PUT the object's bytes to.
//
// `contentType` is signed into the URL, so the upload is refused unless it
// matches — which is what stops a request for a JPEG slot being used to store
// something else.
func (s *Store) PresignPut(key, contentType string, expires time.Duration, now time.Time) (string, error) {
	if s == nil {
		return "", ErrNotConfigured
	}
	return s.presign("PUT", key, contentType, expires, now)
}

// PresignDelete returns a URL the object may be removed with.
//
// Used server-side rather than handed to a client: deleting a check-in has to
// delete its photo, and the key is deterministic — so an object left behind is
// not merely retained, it is **resurrectable**. Requesting an upload URL for the
// same day would hand back a working read link for the photo the athlete
// deleted, before anything new was uploaded.
func (s *Store) PresignDelete(key string, expires time.Duration, now time.Time) (string, error) {
	if s == nil {
		return "", ErrNotConfigured
	}
	return s.presign("DELETE", key, "", expires, now)
}

// PresignGet returns a URL the object may be read from, for `expires`.
//
// Short by design at the call site: a leaked URL is a leaked photo until it
// expires, and nothing about the read path benefits from a long life.
func (s *Store) PresignGet(key string, expires time.Duration, now time.Time) (string, error) {
	if s == nil {
		return "", ErrNotConfigured
	}
	return s.presign("GET", key, "", expires, now)
}

/*
presign implements AWS Signature Version 4 "query parameter" signing.

The steps are the specification's, in its order, and the comments name them so
this can be read against the AWS documentation rather than trusted:

 1. canonical request  — method, path, sorted query, signed headers, payload
 2. string to sign     — algorithm, timestamp, scope, hash of (1)
 3. signing key        — HMAC chain over date / region / service / terminator
 4. signature          — HMAC of (2) with (3), appended as a query parameter

The two details that are easy to get wrong and are the reason for the tests:
each path SEGMENT is escaped but the separating slashes are not, and the query
string must be sorted by the ENCODED key.
*/
func (s *Store) presign(method, key, contentType string, expires time.Duration, now time.Time) (string, error) {
	if strings.TrimSpace(key) == "" {
		return "", errors.New("objectstore: empty key")
	}
	if expires <= 0 || expires > MaxExpiry {
		return "", fmt.Errorf("objectstore: expiry must be between 0 and %s", MaxExpiry)
	}

	host, err := hostOf(s.Endpoint)
	if err != nil {
		return "", err
	}

	now = now.UTC()
	stamp := now.Format("20060102T150405Z")
	day := now.Format("20060102")
	scope := strings.Join([]string{day, s.Region, "s3", "aws4_request"}, "/")

	// Host is always signed. Content-Type is signed only when we are pinning
	// it, so a GET's signature does not depend on a header it never sends.
	signed := []string{"host"}
	headers := map[string]string{"host": host}
	if contentType != "" {
		signed = append(signed, "content-type")
		headers["content-type"] = contentType
	}
	sort.Strings(signed)

	q := url.Values{}
	q.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	q.Set("X-Amz-Credential", s.AccessKey+"/"+scope)
	q.Set("X-Amz-Date", stamp)
	q.Set("X-Amz-Expires", fmt.Sprintf("%d", int(expires.Seconds())))
	q.Set("X-Amz-SignedHeaders", strings.Join(signed, ";"))

	// Path-style when a bucket is named, virtual-hosted style when it is not
	// (the bucket then lives in the endpoint's hostname). Concatenating
	// unconditionally yields "//key" in the second case, which is a different
	// path and therefore a signature the server rejects — caught here by AWS's
	// own published vector, which is virtual-hosted.
	canonicalPath := "/" + escapePath(key)
	if s.Bucket != "" {
		canonicalPath = "/" + s.Bucket + canonicalPath
	}

	var canonicalHeaders strings.Builder
	for _, h := range signed {
		canonicalHeaders.WriteString(h)
		canonicalHeaders.WriteString(":")
		canonicalHeaders.WriteString(strings.TrimSpace(headers[h]))
		canonicalHeaders.WriteString("\n")
	}

	canonicalRequest := strings.Join([]string{
		method,
		canonicalPath,
		encodeQuery(q),
		canonicalHeaders.String(),
		strings.Join(signed, ";"),
		UnsignedPayload,
	}, "\n")

	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		stamp,
		scope,
		sha256Hex(canonicalRequest),
	}, "\n")

	key1 := hmacSHA256([]byte("AWS4"+s.SecretKey), day)
	key2 := hmacSHA256(key1, s.Region)
	key3 := hmacSHA256(key2, "s3")
	signingKey := hmacSHA256(key3, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))

	q.Set("X-Amz-Signature", signature)
	return s.Endpoint + canonicalPath + "?" + encodeQuery(q), nil
}

/*
escapePath escapes each segment but not the separators.

`url.PathEscape` on the whole key would turn every "/" into "%2F" and the
signature would be computed over a path the server never sees. This is the
single likeliest way to get a working signature for flat keys and a broken one
for nested ones — which is exactly the shape this module uses
(`checkins/<user>/<date>.jpg`).
*/
func escapePath(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		// NOT `url.PathEscape`, which leaves `: + = @ & $` raw in a segment —
		// SigV4's canonical URI requires everything outside the unreserved set
		// encoded. Unreachable with today's keys (Clerk ids and dates are
		// ASCII-safe) and invisible to the AWS vector, whose key is flat ASCII
		// — so it would have waited for the first key with a `+` in it and then
		// failed as a signature mismatch naming nothing. Raised in review.
		parts[i] = escapeRFC3986(p)
	}
	return strings.Join(parts, "/")
}

/*
encodeQuery sorts by the ENCODED key and uses RFC 3986 escaping.

`url.Values.Encode` sorts by the raw key, which differs from the encoded order
whenever a key contains a character that escapes to a different byte — and it
leaves "+" meaning space, which SigV4 requires as "%20". Both differences are
invisible until a signature is rejected.
*/
// Single-valued only: SigV4 requires repeated keys to be sorted by value too,
// and nothing here emits one. A future caller with a multi-valued query needs
// this extended rather than trusted.
func encodeQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, escapeRFC3986(k))
	}
	sort.Strings(keys)

	byEncoded := make(map[string]string, len(q))
	for k, vs := range q {
		byEncoded[escapeRFC3986(k)] = escapeRFC3986(vs[0])
	}

	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteString("&")
		}
		b.WriteString(k)
		b.WriteString("=")
		b.WriteString(byEncoded[k])
	}
	return b.String()
}

// escapeRFC3986 percent-encodes everything outside the unreserved set.
//
// `url.QueryEscape` is close but encodes a space as "+" and leaves "~" alone in
// some versions; SigV4 wants "%20" and "~" unescaped. Written out rather than
// patched afterwards, because a replace-based fix corrupts a literal "+".
func escapeRFC3986(s string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

func hostOf(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("objectstore: bad endpoint %q", endpoint)
	}
	return u.Host, nil
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}
