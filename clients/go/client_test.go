package slotlock

// The Go client against a running Slotlock server, and its checks that need none. The server tests
// run when SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY (a key with read, write and admin) are set, against a
// server that confirms only deletes (SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event). Every language
// client runs the same scenario.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

var allWeek = []map[string]any{
	{"rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", "start_minutes": float64(0), "duration_minutes": float64(1440)},
}

func TestHasAMethodForEveryOperation(t *testing.T) {
	client := reflect.TypeOf(&Client{})
	for name := range operations {
		method := ""
		for _, part := range strings.Split(strings.TrimPrefix(name, "slotlock_"), "_") {
			method += strings.ToUpper(part[:1]) + part[1:]
		}
		if _, ok := client.MethodByName(method); !ok {
			t.Errorf("no method %s for %s", method, name)
		}
	}
}

func TestRefusesToSendAKeyOverPlainHTTPToAnotherHost(t *testing.T) {
	if _, err := New("http://calendar.example.com", "slk_x"); err == nil || !strings.Contains(err.Error(), "unencrypted") {
		t.Fatalf("plain HTTP to another host: %v", err)
	}
	for _, ok := range []struct {
		url  string
		opts []Option
	}{
		{"http://calendar.example.com", []Option{AllowInsecure()}},
		{"http://localhost:8080", nil},
		{"https://calendar.example.com/", nil},
	} {
		if _, err := New(ok.url, "slk_x", ok.opts...); err != nil {
			t.Errorf("%s: %v", ok.url, err)
		}
	}
	for _, url := range []string{"ftp://example.com", "calendar.example.com", "https://example.com/?a=1"} {
		if _, err := New(url, "slk_x"); err == nil {
			t.Errorf("%s was accepted", url)
		}
	}
	for _, key := range []string{"", "slk_ x", "slk_\n"} {
		if _, err := New("https://example.com", key); err == nil {
			t.Errorf("key %q was accepted", key)
		}
	}
}

func TestNeverShowsTheKey(t *testing.T) {
	client, _ := New("https://calendar.example.com", "slk_secret")
	if strings.Contains(client.String(), "slk_secret") {
		t.Fatal("String shows the key")
	}
}

func TestRefusesAnUnknownOperationOrAMissingPathParameter(t *testing.T) {
	client, _ := New("https://calendar.example.com", "slk_x")
	if _, err := client.Call(context.Background(), "slotlock_nothing", nil); err == nil {
		t.Error("unknown operation accepted")
	}
	if _, err := client.GetResource(context.Background(), GetResourceInput{}); err == nil || !strings.Contains(err.Error(), "needs resource_id") {
		t.Errorf("missing path parameter: %v", err)
	}
	if _, err := client.Call(context.Background(), "slotlock_list_resources", map[string]any{"limt": 5}); err == nil || !strings.Contains(err.Error(), "has no argument limt") {
		t.Errorf("unknown query argument: %v", err)
	}
}

type server struct {
	t      *testing.T
	client *Client
	ctx    context.Context
	suffix string
	day    time.Time
}

func newServer(t *testing.T) *server {
	url, key := os.Getenv("SLOTLOCK_URL"), os.Getenv("SLOTLOCK_ADMIN_KEY")
	if url == "" || key == "" {
		t.Skip("set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server")
	}
	client, err := New(url, key)
	if err != nil {
		t.Fatal(err)
	}
	random := make([]byte, 6)
	_, _ = rand.Read(random)
	day := time.Now().UTC().Truncate(24 * time.Hour).Add(30 * 24 * time.Hour)
	return &server{t: t, client: client, ctx: context.Background(), suffix: hex.EncodeToString(random), day: day}
}

func (s *server) at(hours float64) string {
	return s.day.Add(time.Duration(hours * float64(time.Hour))).Format("2006-01-02T15:04:05Z")
}

func (s *server) must(result map[string]any, err error) map[string]any {
	s.t.Helper()
	if err != nil {
		s.t.Fatal(err)
	}
	return result
}

func (s *server) refused(status int, code string, err error) {
	s.t.Helper()
	var failure *Error
	if !errors.As(err, &failure) || failure.Status != status || failure.Code != code {
		s.t.Fatalf("want %d %s, got %v", status, code, err)
	}
}

func instant(t *testing.T, value any) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value.(string))
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestBooksHoldsAndReservationsWithoutDoubleBooking(t *testing.T) {
	s := newServer(t)
	c := s.client
	resource := s.must(c.CreateResource(s.ctx, CreateResourceInput{ExternalRef: "go-" + s.suffix, Timezone: Ptr("UTC")}))["resource"].(map[string]any)
	id := resource["id"].(string)
	if got := s.must(c.GetResource(s.ctx, GetResourceInput{ResourceID: id}))["resource"]; !reflect.DeepEqual(got, resource) {
		t.Fatalf("get_resource: %v", got)
	}
	hours := s.must(c.SetResourceAvailability(s.ctx, SetResourceAvailabilityInput{ResourceID: id, Rules: Value(allWeek)}))["resource"].(map[string]any)
	if !reflect.DeepEqual(hours["availability"], []any{map[string]any(allWeek[0])}) {
		t.Fatalf("availability: %v", hours["availability"])
	}

	window := AcquireHoldInput{ResourceID: id, Start: s.at(9), End: s.at(10), TTLSeconds: 600, Source: Ptr("checkout")}
	hold := s.must(c.AcquireHold(s.ctx, window))["hold"].(map[string]any)
	if hold["source"] != "checkout" {
		t.Fatalf("hold: %v", hold)
	}
	_, err := c.AcquireHold(s.ctx, AcquireHoldInput{ResourceID: id, Start: s.at(9), End: s.at(10), TTLSeconds: 60})
	s.refused(409, "overlap", err)
	confirmed := s.must(c.ConfirmHold(s.ctx, ConfirmHoldInput{HoldID: hold["id"].(string)}))["reservation"]
	if confirmed.(map[string]any)["id"] != hold["id"] {
		t.Fatalf("confirm_hold: %v", confirmed)
	}
	if again := s.must(c.ConfirmHold(s.ctx, ConfirmHoldInput{HoldID: hold["id"].(string)}))["reservation"]; !reflect.DeepEqual(again, confirmed) {
		t.Fatalf("confirm_hold again: %v", again)
	}

	// A reference with a slash, a space and an accent travels in the path intact.
	reference := "BK/" + s.suffix + " ü"
	booking := PutReservationInput{ReservationRef: reference, ResourceID: id, Start: s.at(11), End: s.at(12), BufferAfterMinutes: Ptr(int64(30)), Revision: 1}
	put := s.must(c.PutReservation(s.ctx, booking))
	reservation := put["reservation"].(map[string]any)
	if put["replayed"] != false || reservation["reservation_ref"] != reference || reservation["buffer_after_minutes"] != float64(30) {
		t.Fatalf("put_reservation: %v", put)
	}
	if again := s.must(c.PutReservation(s.ctx, booking)); again["replayed"] != true {
		t.Fatalf("put_reservation again: %v", again)
	}
	_, err = c.AcquireHold(s.ctx, AcquireHoldInput{ResourceID: id, Start: s.at(12.25), End: s.at(12.5), TTLSeconds: 60})
	s.refused(409, "overlap", err)

	freeBusy := s.must(c.GetFreeBusy(s.ctx, GetFreeBusyInput{ResourceIDs: []string{id}, Start: s.at(0), End: s.at(24)}))
	busy := freeBusy["resources"].([]any)[0].(map[string]any)["busy"].([]any)
	want := [][2]string{{s.at(9), s.at(10)}, {s.at(11), s.at(12.5)}}
	if len(busy) != len(want) {
		t.Fatalf("busy: %v", busy)
	}
	for i, interval := range busy {
		got := interval.(map[string]any)
		if !instant(t, got["start"]).Equal(instant(t, want[i][0])) || !instant(t, got["end"]).Equal(instant(t, want[i][1])) {
			t.Fatalf("busy[%d]: %v", i, got)
		}
	}

	cancelled := s.must(c.CancelReservation(s.ctx, CancelReservationInput{ReservationRef: reference, Revision: 2}))
	if !reflect.DeepEqual(cancelled, map[string]any{"cancelled": true, "revision": float64(2)}) {
		t.Fatalf("cancel_reservation: %v", cancelled)
	}
	coverage := s.must(c.RecordCoverage(s.ctx, RecordCoverageInput{ResourceID: id, Source: "ics:https://calendar.example.com/fleet.ics", Start: s.at(0), End: s.at(24), Revision: 1}))
	if !reflect.DeepEqual(coverage, map[string]any{"revision": float64(1), "replayed": false}) {
		t.Fatalf("record_coverage: %v", coverage)
	}
	maintenance := s.must(c.RunMaintenance(s.ctx, RunMaintenanceInput{}))
	for _, key := range []string{"extended", "conflicts", "refused", "pruned", "zone_shifts", "stale_sources", "capped"} {
		if _, ok := maintenance[key]; !ok {
			t.Fatalf("run_maintenance: %v", maintenance)
		}
	}

	found := false
	var cursor *string
	for !found {
		page := s.must(c.ListResources(s.ctx, ListResourcesInput{Limit: Ptr(int64(100)), Cursor: cursor}))
		for _, r := range page["resources"].([]any) {
			found = found || r.(map[string]any)["id"] == id
		}
		next, ok := page["next_cursor"].(string)
		if !ok {
			break
		}
		cursor = &next
	}
	if !found {
		t.Fatal("list_resources does not list the resource")
	}
}

func TestWritesEventsAndClearsAFieldWithNull(t *testing.T) {
	s := newServer(t)
	c := s.client
	id := s.must(c.CreateResource(s.ctx, CreateResourceInput{ExternalRef: "go-events-" + s.suffix}))["resource"].(map[string]any)["id"].(string)
	s.must(c.SetResourceAvailability(s.ctx, SetResourceAvailabilityInput{ResourceID: id, Rules: Value(allWeek)}))
	key := func() string {
		random := make([]byte, 16)
		_, _ = rand.Read(random)
		return hex.EncodeToString(random)
	}
	created := s.must(c.CreateEvent(s.ctx, CreateEventInput{
		ResourceID: id, StartsAt: s.at(14), EndsAt: s.at(15), Timezone: "UTC",
		Title: Ptr("Handover"), Description: Ptr("Keys at the desk"), IdempotencyKey: key(),
	}))["event"].(map[string]any)
	if created["title"] != "Handover" || created["description"] != "Keys at the desk" {
		t.Fatalf("create_event: %v", created)
	}
	// Null clears the description; the title, left out, stays.
	updated := s.must(c.UpdateEvent(s.ctx, UpdateEventInput{
		EventID: created["id"].(string), ExpectedRevision: int64(created["revision"].(float64)),
		IdempotencyKey: key(), Description: Null[string](),
	}))["event"].(map[string]any)
	if updated["title"] != "Handover" || updated["description"] != nil {
		t.Fatalf("update_event: %v", updated)
	}
	// The server makes deletes wait for a person, which REST cannot ask: 428.
	_, err := c.DeleteEvent(s.ctx, DeleteEventInput{EventID: created["id"].(string), ExpectedRevision: int64(updated["revision"].(float64)), IdempotencyKey: key()})
	s.refused(428, "confirmation_required", err)
}

func TestRetriesAKeyedHoldAndRetiresAResource(t *testing.T) {
	s := newServer(t)
	c := s.client
	resource := s.must(c.CreateResource(s.ctx, CreateResourceInput{ExternalRef: "go-retire-" + s.suffix, Visibility: Ptr("private")}))["resource"].(map[string]any)
	id := resource["id"].(string)
	if resource["visibility"] != "private" {
		t.Fatalf("create_resource: %v", resource)
	}
	s.must(c.SetResourceAvailability(s.ctx, SetResourceAvailabilityInput{ResourceID: id, Rules: Value(allWeek)}))
	// A keyed hold retried answers the hold the first request made.
	window := AcquireHoldInput{ResourceID: id, Start: s.at(9), End: s.at(10), TTLSeconds: 600, IdempotencyKey: Ptr("go-hold-" + s.suffix)}
	hold := s.must(c.AcquireHold(s.ctx, window))["hold"].(map[string]any)
	if again := s.must(c.AcquireHold(s.ctx, window))["hold"]; !reflect.DeepEqual(again, hold) {
		t.Fatalf("acquire_hold again: %v", again)
	}
	window.TTLSeconds = 60
	_, err := c.AcquireHold(s.ctx, window)
	s.refused(422, "idempotency_conflict", err)
	holdID := hold["id"].(string)
	if got := s.must(c.GetHold(s.ctx, GetHoldInput{HoldID: holdID}))["hold"]; !reflect.DeepEqual(got, hold) {
		t.Fatalf("get_hold: %v", got)
	}
	// Confirmed, it is the reservation its id names, cancelled by that reference.
	confirmed := s.must(c.ConfirmHold(s.ctx, ConfirmHoldInput{HoldID: holdID}))["reservation"]
	if got := s.must(c.GetReservation(s.ctx, GetReservationInput{ReservationRef: holdID}))["reservation"]; !reflect.DeepEqual(got, confirmed) {
		t.Fatalf("get_reservation: %v", got)
	}
	s.must(c.CancelReservation(s.ctx, CancelReservationInput{ReservationRef: holdID, Revision: 2}))
	_, err = c.GetReservation(s.ctx, GetReservationInput{ReservationRef: holdID})
	s.refused(404, "reservation_not_found", err)

	archived := s.must(c.ArchiveResource(s.ctx, ArchiveResourceInput{ResourceID: id}))["resource"].(map[string]any)
	if archived["archived_at"] == nil {
		t.Fatalf("archive_resource: %v", archived)
	}
	if restored := s.must(c.RestoreResource(s.ctx, RestoreResourceInput{ResourceID: id}))["resource"].(map[string]any); restored["archived_at"] != nil {
		t.Fatalf("restore_resource: %v", restored)
	}
	if deleted := s.must(c.DeleteResource(s.ctx, DeleteResourceInput{ResourceID: id})); deleted["deleted"] != true {
		t.Fatalf("delete_resource: %v", deleted)
	}
	_, err = c.GetResource(s.ctx, GetResourceInput{ResourceID: id})
	s.refused(404, "resource_not_found", err)
}

func TestSaysWhyACallWasRefused(t *testing.T) {
	s := newServer(t)
	_, err := s.client.GetResource(s.ctx, GetResourceInput{ResourceID: "00000000-0000-4000-8000-000000000000"})
	s.refused(404, "resource_not_found", err)
	stranger, _ := New(os.Getenv("SLOTLOCK_URL"), "slk_"+strings.Repeat("0", 46))
	_, err = stranger.RunMaintenance(s.ctx, RunMaintenanceInput{})
	s.refused(401, "authentication_required", err)
}
