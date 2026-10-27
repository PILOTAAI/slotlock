// Generated from openapi.json by clients/generate.ts. Do not edit: change the server, then run
// SLOTLOCK_WRITE_GENERATED=1 npx vitest run src/__tests__/generated.test.ts
package io.pylota.slotlock;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Every Slotlock REST operation as a method; {@link #call} runs one by name. */
public abstract class SlotlockOperations {
  /** Every operation, by name: its method, path, path parameters and query parameters. */
  static final Map<String, Operation> OPERATIONS =
      Map.ofEntries(
          Map.entry("slotlock_list_resources", new Operation("GET", "/v1/resources", List.of(), List.of("cursor", "limit"))),
          Map.entry("slotlock_create_resource", new Operation("POST", "/v1/resources", List.of(), List.of())),
          Map.entry("slotlock_get_free_busy", new Operation("GET", "/v1/free-busy", List.of(), List.of("resource_ids", "start", "end"))),
          Map.entry("slotlock_find_next_available", new Operation("GET", "/v1/next-available", List.of(), List.of("resource_ids", "start", "end", "duration_minutes"))),
          Map.entry("slotlock_find_available_slots", new Operation("GET", "/v1/available-slots", List.of(), List.of("resource_ids", "start", "end", "duration_minutes", "limit"))),
          Map.entry("slotlock_hold_slots", new Operation("POST", "/v1/slot-holds", List.of(), List.of())),
          Map.entry("slotlock_release_slots", new Operation("DELETE", "/v1/slot-holds/{hold_id}", List.of("hold_id"), List.of())),
          Map.entry("slotlock_list_events", new Operation("GET", "/v1/events", List.of(), List.of("resource_ids", "start", "end", "cursor", "limit"))),
          Map.entry("slotlock_create_event", new Operation("POST", "/v1/events", List.of(), List.of())),
          Map.entry("slotlock_get_event", new Operation("GET", "/v1/events/{event_id}", List.of("event_id"), List.of())),
          Map.entry("slotlock_update_event", new Operation("PATCH", "/v1/events/{event_id}", List.of("event_id"), List.of())),
          Map.entry("slotlock_delete_event", new Operation("DELETE", "/v1/events/{event_id}", List.of("event_id"), List.of("expected_revision", "idempotency_key"))),
          Map.entry("slotlock_get_resource", new Operation("GET", "/v1/resources/{resource_id}", List.of("resource_id"), List.of())),
          Map.entry("slotlock_delete_resource", new Operation("DELETE", "/v1/resources/{resource_id}", List.of("resource_id"), List.of())),
          Map.entry("slotlock_archive_resource", new Operation("POST", "/v1/resources/{resource_id}/archive", List.of("resource_id"), List.of())),
          Map.entry("slotlock_restore_resource", new Operation("POST", "/v1/resources/{resource_id}/restore", List.of("resource_id"), List.of())),
          Map.entry("slotlock_list_busy", new Operation("GET", "/v1/resources/{resource_id}/busy", List.of("resource_id"), List.of("start", "end"))),
          Map.entry("slotlock_set_resource_availability", new Operation("PUT", "/v1/resources/{resource_id}/availability", List.of("resource_id"), List.of())),
          Map.entry("slotlock_set_resource_booking_rules", new Operation("PUT", "/v1/resources/{resource_id}/booking-rules", List.of("resource_id"), List.of())),
          Map.entry("slotlock_set_tenant_availability", new Operation("PUT", "/v1/availability", List.of(), List.of())),
          Map.entry("slotlock_acquire_hold", new Operation("POST", "/v1/holds", List.of(), List.of())),
          Map.entry("slotlock_get_hold", new Operation("GET", "/v1/holds/{hold_id}", List.of("hold_id"), List.of())),
          Map.entry("slotlock_release_hold", new Operation("DELETE", "/v1/holds/{hold_id}", List.of("hold_id"), List.of())),
          Map.entry("slotlock_list_holds", new Operation("GET", "/v1/resources/{resource_id}/holds", List.of("resource_id"), List.of("limit", "cursor"))),
          Map.entry("slotlock_confirm_hold", new Operation("POST", "/v1/holds/{hold_id}/confirm", List.of("hold_id"), List.of())),
          Map.entry("slotlock_get_reservation", new Operation("GET", "/v1/reservations/{reservation_ref}", List.of("reservation_ref"), List.of())),
          Map.entry("slotlock_put_reservation", new Operation("PUT", "/v1/reservations/{reservation_ref}", List.of("reservation_ref"), List.of())),
          Map.entry("slotlock_cancel_reservation", new Operation("DELETE", "/v1/reservations/{reservation_ref}", List.of("reservation_ref"), List.of("revision"))),
          Map.entry("slotlock_list_reservations", new Operation("GET", "/v1/resources/{resource_id}/reservations", List.of("resource_id"), List.of("start", "end", "limit", "cursor"))),
          Map.entry("slotlock_record_coverage", new Operation("PUT", "/v1/resources/{resource_id}/coverage/{source}", List.of("resource_id", "source"), List.of())),
          Map.entry("slotlock_list_tenant_events", new Operation("GET", "/v1/tenant/events", List.of(), List.of("resource_id", "start", "end", "limit", "cursor"))),
          Map.entry("slotlock_get_tenant_event", new Operation("GET", "/v1/tenant/events/{event_id}", List.of("event_id"), List.of())),
          Map.entry("slotlock_cancel_tenant_event", new Operation("DELETE", "/v1/tenant/events/{event_id}", List.of("event_id"), List.of("expected_revision", "expected_resource_id", "idempotency_key"))),
          Map.entry("slotlock_get_tenant", new Operation("GET", "/v1/tenant", List.of(), List.of())),
          Map.entry("slotlock_erase_tenant", new Operation("POST", "/v1/tenant/erase", List.of(), List.of())),
          Map.entry("slotlock_run_maintenance", new Operation("POST", "/v1/maintenance", List.of(), List.of())));

  /**
   * Runs an operation by its name with its arguments, path parameters included.
   *
   * @param operation the operation's name, {@code slotlock_…}
   * @param values its arguments, by name; a null value sends null
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public abstract Map<String, Object> call(String operation, Map<String, ?> values);

  /** Only {@link SlotlockClient} extends this. */
  SlotlockOperations() {}

  private static void putOptional(
      Map<String, Object> values, Map<String, ?> optional, Set<String> names, String operation) {
    if (optional == null) return;
    for (Map.Entry<String, ?> entry : optional.entrySet()) {
      if (!names.contains(entry.getKey())) {
        throw new IllegalArgumentException(operation + " has no optional argument " + entry.getKey());
      }
      values.put(entry.getKey(), entry.getValue());
    }
  }

  /**
   * List calendar resources. List resources visible to the authenticated tenant principal.
   *
   * @param optional the optional arguments, or null: {@code cursor} (string), {@code limit}
   * (integer)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listResources(Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    putOptional(values, optional, Set.of("cursor", "limit"), "slotlock_list_resources");
    return call("slotlock_list_resources", values);
  }

  /**
   * List calendar resources. List resources visible to the authenticated tenant principal.
   *
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listResources() {
    return listResources(null);
  }

  /**
   * Create or update a resource. Create the resource with this external reference, or update its
   * time zone if the tenant already has it. Repeating the call changes nothing more. visibility
   * is shared (the default: agents list and book it) or private (agents never see it), fixed at
   * creation: naming another for an existing resource answers 409 resource_visibility_conflict.
   *
   * @param externalRef {@code external_ref}, string
   * @param optional the optional arguments, or null: {@code timezone} (string), {@code
   * visibility} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createResource(String externalRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("external_ref", externalRef);
    putOptional(values, optional, Set.of("timezone", "visibility"), "slotlock_create_resource");
    return call("slotlock_create_resource", values);
  }

  /**
   * Create or update a resource. Create the resource with this external reference, or update its
   * time zone if the tenant already has it. Repeating the call changes nothing more. visibility
   * is shared (the default: agents list and book it) or private (agents never see it), fixed at
   * creation: naming another for an existing resource answers 409 resource_visibility_conflict.
   *
   * @param externalRef {@code external_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createResource(String externalRef) {
    return createResource(externalRef, null);
  }

  /**
   * Get free-busy. Return privacy-minimized busy intervals and explicit coverage certainty.
   *
   * @param resourceIds {@code resource_ids}, list of string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getFreeBusy(List<?> resourceIds, String start, String end) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_ids", resourceIds);
    values.put("start", start);
    values.put("end", end);
    return call("slotlock_get_free_busy", values);
  }

  /**
   * Find next available interval. Find the earliest certain interval that satisfies the requested
   * duration (up to the 367-day search window, so a multi-month rental slot can be found).
   *
   * @param resourceIds {@code resource_ids}, list of string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param durationMinutes {@code duration_minutes}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findNextAvailable(List<?> resourceIds, String start, String end, long durationMinutes) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_ids", resourceIds);
    values.put("start", start);
    values.put("end", end);
    values.put("duration_minutes", durationMinutes);
    return call("slotlock_find_next_available", values);
  }

  /**
   * Find available slots. List up to `limit` certain slots of the requested duration, earliest
   * first across the resources, each one free of busy time and inside the resource's hours, to
   * offer a person a choice. No slot is listed unless every resource's coverage is certain.
   *
   * @param resourceIds {@code resource_ids}, list of string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param durationMinutes {@code duration_minutes}, integer
   * @param optional the optional arguments, or null: {@code limit} (integer)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findAvailableSlots(List<?> resourceIds, String start, String end, long durationMinutes, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_ids", resourceIds);
    values.put("start", start);
    values.put("end", end);
    values.put("duration_minutes", durationMinutes);
    putOptional(values, optional, Set.of("limit"), "slotlock_find_available_slots");
    return call("slotlock_find_available_slots", values);
  }

  /**
   * Find available slots. List up to `limit` certain slots of the requested duration, earliest
   * first across the resources, each one free of busy time and inside the resource's hours, to
   * offer a person a choice. No slot is listed unless every resource's coverage is certain.
   *
   * @param resourceIds {@code resource_ids}, list of string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param durationMinutes {@code duration_minutes}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findAvailableSlots(List<?> resourceIds, String start, String end, long durationMinutes) {
    return findAvailableSlots(resourceIds, start, end, durationMinutes, null);
  }

  /**
   * Hold candidate slots. Hold up to five candidate slots for a short time (30-900 seconds) while
   * a person chooses, as alternatives in one group: each free one is held, the others are listed
   * with why not. Book one by passing its hold_id to slotlock_create_event, which releases the
   * rest; unbooked holds expire on their own. A hold is yours alone, and you may have 20 live at
   * once.
   *
   * @param slots {@code slots}, list of object
   * @param idempotencyKey {@code idempotency_key}, string
   * @param optional the optional arguments, or null: {@code ttl_seconds} (integer)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> holdSlots(List<?> slots, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("slots", slots);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("ttl_seconds"), "slotlock_hold_slots");
    return call("slotlock_hold_slots", values);
  }

  /**
   * Hold candidate slots. Hold up to five candidate slots for a short time (30-900 seconds) while
   * a person chooses, as alternatives in one group: each free one is held, the others are listed
   * with why not. Book one by passing its hold_id to slotlock_create_event, which releases the
   * rest; unbooked holds expire on their own. A hold is yours alone, and you may have 20 live at
   * once.
   *
   * @param slots {@code slots}, list of object
   * @param idempotencyKey {@code idempotency_key}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> holdSlots(List<?> slots, String idempotencyKey) {
    return holdSlots(slots, idempotencyKey, null);
  }

  /**
   * Release held slots. Release one of your holds, and the rest of its group, at once instead of
   * letting them expire. `released` is false when it was already gone.
   *
   * @param holdId {@code hold_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> releaseSlots(String holdId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    return call("slotlock_release_slots", values);
  }

  /**
   * List resource events. List bounded events intersecting a time window.
   *
   * @param resourceIds {@code resource_ids}, list of string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param optional the optional arguments, or null: {@code cursor} (string), {@code limit}
   * (integer)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listEvents(List<?> resourceIds, String start, String end, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_ids", resourceIds);
    values.put("start", start);
    values.put("end", end);
    putOptional(values, optional, Set.of("cursor", "limit"), "slotlock_list_events");
    return call("slotlock_list_events", values);
  }

  /**
   * List resource events. List bounded events intersecting a time window.
   *
   * @param resourceIds {@code resource_ids}, list of string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listEvents(List<?> resourceIds, String start, String end) {
    return listEvents(resourceIds, start, end, null);
  }

  /**
   * Create resource event. Create an event of up to 3,660 days (a booking, lease or long rental);
   * opaque occurrences use the database overlap arbiter.
   *
   * @param resourceId {@code resource_id}, string
   * @param startsAt {@code starts_at}, string
   * @param endsAt {@code ends_at}, string
   * @param timezone {@code timezone}, string
   * @param idempotencyKey {@code idempotency_key}, string
   * @param optional the optional arguments, or null: {@code title} (string), {@code description}
   * (string), {@code location} (string), {@code organizer} (object), {@code transparency}
   * (string), {@code status} (string), {@code recurrence_rule} (string), {@code attendees} (list
   * of object), {@code reminders} (list of object), {@code recurrence_exceptions} (list of
   * object), {@code hold_id} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createEvent(String resourceId, String startsAt, String endsAt, String timezone, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("starts_at", startsAt);
    values.put("ends_at", endsAt);
    values.put("timezone", timezone);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("title", "description", "location", "organizer", "transparency", "status", "recurrence_rule", "attendees", "reminders", "recurrence_exceptions", "hold_id"), "slotlock_create_event");
    return call("slotlock_create_event", values);
  }

  /**
   * Create resource event. Create an event of up to 3,660 days (a booking, lease or long rental);
   * opaque occurrences use the database overlap arbiter.
   *
   * @param resourceId {@code resource_id}, string
   * @param startsAt {@code starts_at}, string
   * @param endsAt {@code ends_at}, string
   * @param timezone {@code timezone}, string
   * @param idempotencyKey {@code idempotency_key}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createEvent(String resourceId, String startsAt, String endsAt, String timezone, String idempotencyKey) {
    return createEvent(resourceId, startsAt, endsAt, timezone, idempotencyKey, null);
  }

  /**
   * Get resource event. Read one tenant-scoped event by stable identifier.
   *
   * @param eventId {@code event_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getEvent(String eventId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    return call("slotlock_get_event", values);
  }

  /**
   * Update resource event. Apply an expected-revision event patch and rematerialize occupancy
   * atomically. With expected_resource_id, the resource you read the event on, an event since
   * moved elsewhere is not found.
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param idempotencyKey {@code idempotency_key}, string
   * @param optional the optional arguments, or null: {@code resource_id} (string), {@code
   * starts_at} (string), {@code ends_at} (string), {@code timezone} (string), {@code title}
   * (string, null clears it), {@code description} (string, null clears it), {@code location}
   * (string, null clears it), {@code organizer} (object, null clears it), {@code attendees} (list
   * of object), {@code reminders} (list of object), {@code transparency} (string), {@code status}
   * (string), {@code recurrence_rule} (string, null clears it), {@code recurrence_exceptions}
   * (list of object), {@code expected_resource_id} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> updateEvent(String eventId, long expectedRevision, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("resource_id", "starts_at", "ends_at", "timezone", "title", "description", "location", "organizer", "attendees", "reminders", "transparency", "status", "recurrence_rule", "recurrence_exceptions", "expected_resource_id"), "slotlock_update_event");
    return call("slotlock_update_event", values);
  }

  /**
   * Update resource event. Apply an expected-revision event patch and rematerialize occupancy
   * atomically. With expected_resource_id, the resource you read the event on, an event since
   * moved elsewhere is not found.
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param idempotencyKey {@code idempotency_key}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> updateEvent(String eventId, long expectedRevision, String idempotencyKey) {
    return updateEvent(eventId, expectedRevision, idempotencyKey, null);
  }

  /**
   * Delete resource event. Tombstone an event at an expected revision so stale sync cannot
   * resurrect it.
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param idempotencyKey {@code idempotency_key}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteEvent(String eventId, long expectedRevision, String idempotencyKey) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    values.put("idempotency_key", idempotencyKey);
    return call("slotlock_delete_event", values);
  }

  /**
   * Get a resource. One resource of the tenant, archived or not, with its own weekly bookable
   * hours and its visibility.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getResource(String resourceId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    return call("slotlock_get_resource", values);
  }

  /**
   * Delete a resource. Delete a resource with its history (past bookings, coverage, cancelled
   * events), freeing its place under the tenant's resource limit. Refused with 409
   * resource_in_use while a booking on it has not ended, a hold on it is live, or a calendar
   * event is on it: cancel or move those first. deleted is false when the tenant has no such
   * resource, deleted already, say.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteResource(String resourceId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    return call("slotlock_delete_resource", values);
  }

  /**
   * Archive a resource. Take a resource out of use: no list shows it and it takes no new booking,
   * hold or event (409 resource_archived), while what is on it stays and can still be cancelled
   * or released. Archiving it again keeps the first time.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> archiveResource(String resourceId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    return call("slotlock_archive_resource", values);
  }

  /**
   * Restore a resource. Put an archived resource back in use. Restoring one in use changes
   * nothing.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> restoreResource(String resourceId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    return call("slotlock_restore_resource", values);
  }

  /**
   * List a resource's busy time. The time a resource of the tenant, private ones included, is
   * occupied in a window of at most 367 days, by start: bookings with their turnaround, live
   * holds, and calendar events. Adjacent intervals are not merged. More than 10,000 answers 400
   * calendar_work_limit: narrow the window. Free/busy with coverage, for the resources agents
   * see, is slotlock_get_free_busy.
   *
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listBusy(String resourceId, String start, String end) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("start", start);
    values.put("end", end);
    return call("slotlock_list_busy", values);
  }

  /**
   * Set a resource's bookable hours. Give one resource its own weekly bookable hours. `null`
   * makes it use the server's default; `[]` makes it never bookable. Each rule is weekly with
   * BYDAY, in the resource's time zone: start_minutes after midnight, lasting duration_minutes.
   *
   * @param resourceId {@code resource_id}, string
   * @param rules {@code rules}, list of object (may be null)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourceAvailability(String resourceId, List<?> rules) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("rules", rules);
    return call("slotlock_set_resource_availability", values);
  }

  /**
   * Set a resource's booking rules. Set what a booking on one resource must satisfy from now on:
   * minimum notice, how far ahead, the step starts fall on (from local midnight in the resource's
   * time zone), the turnaround kept free after each booking, and whether bookings must lie inside
   * its hours. `null` clears them. Holds, reservations, moves and agents' events are refused with
   * the rule they break; searches offer only what they allow.
   *
   * @param resourceId {@code resource_id}, string
   * @param rules {@code rules}, object (may be null)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourceBookingRules(String resourceId, Map<String, ?> rules) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("rules", rules);
    return call("slotlock_set_resource_booking_rules", values);
  }

  /**
   * Set every resource's bookable hours. Set the weekly bookable hours of every resource the
   * tenant has, as slotlock_set_resource_availability does for one. `null` makes them all use the
   * server's default. Returns how many resources changed.
   *
   * @param rules {@code rules}, list of object (may be null)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setTenantAvailability(List<?> rules) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("rules", rules);
    return call("slotlock_set_tenant_availability", values);
  }

  /**
   * Hold time. Occupy a window without booking it, for example while a customer pays. The hold
   * blocks every other booking until it expires (the database clock, ttl_seconds from now), is
   * confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and a
   * confirmed hold keeps it. A taken window answers 409 overlap. With an idempotency key (the
   * Idempotency-Key header or idempotency_key), a retry answers the hold the first request made,
   * until that hold would have expired, is released or is confirmed; the same key with another
   * request is 409 idempotency_conflict.
   *
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param ttlSeconds {@code ttl_seconds}, integer
   * @param optional the optional arguments, or null: {@code source} (string), {@code
   * idempotency_key} (string), {@code buffer_after_minutes} (integer)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> acquireHold(String resourceId, String start, String end, long ttlSeconds, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("start", start);
    values.put("end", end);
    values.put("ttl_seconds", ttlSeconds);
    putOptional(values, optional, Set.of("source", "idempotency_key", "buffer_after_minutes"), "slotlock_acquire_hold");
    return call("slotlock_acquire_hold", values);
  }

  /**
   * Hold time. Occupy a window without booking it, for example while a customer pays. The hold
   * blocks every other booking until it expires (the database clock, ttl_seconds from now), is
   * confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and a
   * confirmed hold keeps it. A taken window answers 409 overlap. With an idempotency key (the
   * Idempotency-Key header or idempotency_key), a retry answers the hold the first request made,
   * until that hold would have expired, is released or is confirmed; the same key with another
   * request is 409 idempotency_conflict.
   *
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param ttlSeconds {@code ttl_seconds}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> acquireHold(String resourceId, String start, String end, long ttlSeconds) {
    return acquireHold(resourceId, start, end, ttlSeconds, null);
  }

  /**
   * Get a hold. One of the tenant's live holds. An expired, confirmed, released or unknown one
   * answers 404 hold_not_found; a confirmed one is a reservation whose reference is the hold's
   * id.
   *
   * @param holdId {@code hold_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getHold(String holdId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    return call("slotlock_get_hold", values);
  }

  /**
   * Release a hold. Free a held window. released is false when the hold was already gone:
   * expired, confirmed or released.
   *
   * @param holdId {@code hold_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> releaseHold(String holdId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    return call("slotlock_release_hold", values);
  }

  /**
   * List a resource's holds. The live holds on one of the tenant's resources, by start then id, a
   * page at a time: pass next_cursor as cursor for the next page, until it is null.
   *
   * @param resourceId {@code resource_id}, string
   * @param optional the optional arguments, or null: {@code limit} (integer), {@code cursor}
   * (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listHolds(String resourceId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    putOptional(values, optional, Set.of("limit", "cursor"), "slotlock_list_holds");
    return call("slotlock_list_holds", values);
  }

  /**
   * List a resource's holds. The live holds on one of the tenant's resources, by start then id, a
   * page at a time: pass next_cursor as cursor for the next page, until it is null.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listHolds(String resourceId) {
    return listHolds(resourceId, null);
  }

  /**
   * Confirm a hold. Turn an unexpired hold into a confirmed reservation, whose reference is the
   * hold's id at revision 1: move or cancel it with the reservation routes by that reference
   * (DELETE /v1/reservations/{hold_id}?revision=2 cancels it). Confirming it again answers the
   * same reservation, so a retry is safe. An expired hold answers 409 hold_expired; a released or
   * unknown one, 404 hold_not_found.
   *
   * @param holdId {@code hold_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> confirmHold(String holdId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    return call("slotlock_confirm_hold", values);
  }

  /**
   * Get a reservation. The tenant's booking with this reference as it now is, at its current
   * revision: move it at that revision plus 1. A cancelled or unknown reference, or a calendar
   * event's time, answers 404 reservation_not_found.
   *
   * @param reservationRef {@code reservation_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getReservation(String reservationRef) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("reservation_ref", reservationRef);
    return call("slotlock_get_reservation", values);
  }

  /**
   * Book or move a reservation. Book the reservation with this reference (revision 1), or move it
   * (the next revision: the current one plus 1). Sending the same reservation at its current
   * revision again changes nothing (replayed: true). A taken window answers 409 overlap and
   * leaves a moved reservation where it was. buffer_after_minutes keeps the time after it busy as
   * well.
   *
   * @param reservationRef {@code reservation_ref}, string
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param revision {@code revision}, integer
   * @param optional the optional arguments, or null: {@code buffer_after_minutes} (integer),
   * {@code source} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> putReservation(String reservationRef, String resourceId, String start, String end, long revision, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("reservation_ref", reservationRef);
    values.put("resource_id", resourceId);
    values.put("start", start);
    values.put("end", end);
    values.put("revision", revision);
    putOptional(values, optional, Set.of("buffer_after_minutes", "source"), "slotlock_put_reservation");
    return call("slotlock_put_reservation", values);
  }

  /**
   * Book or move a reservation. Book the reservation with this reference (revision 1), or move it
   * (the next revision: the current one plus 1). Sending the same reservation at its current
   * revision again changes nothing (replayed: true). A taken window answers 409 overlap and
   * leaves a moved reservation where it was. buffer_after_minutes keeps the time after it busy as
   * well.
   *
   * @param reservationRef {@code reservation_ref}, string
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param revision {@code revision}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> putReservation(String reservationRef, String resourceId, String start, String end, long revision) {
    return putReservation(reservationRef, resourceId, start, end, revision, null);
  }

  /**
   * Cancel a reservation. Cancel the reservation with this reference at the next revision (the
   * current one plus 1). Cancelling leaves a tombstone, so a delayed booking cannot bring it
   * back; repeating the cancel answers cancelled: false. Use a new reference for a new
   * reservation.
   *
   * @param reservationRef {@code reservation_ref}, string
   * @param revision {@code revision}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> cancelReservation(String reservationRef, long revision) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("reservation_ref", reservationRef);
    values.put("revision", revision);
    return call("slotlock_cancel_reservation", values);
  }

  /**
   * List a resource's reservations. The tenant's bookings on one resource whose time, turnaround
   * included, meets a window of at most 367 days, by start then id, a page at a time: pass
   * next_cursor as cursor for the next page, until it is null. Calendar events are not bookings;
   * slotlock_list_tenant_events lists them.
   *
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param optional the optional arguments, or null: {@code limit} (integer), {@code cursor}
   * (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listReservations(String resourceId, String start, String end, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("start", start);
    values.put("end", end);
    putOptional(values, optional, Set.of("limit", "cursor"), "slotlock_list_reservations");
    return call("slotlock_list_reservations", values);
  }

  /**
   * List a resource's reservations. The tenant's bookings on one resource whose time, turnaround
   * included, meets a window of at most 367 days, by start then id, a page at a time: pass
   * next_cursor as cursor for the next page, until it is null. Calendar events are not bookings;
   * slotlock_list_tenant_events lists them.
   *
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listReservations(String resourceId, String start, String end) {
    return listReservations(resourceId, start, end, null);
  }

  /**
   * Record calendar coverage. Record that the events of an external calendar (source) are
   * complete for a window of a resource, at that source's revision. Free/busy calls time
   * unproven, not free, until every source a resource requires covers it. Revisions only go
   * forward; repeating one changes nothing.
   *
   * @param resourceId {@code resource_id}, string
   * @param source {@code source}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param revision {@code revision}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> recordCoverage(String resourceId, String source, String start, String end, long revision) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("source", source);
    values.put("start", start);
    values.put("end", end);
    values.put("revision", revision);
    return call("slotlock_record_coverage", values);
  }

  /**
   * List a resource's events, every key's. The calendar events on one of the tenant's resources
   * with an occurrence in a window of at most 367 days, whichever key wrote them (a revoked one's
   * included), by start then id, a page at a time: pass next_cursor as cursor for the next page,
   * until it is null.
   *
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param optional the optional arguments, or null: {@code limit} (integer), {@code cursor}
   * (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listTenantEvents(String resourceId, String start, String end, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("start", start);
    values.put("end", end);
    putOptional(values, optional, Set.of("limit", "cursor"), "slotlock_list_tenant_events");
    return call("slotlock_list_tenant_events", values);
  }

  /**
   * List a resource's events, every key's. The calendar events on one of the tenant's resources
   * with an occurrence in a window of at most 367 days, whichever key wrote them (a revoked one's
   * included), by start then id, a page at a time: pass next_cursor as cursor for the next page,
   * until it is null.
   *
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listTenantEvents(String resourceId, String start, String end) {
    return listTenantEvents(resourceId, start, end, null);
  }

  /**
   * Get any event of the tenant. One of the tenant's events by its id (the id
   * slotlock_list_tenant_events gives), whichever key wrote it. A cancelled or unknown one
   * answers 404 event_not_found.
   *
   * @param eventId {@code event_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getTenantEvent(String eventId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    return call("slotlock_get_tenant_event", values);
  }

  /**
   * Cancel any event of the tenant. Cancel one of the tenant's events by its id, whichever key
   * wrote it (a revoked key's included, without charging its quota), at the revision you last
   * read (expected_revision). Its owner cannot create it again. With expected_resource_id, an
   * event since moved to another resource answers 404 event_not_found. Needs an idempotency key
   * (the Idempotency-Key header or idempotency_key): a retry with it answers the first
   * cancellation (replayed: true).
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param idempotencyKey A retry identity, also accepted as the Idempotency-Key header: the same
   * key with the same request answers what the first did; with another request, 409
   * idempotency_conflict.
   * @param optional the optional arguments, or null: {@code expected_resource_id} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> cancelTenantEvent(String eventId, long expectedRevision, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("expected_resource_id"), "slotlock_cancel_tenant_event");
    return call("slotlock_cancel_tenant_event", values);
  }

  /**
   * Cancel any event of the tenant. Cancel one of the tenant's events by its id, whichever key
   * wrote it (a revoked key's included, without charging its quota), at the revision you last
   * read (expected_revision). Its owner cannot create it again. With expected_resource_id, an
   * event since moved to another resource answers 404 event_not_found. Needs an idempotency key
   * (the Idempotency-Key header or idempotency_key): a retry with it answers the first
   * cancellation (replayed: true).
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param idempotencyKey A retry identity, also accepted as the Idempotency-Key header: the same
   * key with the same request answers what the first did; with another request, 409
   * idempotency_conflict.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> cancelTenantEvent(String eventId, long expectedRevision, String idempotencyKey) {
    return cancelTenantEvent(eventId, expectedRevision, idempotencyKey, null);
  }

  /**
   * Get the tenant. The key's tenant: its reference, and whether it is suspended. A suspended
   * tenant may read and writes nothing (403 tenant_suspended); only the server's operator
   * suspends a tenant or lifts a suspension (slotlock tenant suspend).
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getTenant() {
    Map<String, Object> values = new LinkedHashMap<>();
    return call("slotlock_get_tenant", values);
  }

  /**
   * Erase the tenant. Delete everything the key's tenant has, at once and for good: resources,
   * holds, bookings, events, coverage and every API key, this one included. confirm_tenant_ref
   * must be the tenant's reference (slotlock_get_tenant), or it answers 400 invalid_confirmation.
   * Off unless the server allows it (403 tenant_erasure_disabled; slotlock serve does not: its
   * operator runs slotlock tenant erase). A suspended tenant cannot erase itself (403
   * tenant_suspended). Erasing again deletes nothing.
   *
   * @param confirmTenantRef {@code confirm_tenant_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> eraseTenant(String confirmTenantRef) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("confirm_tenant_ref", confirmTenantRef);
    return call("slotlock_erase_tenant", values);
  }

  /**
   * Run maintenance. Extend recurring events to the rolling horizon and prune what the retention
   * window no longer needs, for the caller's tenant. Run it at least daily (slotlock serve does).
   * capped is true when there was more than one call does: call again.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> runMaintenance() {
    Map<String, Object> values = new LinkedHashMap<>();
    return call("slotlock_run_maintenance", values);
  }

}
