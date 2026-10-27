// Package slotlock is a client for Slotlock's REST API: the agent tools and the application API.
//
//	client, err := slotlock.New("https://calendar.example.com", apiKey)
//	hold, err := client.AcquireHold(ctx, slotlock.AcquireHoldInput{
//		ResourceID: resourceID, Start: "2027-03-29T09:00:00Z", End: "2027-03-29T10:00:00Z", TTLSeconds: 600,
//	})
//
// Every operation is a method taking its own input struct; Call runs one by name. A refusal is an
// *Error with the HTTP status and the server's code. Only the standard library is used.
package slotlock

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Version is this client's version, sent in its User-Agent.
const Version = "0.3.0"

type operation struct {
	name       string
	method     string
	path       string
	pathParams []string
	query      []string
}

// Error is a call the server refused: Status is the HTTP status, Code says why (overlap,
// forbidden, confirmation_required, ...), or http_<status> when the response carried no code; a
// redirect is one too (http_302), never followed. RetryAfter is what a 429 or 503 asks the caller
// to wait, when its Retry-After says, in seconds or as a date (at most a day).
type Error struct {
	Status     int
	Code       string
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	return fmt.Sprintf("slotlock: the server answered %d %s", e.Status, e.Code)
}

// Client calls one Slotlock server with one API key. It is safe for concurrent use.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	userAgent  string
}

// Option changes how New builds a Client.
type Option func(*options)

type options struct {
	httpClient    *http.Client
	userAgent     string
	allowInsecure bool
}

// WithHTTPClient sends requests with the given client (timeouts, proxies, transports), less its
// redirect policy: no redirect is followed.
func WithHTTPClient(client *http.Client) Option { return func(o *options) { o.httpClient = client } }

// WithUserAgent replaces the User-Agent, slotlock-go/<version> by default.
func WithUserAgent(userAgent string) Option { return func(o *options) { o.userAgent = userAgent } }

// AllowInsecure lets New send the key over plain HTTP to a host other than this machine.
func AllowInsecure() Option { return func(o *options) { o.allowInsecure = true } }

// New returns a client for the server at baseURL (its SLOTLOCK_PUBLIC_URL) with an API key
// (slk_...) or the server token. The application API needs a key with the admin scope. Plain
// HTTP is refused except to this machine, since it would send the key unencrypted.
func New(baseURL, apiKey string, opts ...Option) (*Client, error) {
	o := options{httpClient: &http.Client{Timeout: 30 * time.Second}, userAgent: "slotlock-go/" + Version}
	for _, opt := range opts {
		opt(&o)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return nil, errors.New("slotlock: baseURL must be an http:// or https:// URL")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("slotlock: baseURL must not have a query or a fragment")
	}
	host := parsed.Hostname()
	if parsed.Scheme == "http" && host != "localhost" && host != "127.0.0.1" && host != "::1" && !o.allowInsecure {
		return nil, errors.New("slotlock: baseURL is plain HTTP to another host, which would send the key unencrypted; use https:// or AllowInsecure()")
	}
	if apiKey == "" || strings.IndexFunc(apiKey, func(r rune) bool { return r < 0x21 || r > 0x7e }) >= 0 {
		return nil, errors.New("slotlock: apiKey must be a Slotlock API key or the server token")
	}
	// A copy, so the caller's client keeps its own policy. A redirect is answered as it came: the key
	// never goes with another request. (The default transport's proxy already skips this machine.)
	httpClient := *o.httpClient
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		httpClient: &httpClient,
		userAgent:  o.userAgent,
	}, nil
}

// String names the server, never the key.
func (c Client) String() string { return "slotlock.Client(" + c.baseURL + ")" }

// GoString is String, so %#v never shows the key either.
func (c Client) GoString() string { return c.String() }

// Call runs an operation by its name (slotlock_...) with its arguments, path parameters included,
// and returns the response body.
func (c *Client) Call(ctx context.Context, name string, values map[string]any) (map[string]any, error) {
	op, ok := operations[name]
	if !ok {
		return nil, fmt.Errorf("slotlock: no operation named %q", name)
	}
	arguments := make(map[string]any, len(values))
	for key, value := range values {
		arguments[key] = value
	}
	path := op.path
	for _, param := range op.pathParams {
		value, ok := arguments[param].(string)
		// The server resolves . and .. as path segments, which would name another route.
		if !ok || value == "" || value == "." || value == ".." {
			return nil, fmt.Errorf("slotlock: %s needs %s, a non-empty string other than . and ..", name, param)
		}
		delete(arguments, param)
		path = strings.Replace(path, "{"+param+"}", url.PathEscape(value), 1)
	}
	var body io.Reader
	if op.method == http.MethodGet || op.method == http.MethodDelete {
		query := url.Values{}
		for key, value := range arguments {
			if !contains(op.query, key) {
				return nil, fmt.Errorf("slotlock: %s has no argument %s", name, key)
			}
			if err := addQuery(query, key, value); err != nil {
				return nil, err
			}
		}
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
	} else {
		encoded, err := json.Marshal(arguments)
		if err != nil {
			return nil, fmt.Errorf("slotlock: %s arguments: %w", name, err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, op.method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", c.userAgent)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, refusal(response, payload)
	}
	decoded := map[string]any{}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &decoded); err != nil {
			return nil, &Error{Status: response.StatusCode, Code: "invalid_response"}
		}
	}
	return decoded, nil
}

func contains(names []string, name string) bool {
	for _, candidate := range names {
		if candidate == name {
			return true
		}
	}
	return false
}

func addQuery(query url.Values, key string, value any) error {
	switch v := value.(type) {
	case []string:
		for _, item := range v {
			query.Add(key, item)
		}
	case []any:
		for _, item := range v {
			if err := addQuery(query, key, item); err != nil {
				return err
			}
		}
	case string:
		query.Add(key, v)
	case bool:
		query.Add(key, strconv.FormatBool(v))
	case int:
		query.Add(key, strconv.Itoa(v))
	case int64:
		query.Add(key, strconv.FormatInt(v, 10))
	case float64:
		query.Add(key, strconv.FormatFloat(v, 'f', -1, 64))
	default:
		return fmt.Errorf("slotlock: query argument %s must be a string, number or boolean, not %T", key, value)
	}
	return nil
}

func refusal(response *http.Response, payload []byte) error {
	failure := &Error{Status: response.StatusCode, Code: "http_" + strconv.Itoa(response.StatusCode)}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(payload, &body) == nil && body.Error.Code != "" {
		failure.Code = body.Error.Code
	}
	failure.RetryAfter = retryAfter(response.Header.Get("Retry-After"), time.Now())
	return failure
}

// maxRetryAfter is the longest wait a Retry-After is read as.
const maxRetryAfter = 24 * time.Hour

var retryAfterSeconds = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)

// retryAfter reads Retry-After in seconds or as an HTTP date, at most a day; anything else is 0.
func retryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if retryAfterSeconds.MatchString(value) {
		seconds, err := strconv.ParseFloat(value, 64)
		if err != nil || seconds >= maxRetryAfter.Seconds() {
			return maxRetryAfter // a day or more, or too long for a float64
		}
		return time.Duration(seconds * float64(time.Second))
	}
	if when, err := time.Parse(http.TimeFormat, value); err == nil {
		return min(max(when.Sub(now), 0), maxRetryAfter)
	}
	return 0
}

// Nullable is an argument that may be null: the zero value leaves it out, Null sends null (which
// clears it, or for rules means the server's default), and Value sends a value.
type Nullable[T any] struct {
	value T
	state uint8
}

// Value is a Nullable that sends v; a nil slice or map is sent empty, never as null.
func Value[T any](v T) Nullable[T] { return Nullable[T]{value: v, state: 2} }

// Null is a Nullable that sends null.
func Null[T any]() Nullable[T] { return Nullable[T]{state: 1} }

func (n Nullable[T]) get() (any, bool) {
	switch n.state {
	case 1:
		return nil, true
	case 2:
		value := reflect.ValueOf(n.value)
		switch {
		case value.Kind() == reflect.Slice && value.IsNil():
			return reflect.MakeSlice(value.Type(), 0, 0).Interface(), true
		case value.Kind() == reflect.Map && value.IsNil():
			return reflect.MakeMap(value.Type()).Interface(), true
		}
		return n.value, true
	default:
		return nil, false
	}
}

// Ptr returns a pointer to v, for optional arguments: slotlock.Ptr("checkout").
func Ptr[T any](v T) *T { return &v }
