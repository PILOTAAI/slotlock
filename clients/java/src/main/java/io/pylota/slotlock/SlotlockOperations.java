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
          Map.entry("slotlock_list_resources", new Operation("GET", "/v1/resources", List.of(), List.of("cursor", "limit", "pool", "kind", "labels", "location", "group"))),
          Map.entry("slotlock_create_resource", new Operation("POST", "/v1/resources", List.of(), List.of())),
          Map.entry("slotlock_get_free_busy", new Operation("GET", "/v1/free-busy", List.of(), List.of("resource_ids", "location", "group", "labels", "kind", "pool", "start", "end"))),
          Map.entry("slotlock_find_next_available", new Operation("GET", "/v1/next-available", List.of(), List.of("resource_ids", "location", "group", "labels", "kind", "pool", "start", "end", "duration_minutes"))),
          Map.entry("slotlock_find_available_slots", new Operation("GET", "/v1/available-slots", List.of(), List.of("resource_ids", "location", "group", "labels", "kind", "pool", "start", "end", "duration_minutes", "limit", "require_free"))),
          Map.entry("slotlock_hold_slots", new Operation("POST", "/v1/slot-holds", List.of(), List.of())),
          Map.entry("slotlock_book_together", new Operation("POST", "/v1/bundles", List.of(), List.of())),
          Map.entry("slotlock_book_pool", new Operation("POST", "/v1/pool-bookings", List.of(), List.of())),
          Map.entry("slotlock_get_pool_availability", new Operation("GET", "/v1/pool-availability", List.of(), List.of("pool", "start", "end"))),
          Map.entry("slotlock_release_slots", new Operation("DELETE", "/v1/slot-holds/{hold_id}", List.of("hold_id"), List.of("dry_run"))),
          Map.entry("slotlock_confirm_slot", new Operation("POST", "/v1/slot-holds/{hold_id}/confirm", List.of("hold_id"), List.of())),
          Map.entry("slotlock_list_events", new Operation("GET", "/v1/events", List.of(), List.of("resource_ids", "start", "end", "cursor", "limit"))),
          Map.entry("slotlock_create_event", new Operation("POST", "/v1/events", List.of(), List.of())),
          Map.entry("slotlock_get_event", new Operation("GET", "/v1/events/{event_id}", List.of("event_id"), List.of())),
          Map.entry("slotlock_update_event", new Operation("PATCH", "/v1/events/{event_id}", List.of("event_id"), List.of())),
          Map.entry("slotlock_delete_event", new Operation("DELETE", "/v1/events/{event_id}", List.of("event_id"), List.of("expected_revision", "idempotency_key", "dry_run"))),
          Map.entry("slotlock_reschedule", new Operation("POST", "/v1/events/{event_id}/reschedule", List.of("event_id"), List.of())),
          Map.entry("slotlock_cancel", new Operation("POST", "/v1/events/{event_id}/cancel", List.of("event_id"), List.of())),
          Map.entry("slotlock_get_resource", new Operation("GET", "/v1/resources/{resource_id}", List.of("resource_id"), List.of())),
          Map.entry("slotlock_update_resource", new Operation("PATCH", "/v1/resources/{resource_id}", List.of("resource_id"), List.of())),
          Map.entry("slotlock_delete_resource", new Operation("DELETE", "/v1/resources/{resource_id}", List.of("resource_id"), List.of("dry_run"))),
          Map.entry("slotlock_list_locations", new Operation("GET", "/v1/locations", List.of(), List.of())),
          Map.entry("slotlock_create_location", new Operation("POST", "/v1/locations", List.of(), List.of())),
          Map.entry("slotlock_update_location", new Operation("PATCH", "/v1/locations/{location_ref}", List.of("location_ref"), List.of())),
          Map.entry("slotlock_delete_location", new Operation("DELETE", "/v1/locations/{location_ref}", List.of("location_ref"), List.of("dry_run"))),
          Map.entry("slotlock_list_groups", new Operation("GET", "/v1/groups", List.of(), List.of())),
          Map.entry("slotlock_create_group", new Operation("POST", "/v1/groups", List.of(), List.of())),
          Map.entry("slotlock_delete_group", new Operation("DELETE", "/v1/groups/{group_ref}", List.of("group_ref"), List.of("dry_run"))),
          Map.entry("slotlock_add_group_member", new Operation("PUT", "/v1/groups/{group_ref}/members/{resource_id}", List.of("group_ref", "resource_id"), List.of())),
          Map.entry("slotlock_remove_group_member", new Operation("DELETE", "/v1/groups/{group_ref}/members/{resource_id}", List.of("group_ref", "resource_id"), List.of("dry_run"))),
          Map.entry("slotlock_archive_resource", new Operation("POST", "/v1/resources/{resource_id}/archive", List.of("resource_id"), List.of())),
          Map.entry("slotlock_restore_resource", new Operation("POST", "/v1/resources/{resource_id}/restore", List.of("resource_id"), List.of())),
          Map.entry("slotlock_list_busy", new Operation("GET", "/v1/resources/{resource_id}/busy", List.of("resource_id"), List.of("start", "end"))),
          Map.entry("slotlock_set_resource_availability", new Operation("PUT", "/v1/resources/{resource_id}/availability", List.of("resource_id"), List.of())),
          Map.entry("slotlock_export_resource_availability", new Operation("GET", "/v1/resources/{resource_id}/availability/ical", List.of("resource_id"), List.of())),
          Map.entry("slotlock_import_resource_availability", new Operation("PUT", "/v1/resources/{resource_id}/availability/ical", List.of("resource_id"), List.of())),
          Map.entry("slotlock_set_resource_booking_rules", new Operation("PUT", "/v1/resources/{resource_id}/booking-rules", List.of("resource_id"), List.of())),
          Map.entry("slotlock_set_resource_pool", new Operation("PUT", "/v1/resources/{resource_id}/pool", List.of("resource_id"), List.of())),
          Map.entry("slotlock_set_resource_parent", new Operation("PUT", "/v1/resources/{resource_id}/parent", List.of("resource_id"), List.of())),
          Map.entry("slotlock_list_pools", new Operation("GET", "/v1/pools", List.of(), List.of())),
          Map.entry("slotlock_set_pool_order", new Operation("PUT", "/v1/pools/{pool}/order", List.of("pool"), List.of())),
          Map.entry("slotlock_get_booking_rule_defaults", new Operation("GET", "/v1/booking-rules", List.of(), List.of())),
          Map.entry("slotlock_set_tenant_booking_rules", new Operation("PUT", "/v1/booking-rules", List.of(), List.of())),
          Map.entry("slotlock_set_pool_booking_rules", new Operation("PUT", "/v1/pools/{pool}/booking-rules", List.of("pool"), List.of())),
          Map.entry("slotlock_get_resource_history", new Operation("GET", "/v1/resources/{resource_id}/history", List.of("resource_id"), List.of("limit", "before"))),
          Map.entry("slotlock_get_reservation_history", new Operation("GET", "/v1/reservations/{reservation_ref}/history", List.of("reservation_ref"), List.of("limit", "before"))),
          Map.entry("slotlock_get_tenant_event_history", new Operation("GET", "/v1/tenant/events/{event_id}/history", List.of("event_id"), List.of("limit", "before"))),
          Map.entry("slotlock_set_tenant_availability", new Operation("PUT", "/v1/availability", List.of(), List.of())),
          Map.entry("slotlock_acquire_hold", new Operation("POST", "/v1/holds", List.of(), List.of())),
          Map.entry("slotlock_get_hold", new Operation("GET", "/v1/holds/{hold_id}", List.of("hold_id"), List.of())),
          Map.entry("slotlock_release_hold", new Operation("DELETE", "/v1/holds/{hold_id}", List.of("hold_id"), List.of("dry_run"))),
          Map.entry("slotlock_list_holds", new Operation("GET", "/v1/resources/{resource_id}/holds", List.of("resource_id"), List.of("limit", "cursor"))),
          Map.entry("slotlock_confirm_hold", new Operation("POST", "/v1/holds/{hold_id}/confirm", List.of("hold_id"), List.of())),
          Map.entry("slotlock_get_reservation", new Operation("GET", "/v1/reservations/{reservation_ref}", List.of("reservation_ref"), List.of())),
          Map.entry("slotlock_put_reservation", new Operation("PUT", "/v1/reservations/{reservation_ref}", List.of("reservation_ref"), List.of())),
          Map.entry("slotlock_cancel_reservation", new Operation("DELETE", "/v1/reservations/{reservation_ref}", List.of("reservation_ref"), List.of("revision", "dry_run"))),
          Map.entry("slotlock_list_reservations", new Operation("GET", "/v1/resources/{resource_id}/reservations", List.of("resource_id"), List.of("start", "end", "limit", "cursor"))),
          Map.entry("slotlock_check_in_reservation", new Operation("POST", "/v1/reservations/{reservation_ref}/check-in", List.of("reservation_ref"), List.of())),
          Map.entry("slotlock_list_waitlist", new Operation("GET", "/v1/waitlist", List.of(), List.of("resource_id", "pool", "holder_ref", "limit"))),
          Map.entry("slotlock_join_waitlist", new Operation("POST", "/v1/waitlist", List.of(), List.of())),
          Map.entry("slotlock_leave_waitlist", new Operation("DELETE", "/v1/waitlist/{entry_id}", List.of("entry_id"), List.of("dry_run"))),
          Map.entry("slotlock_record_coverage", new Operation("PUT", "/v1/resources/{resource_id}/coverage/{source}", List.of("resource_id", "source"), List.of())),
          Map.entry("slotlock_delete_coverage", new Operation("DELETE", "/v1/resources/{resource_id}/coverage/{source}", List.of("resource_id", "source"), List.of("dry_run"))),
          Map.entry("slotlock_get_coverage", new Operation("GET", "/v1/resources/{resource_id}/coverage", List.of("resource_id"), List.of())),
          Map.entry("slotlock_record_coverage_failure", new Operation("POST", "/v1/resources/{resource_id}/coverage/{source}/failure", List.of("resource_id", "source"), List.of())),
          Map.entry("slotlock_list_tenant_events", new Operation("GET", "/v1/tenant/events", List.of(), List.of("resource_id", "start", "end", "limit", "cursor"))),
          Map.entry("slotlock_get_tenant_event", new Operation("GET", "/v1/tenant/events/{event_id}", List.of("event_id"), List.of())),
          Map.entry("slotlock_cancel_tenant_event", new Operation("DELETE", "/v1/tenant/events/{event_id}", List.of("event_id"), List.of("expected_revision", "expected_resource_id", "idempotency_key", "dry_run"))),
          Map.entry("slotlock_export_tenant_event", new Operation("GET", "/v1/tenant/events/{event_id}/jscalendar", List.of("event_id"), List.of())),
          Map.entry("slotlock_get_tenant", new Operation("GET", "/v1/tenant", List.of(), List.of())),
          Map.entry("slotlock_erase_tenant", new Operation("POST", "/v1/tenant/erase", List.of(), List.of())),
          Map.entry("slotlock_run_maintenance", new Operation("POST", "/v1/maintenance", List.of(), List.of())),
          Map.entry("slotlock_list_changes", new Operation("GET", "/v1/changes", List.of(), List.of("cursor", "limit"))),
          Map.entry("slotlock_list_webhooks", new Operation("GET", "/v1/webhooks", List.of(), List.of())),
          Map.entry("slotlock_create_webhook", new Operation("POST", "/v1/webhooks", List.of(), List.of())),
          Map.entry("slotlock_delete_webhook", new Operation("DELETE", "/v1/webhooks/{webhook_id}", List.of("webhook_id"), List.of("dry_run"))),
          Map.entry("slotlock_enable_webhook", new Operation("POST", "/v1/webhooks/{webhook_id}/enable", List.of("webhook_id"), List.of())),
          Map.entry("slotlock_get_usage", new Operation("GET", "/v1/usage", List.of(), List.of("from", "to"))),
          Map.entry("slotlock_partner_get_account", new Operation("GET", "/v1/partner/accounts/{account}", List.of("account"), List.of())),
          Map.entry("slotlock_partner_put_account", new Operation("PUT", "/v1/partner/accounts/{account}", List.of("account"), List.of())),
          Map.entry("slotlock_partner_list_accounts", new Operation("GET", "/v1/partner/accounts", List.of(), List.of())),
          Map.entry("slotlock_partner_list_keys", new Operation("GET", "/v1/partner/accounts/{account}/keys", List.of("account"), List.of("environment"))),
          Map.entry("slotlock_partner_create_key", new Operation("POST", "/v1/partner/accounts/{account}/keys", List.of("account"), List.of())),
          Map.entry("slotlock_partner_rotate_key", new Operation("POST", "/v1/partner/accounts/{account}/keys/{key_id}/rotate", List.of("account", "key_id"), List.of())),
          Map.entry("slotlock_partner_revoke_key", new Operation("DELETE", "/v1/partner/accounts/{account}/keys/{key_id}", List.of("account", "key_id"), List.of("environment"))),
          Map.entry("slotlock_partner_suspend_account", new Operation("POST", "/v1/partner/accounts/{account}/suspend", List.of("account"), List.of())),
          Map.entry("slotlock_partner_unsuspend_account", new Operation("POST", "/v1/partner/accounts/{account}/unsuspend", List.of("account"), List.of())),
          Map.entry("slotlock_partner_erase_account", new Operation("POST", "/v1/partner/accounts/{account}/erase", List.of("account"), List.of())),
          Map.entry("slotlock_partner_get_usage", new Operation("GET", "/v1/partner/usage", List.of(), List.of("from", "to", "account"))),
          Map.entry("slotlock_partner_reconcile_usage", new Operation("POST", "/v1/partner/usage/reconcile", List.of(), List.of())));

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
   * List calendar resources. List resources visible to the authenticated tenant principal, with
   * what each says about itself: its name (show it rather than the reference), description, kind,
   * capacity and labels, where it is (location), the groups it is in (a team, a department), and
   * the pool it belongs to (a vehicle class, a room type). With kind, only resources of that
   * kind; with labels, only those with every label given; with location, only those there or at a
   * location in it; with group, only that group's. With pool, only that pool's members, in the
   * order slotlock_book_pool tries them.
   *
   * @param optional the optional arguments, or null: {@code cursor} (string), {@code limit}
   * (integer), {@code pool} (string), {@code kind} (string), {@code labels} (list of string),
   * {@code location} (string), {@code group} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listResources(Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    putOptional(values, optional, Set.of("cursor", "limit", "pool", "kind", "labels", "location", "group"), "slotlock_list_resources");
    return call("slotlock_list_resources", values);
  }

  /**
   * List calendar resources. List resources visible to the authenticated tenant principal, with
   * what each says about itself: its name (show it rather than the reference), description, kind,
   * capacity and labels, where it is (location), the groups it is in (a team, a department), and
   * the pool it belongs to (a vehicle class, a room type). With kind, only resources of that
   * kind; with labels, only those with every label given; with location, only those there or at a
   * location in it; with group, only that group's. With pool, only that pool's members, in the
   * order slotlock_book_pool tries them.
   *
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listResources() {
    return listResources(null);
  }

  /**
   * Create or update a resource. Create the resource with this external reference, or update its
   * time zone, and the profile fields and location given, if the tenant already has it. Without a
   * time zone, a new resource takes the nearest one its location, or a location above it, has,
   * else UTC; a location the tenant does not have answers 404 location_not_found. Repeating the
   * call changes nothing more. visibility is shared (the default: agents list and book it) or
   * private (agents never see it), fixed at creation: naming another for an existing resource
   * answers 409 resource_visibility_conflict. Its profile is optional: a name agents and people
   * see instead of the reference, a description, its kind (person, room, desk, space, vehicle,
   * machine, equipment, service or other: a hint, never a rule), its capacity (informational), up
   * to 20 labels to find it by, and attributes you want back.
   *
   * @param externalRef {@code external_ref}, string
   * @param optional the optional arguments, or null: {@code timezone} (string), {@code
   * visibility} (string), {@code name} (string, null clears it), {@code description} (string,
   * null clears it), {@code kind} (string), {@code capacity} (integer, null clears it), {@code
   * labels} (list of string), {@code attributes} (object), {@code location} (string), {@code
   * dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createResource(String externalRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("external_ref", externalRef);
    putOptional(values, optional, Set.of("timezone", "visibility", "name", "description", "kind", "capacity", "labels", "attributes", "location", "dry_run"), "slotlock_create_resource");
    return call("slotlock_create_resource", values);
  }

  /**
   * Create or update a resource. Create the resource with this external reference, or update its
   * time zone, and the profile fields and location given, if the tenant already has it. Without a
   * time zone, a new resource takes the nearest one its location, or a location above it, has,
   * else UTC; a location the tenant does not have answers 404 location_not_found. Repeating the
   * call changes nothing more. visibility is shared (the default: agents list and book it) or
   * private (agents never see it), fixed at creation: naming another for an existing resource
   * answers 409 resource_visibility_conflict. Its profile is optional: a name agents and people
   * see instead of the reference, a description, its kind (person, room, desk, space, vehicle,
   * machine, equipment, service or other: a hint, never a rule), its capacity (informational), up
   * to 20 labels to find it by, and attributes you want back.
   *
   * @param externalRef {@code external_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createResource(String externalRef) {
    return createResource(externalRef, null);
  }

  /**
   * Get free-busy. When each resource is busy in a window, as busy intervals only (never whose or
   * what), and whether that is certain (coverage: "uncertain" where a calendar feeding it has not
   * been read lately). Name the resources with resource_ids, or select them instead by location
   * (and every location in it), group, labels (every one), kind or pool: at most 100 (more
   * answers selection_too_large, none selection_empty), named in selected_resource_ids.
   *
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param optional the optional arguments, or null: {@code resource_ids} (list of string),
   * {@code location} (string), {@code group} (string), {@code labels} (list of string), {@code
   * kind} (string), {@code pool} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getFreeBusy(String start, String end, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("start", start);
    values.put("end", end);
    putOptional(values, optional, Set.of("resource_ids", "location", "group", "labels", "kind", "pool"), "slotlock_get_free_busy");
    return call("slotlock_get_free_busy", values);
  }

  /**
   * Get free-busy. When each resource is busy in a window, as busy intervals only (never whose or
   * what), and whether that is certain (coverage: "uncertain" where a calendar feeding it has not
   * been read lately). Name the resources with resource_ids, or select them instead by location
   * (and every location in it), group, labels (every one), kind or pool: at most 100 (more
   * answers selection_too_large, none selection_empty), named in selected_resource_ids.
   *
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getFreeBusy(String start, String end) {
    return getFreeBusy(start, end, null);
  }

  /**
   * Get free-busy, as earlier releases took it: {@code resource_ids} in its old place. See the
   * method that takes them in {@code optional}.
   *
   * @param resourceIds {@code resource_ids}
   * @param start {@code start}
   * @param end {@code end}
   * @param optional the other optional arguments, or null
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getFreeBusy(List<?> resourceIds, String start, String end, Map<String, ?> optional) {
    Map<String, Object> merged = new LinkedHashMap<>();
    if (optional != null) merged.putAll(optional);
    merged.put("resource_ids", resourceIds);
    return getFreeBusy(start, end, merged);
  }

  /**
   * Get free-busy, as earlier releases took it: {@code resource_ids} in its old place. See the
   * method that takes them in {@code optional}.
   *
   * @param resourceIds {@code resource_ids}
   * @param start {@code start}
   * @param end {@code end}
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getFreeBusy(List<?> resourceIds, String start, String end) {
    return getFreeBusy(resourceIds, start, end, null);
  }

  /**
   * Find next available interval. Find the earliest certain interval that satisfies the requested
   * duration (up to the 367-day search window, so a multi-month rental slot can be found). Name
   * the resources with resource_ids, or select them as slotlock_get_free_busy does: at most 100.
   *
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param durationMinutes {@code duration_minutes}, integer
   * @param optional the optional arguments, or null: {@code resource_ids} (list of string),
   * {@code location} (string), {@code group} (string), {@code labels} (list of string), {@code
   * kind} (string), {@code pool} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findNextAvailable(String start, String end, long durationMinutes, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("start", start);
    values.put("end", end);
    values.put("duration_minutes", durationMinutes);
    putOptional(values, optional, Set.of("resource_ids", "location", "group", "labels", "kind", "pool"), "slotlock_find_next_available");
    return call("slotlock_find_next_available", values);
  }

  /**
   * Find next available interval. Find the earliest certain interval that satisfies the requested
   * duration (up to the 367-day search window, so a multi-month rental slot can be found). Name
   * the resources with resource_ids, or select them as slotlock_get_free_busy does: at most 100.
   *
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param durationMinutes {@code duration_minutes}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findNextAvailable(String start, String end, long durationMinutes) {
    return findNextAvailable(start, end, durationMinutes, null);
  }

  /**
   * Find next available interval, as earlier releases took it: {@code resource_ids} in its old
   * place. See the method that takes them in {@code optional}.
   *
   * @param resourceIds {@code resource_ids}
   * @param start {@code start}
   * @param end {@code end}
   * @param durationMinutes {@code duration_minutes}
   * @param optional the other optional arguments, or null
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findNextAvailable(List<?> resourceIds, String start, String end, long durationMinutes, Map<String, ?> optional) {
    Map<String, Object> merged = new LinkedHashMap<>();
    if (optional != null) merged.putAll(optional);
    merged.put("resource_ids", resourceIds);
    return findNextAvailable(start, end, durationMinutes, merged);
  }

  /**
   * Find next available interval, as earlier releases took it: {@code resource_ids} in its old
   * place. See the method that takes them in {@code optional}.
   *
   * @param resourceIds {@code resource_ids}
   * @param start {@code start}
   * @param end {@code end}
   * @param durationMinutes {@code duration_minutes}
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findNextAvailable(List<?> resourceIds, String start, String end, long durationMinutes) {
    return findNextAvailable(resourceIds, start, end, durationMinutes, null);
  }

  /**
   * Find available slots. List up to `limit` certain slots of the requested duration, earliest
   * first across the resources, each one free of busy time and inside the resource's hours, to
   * offer a person a choice. With require_free, only times when at least that many of the
   * resources are free together, each slot naming them in resource_ids: every resource for a
   * booking that needs them all (book it with slotlock_book_together), or any n of them. No slot
   * is listed unless every resource's coverage is certain. Name the resources with resource_ids,
   * or select them as slotlock_get_free_busy does: at most 20.
   *
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param durationMinutes {@code duration_minutes}, integer
   * @param optional the optional arguments, or null: {@code resource_ids} (list of string),
   * {@code location} (string), {@code group} (string), {@code labels} (list of string), {@code
   * kind} (string), {@code pool} (string), {@code limit} (integer), {@code require_free}
   * (integer)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findAvailableSlots(String start, String end, long durationMinutes, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("start", start);
    values.put("end", end);
    values.put("duration_minutes", durationMinutes);
    putOptional(values, optional, Set.of("resource_ids", "location", "group", "labels", "kind", "pool", "limit", "require_free"), "slotlock_find_available_slots");
    return call("slotlock_find_available_slots", values);
  }

  /**
   * Find available slots. List up to `limit` certain slots of the requested duration, earliest
   * first across the resources, each one free of busy time and inside the resource's hours, to
   * offer a person a choice. With require_free, only times when at least that many of the
   * resources are free together, each slot naming them in resource_ids: every resource for a
   * booking that needs them all (book it with slotlock_book_together), or any n of them. No slot
   * is listed unless every resource's coverage is certain. Name the resources with resource_ids,
   * or select them as slotlock_get_free_busy does: at most 20.
   *
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param durationMinutes {@code duration_minutes}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findAvailableSlots(String start, String end, long durationMinutes) {
    return findAvailableSlots(start, end, durationMinutes, null);
  }

  /**
   * Find available slots, as earlier releases took it: {@code resource_ids} in its old place. See
   * the method that takes them in {@code optional}.
   *
   * @param resourceIds {@code resource_ids}
   * @param start {@code start}
   * @param end {@code end}
   * @param durationMinutes {@code duration_minutes}
   * @param optional the other optional arguments, or null
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> findAvailableSlots(List<?> resourceIds, String start, String end, long durationMinutes, Map<String, ?> optional) {
    Map<String, Object> merged = new LinkedHashMap<>();
    if (optional != null) merged.putAll(optional);
    merged.put("resource_ids", resourceIds);
    return findAvailableSlots(start, end, durationMinutes, merged);
  }

  /**
   * Find available slots, as earlier releases took it: {@code resource_ids} in its old place. See
   * the method that takes them in {@code optional}.
   *
   * @param resourceIds {@code resource_ids}
   * @param start {@code start}
   * @param end {@code end}
   * @param durationMinutes {@code duration_minutes}
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
   * once. A candidate refused for its time comes with alternatives (the earliest free times of
   * its length). slotlock_confirm_slot books a held time.
   *
   * @param slots {@code slots}, list of object
   * @param idempotencyKey {@code idempotency_key}, string
   * @param optional the optional arguments, or null: {@code ttl_seconds} (integer), {@code
   * dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> holdSlots(List<?> slots, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("slots", slots);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("ttl_seconds", "dry_run"), "slotlock_hold_slots");
    return call("slotlock_hold_slots", values);
  }

  /**
   * Hold candidate slots. Hold up to five candidate slots for a short time (30-900 seconds) while
   * a person chooses, as alternatives in one group: each free one is held, the others are listed
   * with why not. Book one by passing its hold_id to slotlock_create_event, which releases the
   * rest; unbooked holds expire on their own. A hold is yours alone, and you may have 20 live at
   * once. A candidate refused for its time comes with alternatives (the earliest free times of
   * its length). slotlock_confirm_slot books a held time.
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
   * Book resources together. Book the same time on 2-20 resources at once, all or none: a van
   * with its driver, a room with its projector. If any of them is taken, nothing is booked, and
   * the refusal names that resource_id. Find such a time with slotlock_find_available_slots and
   * require_free. A retry with the same idempotency_key answers the same events.
   *
   * @param resourceIds {@code resource_ids}, list of string
   * @param startsAt {@code starts_at}, string
   * @param endsAt {@code ends_at}, string
   * @param timezone {@code timezone}, string
   * @param idempotencyKey {@code idempotency_key}, string
   * @param optional the optional arguments, or null: {@code title} (string), {@code dry_run}
   * (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> bookTogether(List<?> resourceIds, String startsAt, String endsAt, String timezone, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_ids", resourceIds);
    values.put("starts_at", startsAt);
    values.put("ends_at", endsAt);
    values.put("timezone", timezone);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("title", "dry_run"), "slotlock_book_together");
    return call("slotlock_book_together", values);
  }

  /**
   * Book resources together. Book the same time on 2-20 resources at once, all or none: a van
   * with its driver, a room with its projector. If any of them is taken, nothing is booked, and
   * the refusal names that resource_id. Find such a time with slotlock_find_available_slots and
   * require_free. A retry with the same idempotency_key answers the same events.
   *
   * @param resourceIds {@code resource_ids}, list of string
   * @param startsAt {@code starts_at}, string
   * @param endsAt {@code ends_at}, string
   * @param timezone {@code timezone}, string
   * @param idempotencyKey {@code idempotency_key}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> bookTogether(List<?> resourceIds, String startsAt, String endsAt, String timezone, String idempotencyKey) {
    return bookTogether(resourceIds, startsAt, endsAt, timezone, idempotencyKey, null);
  }

  /**
   * Book from a pool. Book any one member of a pool (a vehicle class, a room type) for a time:
   * members are tried in the pool's order (by id, fewest bookings in the last 30 days first, or
   * in turn, as the tenant sets it) and the first that is free and allows the booking is booked,
   * in one transaction, so a class sells out exactly at its number of members. The event names
   * the member booked. 409 pool_full when none is free; 404 pool_not_found when the pool has no
   * member you may book. A retry with the same idempotency_key answers the same event.
   *
   * @param pool {@code pool}, string
   * @param startsAt {@code starts_at}, string
   * @param endsAt {@code ends_at}, string
   * @param timezone {@code timezone}, string
   * @param idempotencyKey {@code idempotency_key}, string
   * @param optional the optional arguments, or null: {@code title} (string), {@code dry_run}
   * (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> bookPool(String pool, String startsAt, String endsAt, String timezone, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("pool", pool);
    values.put("starts_at", startsAt);
    values.put("ends_at", endsAt);
    values.put("timezone", timezone);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("title", "dry_run"), "slotlock_book_pool");
    return call("slotlock_book_pool", values);
  }

  /**
   * Book from a pool. Book any one member of a pool (a vehicle class, a room type) for a time:
   * members are tried in the pool's order (by id, fewest bookings in the last 30 days first, or
   * in turn, as the tenant sets it) and the first that is free and allows the booking is booked,
   * in one transaction, so a class sells out exactly at its number of members. The event names
   * the member booked. 409 pool_full when none is free; 404 pool_not_found when the pool has no
   * member you may book. A retry with the same idempotency_key answers the same event.
   *
   * @param pool {@code pool}, string
   * @param startsAt {@code starts_at}, string
   * @param endsAt {@code ends_at}, string
   * @param timezone {@code timezone}, string
   * @param idempotencyKey {@code idempotency_key}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> bookPool(String pool, String startsAt, String endsAt, String timezone, String idempotencyKey) {
    return bookPool(pool, startsAt, endsAt, timezone, idempotencyKey, null);
  }

  /**
   * Get pool availability. How many members of a pool (a vehicle class, a room type) are free
   * across a window, each only where its booking rules let a booking start: the window split
   * where that number changes, each part with how many are free, and coverage certainty. Book one
   * with slotlock_book_pool. 404 pool_not_found when the pool has no member you may book.
   *
   * @param pool {@code pool}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getPoolAvailability(String pool, String start, String end) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("pool", pool);
    values.put("start", start);
    values.put("end", end);
    return call("slotlock_get_pool_availability", values);
  }

  /**
   * Release held slots. Release one of your holds, and the rest of its group, at once instead of
   * letting them expire. `released` is false when it was already gone.
   *
   * @param holdId {@code hold_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> releaseSlots(String holdId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_release_slots");
    return call("slotlock_release_slots", values);
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
    return releaseSlots(holdId, null);
  }

  /**
   * Confirm a held slot. Book a time you hold (a hold_id from slotlock_hold_slots): the held
   * resource and time exactly, with the title and details you give, and the rest of its group
   * released. 409 hold_expired when the hold lapsed first; 404 hold_not_found when it was
   * released, booked or is not yours. A retry answers the same event (replayed).
   *
   * @param holdId {@code hold_id}, string
   * @param optional the optional arguments, or null: {@code title} (string), {@code description}
   * (string), {@code location} (string), {@code timezone} (string), {@code idempotency_key}
   * (string), {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> confirmSlot(String holdId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    putOptional(values, optional, Set.of("title", "description", "location", "timezone", "idempotency_key", "dry_run"), "slotlock_confirm_slot");
    return call("slotlock_confirm_slot", values);
  }

  /**
   * Confirm a held slot. Book a time you hold (a hold_id from slotlock_hold_slots): the held
   * resource and time exactly, with the title and details you give, and the rest of its group
   * released. 409 hold_expired when the hold lapsed first; 404 hold_not_found when it was
   * released, booked or is not yours. A retry answers the same event (replayed).
   *
   * @param holdId {@code hold_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> confirmSlot(String holdId) {
    return confirmSlot(holdId, null);
  }

  /**
   * List resource events. List your events that meet a time window, earliest first.
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
   * List resource events. List your events that meet a time window, earliest first.
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
   * Create resource event. Book a resource for a time, as an event of up to 3,660 days (a
   * booking, lease or long rental). The database refuses a time already taken: 409 overlap, with
   * alternatives (the earliest free times of the same length) and, when the booking in the way is
   * yours, its id. A booking rule that refuses the time answers booking_rule_… with alternatives
   * too. To book a time you hold, pass its hold_id, or use slotlock_confirm_slot. A retry with
   * the same idempotency_key answers the same event.
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
   * object), {@code hold_id} (string), {@code dry_run} (boolean)
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
    putOptional(values, optional, Set.of("title", "description", "location", "organizer", "transparency", "status", "recurrence_rule", "attendees", "reminders", "recurrence_exceptions", "hold_id", "dry_run"), "slotlock_create_event");
    return call("slotlock_create_event", values);
  }

  /**
   * Create resource event. Book a resource for a time, as an event of up to 3,660 days (a
   * booking, lease or long rental). The database refuses a time already taken: 409 overlap, with
   * alternatives (the earliest free times of the same length) and, when the booking in the way is
   * yours, its id. A booking rule that refuses the time answers booking_rule_… with alternatives
   * too. To book a time you hold, pass its hold_id, or use slotlock_confirm_slot. A retry with
   * the same idempotency_key answers the same event.
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
   * Get resource event. Read one of your events by its id, with its revision (pass it as
   * expected_revision to change or cancel it).
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
   * Update resource event. Change one of your events at the revision you last read
   * (expected_revision): its time, resource or details, all or nothing. A time already taken is
   * 409 overlap with alternatives; a stale revision is 409 revision_conflict (read the event
   * again). With expected_resource_id, the resource you read it on, an event since moved
   * elsewhere is not found. To change only the time, slotlock_reschedule is simpler.
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
   * (list of object), {@code expected_resource_id} (string), {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> updateEvent(String eventId, long expectedRevision, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("resource_id", "starts_at", "ends_at", "timezone", "title", "description", "location", "organizer", "attendees", "reminders", "transparency", "status", "recurrence_rule", "recurrence_exceptions", "expected_resource_id", "dry_run"), "slotlock_update_event");
    return call("slotlock_update_event", values);
  }

  /**
   * Update resource event. Change one of your events at the revision you last read
   * (expected_revision): its time, resource or details, all or nothing. A time already taken is
   * 409 overlap with alternatives; a stale revision is 409 revision_conflict (read the event
   * again). With expected_resource_id, the resource you read it on, an event since moved
   * elsewhere is not found. To change only the time, slotlock_reschedule is simpler.
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
   * Delete resource event. Cancel one of your events at the revision you last read
   * (expected_revision); a stale one is 409 revision_conflict. It cannot come back at that
   * revision, so an old copy synced later does not restore it. slotlock_cancel does the same with
   * fewer fields.
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param idempotencyKey {@code idempotency_key}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteEvent(String eventId, long expectedRevision, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_delete_event");
    return call("slotlock_delete_event", values);
  }

  /**
   * Delete resource event. Cancel one of your events at the revision you last read
   * (expected_revision); a stale one is 409 revision_conflict. It cannot come back at that
   * revision, so an old copy synced later does not restore it. slotlock_cancel does the same with
   * fewer fields.
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param idempotencyKey {@code idempotency_key}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteEvent(String eventId, long expectedRevision, String idempotencyKey) {
    return deleteEvent(eventId, expectedRevision, idempotencyKey, null);
  }

  /**
   * Reschedule an event. Move one of your events to a new time, and to another resource if you
   * give one, at the revision you last read (expected_revision). A time already taken is 409
   * overlap with alternatives; a stale revision 409 revision_conflict. A retry answers the same
   * move (replayed).
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param startsAt {@code starts_at}, string
   * @param endsAt {@code ends_at}, string
   * @param optional the optional arguments, or null: {@code resource_id} (string), {@code
   * idempotency_key} (string), {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> reschedule(String eventId, long expectedRevision, String startsAt, String endsAt, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    values.put("starts_at", startsAt);
    values.put("ends_at", endsAt);
    putOptional(values, optional, Set.of("resource_id", "idempotency_key", "dry_run"), "slotlock_reschedule");
    return call("slotlock_reschedule", values);
  }

  /**
   * Reschedule an event. Move one of your events to a new time, and to another resource if you
   * give one, at the revision you last read (expected_revision). A time already taken is 409
   * overlap with alternatives; a stale revision 409 revision_conflict. A retry answers the same
   * move (replayed).
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param startsAt {@code starts_at}, string
   * @param endsAt {@code ends_at}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> reschedule(String eventId, long expectedRevision, String startsAt, String endsAt) {
    return reschedule(eventId, expectedRevision, startsAt, endsAt, null);
  }

  /**
   * Cancel an event. Cancel one of your events at the revision you last read (expected_revision);
   * a stale one is 409 revision_conflict. Its time is free at once. A retry answers the same
   * cancellation (replayed).
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @param optional the optional arguments, or null: {@code idempotency_key} (string), {@code
   * dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> cancel(String eventId, long expectedRevision, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    putOptional(values, optional, Set.of("idempotency_key", "dry_run"), "slotlock_cancel");
    return call("slotlock_cancel", values);
  }

  /**
   * Cancel an event. Cancel one of your events at the revision you last read (expected_revision);
   * a stale one is 409 revision_conflict. Its time is free at once. A retry answers the same
   * cancellation (replayed).
   *
   * @param eventId {@code event_id}, string
   * @param expectedRevision {@code expected_revision}, integer
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> cancel(String eventId, long expectedRevision) {
    return cancel(eventId, expectedRevision, null);
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
   * Change a resource's profile. Change a resource's name, description, kind, capacity, labels,
   * attributes or location: the fields given, keeping the rest. null clears a name, description,
   * capacity or location; [] and {} clear labels and attributes. A location the tenant does not
   * have answers 404 location_not_found. The feed's resource.updated names the fields that
   * changed (profile_changed), never their values. 400 invalid_resource_profile outside the
   * bounds, naming the field.
   *
   * @param resourceId {@code resource_id}, string
   * @param optional the optional arguments, or null: {@code name} (string, null clears it),
   * {@code description} (string, null clears it), {@code kind} (string), {@code capacity}
   * (integer, null clears it), {@code labels} (list of string), {@code attributes} (object),
   * {@code location} (string, null clears it), {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> updateResource(String resourceId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    putOptional(values, optional, Set.of("name", "description", "kind", "capacity", "labels", "attributes", "location", "dry_run"), "slotlock_update_resource");
    return call("slotlock_update_resource", values);
  }

  /**
   * Change a resource's profile. Change a resource's name, description, kind, capacity, labels,
   * attributes or location: the fields given, keeping the rest. null clears a name, description,
   * capacity or location; [] and {} clear labels and attributes. A location the tenant does not
   * have answers 404 location_not_found. The feed's resource.updated names the fields that
   * changed (profile_changed), never their values. 400 invalid_resource_profile outside the
   * bounds, naming the field.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> updateResource(String resourceId) {
    return updateResource(resourceId, null);
  }

  /**
   * Delete a resource. Delete a resource with its history (past bookings, coverage, cancelled
   * events), freeing its place under the tenant's resource limit. Refused with 409
   * resource_in_use while a booking on it has not ended, a hold on it is live, or a calendar
   * event is on it: cancel or move those first. deleted is false when the tenant has no such
   * resource, deleted already, say.
   *
   * @param resourceId {@code resource_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteResource(String resourceId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_delete_resource");
    return call("slotlock_delete_resource", values);
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
    return deleteResource(resourceId, null);
  }

  /**
   * List locations. The tenant's locations, each after the one it is in (depth first), with how
   * many resources are at each. A tree of at most 5 levels and 1000 locations: a region, a site,
   * a building, a floor, a zone, or whatever yours are.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listLocations() {
    Map<String, Object> values = new LinkedHashMap<>();
    return call("slotlock_list_locations", values);
  }

  /**
   * Create or update a location. Create the location with this reference, or change its name, and
   * the parent and time zone given. 404 location_not_found for a parent the tenant does not have;
   * 409 location_too_deep past 5 levels, location_cycle under itself, location_limit_reached past
   * 1000.
   *
   * @param ref {@code ref}, string
   * @param name {@code name}, string
   * @param optional the optional arguments, or null: {@code parent_ref} (string, null clears it),
   * {@code timezone} (string, null clears it), {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createLocation(String ref, String name, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("ref", ref);
    values.put("name", name);
    putOptional(values, optional, Set.of("parent_ref", "timezone", "dry_run"), "slotlock_create_location");
    return call("slotlock_create_location", values);
  }

  /**
   * Create or update a location. Create the location with this reference, or change its name, and
   * the parent and time zone given. 404 location_not_found for a parent the tenant does not have;
   * 409 location_too_deep past 5 levels, location_cycle under itself, location_limit_reached past
   * 1000.
   *
   * @param ref {@code ref}, string
   * @param name {@code name}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createLocation(String ref, String name) {
    return createLocation(ref, name, null);
  }

  /**
   * Change a location. Change a location's name, parent or time zone: the fields given. Refused
   * as creating one is.
   *
   * @param locationRef {@code location_ref}, string
   * @param optional the optional arguments, or null: {@code name} (string), {@code parent_ref}
   * (string, null clears it), {@code timezone} (string, null clears it), {@code dry_run}
   * (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> updateLocation(String locationRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("location_ref", locationRef);
    putOptional(values, optional, Set.of("name", "parent_ref", "timezone", "dry_run"), "slotlock_update_location");
    return call("slotlock_update_location", values);
  }

  /**
   * Change a location. Change a location's name, parent or time zone: the fields given. Refused
   * as creating one is.
   *
   * @param locationRef {@code location_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> updateLocation(String locationRef) {
    return updateLocation(locationRef, null);
  }

  /**
   * Delete a location. Delete a location. Refused with 409 location_in_use while a resource is at
   * it or a location is in it: move them first. deleted is false when the tenant has no such
   * location.
   *
   * @param locationRef {@code location_ref}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteLocation(String locationRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("location_ref", locationRef);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_delete_location");
    return call("slotlock_delete_location", values);
  }

  /**
   * Delete a location. Delete a location. Refused with 409 location_in_use while a resource is at
   * it or a location is in it: move them first. deleted is false when the tenant has no such
   * location.
   *
   * @param locationRef {@code location_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteLocation(String locationRef) {
    return deleteLocation(locationRef, null);
  }

  /**
   * List groups. The tenant's groups, by reference, with how many resources are in each: any sets
   * you want (a team, a department, a contract), at most 500. A group changes nothing about how
   * its resources are booked; a pool does that.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listGroups() {
    Map<String, Object> values = new LinkedHashMap<>();
    return call("slotlock_list_groups", values);
  }

  /**
   * Create or update a group. Create the group with this reference, or change its name, and its
   * description when given. 409 group_limit_reached past 500.
   *
   * @param ref {@code ref}, string
   * @param name {@code name}, string
   * @param optional the optional arguments, or null: {@code description} (string, null clears
   * it), {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createGroup(String ref, String name, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("ref", ref);
    values.put("name", name);
    putOptional(values, optional, Set.of("description", "dry_run"), "slotlock_create_group");
    return call("slotlock_create_group", values);
  }

  /**
   * Create or update a group. Create the group with this reference, or change its name, and its
   * description when given. 409 group_limit_reached past 500.
   *
   * @param ref {@code ref}, string
   * @param name {@code name}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createGroup(String ref, String name) {
    return createGroup(ref, name, null);
  }

  /**
   * Delete a group. Delete a group; its resources stay as they are. deleted is false when the
   * tenant has no such group.
   *
   * @param groupRef {@code group_ref}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteGroup(String groupRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("group_ref", groupRef);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_delete_group");
    return call("slotlock_delete_group", values);
  }

  /**
   * Delete a group. Delete a group; its resources stay as they are. deleted is false when the
   * tenant has no such group.
   *
   * @param groupRef {@code group_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteGroup(String groupRef) {
    return deleteGroup(groupRef, null);
  }

  /**
   * Put a resource in a group. Put one of the tenant's resources in a group. added is false when
   * it was in it already. 404 group_not_found or resource_not_found; 409
   * resource_group_limit_reached past 20 groups a resource.
   *
   * @param groupRef {@code group_ref}, string
   * @param resourceId {@code resource_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> addGroupMember(String groupRef, String resourceId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("group_ref", groupRef);
    values.put("resource_id", resourceId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_add_group_member");
    return call("slotlock_add_group_member", values);
  }

  /**
   * Put a resource in a group. Put one of the tenant's resources in a group. added is false when
   * it was in it already. 404 group_not_found or resource_not_found; 409
   * resource_group_limit_reached past 20 groups a resource.
   *
   * @param groupRef {@code group_ref}, string
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> addGroupMember(String groupRef, String resourceId) {
    return addGroupMember(groupRef, resourceId, null);
  }

  /**
   * Take a resource out of a group. Take a resource out of a group. removed is false when it was
   * not in it.
   *
   * @param groupRef {@code group_ref}, string
   * @param resourceId {@code resource_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> removeGroupMember(String groupRef, String resourceId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("group_ref", groupRef);
    values.put("resource_id", resourceId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_remove_group_member");
    return call("slotlock_remove_group_member", values);
  }

  /**
   * Take a resource out of a group. Take a resource out of a group. removed is false when it was
   * not in it.
   *
   * @param groupRef {@code group_ref}, string
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> removeGroupMember(String groupRef, String resourceId) {
    return removeGroupMember(groupRef, resourceId, null);
  }

  /**
   * Archive a resource. Take a resource out of use: no list shows it and it takes no new booking,
   * hold or event (409 resource_archived), while what is on it stays and can still be cancelled
   * or released. Archiving it again keeps the first time.
   *
   * @param resourceId {@code resource_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> archiveResource(String resourceId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_archive_resource");
    return call("slotlock_archive_resource", values);
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
    return archiveResource(resourceId, null);
  }

  /**
   * Restore a resource. Put an archived resource back in use. Restoring one in use changes
   * nothing.
   *
   * @param resourceId {@code resource_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> restoreResource(String resourceId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_restore_resource");
    return call("slotlock_restore_resource", values);
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
    return restoreResource(resourceId, null);
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
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourceAvailability(String resourceId, List<?> rules, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("rules", rules);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_set_resource_availability");
    return call("slotlock_set_resource_availability", values);
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
    return setResourceAvailability(resourceId, rules, null);
  }

  /**
   * Export a resource's bookable hours as iCalendar. One resource's own weekly bookable hours as
   * an iCalendar VAVAILABILITY (RFC 7953) for a calendar or scheduling tool: an AVAILABLE per
   * rule, its DTSTART's TZID the resource's IANA time zone. `null` when the resource uses the
   * server's default.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> exportResourceAvailability(String resourceId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    return call("slotlock_export_resource_availability", values);
  }

  /**
   * Import a resource's bookable hours from iCalendar. Set one resource's own weekly bookable
   * hours from an iCalendar VAVAILABILITY (RFC 7953), as slotlock_set_resource_availability does
   * from rules: each AVAILABLE a weekly RRULE with a start time and DTEND or DURATION. Times must
   * be in the resource's time zone (its TZID) or floating. 400 invalid_availability names what
   * weekly hours cannot say: a bounded VAVAILABILITY, RDATE, EXDATE, a single window, another
   * zone.
   *
   * @param resourceId {@code resource_id}, string
   * @param icalendar {@code icalendar}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> importResourceAvailability(String resourceId, String icalendar, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("icalendar", icalendar);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_import_resource_availability");
    return call("slotlock_import_resource_availability", values);
  }

  /**
   * Import a resource's bookable hours from iCalendar. Set one resource's own weekly bookable
   * hours from an iCalendar VAVAILABILITY (RFC 7953), as slotlock_set_resource_availability does
   * from rules: each AVAILABLE a weekly RRULE with a start time and DTEND or DURATION. Times must
   * be in the resource's time zone (its TZID) or floating. 400 invalid_availability names what
   * weekly hours cannot say: a bounded VAVAILABILITY, RDATE, EXDATE, a single window, another
   * zone.
   *
   * @param resourceId {@code resource_id}, string
   * @param icalendar {@code icalendar}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> importResourceAvailability(String resourceId, String icalendar) {
    return importResourceAvailability(resourceId, icalendar, null);
  }

  /**
   * Set a resource's booking rules. Set what a booking on one resource must satisfy from now on:
   * minimum notice, how far ahead, the step starts fall on (from local midnight in the resource's
   * time zone, offset by step_offset_minutes), the time kept free before and after each booking,
   * and whether bookings must lie inside its hours. `null` clears them. A rule it does not set
   * comes from its pool's or the tenant's defaults (slotlock_set_pool_booking_rules,
   * slotlock_set_tenant_booking_rules). Holds, reservations, moves and agents' events are refused
   * with the rule they break; searches offer only what they allow.
   *
   * @param resourceId {@code resource_id}, string
   * @param rules {@code rules}, object (may be null)
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourceBookingRules(String resourceId, Map<String, ?> rules, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("rules", rules);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_set_resource_booking_rules");
    return call("slotlock_set_resource_booking_rules", values);
  }

  /**
   * Set a resource's booking rules. Set what a booking on one resource must satisfy from now on:
   * minimum notice, how far ahead, the step starts fall on (from local midnight in the resource's
   * time zone, offset by step_offset_minutes), the time kept free before and after each booking,
   * and whether bookings must lie inside its hours. `null` clears them. A rule it does not set
   * comes from its pool's or the tenant's defaults (slotlock_set_pool_booking_rules,
   * slotlock_set_tenant_booking_rules). Holds, reservations, moves and agents' events are refused
   * with the rule they break; searches offer only what they allow.
   *
   * @param resourceId {@code resource_id}, string
   * @param rules {@code rules}, object (may be null)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourceBookingRules(String resourceId, Map<String, ?> rules) {
    return setResourceBookingRules(resourceId, rules, null);
  }

  /**
   * Set a resource's pool. Make a resource a member of a pool, a class of interchangeable
   * resources such as a vehicle class or a room type, or take it out (`null`). Agents book the
   * class with slotlock_book_pool, which takes the first member free; the class's capacity is its
   * number of members. A resource is in one pool at most; pool names are 1-100 of a-z, 0-9, '.',
   * '_' and '-'.
   *
   * @param resourceId {@code resource_id}, string
   * @param pool {@code pool}, string (may be null)
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourcePool(String resourceId, String pool, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("pool", pool);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_set_resource_pool");
    return call("slotlock_set_resource_pool", values);
  }

  /**
   * Set a resource's pool. Make a resource a member of a pool, a class of interchangeable
   * resources such as a vehicle class or a room type, or take it out (`null`). Agents book the
   * class with slotlock_book_pool, which takes the first member free; the class's capacity is its
   * number of members. A resource is in one pool at most; pool names are 1-100 of a-z, 0-9, '.',
   * '_' and '-'.
   *
   * @param resourceId {@code resource_id}, string
   * @param pool {@code pool}, string (may be null)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourcePool(String resourceId, String pool) {
    return setResourcePool(resourceId, pool, null);
  }

  /**
   * Make a resource part of another. Make a resource a part of a composite (a room of a hall, a
   * half of a court), or no part (`null`). A booking of the composite as a whole then conflicts
   * with a booking of any of its parts, and two parts never conflict with each other; each part's
   * free/busy shows the whole's bookings, and the whole's shows its parts'. One level deep, at
   * most 50 parts; refused while either side has a booking or live hold still to come
   * (`composite_busy`).
   *
   * @param resourceId {@code resource_id}, string
   * @param parentId {@code parent_id}, string (may be null)
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourceParent(String resourceId, String parentId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("parent_id", parentId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_set_resource_parent");
    return call("slotlock_set_resource_parent", values);
  }

  /**
   * Make a resource part of another. Make a resource a part of a composite (a room of a hall, a
   * half of a court), or no part (`null`). A booking of the composite as a whole then conflicts
   * with a booking of any of its parts, and two parts never conflict with each other; each part's
   * free/busy shows the whole's bookings, and the whole's shows its parts'. One level deep, at
   * most 50 parts; refused while either side has a booking or live hold still to come
   * (`composite_busy`).
   *
   * @param resourceId {@code resource_id}, string
   * @param parentId {@code parent_id}, string (may be null)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setResourceParent(String resourceId, String parentId) {
    return setResourceParent(resourceId, parentId, null);
  }

  /**
   * List pools. The tenant's pools by name, each with its capacity (how many members it has that
   * are not archived) and the order slotlock_book_pool tries them in.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listPools() {
    Map<String, Object> values = new LinkedHashMap<>();
    return call("slotlock_list_pools", values);
  }

  /**
   * Set a pool's order. The order slotlock_book_pool tries a pool's members in: stable (by id,
   * the default), least_booked (fewest bookings made on each in the last 30 days first, to share
   * them out) or round_robin (from the member after the one booked last). At most 1,000 pools
   * have one: one more is 409 pool_order_limit_reached.
   *
   * @param pool {@code pool}, string
   * @param order {@code order}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setPoolOrder(String pool, String order, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("pool", pool);
    values.put("order", order);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_set_pool_order");
    return call("slotlock_set_pool_order", values);
  }

  /**
   * Set a pool's order. The order slotlock_book_pool tries a pool's members in: stable (by id,
   * the default), least_booked (fewest bookings made on each in the last 30 days first, to share
   * them out) or round_robin (from the member after the one booked last). At most 1,000 pools
   * have one: one more is 409 pool_order_limit_reached.
   *
   * @param pool {@code pool}, string
   * @param order {@code order}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setPoolOrder(String pool, String order) {
    return setPoolOrder(pool, order, null);
  }

  /**
   * Get default booking rules. The tenant's default booking rules, and each pool's that has them.
   * A resource's rules as they apply (effective_booking_rules) are the tenant's defaults,
   * overlaid by its pool's, overlaid by its own: a rule set at a narrower level wins.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getBookingRuleDefaults() {
    Map<String, Object> values = new LinkedHashMap<>();
    return call("slotlock_get_booking_rule_defaults", values);
  }

  /**
   * Set default booking rules. Set the booking rules every resource of the tenant has unless its
   * pool or its own rules set the same rule, from now on; `null` clears them. They take any
   * resource rule but check_in_minutes, which only a resource sets.
   *
   * @param rules {@code rules}, object (may be null)
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setTenantBookingRules(Map<String, ?> rules, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("rules", rules);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_set_tenant_booking_rules");
    return call("slotlock_set_tenant_booking_rules", values);
  }

  /**
   * Set default booking rules. Set the booking rules every resource of the tenant has unless its
   * pool or its own rules set the same rule, from now on; `null` clears them. They take any
   * resource rule but check_in_minutes, which only a resource sets.
   *
   * @param rules {@code rules}, object (may be null)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setTenantBookingRules(Map<String, ?> rules) {
    return setTenantBookingRules(rules, null);
  }

  /**
   * Set a pool's booking rules. Set the booking rules every member of one pool has unless its own
   * rules set the same rule, over the tenant's defaults, from now on; `null` clears them. They
   * take any resource rule but check_in_minutes. At most 1,000 pools have them: one more is 409
   * pool_rules_limit_reached.
   *
   * @param pool {@code pool}, string
   * @param rules {@code rules}, object (may be null)
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setPoolBookingRules(String pool, Map<String, ?> rules, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("pool", pool);
    values.put("rules", rules);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_set_pool_booking_rules");
    return call("slotlock_set_pool_booking_rules", values);
  }

  /**
   * Set a pool's booking rules. Set the booking rules every member of one pool has unless its own
   * rules set the same rule, over the tenant's defaults, from now on; `null` clears them. They
   * take any resource rule but check_in_minutes. At most 1,000 pools have them: one more is 409
   * pool_rules_limit_reached.
   *
   * @param pool {@code pool}, string
   * @param rules {@code rules}, object (may be null)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setPoolBookingRules(String pool, Map<String, ?> rules) {
    return setPoolBookingRules(pool, rules, null);
  }

  /**
   * A resource's history. What happened on one of the tenant's resources, newest first: each
   * hold, booking and event made, moved, confirmed, released or cancelled, and each change to the
   * resource itself (created, rules, pool or hours changed, archived, restored, coverage recorded
   * or deleted), when, by whom (the actor and API key), from where (origin), and for a change
   * what it was before. Kept 30 days. Pass next_before as before for older entries.
   *
   * @param resourceId {@code resource_id}, string
   * @param optional the optional arguments, or null: {@code limit} (integer), {@code before}
   * (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getResourceHistory(String resourceId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    putOptional(values, optional, Set.of("limit", "before"), "slotlock_get_resource_history");
    return call("slotlock_get_resource_history", values);
  }

  /**
   * A resource's history. What happened on one of the tenant's resources, newest first: each
   * hold, booking and event made, moved, confirmed, released or cancelled, and each change to the
   * resource itself (created, rules, pool or hours changed, archived, restored, coverage recorded
   * or deleted), when, by whom (the actor and API key), from where (origin), and for a change
   * what it was before. Kept 30 days. Pass next_before as before for older entries.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getResourceHistory(String resourceId) {
    return getResourceHistory(resourceId, null);
  }

  /**
   * A booking's history. What happened to one booking, by its reference, newest first: made,
   * moved, cancelled, when and by whom, as slotlock_get_resource_history.
   *
   * @param reservationRef {@code reservation_ref}, string
   * @param optional the optional arguments, or null: {@code limit} (integer), {@code before}
   * (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getReservationHistory(String reservationRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("reservation_ref", reservationRef);
    putOptional(values, optional, Set.of("limit", "before"), "slotlock_get_reservation_history");
    return call("slotlock_get_reservation_history", values);
  }

  /**
   * A booking's history. What happened to one booking, by its reference, newest first: made,
   * moved, cancelled, when and by whom, as slotlock_get_resource_history.
   *
   * @param reservationRef {@code reservation_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getReservationHistory(String reservationRef) {
    return getReservationHistory(reservationRef, null);
  }

  /**
   * An event's history. What happened to one calendar event of the tenant, by its id, newest
   * first: created, changed, cancelled, when and by whom, as slotlock_get_resource_history.
   *
   * @param eventId {@code event_id}, string
   * @param optional the optional arguments, or null: {@code limit} (integer), {@code before}
   * (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getTenantEventHistory(String eventId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    putOptional(values, optional, Set.of("limit", "before"), "slotlock_get_tenant_event_history");
    return call("slotlock_get_tenant_event_history", values);
  }

  /**
   * An event's history. What happened to one calendar event of the tenant, by its id, newest
   * first: created, changed, cancelled, when and by whom, as slotlock_get_resource_history.
   *
   * @param eventId {@code event_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getTenantEventHistory(String eventId) {
    return getTenantEventHistory(eventId, null);
  }

  /**
   * Set every resource's bookable hours. Set the weekly bookable hours of every resource the
   * tenant has, as slotlock_set_resource_availability does for one. `null` makes them all use the
   * server's default. Returns how many resources changed.
   *
   * @param rules {@code rules}, list of object (may be null)
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> setTenantAvailability(List<?> rules, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("rules", rules);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_set_tenant_availability");
    return call("slotlock_set_tenant_availability", values);
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
    return setTenantAvailability(rules, null);
  }

  /**
   * Hold time. Occupy a window without booking it, for example while a customer pays. The hold
   * blocks every other booking until it expires (the database clock, ttl_seconds from now), is
   * confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and a
   * confirmed hold keeps it. A taken window answers 409 overlap. With an idempotency key (the
   * Idempotency-Key header or idempotency_key), a retry answers the hold the first request made,
   * until that hold would have expired, is released or is confirmed; the same key with another
   * request is 422 idempotency_conflict.
   *
   * @param resourceId {@code resource_id}, string
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param ttlSeconds {@code ttl_seconds}, integer
   * @param optional the optional arguments, or null: {@code source} (string), {@code
   * idempotency_key} (string), {@code buffer_after_minutes} (integer), {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> acquireHold(String resourceId, String start, String end, long ttlSeconds, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("start", start);
    values.put("end", end);
    values.put("ttl_seconds", ttlSeconds);
    putOptional(values, optional, Set.of("source", "idempotency_key", "buffer_after_minutes", "dry_run"), "slotlock_acquire_hold");
    return call("slotlock_acquire_hold", values);
  }

  /**
   * Hold time. Occupy a window without booking it, for example while a customer pays. The hold
   * blocks every other booking until it expires (the database clock, ttl_seconds from now), is
   * confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and a
   * confirmed hold keeps it. A taken window answers 409 overlap. With an idempotency key (the
   * Idempotency-Key header or idempotency_key), a retry answers the hold the first request made,
   * until that hold would have expired, is released or is confirmed; the same key with another
   * request is 422 idempotency_conflict.
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
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> releaseHold(String holdId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_release_hold");
    return call("slotlock_release_hold", values);
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
    return releaseHold(holdId, null);
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
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> confirmHold(String holdId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("hold_id", holdId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_confirm_hold");
    return call("slotlock_confirm_hold", values);
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
    return confirmHold(holdId, null);
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
   * {@code source} (string), {@code dry_run} (boolean)
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
    putOptional(values, optional, Set.of("buffer_after_minutes", "source", "dry_run"), "slotlock_put_reservation");
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
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> cancelReservation(String reservationRef, long revision, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("reservation_ref", reservationRef);
    values.put("revision", revision);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_cancel_reservation");
    return call("slotlock_cancel_reservation", values);
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
    return cancelReservation(reservationRef, revision, null);
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
   * Check in a booking. Claim a booking by its reference: the customer has arrived or picked up.
   * On a resource whose booking rules set check_in_minutes, a booking not checked in that long
   * after its start is released by maintenance (reservation.no_show on the feed) and offered to
   * the waitlist. Check-in opens an hour before the start (409 check_in_not_open before then) and
   * moving the booking to another start clears it. Checking in again keeps the first time; a
   * booking that has ended answers 409 reservation_ended.
   *
   * @param reservationRef {@code reservation_ref}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> checkInReservation(String reservationRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("reservation_ref", reservationRef);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_check_in_reservation");
    return call("slotlock_check_in_reservation", values);
  }

  /**
   * Check in a booking. Claim a booking by its reference: the customer has arrived or picked up.
   * On a resource whose booking rules set check_in_minutes, a booking not checked in that long
   * after its start is released by maintenance (reservation.no_show on the feed) and offered to
   * the waitlist. Check-in opens an hour before the start (409 check_in_not_open before then) and
   * moving the booking to another start clears it. Checking in again keeps the first time; a
   * booking that has ended answers 409 reservation_ended.
   *
   * @param reservationRef {@code reservation_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> checkInReservation(String reservationRef) {
    return checkInReservation(reservationRef, null);
  }

  /**
   * List the waitlist. The tenant's waitlist entries in the order they are offered (oldest
   * first), with what each was offered: optionally only those of one resource, pool or holder.
   *
   * @param optional the optional arguments, or null: {@code resource_id} (string), {@code pool}
   * (string), {@code holder_ref} (string), {@code limit} (integer)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listWaitlist(Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    putOptional(values, optional, Set.of("resource_id", "pool", "holder_ref", "limit"), "slotlock_list_waitlist");
    return call("slotlock_list_waitlist", values);
  }

  /**
   * List the waitlist. The tenant's waitlist entries in the order they are offered (oldest
   * first), with what each was offered: optionally only those of one resource, pool or holder.
   *
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listWaitlist() {
    return listWaitlist(null);
  }

  /**
   * Join the waitlist. Wait for a window on one resource (resource_id) or on any member of a pool
   * (pool) that is taken now. When it comes free (a booking cancelled, a hold released or
   * expired, a no-show), the entries waiting for it are offered in the order they joined: the
   * first gets a hold of it for holder_ref, for offer_ttl_seconds (default 900), and the feed
   * says so (waitlist.offered, with hold_id): confirm the hold to book it. An entry whose window
   * starts first expires (waitlist.expired). A holder may wait for 20 windows at once (409
   * waitlist_limit_reached); a window is at most 31 days. With an idempotency key (the
   * Idempotency-Key header or idempotency_key), a retry answers the entry the first request made
   * (replayed: true) for as long as it is kept; the same key with another request is 422
   * idempotency_conflict.
   *
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param holderRef {@code holder_ref}, string
   * @param optional the optional arguments, or null: {@code resource_id} (string), {@code pool}
   * (string), {@code offer_ttl_seconds} (integer), {@code idempotency_key} (string), {@code
   * dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> joinWaitlist(String start, String end, String holderRef, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("start", start);
    values.put("end", end);
    values.put("holder_ref", holderRef);
    putOptional(values, optional, Set.of("resource_id", "pool", "offer_ttl_seconds", "idempotency_key", "dry_run"), "slotlock_join_waitlist");
    return call("slotlock_join_waitlist", values);
  }

  /**
   * Join the waitlist. Wait for a window on one resource (resource_id) or on any member of a pool
   * (pool) that is taken now. When it comes free (a booking cancelled, a hold released or
   * expired, a no-show), the entries waiting for it are offered in the order they joined: the
   * first gets a hold of it for holder_ref, for offer_ttl_seconds (default 900), and the feed
   * says so (waitlist.offered, with hold_id): confirm the hold to book it. An entry whose window
   * starts first expires (waitlist.expired). A holder may wait for 20 windows at once (409
   * waitlist_limit_reached); a window is at most 31 days. With an idempotency key (the
   * Idempotency-Key header or idempotency_key), a retry answers the entry the first request made
   * (replayed: true) for as long as it is kept; the same key with another request is 422
   * idempotency_conflict.
   *
   * @param start {@code start}, string
   * @param end {@code end}, string
   * @param holderRef {@code holder_ref}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> joinWaitlist(String start, String end, String holderRef) {
    return joinWaitlist(start, end, holderRef, null);
  }

  /**
   * Leave the waitlist. Stop waiting. A hold offered and not yet confirmed is released with the
   * entry, and the time offered to the next who waits; one confirmed is a booking and stays. left
   * is false when there was no such entry.
   *
   * @param entryId {@code entry_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> leaveWaitlist(String entryId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("entry_id", entryId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_leave_waitlist");
    return call("slotlock_leave_waitlist", values);
  }

  /**
   * Leave the waitlist. Stop waiting. A hold offered and not yet confirmed is released with the
   * entry, and the time offered to the next who waits; one confirmed is a booking and stays. left
   * is false when there was no such entry.
   *
   * @param entryId {@code entry_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> leaveWaitlist(String entryId) {
    return leaveWaitlist(entryId, null);
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
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> recordCoverage(String resourceId, String source, String start, String end, long revision, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("source", source);
    values.put("start", start);
    values.put("end", end);
    values.put("revision", revision);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_record_coverage");
    return call("slotlock_record_coverage", values);
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
    return recordCoverage(resourceId, source, start, end, revision, null);
  }

  /**
   * Retire a source. Forget a source's coverage of the resource, for a calendar sync that is
   * disconnected or replaced: free/busy and a resource whose booking rules require certainty stop
   * waiting on it. 404 coverage_not_found for a source with no coverage of the resource.
   *
   * @param resourceId {@code resource_id}, string
   * @param source {@code source}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteCoverage(String resourceId, String source, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("source", source);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_delete_coverage");
    return call("slotlock_delete_coverage", values);
  }

  /**
   * Retire a source. Forget a source's coverage of the resource, for a calendar sync that is
   * disconnected or replaced: free/busy and a resource whose booking rules require certainty stop
   * waiting on it. 404 coverage_not_found for a source with no coverage of the resource.
   *
   * @param resourceId {@code resource_id}, string
   * @param source {@code source}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteCoverage(String resourceId, String source) {
    return deleteCoverage(resourceId, source, null);
  }

  /**
   * A resource's coverage and its health. Each external calendar (source) that records coverage
   * of a resource: the window it covers, when it was last read, its last error, and whether it is
   * stale (not read for a day, so the time it covers is unproven, not free). A source that goes
   * stale is also put on the change feed once, as coverage.stale, until it is read again. The
   * feed names a source by its source_id (random, made when the source is first recorded for the
   * resource and kept until it is deleted), never the source itself.
   *
   * @param resourceId {@code resource_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getCoverage(String resourceId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    return call("slotlock_get_coverage", values);
  }

  /**
   * Record a failed read of a source. Record that reading an external calendar failed (it
   * answered 500, a token expired): kept as the source's last error, shown by
   * slotlock_get_coverage, while its coverage stays as it was. 404 coverage_not_found for a
   * source that has never recorded coverage of the resource.
   *
   * @param resourceId {@code resource_id}, string
   * @param source {@code source}, string
   * @param error {@code error}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> recordCoverageFailure(String resourceId, String source, String error, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("resource_id", resourceId);
    values.put("source", source);
    values.put("error", error);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_record_coverage_failure");
    return call("slotlock_record_coverage_failure", values);
  }

  /**
   * Record a failed read of a source. Record that reading an external calendar failed (it
   * answered 500, a token expired): kept as the source's last error, shown by
   * slotlock_get_coverage, while its coverage stays as it was. 404 coverage_not_found for a
   * source that has never recorded coverage of the resource.
   *
   * @param resourceId {@code resource_id}, string
   * @param source {@code source}, string
   * @param error {@code error}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> recordCoverageFailure(String resourceId, String source, String error) {
    return recordCoverageFailure(resourceId, source, error, null);
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
   * key with the same request answers what the first did; with another request, 422
   * idempotency_conflict.
   * @param optional the optional arguments, or null: {@code expected_resource_id} (string),
   * {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> cancelTenantEvent(String eventId, long expectedRevision, String idempotencyKey, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    values.put("expected_revision", expectedRevision);
    values.put("idempotency_key", idempotencyKey);
    putOptional(values, optional, Set.of("expected_resource_id", "dry_run"), "slotlock_cancel_tenant_event");
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
   * key with the same request answers what the first did; with another request, 422
   * idempotency_conflict.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> cancelTenantEvent(String eventId, long expectedRevision, String idempotencyKey) {
    return cancelTenantEvent(eventId, expectedRevision, idempotencyKey, null);
  }

  /**
   * Export an event as JSCalendar. One of the tenant's events as a JSCalendar Event (RFC 8984),
   * the JSON form of a calendar event: uid is its id, sequence its revision, start a local time
   * in timeZone with an exact duration, its people participants, its reminders alerts, its
   * recurrence recurrenceRules and recurrenceOverrides (and the RRULE verbatim as
   * slotlock.pylota.io:rrule). A cancelled or unknown one answers 404 event_not_found.
   *
   * @param eventId {@code event_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> exportTenantEvent(String eventId) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("event_id", eventId);
    return call("slotlock_export_tenant_event", values);
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
   * tenant_suspended), nor can one whose hosted plan is still paid for until it is cancelled (409
   * billing_active). Erasing again deletes nothing.
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

  /**
   * List changes. What changed in the tenant, oldest first, as CloudEvents: holds made,
   * confirmed, released or expired; bookings made, moved or cancelled; calendar events created,
   * changed or cancelled; resources created, changed (rules, pool, hours), archived, restored or
   * deleted; coverage sources recorded or deleted; webhooks added, enabled or deleted; API keys
   * created, rotated or revoked (ids, times and states, never titles, attendees, URLs or
   * secrets). Each names where it came from (slotlockorigin) and the API key that made it
   * (slotlockkeyid) when recorded. Pass next_cursor as cursor to read on; it is returned even
   * when nothing is new, so poll with it. Only changes of transactions that have ended are
   * listed, so following the cursor never skips one. Changes are kept 30 days: an older cursor
   * answers 410 cursor_expired, so start again without one.
   *
   * @param optional the optional arguments, or null: {@code cursor} (string), {@code limit}
   * (integer)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listChanges(Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    putOptional(values, optional, Set.of("cursor", "limit"), "slotlock_list_changes");
    return call("slotlock_list_changes", values);
  }

  /**
   * List changes. What changed in the tenant, oldest first, as CloudEvents: holds made,
   * confirmed, released or expired; bookings made, moved or cancelled; calendar events created,
   * changed or cancelled; resources created, changed (rules, pool, hours), archived, restored or
   * deleted; coverage sources recorded or deleted; webhooks added, enabled or deleted; API keys
   * created, rotated or revoked (ids, times and states, never titles, attendees, URLs or
   * secrets). Each names where it came from (slotlockorigin) and the API key that made it
   * (slotlockkeyid) when recorded. Pass next_cursor as cursor to read on; it is returned even
   * when nothing is new, so poll with it. Only changes of transactions that have ended are
   * listed, so following the cursor never skips one. Changes are kept 30 days: an older cursor
   * answers 410 cursor_expired, so start again without one.
   *
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listChanges() {
    return listChanges(null);
  }

  /**
   * List webhooks. The tenant's webhooks with how delivery is going: failed attempts, the last
   * status, and whether and why one is disabled.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> listWebhooks() {
    Map<String, Object> values = new LinkedHashMap<>();
    return call("slotlock_list_webhooks", values);
  }

  /**
   * Add a webhook. Send the changes slotlock_list_changes lists from now on to an https URL, each
   * as a CloudEvent signed as Standard Webhooks (webhook-id, webhook-timestamp,
   * webhook-signature), in order, until a 2xx. A failure is retried with backoff; after 24 hours
   * of failures, or a 410, the webhook is disabled and the feed records webhook.disabled. The
   * secret is returned here only. At most 25 per tenant, or fewer on a plan (409
   * webhook_limit_reached). With resource_ids, pools, locations (each with every location in it)
   * or groups, only changes about a resource that matches one of them, as it is when the change
   * is delivered: a change about no resource (a key, a webhook, a usage notice) is not sent. At
   * most 100 resource ids and 20 of each other kind (400 invalid_webhook_filter). With an
   * idempotency key (the Idempotency-Key header or idempotency_key), a retry answers the webhook
   * and secret the first request made (replayed: true) for as long as the webhook is kept; the
   * same key with another request is 422 idempotency_conflict.
   *
   * @param url {@code url}, string
   * @param optional the optional arguments, or null: {@code event_types} (list of string), {@code
   * resource_ids} (list of string), {@code pools} (list of string), {@code locations} (list of
   * string), {@code groups} (list of string), {@code idempotency_key} (string), {@code dry_run}
   * (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createWebhook(String url, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("url", url);
    putOptional(values, optional, Set.of("event_types", "resource_ids", "pools", "locations", "groups", "idempotency_key", "dry_run"), "slotlock_create_webhook");
    return call("slotlock_create_webhook", values);
  }

  /**
   * Add a webhook. Send the changes slotlock_list_changes lists from now on to an https URL, each
   * as a CloudEvent signed as Standard Webhooks (webhook-id, webhook-timestamp,
   * webhook-signature), in order, until a 2xx. A failure is retried with backoff; after 24 hours
   * of failures, or a 410, the webhook is disabled and the feed records webhook.disabled. The
   * secret is returned here only. At most 25 per tenant, or fewer on a plan (409
   * webhook_limit_reached). With resource_ids, pools, locations (each with every location in it)
   * or groups, only changes about a resource that matches one of them, as it is when the change
   * is delivered: a change about no resource (a key, a webhook, a usage notice) is not sent. At
   * most 100 resource ids and 20 of each other kind (400 invalid_webhook_filter). With an
   * idempotency key (the Idempotency-Key header or idempotency_key), a retry answers the webhook
   * and secret the first request made (replayed: true) for as long as the webhook is kept; the
   * same key with another request is 422 idempotency_conflict.
   *
   * @param url {@code url}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> createWebhook(String url) {
    return createWebhook(url, null);
  }

  /**
   * Delete a webhook. Stop sending to a webhook. deleted is false when the tenant has no such
   * webhook.
   *
   * @param webhookId {@code webhook_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteWebhook(String webhookId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("webhook_id", webhookId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_delete_webhook");
    return call("slotlock_delete_webhook", values);
  }

  /**
   * Delete a webhook. Stop sending to a webhook. deleted is false when the tenant has no such
   * webhook.
   *
   * @param webhookId {@code webhook_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> deleteWebhook(String webhookId) {
    return deleteWebhook(webhookId, null);
  }

  /**
   * Enable a webhook. Send to a disabled webhook again, from the first change it did not accept.
   * 404 webhook_not_found when the tenant has no such webhook; 409 changes_pruned when what it
   * missed is older than the 30 days the feed keeps, since it would skip those unseen: delete it,
   * add it again, and read what it missed from slotlock_list_changes.
   *
   * @param webhookId {@code webhook_id}, string
   * @param optional the optional arguments, or null: {@code dry_run} (boolean)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> enableWebhook(String webhookId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("webhook_id", webhookId);
    putOptional(values, optional, Set.of("dry_run"), "slotlock_enable_webhook");
    return call("slotlock_enable_webhook", values);
  }

  /**
   * Enable a webhook. Send to a disabled webhook again, from the first change it did not accept.
   * 404 webhook_not_found when the tenant has no such webhook; 409 changes_pruned when what it
   * missed is older than the 30 days the feed keeps, since it would skip those unseen: delete it,
   * add it again, and read what it missed from slotlock_list_changes.
   *
   * @param webhookId {@code webhook_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> enableWebhook(String webhookId) {
    return enableWebhook(webhookId, null);
  }

  /**
   * Read usage. How much the tenant used the service from one UTC day to another (inclusive, at
   * most 400 days apart; by default the first of this month to today): operations its keys and
   * the dashboard assistant ran (each call that reached its operation, whatever it returned),
   * bookings (bookings, events and confirmed holds) and holds it made, webhook deliveries its
   * endpoints accepted, messages to the dashboard assistant, and the resources it held (each
   * day's count, archived ones included; in totals, the last day's, not a sum). Totals, then by
   * day, by API key (key_id null for none) and by surface (mcp, a2a, rest, application,
   * dashboard-assistant, webhooks); resources are by day only. Counts only, never what was asked.
   * Empty unless the server meters usage (SLOTLOCK_USAGE=on); operations, deliveries and messages
   * appear within 15 seconds; bookings, holds and resources within the hour. 400
   * invalid_usage_range when to is before from, the range is longer than 400 days, or to is after
   * today.
   *
   * @param optional the optional arguments, or null: {@code from} (string), {@code to} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getUsage(Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    putOptional(values, optional, Set.of("from", "to"), "slotlock_get_usage");
    return call("slotlock_get_usage", values);
  }

  /**
   * Read usage. How much the tenant used the service from one UTC day to another (inclusive, at
   * most 400 days apart; by default the first of this month to today): operations its keys and
   * the dashboard assistant ran (each call that reached its operation, whatever it returned),
   * bookings (bookings, events and confirmed holds) and holds it made, webhook deliveries its
   * endpoints accepted, messages to the dashboard assistant, and the resources it held (each
   * day's count, archived ones included; in totals, the last day's, not a sum). Totals, then by
   * day, by API key (key_id null for none) and by surface (mcp, a2a, rest, application,
   * dashboard-assistant, webhooks); resources are by day only. Counts only, never what was asked.
   * Empty unless the server meters usage (SLOTLOCK_USAGE=on); operations, deliveries and messages
   * appear within 15 seconds; bookings, holds and resources within the hour. 400
   * invalid_usage_range when to is before from, the range is longer than 400 days, or to is after
   * today.
   *
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> getUsage() {
    return getUsage(null);
  }

  /**
   * Read an account. One of the partner's accounts, with how many resources (archived ones
   * included) and active API keys it holds. 404 account_not_found for an account the partner does
   * not have.
   *
   * @param account {@code account}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerGetAccount(String account) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    return call("slotlock_partner_get_account", values);
  }

  /**
   * Create or update an account. Create the partner's account with this id (your own id for your
   * user, 1-128 letters, digits, dots, dashes or underscores), or put it on another plan: one of
   * your contract's, whose limits and monthly quotas the account then has. Its tenant is
   * partner:&lt;partner&gt;:&lt;account&gt;, an ordinary Slotlock tenant of its own. Repeating
   * the call changes nothing more. 400 invalid_partner_plan for a plan your contract does not
   * have.
   *
   * @param account {@code account}, string
   * @param plan {@code plan}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerPutAccount(String account, String plan) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    values.put("plan", plan);
    return call("slotlock_partner_put_account", values);
  }

  /**
   * List accounts. The partner's accounts, by id: plan, whether suspended, and when made and last
   * changed.
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerListAccounts() {
    Map<String, Object> values = new LinkedHashMap<>();
    return call("slotlock_partner_list_accounts", values);
  }

  /**
   * List an account's keys. The account's API keys, revoked and expired ones included, newest
   * first; never the keys themselves.
   *
   * @param account {@code account}, string
   * @param optional the optional arguments, or null: {@code environment} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerListKeys(String account, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    putOptional(values, optional, Set.of("environment"), "slotlock_partner_list_keys");
    return call("slotlock_partner_list_keys", values);
  }

  /**
   * List an account's keys. The account's API keys, revoked and expired ones included, newest
   * first; never the keys themselves.
   *
   * @param account {@code account}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerListKeys(String account) {
    return partnerListKeys(account, null);
  }

  /**
   * Create a key for an account. An API key for the account, shown once in key and never again;
   * only its SHA-256 is kept. Give it to your user's calls: it acts in the account's tenant, over
   * MCP, A2A and REST, as any key. environment: test makes it in the account's test environment
   * instead (a tenant of its own, on the same plan, never billed; its keys start slk_test_).
   * scopes: some of the ones your contract allows (read and write unless it says), by default all
   * of them; expires_in_days: 1-3650, or none. 403 scope_not_in_contract for another scope; 409
   * api_key_limit_reached past the account plan's keys.
   *
   * @param account {@code account}, string
   * @param name {@code name}, string
   * @param optional the optional arguments, or null: {@code scopes} (list of string), {@code
   * expires_in_days} (integer), {@code environment} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerCreateKey(String account, String name, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    values.put("name", name);
    putOptional(values, optional, Set.of("scopes", "expires_in_days", "environment"), "slotlock_partner_create_key");
    return call("slotlock_partner_create_key", values);
  }

  /**
   * Create a key for an account. An API key for the account, shown once in key and never again;
   * only its SHA-256 is kept. Give it to your user's calls: it acts in the account's tenant, over
   * MCP, A2A and REST, as any key. environment: test makes it in the account's test environment
   * instead (a tenant of its own, on the same plan, never billed; its keys start slk_test_).
   * scopes: some of the ones your contract allows (read and write unless it says), by default all
   * of them; expires_in_days: 1-3650, or none. 403 scope_not_in_contract for another scope; 409
   * api_key_limit_reached past the account plan's keys.
   *
   * @param account {@code account}, string
   * @param name {@code name}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerCreateKey(String account, String name) {
    return partnerCreateKey(account, name, null);
  }

  /**
   * Rotate an account's key. A new secret for one of the account's active keys, shown once; the
   * old one stops at once. The key keeps its id and what it booked. 404 key_not_found otherwise.
   *
   * @param account {@code account}, string
   * @param keyId {@code key_id}, string
   * @param optional the optional arguments, or null: {@code environment} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerRotateKey(String account, String keyId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    values.put("key_id", keyId);
    putOptional(values, optional, Set.of("environment"), "slotlock_partner_rotate_key");
    return call("slotlock_partner_rotate_key", values);
  }

  /**
   * Rotate an account's key. A new secret for one of the account's active keys, shown once; the
   * old one stops at once. The key keeps its id and what it booked. 404 key_not_found otherwise.
   *
   * @param account {@code account}, string
   * @param keyId {@code key_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerRotateKey(String account, String keyId) {
    return partnerRotateKey(account, keyId, null);
  }

  /**
   * Revoke an account's key. Revoke one of the account's keys at once; revoking it again changes
   * nothing. 404 key_not_found otherwise.
   *
   * @param account {@code account}, string
   * @param keyId {@code key_id}, string
   * @param optional the optional arguments, or null: {@code environment} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerRevokeKey(String account, String keyId, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    values.put("key_id", keyId);
    putOptional(values, optional, Set.of("environment"), "slotlock_partner_revoke_key");
    return call("slotlock_partner_revoke_key", values);
  }

  /**
   * Revoke an account's key. Revoke one of the account's keys at once; revoking it again changes
   * nothing. 404 key_not_found otherwise.
   *
   * @param account {@code account}, string
   * @param keyId {@code key_id}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerRevokeKey(String account, String keyId) {
    return partnerRevokeKey(account, keyId, null);
  }

  /**
   * Suspend an account. Suspend the account, as slotlock tenant suspend: it may read, and writes
   * nothing; its keys get no new secret. suspended says whether it was not suspended already.
   *
   * @param account {@code account}, string
   * @param optional the optional arguments, or null: {@code reason} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerSuspendAccount(String account, Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    putOptional(values, optional, Set.of("reason"), "slotlock_partner_suspend_account");
    return call("slotlock_partner_suspend_account", values);
  }

  /**
   * Suspend an account. Suspend the account, as slotlock tenant suspend: it may read, and writes
   * nothing; its keys get no new secret. suspended says whether it was not suspended already.
   *
   * @param account {@code account}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerSuspendAccount(String account) {
    return partnerSuspendAccount(account, null);
  }

  /**
   * Lift a suspension. Lift a suspension the partner made. One Pylota made stays: unsuspended is
   * false then, as when the account was not suspended.
   *
   * @param account {@code account}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerUnsuspendAccount(String account) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    return call("slotlock_partner_unsuspend_account", values);
  }

  /**
   * Erase an account. Erase the account's tenant, every row it owns, as /v1/tenant/erase, and the
   * partner's record of it. confirm repeats the account. Cannot be undone.
   *
   * @param account {@code account}, string
   * @param confirm {@code confirm}, string
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerEraseAccount(String account, String confirm) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("account", account);
    values.put("confirm", confirm);
    return call("slotlock_partner_erase_account", values);
  }

  /**
   * Read the accounts' usage. The partner's accounts' usage, the counts Pylota invoices from, by
   * account, UTC day and metric (operations, bookings, holds, webhook_deliveries, resources: each
   * day's count), from one UTC day to another (inclusive, at most 400 days apart; by default this
   * month); one account, or all. 400 invalid_usage_range otherwise.
   *
   * @param optional the optional arguments, or null: {@code from} (string), {@code to} (string),
   * {@code account} (string)
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerGetUsage(Map<String, ?> optional) {
    Map<String, Object> values = new LinkedHashMap<>();
    putOptional(values, optional, Set.of("from", "to", "account"), "slotlock_partner_get_usage");
    return call("slotlock_partner_get_usage", values);
  }

  /**
   * Read the accounts' usage. The partner's accounts' usage, the counts Pylota invoices from, by
   * account, UTC day and metric (operations, bookings, holds, webhook_deliveries, resources: each
   * day's count), from one UTC day to another (inclusive, at most 400 days apart; by default this
   * month); one account, or all. 400 invalid_usage_range otherwise.
   *
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerGetUsage() {
    return partnerGetUsage(null);
  }

  /**
   * Compare your counts with ours. Send your count of each account's operations (and, if you keep
   * them, bookings) on one ended UTC day, as your daily cross-check: the answer gives ours beside
   * yours for every account either of us counted, the difference in percent, and whether every
   * one is within 0.5%. A day outside that is recorded as a mismatch, which Pylota looks into.
   * Sending the same day again replaces its record.
   *
   * @param day {@code day}, string
   * @param accounts {@code accounts}, list of object
   * @return the response body
   * @throws SlotlockException when the server refuses the call
   */
  public Map<String, Object> partnerReconcileUsage(String day, List<?> accounts) {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("day", day);
    values.put("accounts", accounts);
    return call("slotlock_partner_reconcile_usage", values);
  }

}
