package slotlock

// The transport against local stub servers: what goes on the wire, and how answers are read.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// stub is a local server that records each request and answers with respond.
type stub struct {
	*httptest.Server
	mu       sync.Mutex
	requests []*http.Request
	bodies   []string
}

func newStub(t *testing.T, respond http.HandlerFunc) *stub {
	t.Helper()
	s := &stub{}
	if respond == nil {
		respond = answer(200, `{}`, nil)
	}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.requests = append(s.requests, r)
		s.bodies = append(s.bodies, string(body))
		s.mu.Unlock()
		respond(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *stub) seen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

func answer(status int, body string, headers map[string]string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		for name, value := range headers {
			w.Header().Set(name, value)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func stubClient(t *testing.T, url string, opts ...Option) *Client {
	t.Helper()
	client, err := New(url, "slk_secret", opts...)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func refusedBy(t *testing.T, err error) *Error {
	t.Helper()
	var refused *Error
	if !errors.As(err, &refused) {
		t.Fatalf("want a refusal, got %v", err)
	}
	return refused
}

func TestARedirectIsARefusalAndTheKeyStays(t *testing.T) {
	elsewhere := newStub(t, nil)
	location := strings.Replace(elsewhere.URL, "127.0.0.1", "localhost", 1) + "/v1/resources"
	origin := newStub(t, answer(http.StatusFound, ``, map[string]string{"Location": location}))
	// A client given with WithHTTPClient follows no redirect either.
	for _, opts := range [][]Option{nil, {WithHTTPClient(&http.Client{})}} {
		_, err := stubClient(t, origin.URL, opts...).ListResources(context.Background(), ListResourcesInput{})
		if refused := refusedBy(t, err); refused.Status != 302 || refused.Code != "http_302" {
			t.Errorf("%+v", refused)
		}
	}
	if elsewhere.seen() != 0 {
		t.Fatalf("the redirect was followed: %d requests elsewhere", elsewhere.seen())
	}
}

func TestARedirectFromHTTPSToPlainHTTPNeverCarriesTheKey(t *testing.T) {
	plain := newStub(t, nil)
	secure := httptest.NewTLSServer(http.RedirectHandler(plain.URL+"/v1/resources", http.StatusMovedPermanently))
	t.Cleanup(secure.Close)
	_, err := stubClient(t, secure.URL, WithHTTPClient(secure.Client())).ListResources(context.Background(), ListResourcesInput{})
	for _, request := range plain.requests {
		t.Errorf("sent over plain HTTP with Authorization %q", request.Header.Get("Authorization"))
	}
	if refused := refusedBy(t, err); refused.Status != 301 {
		t.Errorf("%+v", refused)
	}
}

// The default transport's proxy comes from the environment once per process, so a child process
// runs the call with HTTP_PROXY set.
func TestALoopbackURLIgnoresAProxy(t *testing.T) {
	if url := os.Getenv("SLOTLOCK_TEST_PROXIED_URL"); url != "" {
		if _, err := stubClient(t, url).ListResources(context.Background(), ListResourcesInput{}); err != nil {
			t.Fatal(err)
		}
		return
	}
	proxy, server := newStub(t, nil), newStub(t, nil)
	child := exec.Command(os.Args[0], "-test.run=^TestALoopbackURLIgnoresAProxy$", "-test.count=1")
	child.Env = append(os.Environ(), "SLOTLOCK_TEST_PROXIED_URL="+server.URL, "HTTP_PROXY="+proxy.URL, "NO_PROXY=", "no_proxy=")
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, output)
	}
	if proxy.seen() != 0 || server.seen() != 1 {
		t.Fatalf("proxy saw %d requests, the server %d", proxy.seen(), server.seen())
	}
}

func TestRefusesADotSegmentPathParameterBeforeAnyRequest(t *testing.T) {
	s := newStub(t, nil)
	for _, reference := range []string{".", ".."} {
		_, err := stubClient(t, s.URL).GetResource(context.Background(), GetResourceInput{ResourceID: reference})
		if err == nil || !strings.Contains(err.Error(), "needs resource_id") {
			t.Errorf("%q: %v", reference, err)
		}
	}
	if s.seen() != 0 {
		t.Fatalf("%d requests sent", s.seen())
	}
}

func TestEncodesPathAndQueryParameters(t *testing.T) {
	s := newStub(t, nil)
	client := stubClient(t, s.URL)
	if _, err := client.GetEvent(context.Background(), GetEventInput{EventID: "BK/42 ?#%é\\x.."}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListEvents(context.Background(), ListEventsInput{
		ResourceIDs: []string{"a b", "c+d/é"}, Start: "2027-03-29T09:00:00+01:00", End: "2027-03-29T10:00:00+01:00", Limit: Ptr(int64(5)),
	}); err != nil {
		t.Fatal(err)
	}
	if got, want := s.requests[0].RequestURI, "/v1/events/BK%2F42%20%3F%23%25%C3%A9%5Cx.."; got != want {
		t.Errorf("path %s, want %s", got, want)
	}
	query := s.requests[1].URL.Query()
	if got := fmt.Sprint(query["resource_ids"], query["start"], query["end"], query["limit"]); got != "[a b c+d/é] [2027-03-29T09:00:00+01:00] [2027-03-29T10:00:00+01:00] [5]" {
		t.Errorf("query %s", got)
	}
}

func TestReadsRetryAfterInSecondsOrAsADate(t *testing.T) {
	read := func(value string) time.Duration {
		s := newStub(t, answer(429, `{"error":{"code":"rate_limited"}}`, map[string]string{"Retry-After": value}))
		_, err := stubClient(t, s.URL).ListResources(context.Background(), ListResourcesInput{})
		refused := refusedBy(t, err)
		if refused.Status != 429 || refused.Code != "rate_limited" {
			t.Errorf("%+v", refused)
		}
		return refused.RetryAfter
	}
	for value, want := range map[string]time.Duration{
		"7":                             7 * time.Second,
		"1.5":                           1500 * time.Millisecond,
		"99999999999999999999":          24 * time.Hour,
		"Wed, 21 Oct 2015 07:28:00 GMT": 0,
		"-5":                            0,
		"NaN":                           0,
		"Inf":                           0,
		"1e3":                           0,
		"soon":                          0,
	} {
		if got := read(value); got != want {
			t.Errorf("Retry-After: %s read as %v, want %v", value, got, want)
		}
	}
	when := time.Now().Add(120 * time.Second).UTC().Format(http.TimeFormat)
	if got := read(when); got < 100*time.Second || got > 120*time.Second {
		t.Errorf("Retry-After: %s read as %v", when, got)
	}
}

func TestAnErrorWithoutAJSONBodyIsStillARefusal(t *testing.T) {
	for status, body := range map[int]string{500: `<html>oops</html>`, 502: ``} {
		s := newStub(t, answer(status, body, nil))
		_, err := stubClient(t, s.URL).ListResources(context.Background(), ListResourcesInput{})
		if refused := refusedBy(t, err); refused.Status != status || refused.Code != fmt.Sprintf("http_%d", status) {
			t.Errorf("%+v", refused)
		}
	}
	s := newStub(t, answer(200, `<html>captive portal</html>`, nil))
	if _, err := stubClient(t, s.URL).ListResources(context.Background(), ListResourcesInput{}); err == nil {
		t.Error("a 200 that is not JSON was a success")
	}
}

func TestTheTimeoutCoversTheBody(t *testing.T) {
	s := newStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(200)
		for range 100 {
			_, _ = io.WriteString(w, " ")
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(200 * time.Millisecond):
			}
		}
	})
	started := time.Now()
	client := stubClient(t, s.URL, WithHTTPClient(&http.Client{Timeout: 500 * time.Millisecond}))
	if _, err := client.ListResources(context.Background(), ListResourcesInput{}); err == nil {
		t.Error("a trickled body was a success")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Errorf("took %v", elapsed)
	}
	if _, err := stubClient(t, "http://127.0.0.1:9").ListResources(context.Background(), ListResourcesInput{}); err == nil {
		t.Error("a refused connection was a success")
	}
}

func TestFormattingNeverShowsTheKey(t *testing.T) {
	client := stubClient(t, "https://calendar.example.com")
	for _, format := range []string{"%v", "%+v", "%s", "%#v"} {
		for _, value := range []any{client, *client} {
			if text := fmt.Sprintf(format, value); strings.Contains(text, "slk_secret") {
				t.Errorf("%s of %T shows the key: %s", format, value, text)
			}
		}
	}
}

func TestLeavesOutUnsetSendsNullAndValues(t *testing.T) {
	s := newStub(t, nil)
	_, err := stubClient(t, s.URL).UpdateEvent(context.Background(), UpdateEventInput{
		EventID: "e1", ExpectedRevision: 3, IdempotencyKey: "k", Description: Null[string](), Location: Value("Dock 4"),
	})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(s.bodies[0]), &body); err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(body); got != "map[description:<nil> expected_revision:3 idempotency_key:k location:Dock 4]" {
		t.Errorf("body %s", got)
	}
}

// rules: null is the server's default hours, [] is never bookable: a required argument that may be
// null sends either, and Value of a nil slice is still [].
func TestARequiredArgumentThatMayBeNullSendsNullOrAValue(t *testing.T) {
	s := newStub(t, nil)
	client := stubClient(t, s.URL)
	var none []map[string]any // what a caller holds after appending no rules
	for _, rules := range []Nullable[[]map[string]any]{Value(none), Null[[]map[string]any](), {}} {
		if _, err := client.SetResourceAvailability(context.Background(), SetResourceAvailabilityInput{ResourceID: "r1", Rules: rules}); err != nil {
			t.Fatal(err)
		}
	}
	if got := strings.Join(s.bodies, " "); got != `{"rules":[]} {"rules":null} {}` {
		t.Fatalf("sent %s", got)
	}
}
