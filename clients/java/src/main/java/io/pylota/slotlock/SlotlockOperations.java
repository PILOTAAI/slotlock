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
          Map.entry("slotlock_list_events", new Operation("GET", "/v1/events", List.of(), List.of("resource_ids", "start", "end", "cursor", "limit"))),
          Map.entry("slotlock_create_event", new Operation("POST", "/v1/events", List.of(), List.of())),
          Map.entry("slotlock_get_event", new Operation("GET", "/v1/events/{event_id}", List.of("event_id"), List.of())),
          Map.entry("slotlock_update_event", new Operation("PATCH", "/v1/events/{event_id}", List.of("event_id"), List.of())),
          Map.entry("slotlock_delete_event", new Operation("DELETE", "/v1/events/{event_id}", List.of("event_id"), List.of("expected_revision", "idempotency_key"))),
          Map.entry("slotlock_get_resource", new Operation("GET", "/v1/resources/{resource_id}", List.of("resource_id"), List.of())),
          Map.entry("slotlock_set_resource_availability", new Operation("PUT", "/v1/resources/{resource_id}/availability", List.of("resource_id"), List.of())),
          Map.entry("slotlock_set_tenant_availability", new Operation("PUT", "/v1/availability", List.of(), List.of())),
          Map.entry("slotlock_acquire_hold", new Operation("POST", "/v1/holds", List.of(), List.of())),
          Map.entry("slotlock_confirm_hold", new Operation("POST", "/v1/holds/{hold_id}/confirm", List.of("hold_id"), List.of())),
          Map.entry("slotlock_release_hold", new Operation("DELETE", "/v1/holds/{hold_id}", List.of("hold_id"), List.of())),
          Map.entry("slotlock_put_reservation", new Operation("PUT", "/v1/reservations/{reservation_ref}", List.of("reservation_ref"), List.of())),
          Map.entry("slotlock_cancel_reservation", new Operation("DELETE", "/v1/reservations/{reservation_ref}", List.of("reservation_ref"), List.of("revision"))),
          Map.entry("slotlock_record_coverage", new Operation("PUT", "/v1/resources/{resource_id}/coverage/{source}", List.of("resource_id", "source"), List.of())),
          Map.entry("slotlock_run_maintenance", new Operation("POST", "/v1/maintenance", List.of(), List.of())));

  /**
   * Runs an operation by its name ({@code slotlock_…}) with its arguments, path parameters included.
   *
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public abstract Map<String, Object> call(String operation, Map<String, ?> values);

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

  /** {@link #listResources} without optional arguments. */
  public Map<String, Object> listResources() {
    return listResources(null);
  }

  /**
   * Create or update a resource. Create the resource with this external reference, or update its
   * time zone if the tenant already has it. Repeating the call changes nothing more.
   *
   * @param externalRef external_ref
   * @param optional the optional arguments, or null: {@code timezone} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createResource(String externalRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("external_ref", externalRef);
    putOptional(values, optional, Set.of("timezone"), "slotlock_create_resource");
    return call("slotlock_create_resource", values);
  }

  /** {@link #createResource} without optional arguments. */
  public Map<String, Object> createResource(String externalRef) {
    return createResource(externalRef, null);
  }

  /**
   * Get free-busy. Return privacy-minimized busy intervals and explicit coverage certainty.
   *
   * @param resourceIds resource_ids
   * @param start start
   * @param end end
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
   * @param resourceIds resource_ids
   * @param start start
   * @param end end
   * @param durationMinutes duration_minutes
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
   * List resource events. List bounded events intersecting a time window.
   *
   * @param resourceIds resource_ids
   * @param start start
   * @param end end
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

  /** {@link #listEvents} without optional arguments. */
  public Map<String, Object> listEvents(List<?> resourceIds, String start, String end) {
    return listEvents(resourceIds, start, end, null);
  }

  /**
   * Create resource event. Create an event of up to 3,660 days (a booking, lease or long rental);
   * opaque occurrences use the database overlap arbiter.
   *
   * @param resourceId resource_id
   * @param startsAt starts_at
   * @param endsAt ends_at
   * @param timezone timezone
   * @param idempotencyKey idempotency_key
   * @param optional the optional arguments, or null: {@code title} (string), {@code description}
   * (string), {@code location} (string), {@code organizer} (object), {@code transparency}
   * (string), {@code status} (string), {@code recurrence_rule} (string), {@code attendees} (list
   * of object), {@code reminders} (list of object), {@code recurrence_exceptions} (list of
   * object)
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
    putOptional(values, optional, Set.of("title", "description", "location", "organizer", "transparency", "status", "recurrence_rule", "attendees", "reminders", "recurrence_exceptions"), "slotlock_create_event");
    return call("slotlock_create_event", values);
  }

  /** {@link #createEvent} without optional arguments. */
  public Map<String, Object> createEvent(String resourceId, String startsAt, String endsAt, String timezone, String idempotencyKey) {
    return createEvent(resourceId, startsAt, endsAt, timezone, idempotencyKey, null);
  }

  /**
   * Get resource event. Read one tenant-scoped event by stable identifier.
   *
   * @param eventId event_id
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
   * atomically.
   *
   * @param eventId event_id
   * @param expectedRevision expected_revision
   * @param idempotencyKey idempotency_key
   * @param optional the optional arguments, or null: {@code resource_id} (string), {@code
   * starts_at} (string), {@code ends_at} (string), {@code timezone} (string), {@code title}
   * (string, null clears it), {@code description} (string, null clears it), {@code location}
   * (string, null clears it), {@code organizer} (object, null clears it), {@code attendees} (list
   * of object), {@code reminders} (list of object), {@code transparency} (string), {@code status}
   * (string), {@code recurrence_rule} (string, null clears it), {@code recurrence_exceptions}
   * (list of object)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> updateEvent(String eventId, long expectedRevision, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("resource_id", "starts_at", "ends_at", "timezone", "title", "description", "location", "organizer", "attendees", "reminders", "transparency", "status", "recurrence_rule", "recurrence_exceptions"), "slotlock_update_event");
    return call("slotlock_update_event", values);
  }

  /** {@link #updateEvent} without optional arguments. */
  public Map<String, Object> updateEvent(String eventId, long expectedRevision, String idempotencyKey) {
    return updateEvent(eventId, expectedRevision, idempotencyKey, null);
  }

  /**
   * Delete resource event. Tombstone an event at an expected revision so stale sync cannot
   * resurrect it.
   *
   * @param eventId event_id
   * @param expectedRevision expected_revision
   * @param idempotencyKey idempotency_key
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
   * Get a resource. One resource of the tenant, with its own weekly bookable hours.
   *
   * @param resourceId resource_id
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getResource(String resourceId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    return call("slotlock_get_resource", values);
  }

  /**
   * Set a resource's bookable hours. Give one resource its own weekly bookable hours. `null`
   * makes it use the server's default; `[]` makes it never bookable. Each rule is weekly with
   * BYDAY, in the resource's time zone: start_minutes after midnight, lasting duration_minutes.
   *
   * @param resourceId resource_id
   * @param rules rules (may be null)
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
   * Set every resource's bookable hours. Set the weekly bookable hours of every resource the
   * tenant has, as slotlock_set_resource_availability does for one. `null` makes them all use the
   * server's default. Returns how many resources changed.
   *
   * @param rules rules (may be null)
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
   * confirmed, or is released. A taken window answers 409 overlap.
   *
   * @param resourceId resource_id
   * @param start start
   * @param end end
   * @param ttlSeconds ttl_seconds
   * @param optional the optional arguments, or null: {@code source} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> acquireHold(String resourceId, String start, String end, long ttlSeconds, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("start", start);
    values.put("end", end);
    values.put("ttl_seconds", ttlSeconds);
    putOptional(values, optional, Set.of("source"), "slotlock_acquire_hold");
    return call("slotlock_acquire_hold", values);
  }

  /** {@link #acquireHold} without optional arguments. */
  public Map<String, Object> acquireHold(String resourceId, String start, String end, long ttlSeconds) {
    return acquireHold(resourceId, start, end, ttlSeconds, null);
  }

  /**
   * Confirm a hold. Turn an unexpired hold into a confirmed reservation. Confirming it again
   * answers the same reservation, so a retry is safe. An expired hold answers 409 hold_expired; a
   * released or unknown one, 404 hold_not_found.
   *
   * @param holdId hold_id
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> confirmHold(String holdId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    return call("slotlock_confirm_hold", values);
  }

  /**
   * Release a hold. Free a held window. released is false when the hold was already gone:
   * expired, confirmed or released.
   *
   * @param holdId hold_id
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> releaseHold(String holdId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    return call("slotlock_release_hold", values);
  }

  /**
   * Book or move a reservation. Book the reservation with this reference (revision 1), or move it
   * (the next revision: the current one plus 1). Sending the same reservation at its current
   * revision again changes nothing (replayed: true). A taken window answers 409 overlap and
   * leaves a moved reservation where it was. buffer_after_minutes keeps the time after it busy as
   * well.
   *
   * @param reservationRef reservation_ref
   * @param resourceId resource_id
   * @param start start
   * @param end end
   * @param revision revision
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

  /** {@link #putReservation} without optional arguments. */
  public Map<String, Object> putReservation(String reservationRef, String resourceId, String start, String end, long revision) {
    return putReservation(reservationRef, resourceId, start, end, revision, null);
  }

  /**
   * Cancel a reservation. Cancel the reservation with this reference at the next revision (the
   * current one plus 1). Cancelling leaves a tombstone, so a delayed booking cannot bring it
   * back; repeating the cancel answers cancelled: false. Use a new reference for a new
   * reservation.
   *
   * @param reservationRef reservation_ref
   * @param revision revision
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
   * Record calendar coverage. Record that the events of an external calendar (source) are
   * complete for a window of a resource, at that source's revision. Free/busy calls time
   * unproven, not free, until every source a resource requires covers it. Revisions only go
   * forward; repeating one changes nothing.
   *
   * @param resourceId resource_id
   * @param source source
   * @param start start
   * @param end end
   * @param revision revision
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
