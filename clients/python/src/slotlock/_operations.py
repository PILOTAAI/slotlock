# Generated from openapi.json by clients/generate.ts. Do not edit: change the server, then run
# SLOTLOCK_WRITE_GENERATED=1 npx vitest run src/__tests__/generated.test.ts
from __future__ import annotations

from typing import Any

from ._transport import UNSET, Operation, Transport, Unset

#: Every operation, by name: its method, path, path parameters and query parameters.
OPERATIONS: dict[str, Operation] = {
    "slotlock_list_resources": Operation(
        "slotlock_list_resources",
        "GET",
        "/v1/resources",
        (),
        ("cursor", "limit", "pool"),
    ),
    "slotlock_create_resource": Operation(
        "slotlock_create_resource",
        "POST",
        "/v1/resources",
        (),
        (),
    ),
    "slotlock_get_free_busy": Operation(
        "slotlock_get_free_busy",
        "GET",
        "/v1/free-busy",
        (),
        ("resource_ids", "start", "end"),
    ),
    "slotlock_find_next_available": Operation(
        "slotlock_find_next_available",
        "GET",
        "/v1/next-available",
        (),
        ("resource_ids", "start", "end", "duration_minutes"),
    ),
    "slotlock_find_available_slots": Operation(
        "slotlock_find_available_slots",
        "GET",
        "/v1/available-slots",
        (),
        ("resource_ids", "start", "end", "duration_minutes", "limit", "require_free"),
    ),
    "slotlock_hold_slots": Operation(
        "slotlock_hold_slots",
        "POST",
        "/v1/slot-holds",
        (),
        (),
    ),
    "slotlock_book_together": Operation(
        "slotlock_book_together",
        "POST",
        "/v1/bundles",
        (),
        (),
    ),
    "slotlock_book_pool": Operation(
        "slotlock_book_pool",
        "POST",
        "/v1/pool-bookings",
        (),
        (),
    ),
    "slotlock_release_slots": Operation(
        "slotlock_release_slots",
        "DELETE",
        "/v1/slot-holds/{hold_id}",
        ("hold_id",),
        (),
    ),
    "slotlock_list_events": Operation(
        "slotlock_list_events",
        "GET",
        "/v1/events",
        (),
        ("resource_ids", "start", "end", "cursor", "limit"),
    ),
    "slotlock_create_event": Operation(
        "slotlock_create_event",
        "POST",
        "/v1/events",
        (),
        (),
    ),
    "slotlock_get_event": Operation(
        "slotlock_get_event",
        "GET",
        "/v1/events/{event_id}",
        ("event_id",),
        (),
    ),
    "slotlock_update_event": Operation(
        "slotlock_update_event",
        "PATCH",
        "/v1/events/{event_id}",
        ("event_id",),
        (),
    ),
    "slotlock_delete_event": Operation(
        "slotlock_delete_event",
        "DELETE",
        "/v1/events/{event_id}",
        ("event_id",),
        ("expected_revision", "idempotency_key"),
    ),
    "slotlock_get_resource": Operation(
        "slotlock_get_resource",
        "GET",
        "/v1/resources/{resource_id}",
        ("resource_id",),
        (),
    ),
    "slotlock_delete_resource": Operation(
        "slotlock_delete_resource",
        "DELETE",
        "/v1/resources/{resource_id}",
        ("resource_id",),
        (),
    ),
    "slotlock_archive_resource": Operation(
        "slotlock_archive_resource",
        "POST",
        "/v1/resources/{resource_id}/archive",
        ("resource_id",),
        (),
    ),
    "slotlock_restore_resource": Operation(
        "slotlock_restore_resource",
        "POST",
        "/v1/resources/{resource_id}/restore",
        ("resource_id",),
        (),
    ),
    "slotlock_list_busy": Operation(
        "slotlock_list_busy",
        "GET",
        "/v1/resources/{resource_id}/busy",
        ("resource_id",),
        ("start", "end"),
    ),
    "slotlock_set_resource_availability": Operation(
        "slotlock_set_resource_availability",
        "PUT",
        "/v1/resources/{resource_id}/availability",
        ("resource_id",),
        (),
    ),
    "slotlock_set_resource_booking_rules": Operation(
        "slotlock_set_resource_booking_rules",
        "PUT",
        "/v1/resources/{resource_id}/booking-rules",
        ("resource_id",),
        (),
    ),
    "slotlock_set_resource_pool": Operation(
        "slotlock_set_resource_pool",
        "PUT",
        "/v1/resources/{resource_id}/pool",
        ("resource_id",),
        (),
    ),
    "slotlock_list_pools": Operation(
        "slotlock_list_pools",
        "GET",
        "/v1/pools",
        (),
        (),
    ),
    "slotlock_get_resource_history": Operation(
        "slotlock_get_resource_history",
        "GET",
        "/v1/resources/{resource_id}/history",
        ("resource_id",),
        ("limit", "before"),
    ),
    "slotlock_get_reservation_history": Operation(
        "slotlock_get_reservation_history",
        "GET",
        "/v1/reservations/{reservation_ref}/history",
        ("reservation_ref",),
        ("limit", "before"),
    ),
    "slotlock_get_tenant_event_history": Operation(
        "slotlock_get_tenant_event_history",
        "GET",
        "/v1/tenant/events/{event_id}/history",
        ("event_id",),
        ("limit", "before"),
    ),
    "slotlock_set_tenant_availability": Operation(
        "slotlock_set_tenant_availability",
        "PUT",
        "/v1/availability",
        (),
        (),
    ),
    "slotlock_acquire_hold": Operation(
        "slotlock_acquire_hold",
        "POST",
        "/v1/holds",
        (),
        (),
    ),
    "slotlock_get_hold": Operation(
        "slotlock_get_hold",
        "GET",
        "/v1/holds/{hold_id}",
        ("hold_id",),
        (),
    ),
    "slotlock_release_hold": Operation(
        "slotlock_release_hold",
        "DELETE",
        "/v1/holds/{hold_id}",
        ("hold_id",),
        (),
    ),
    "slotlock_list_holds": Operation(
        "slotlock_list_holds",
        "GET",
        "/v1/resources/{resource_id}/holds",
        ("resource_id",),
        ("limit", "cursor"),
    ),
    "slotlock_confirm_hold": Operation(
        "slotlock_confirm_hold",
        "POST",
        "/v1/holds/{hold_id}/confirm",
        ("hold_id",),
        (),
    ),
    "slotlock_get_reservation": Operation(
        "slotlock_get_reservation",
        "GET",
        "/v1/reservations/{reservation_ref}",
        ("reservation_ref",),
        (),
    ),
    "slotlock_put_reservation": Operation(
        "slotlock_put_reservation",
        "PUT",
        "/v1/reservations/{reservation_ref}",
        ("reservation_ref",),
        (),
    ),
    "slotlock_cancel_reservation": Operation(
        "slotlock_cancel_reservation",
        "DELETE",
        "/v1/reservations/{reservation_ref}",
        ("reservation_ref",),
        ("revision",),
    ),
    "slotlock_list_reservations": Operation(
        "slotlock_list_reservations",
        "GET",
        "/v1/resources/{resource_id}/reservations",
        ("resource_id",),
        ("start", "end", "limit", "cursor"),
    ),
    "slotlock_record_coverage": Operation(
        "slotlock_record_coverage",
        "PUT",
        "/v1/resources/{resource_id}/coverage/{source}",
        ("resource_id", "source"),
        (),
    ),
    "slotlock_get_coverage": Operation(
        "slotlock_get_coverage",
        "GET",
        "/v1/resources/{resource_id}/coverage",
        ("resource_id",),
        (),
    ),
    "slotlock_record_coverage_failure": Operation(
        "slotlock_record_coverage_failure",
        "POST",
        "/v1/resources/{resource_id}/coverage/{source}/failure",
        ("resource_id", "source"),
        (),
    ),
    "slotlock_list_tenant_events": Operation(
        "slotlock_list_tenant_events",
        "GET",
        "/v1/tenant/events",
        (),
        ("resource_id", "start", "end", "limit", "cursor"),
    ),
    "slotlock_get_tenant_event": Operation(
        "slotlock_get_tenant_event",
        "GET",
        "/v1/tenant/events/{event_id}",
        ("event_id",),
        (),
    ),
    "slotlock_cancel_tenant_event": Operation(
        "slotlock_cancel_tenant_event",
        "DELETE",
        "/v1/tenant/events/{event_id}",
        ("event_id",),
        ("expected_revision", "expected_resource_id", "idempotency_key"),
    ),
    "slotlock_get_tenant": Operation(
        "slotlock_get_tenant",
        "GET",
        "/v1/tenant",
        (),
        (),
    ),
    "slotlock_erase_tenant": Operation(
        "slotlock_erase_tenant",
        "POST",
        "/v1/tenant/erase",
        (),
        (),
    ),
    "slotlock_run_maintenance": Operation(
        "slotlock_run_maintenance",
        "POST",
        "/v1/maintenance",
        (),
        (),
    ),
    "slotlock_list_changes": Operation(
        "slotlock_list_changes",
        "GET",
        "/v1/changes",
        (),
        ("cursor", "limit"),
    ),
    "slotlock_list_webhooks": Operation(
        "slotlock_list_webhooks",
        "GET",
        "/v1/webhooks",
        (),
        (),
    ),
    "slotlock_create_webhook": Operation(
        "slotlock_create_webhook",
        "POST",
        "/v1/webhooks",
        (),
        (),
    ),
    "slotlock_delete_webhook": Operation(
        "slotlock_delete_webhook",
        "DELETE",
        "/v1/webhooks/{webhook_id}",
        ("webhook_id",),
        (),
    ),
    "slotlock_enable_webhook": Operation(
        "slotlock_enable_webhook",
        "POST",
        "/v1/webhooks/{webhook_id}/enable",
        ("webhook_id",),
        (),
    ),
}


class Operations(Transport):
    """Every Slotlock REST operation as a method; `call` runs one by name."""

    def list_resources(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        pool: str | None = None,
    ) -> dict[str, Any]:
        """List calendar resources.

        List resources visible to the authenticated tenant principal, with the pool each belongs
        to (a vehicle class, a room type). With pool, only that pool's members, in the order
        slotlock_book_pool tries them.
        """
        values: dict[str, Any] = {}
        if cursor is not None:
            values["cursor"] = cursor
        if limit is not None:
            values["limit"] = limit
        if pool is not None:
            values["pool"] = pool
        return self.call("slotlock_list_resources", values)

    def create_resource(
        self,
        *,
        external_ref: str,
        timezone: str | None = None,
        visibility: str | None = None,
    ) -> dict[str, Any]:
        """Create or update a resource.

        Create the resource with this external reference, or update its time zone if the tenant
        already has it. Repeating the call changes nothing more. visibility is shared (the
        default: agents list and book it) or private (agents never see it), fixed at creation:
        naming another for an existing resource answers 409 resource_visibility_conflict.
        """
        values: dict[str, Any] = {"external_ref": external_ref}
        if timezone is not None:
            values["timezone"] = timezone
        if visibility is not None:
            values["visibility"] = visibility
        return self.call("slotlock_create_resource", values)

    def get_free_busy(self, *, resource_ids: list[str], start: str, end: str) -> dict[str, Any]:
        """Get free-busy.

        Return privacy-minimized busy intervals and explicit coverage certainty.
        """
        values: dict[str, Any] = {"resource_ids": resource_ids, "start": start, "end": end}
        return self.call("slotlock_get_free_busy", values)

    def find_next_available(
        self,
        *,
        resource_ids: list[str],
        start: str,
        end: str,
        duration_minutes: int,
    ) -> dict[str, Any]:
        """Find next available interval.

        Find the earliest certain interval that satisfies the requested duration (up to the
        367-day search window, so a multi-month rental slot can be found).
        """
        values: dict[str, Any] = {
            "resource_ids": resource_ids,
            "start": start,
            "end": end,
            "duration_minutes": duration_minutes,
        }
        return self.call("slotlock_find_next_available", values)

    def find_available_slots(
        self,
        *,
        resource_ids: list[str],
        start: str,
        end: str,
        duration_minutes: int,
        limit: int | None = None,
        require_free: int | None = None,
    ) -> dict[str, Any]:
        """Find available slots.

        List up to `limit` certain slots of the requested duration, earliest first across the
        resources, each one free of busy time and inside the resource's hours, to offer a person a
        choice. With require_free, only times when at least that many of the resources are free
        together, each slot naming them in resource_ids: every resource for a booking that needs
        them all (book it with slotlock_book_together), or any n of them. No slot is listed unless
        every resource's coverage is certain.
        """
        values: dict[str, Any] = {
            "resource_ids": resource_ids,
            "start": start,
            "end": end,
            "duration_minutes": duration_minutes,
        }
        if limit is not None:
            values["limit"] = limit
        if require_free is not None:
            values["require_free"] = require_free
        return self.call("slotlock_find_available_slots", values)

    def hold_slots(
        self,
        *,
        slots: list[dict[str, Any]],
        idempotency_key: str,
        ttl_seconds: int | None = None,
    ) -> dict[str, Any]:
        """Hold candidate slots.

        Hold up to five candidate slots for a short time (30-900 seconds) while a person chooses,
        as alternatives in one group: each free one is held, the others are listed with why not.
        Book one by passing its hold_id to slotlock_create_event, which releases the rest;
        unbooked holds expire on their own. A hold is yours alone, and you may have 20 live at
        once.
        """
        values: dict[str, Any] = {"slots": slots, "idempotency_key": idempotency_key}
        if ttl_seconds is not None:
            values["ttl_seconds"] = ttl_seconds
        return self.call("slotlock_hold_slots", values)

    def book_together(
        self,
        *,
        resource_ids: list[str],
        starts_at: str,
        ends_at: str,
        timezone: str,
        idempotency_key: str,
        title: str | None = None,
    ) -> dict[str, Any]:
        """Book resources together.

        Book the same time on 2-20 resources at once, all or none: a van with its driver, a room
        with its projector. If any of them is taken, nothing is booked, and the refusal names that
        resource_id. Find such a time with slotlock_find_available_slots and require_free. A retry
        with the same idempotency_key answers the same events.
        """
        values: dict[str, Any] = {
            "resource_ids": resource_ids,
            "starts_at": starts_at,
            "ends_at": ends_at,
            "timezone": timezone,
            "idempotency_key": idempotency_key,
        }
        if title is not None:
            values["title"] = title
        return self.call("slotlock_book_together", values)

    def book_pool(
        self,
        *,
        pool: str,
        starts_at: str,
        ends_at: str,
        timezone: str,
        idempotency_key: str,
        title: str | None = None,
    ) -> dict[str, Any]:
        """Book from a pool.

        Book any one member of a pool (a vehicle class, a room type) for a time: members are tried
        in a fixed order and the first that is free and allows the booking is booked, in one
        transaction, so a class sells out exactly at its number of members. The event names the
        member booked. 409 pool_full when none is free; 404 pool_not_found when the pool has no
        member you may book. A retry with the same idempotency_key answers the same event.
        """
        values: dict[str, Any] = {
            "pool": pool,
            "starts_at": starts_at,
            "ends_at": ends_at,
            "timezone": timezone,
            "idempotency_key": idempotency_key,
        }
        if title is not None:
            values["title"] = title
        return self.call("slotlock_book_pool", values)

    def release_slots(self, hold_id: str) -> dict[str, Any]:
        """Release held slots.

        Release one of your holds, and the rest of its group, at once instead of letting them
        expire. `released` is false when it was already gone.
        """
        values: dict[str, Any] = {"hold_id": hold_id}
        return self.call("slotlock_release_slots", values)

    def list_events(
        self,
        *,
        resource_ids: list[str],
        start: str,
        end: str,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """List resource events.

        List bounded events intersecting a time window.
        """
        values: dict[str, Any] = {"resource_ids": resource_ids, "start": start, "end": end}
        if cursor is not None:
            values["cursor"] = cursor
        if limit is not None:
            values["limit"] = limit
        return self.call("slotlock_list_events", values)

    def create_event(
        self,
        *,
        resource_id: str,
        starts_at: str,
        ends_at: str,
        timezone: str,
        idempotency_key: str,
        title: str | None = None,
        description: str | None = None,
        location: str | None = None,
        organizer: dict[str, Any] | None = None,
        transparency: str | None = None,
        status: str | None = None,
        recurrence_rule: str | None = None,
        attendees: list[dict[str, Any]] | None = None,
        reminders: list[dict[str, Any]] | None = None,
        recurrence_exceptions: list[dict[str, Any]] | None = None,
        hold_id: str | None = None,
    ) -> dict[str, Any]:
        """Create resource event.

        Create an event of up to 3,660 days (a booking, lease or long rental); opaque occurrences
        use the database overlap arbiter.
        """
        values: dict[str, Any] = {
            "resource_id": resource_id,
            "starts_at": starts_at,
            "ends_at": ends_at,
            "timezone": timezone,
            "idempotency_key": idempotency_key,
        }
        if title is not None:
            values["title"] = title
        if description is not None:
            values["description"] = description
        if location is not None:
            values["location"] = location
        if organizer is not None:
            values["organizer"] = organizer
        if transparency is not None:
            values["transparency"] = transparency
        if status is not None:
            values["status"] = status
        if recurrence_rule is not None:
            values["recurrence_rule"] = recurrence_rule
        if attendees is not None:
            values["attendees"] = attendees
        if reminders is not None:
            values["reminders"] = reminders
        if recurrence_exceptions is not None:
            values["recurrence_exceptions"] = recurrence_exceptions
        if hold_id is not None:
            values["hold_id"] = hold_id
        return self.call("slotlock_create_event", values)

    def get_event(self, event_id: str) -> dict[str, Any]:
        """Get resource event.

        Read one tenant-scoped event by stable identifier.
        """
        values: dict[str, Any] = {"event_id": event_id}
        return self.call("slotlock_get_event", values)

    def update_event(
        self,
        event_id: str,
        *,
        expected_revision: int,
        idempotency_key: str,
        resource_id: str | None = None,
        starts_at: str | None = None,
        ends_at: str | None = None,
        timezone: str | None = None,
        title: str | None | Unset = UNSET,
        description: str | None | Unset = UNSET,
        location: str | None | Unset = UNSET,
        organizer: dict[str, Any] | None | Unset = UNSET,
        attendees: list[dict[str, Any]] | None = None,
        reminders: list[dict[str, Any]] | None = None,
        transparency: str | None = None,
        status: str | None = None,
        recurrence_rule: str | None | Unset = UNSET,
        recurrence_exceptions: list[dict[str, Any]] | None = None,
        expected_resource_id: str | None = None,
    ) -> dict[str, Any]:
        """Update resource event.

        Apply an expected-revision event patch and rematerialize occupancy atomically. With
        expected_resource_id, the resource you read the event on, an event since moved elsewhere
        is not found.
        """
        values: dict[str, Any] = {
            "event_id": event_id,
            "expected_revision": expected_revision,
            "idempotency_key": idempotency_key,
        }
        if resource_id is not None:
            values["resource_id"] = resource_id
        if starts_at is not None:
            values["starts_at"] = starts_at
        if ends_at is not None:
            values["ends_at"] = ends_at
        if timezone is not None:
            values["timezone"] = timezone
        if not isinstance(title, Unset):
            values["title"] = title
        if not isinstance(description, Unset):
            values["description"] = description
        if not isinstance(location, Unset):
            values["location"] = location
        if not isinstance(organizer, Unset):
            values["organizer"] = organizer
        if attendees is not None:
            values["attendees"] = attendees
        if reminders is not None:
            values["reminders"] = reminders
        if transparency is not None:
            values["transparency"] = transparency
        if status is not None:
            values["status"] = status
        if not isinstance(recurrence_rule, Unset):
            values["recurrence_rule"] = recurrence_rule
        if recurrence_exceptions is not None:
            values["recurrence_exceptions"] = recurrence_exceptions
        if expected_resource_id is not None:
            values["expected_resource_id"] = expected_resource_id
        return self.call("slotlock_update_event", values)

    def delete_event(
        self,
        event_id: str,
        *,
        expected_revision: int,
        idempotency_key: str,
    ) -> dict[str, Any]:
        """Delete resource event.

        Tombstone an event at an expected revision so stale sync cannot resurrect it.
        """
        values: dict[str, Any] = {
            "event_id": event_id,
            "expected_revision": expected_revision,
            "idempotency_key": idempotency_key,
        }
        return self.call("slotlock_delete_event", values)

    def get_resource(self, resource_id: str) -> dict[str, Any]:
        """Get a resource.

        One resource of the tenant, archived or not, with its own weekly bookable hours and its
        visibility.
        """
        values: dict[str, Any] = {"resource_id": resource_id}
        return self.call("slotlock_get_resource", values)

    def delete_resource(self, resource_id: str) -> dict[str, Any]:
        """Delete a resource.

        Delete a resource with its history (past bookings, coverage, cancelled events), freeing
        its place under the tenant's resource limit. Refused with 409 resource_in_use while a
        booking on it has not ended, a hold on it is live, or a calendar event is on it: cancel or
        move those first. deleted is false when the tenant has no such resource, deleted already,
        say.
        """
        values: dict[str, Any] = {"resource_id": resource_id}
        return self.call("slotlock_delete_resource", values)

    def archive_resource(self, resource_id: str) -> dict[str, Any]:
        """Archive a resource.

        Take a resource out of use: no list shows it and it takes no new booking, hold or event
        (409 resource_archived), while what is on it stays and can still be cancelled or released.
        Archiving it again keeps the first time.
        """
        values: dict[str, Any] = {"resource_id": resource_id}
        return self.call("slotlock_archive_resource", values)

    def restore_resource(self, resource_id: str) -> dict[str, Any]:
        """Restore a resource.

        Put an archived resource back in use. Restoring one in use changes nothing.
        """
        values: dict[str, Any] = {"resource_id": resource_id}
        return self.call("slotlock_restore_resource", values)

    def list_busy(self, resource_id: str, *, start: str, end: str) -> dict[str, Any]:
        """List a resource's busy time.

        The time a resource of the tenant, private ones included, is occupied in a window of at
        most 367 days, by start: bookings with their turnaround, live holds, and calendar events.
        Adjacent intervals are not merged. More than 10,000 answers 400 calendar_work_limit:
        narrow the window. Free/busy with coverage, for the resources agents see, is
        slotlock_get_free_busy.
        """
        values: dict[str, Any] = {"resource_id": resource_id, "start": start, "end": end}
        return self.call("slotlock_list_busy", values)

    def set_resource_availability(
        self,
        resource_id: str,
        *,
        rules: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        """Set a resource's bookable hours.

        Give one resource its own weekly bookable hours. `null` makes it use the server's default;
        `[]` makes it never bookable. Each rule is weekly with BYDAY, in the resource's time zone:
        start_minutes after midnight, lasting duration_minutes.
        """
        values: dict[str, Any] = {"resource_id": resource_id, "rules": rules}
        return self.call("slotlock_set_resource_availability", values)

    def set_resource_booking_rules(
        self,
        resource_id: str,
        *,
        rules: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Set a resource's booking rules.

        Set what a booking on one resource must satisfy from now on: minimum notice, how far
        ahead, the step starts fall on (from local midnight in the resource's time zone), the
        turnaround kept free after each booking, and whether bookings must lie inside its hours.
        `null` clears them. Holds, reservations, moves and agents' events are refused with the
        rule they break; searches offer only what they allow.
        """
        values: dict[str, Any] = {"resource_id": resource_id, "rules": rules}
        return self.call("slotlock_set_resource_booking_rules", values)

    def set_resource_pool(self, resource_id: str, *, pool: str | None) -> dict[str, Any]:
        """Set a resource's pool.

        Make a resource a member of a pool, a class of interchangeable resources such as a vehicle
        class or a room type, or take it out (`null`). Agents book the class with
        slotlock_book_pool, which takes the first member free; the class's capacity is its number
        of members. A resource is in one pool at most; pool names are 1-100 of a-z, 0-9, '.', '_'
        and '-'.
        """
        values: dict[str, Any] = {"resource_id": resource_id, "pool": pool}
        return self.call("slotlock_set_resource_pool", values)

    def list_pools(self) -> dict[str, Any]:
        """List pools.

        The tenant's pools by name, each with its capacity: how many members it has that are not
        archived.
        """
        values: dict[str, Any] = {}
        return self.call("slotlock_list_pools", values)

    def get_resource_history(
        self,
        resource_id: str,
        *,
        limit: int | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """A resource's history.

        What happened on one of the tenant's resources, newest first: each hold, booking and event
        made, moved, confirmed, released or cancelled, when, by whom (the API key or agent), and
        for a change what it was before. Kept 30 days. Pass next_before as before for older
        entries.
        """
        values: dict[str, Any] = {"resource_id": resource_id}
        if limit is not None:
            values["limit"] = limit
        if before is not None:
            values["before"] = before
        return self.call("slotlock_get_resource_history", values)

    def get_reservation_history(
        self,
        reservation_ref: str,
        *,
        limit: int | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """A booking's history.

        What happened to one booking, by its reference, newest first: made, moved, cancelled, when
        and by whom, as slotlock_get_resource_history.
        """
        values: dict[str, Any] = {"reservation_ref": reservation_ref}
        if limit is not None:
            values["limit"] = limit
        if before is not None:
            values["before"] = before
        return self.call("slotlock_get_reservation_history", values)

    def get_tenant_event_history(
        self,
        event_id: str,
        *,
        limit: int | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """An event's history.

        What happened to one calendar event of the tenant, by its id, newest first: created,
        changed, cancelled, when and by whom, as slotlock_get_resource_history.
        """
        values: dict[str, Any] = {"event_id": event_id}
        if limit is not None:
            values["limit"] = limit
        if before is not None:
            values["before"] = before
        return self.call("slotlock_get_tenant_event_history", values)

    def set_tenant_availability(self, *, rules: list[dict[str, Any]] | None) -> dict[str, Any]:
        """Set every resource's bookable hours.

        Set the weekly bookable hours of every resource the tenant has, as
        slotlock_set_resource_availability does for one. `null` makes them all use the server's
        default. Returns how many resources changed.
        """
        values: dict[str, Any] = {"rules": rules}
        return self.call("slotlock_set_tenant_availability", values)

    def acquire_hold(
        self,
        *,
        resource_id: str,
        start: str,
        end: str,
        ttl_seconds: int,
        source: str | None = None,
        idempotency_key: str | None = None,
        buffer_after_minutes: int | None = None,
    ) -> dict[str, Any]:
        """Hold time.

        Occupy a window without booking it, for example while a customer pays. The hold blocks
        every other booking until it expires (the database clock, ttl_seconds from now), is
        confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and
        a confirmed hold keeps it. A taken window answers 409 overlap. With an idempotency key
        (the Idempotency-Key header or idempotency_key), a retry answers the hold the first
        request made, until that hold would have expired, is released or is confirmed; the same
        key with another request is 422 idempotency_conflict.

        Args:
            idempotency_key: A retry identity, also accepted as the Idempotency-Key header: the
            same key with the same request answers what the first did; with another request, 422
            idempotency_conflict.
        """
        values: dict[str, Any] = {
            "resource_id": resource_id,
            "start": start,
            "end": end,
            "ttl_seconds": ttl_seconds,
        }
        if source is not None:
            values["source"] = source
        if idempotency_key is not None:
            values["idempotency_key"] = idempotency_key
        if buffer_after_minutes is not None:
            values["buffer_after_minutes"] = buffer_after_minutes
        return self.call("slotlock_acquire_hold", values)

    def get_hold(self, hold_id: str) -> dict[str, Any]:
        """Get a hold.

        One of the tenant's live holds. An expired, confirmed, released or unknown one answers 404
        hold_not_found; a confirmed one is a reservation whose reference is the hold's id.
        """
        values: dict[str, Any] = {"hold_id": hold_id}
        return self.call("slotlock_get_hold", values)

    def release_hold(self, hold_id: str) -> dict[str, Any]:
        """Release a hold.

        Free a held window. released is false when the hold was already gone: expired, confirmed
        or released.
        """
        values: dict[str, Any] = {"hold_id": hold_id}
        return self.call("slotlock_release_hold", values)

    def list_holds(
        self,
        resource_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List a resource's holds.

        The live holds on one of the tenant's resources, by start then id, a page at a time: pass
        next_cursor as cursor for the next page, until it is null.
        """
        values: dict[str, Any] = {"resource_id": resource_id}
        if limit is not None:
            values["limit"] = limit
        if cursor is not None:
            values["cursor"] = cursor
        return self.call("slotlock_list_holds", values)

    def confirm_hold(self, hold_id: str) -> dict[str, Any]:
        """Confirm a hold.

        Turn an unexpired hold into a confirmed reservation, whose reference is the hold's id at
        revision 1: move or cancel it with the reservation routes by that reference (DELETE
        /v1/reservations/{hold_id}?revision=2 cancels it). Confirming it again answers the same
        reservation, so a retry is safe. An expired hold answers 409 hold_expired; a released or
        unknown one, 404 hold_not_found.
        """
        values: dict[str, Any] = {"hold_id": hold_id}
        return self.call("slotlock_confirm_hold", values)

    def get_reservation(self, reservation_ref: str) -> dict[str, Any]:
        """Get a reservation.

        The tenant's booking with this reference as it now is, at its current revision: move it at
        that revision plus 1. A cancelled or unknown reference, or a calendar event's time,
        answers 404 reservation_not_found.
        """
        values: dict[str, Any] = {"reservation_ref": reservation_ref}
        return self.call("slotlock_get_reservation", values)

    def put_reservation(
        self,
        reservation_ref: str,
        *,
        resource_id: str,
        start: str,
        end: str,
        revision: int,
        buffer_after_minutes: int | None = None,
        source: str | None = None,
    ) -> dict[str, Any]:
        """Book or move a reservation.

        Book the reservation with this reference (revision 1), or move it (the next revision: the
        current one plus 1). Sending the same reservation at its current revision again changes
        nothing (replayed: true). A taken window answers 409 overlap and leaves a moved
        reservation where it was. buffer_after_minutes keeps the time after it busy as well.
        """
        values: dict[str, Any] = {
            "reservation_ref": reservation_ref,
            "resource_id": resource_id,
            "start": start,
            "end": end,
            "revision": revision,
        }
        if buffer_after_minutes is not None:
            values["buffer_after_minutes"] = buffer_after_minutes
        if source is not None:
            values["source"] = source
        return self.call("slotlock_put_reservation", values)

    def cancel_reservation(self, reservation_ref: str, *, revision: int) -> dict[str, Any]:
        """Cancel a reservation.

        Cancel the reservation with this reference at the next revision (the current one plus 1).
        Cancelling leaves a tombstone, so a delayed booking cannot bring it back; repeating the
        cancel answers cancelled: false. Use a new reference for a new reservation.
        """
        values: dict[str, Any] = {"reservation_ref": reservation_ref, "revision": revision}
        return self.call("slotlock_cancel_reservation", values)

    def list_reservations(
        self,
        resource_id: str,
        *,
        start: str,
        end: str,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List a resource's reservations.

        The tenant's bookings on one resource whose time, turnaround included, meets a window of
        at most 367 days, by start then id, a page at a time: pass next_cursor as cursor for the
        next page, until it is null. Calendar events are not bookings; slotlock_list_tenant_events
        lists them.
        """
        values: dict[str, Any] = {"resource_id": resource_id, "start": start, "end": end}
        if limit is not None:
            values["limit"] = limit
        if cursor is not None:
            values["cursor"] = cursor
        return self.call("slotlock_list_reservations", values)

    def record_coverage(
        self,
        resource_id: str,
        source: str,
        *,
        start: str,
        end: str,
        revision: int,
    ) -> dict[str, Any]:
        """Record calendar coverage.

        Record that the events of an external calendar (source) are complete for a window of a
        resource, at that source's revision. Free/busy calls time unproven, not free, until every
        source a resource requires covers it. Revisions only go forward; repeating one changes
        nothing.
        """
        values: dict[str, Any] = {
            "resource_id": resource_id,
            "source": source,
            "start": start,
            "end": end,
            "revision": revision,
        }
        return self.call("slotlock_record_coverage", values)

    def get_coverage(self, resource_id: str) -> dict[str, Any]:
        """A resource's coverage and its health.

        Each external calendar (source) that records coverage of a resource: the window it covers,
        when it was last read, its last error, and whether it is stale (not read for a day, so the
        time it covers is unproven, not free). A source that goes stale is also put on the change
        feed once, as coverage.stale, until it is read again.
        """
        values: dict[str, Any] = {"resource_id": resource_id}
        return self.call("slotlock_get_coverage", values)

    def record_coverage_failure(
        self,
        resource_id: str,
        source: str,
        *,
        error: str,
    ) -> dict[str, Any]:
        """Record a failed read of a source.

        Record that reading an external calendar failed (it answered 500, a token expired): kept
        as the source's last error, shown by slotlock_get_coverage, while its coverage stays as it
        was. 404 coverage_not_found for a source that has never recorded coverage of the resource.
        """
        values: dict[str, Any] = {"resource_id": resource_id, "source": source, "error": error}
        return self.call("slotlock_record_coverage_failure", values)

    def list_tenant_events(
        self,
        *,
        resource_id: str,
        start: str,
        end: str,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List a resource's events, every key's.

        The calendar events on one of the tenant's resources with an occurrence in a window of at
        most 367 days, whichever key wrote them (a revoked one's included), by start then id, a
        page at a time: pass next_cursor as cursor for the next page, until it is null.
        """
        values: dict[str, Any] = {"resource_id": resource_id, "start": start, "end": end}
        if limit is not None:
            values["limit"] = limit
        if cursor is not None:
            values["cursor"] = cursor
        return self.call("slotlock_list_tenant_events", values)

    def get_tenant_event(self, event_id: str) -> dict[str, Any]:
        """Get any event of the tenant.

        One of the tenant's events by its id (the id slotlock_list_tenant_events gives), whichever
        key wrote it. A cancelled or unknown one answers 404 event_not_found.
        """
        values: dict[str, Any] = {"event_id": event_id}
        return self.call("slotlock_get_tenant_event", values)

    def cancel_tenant_event(
        self,
        event_id: str,
        *,
        expected_revision: int,
        idempotency_key: str,
        expected_resource_id: str | None = None,
    ) -> dict[str, Any]:
        """Cancel any event of the tenant.

        Cancel one of the tenant's events by its id, whichever key wrote it (a revoked key's
        included, without charging its quota), at the revision you last read (expected_revision).
        Its owner cannot create it again. With expected_resource_id, an event since moved to
        another resource answers 404 event_not_found. Needs an idempotency key (the
        Idempotency-Key header or idempotency_key): a retry with it answers the first cancellation
        (replayed: true).

        Args:
            idempotency_key: A retry identity, also accepted as the Idempotency-Key header: the
            same key with the same request answers what the first did; with another request, 422
            idempotency_conflict.
        """
        values: dict[str, Any] = {
            "event_id": event_id,
            "expected_revision": expected_revision,
            "idempotency_key": idempotency_key,
        }
        if expected_resource_id is not None:
            values["expected_resource_id"] = expected_resource_id
        return self.call("slotlock_cancel_tenant_event", values)

    def get_tenant(self) -> dict[str, Any]:
        """Get the tenant.

        The key's tenant: its reference, and whether it is suspended. A suspended tenant may read
        and writes nothing (403 tenant_suspended); only the server's operator suspends a tenant or
        lifts a suspension (slotlock tenant suspend).
        """
        values: dict[str, Any] = {}
        return self.call("slotlock_get_tenant", values)

    def erase_tenant(self, *, confirm_tenant_ref: str) -> dict[str, Any]:
        """Erase the tenant.

        Delete everything the key's tenant has, at once and for good: resources, holds, bookings,
        events, coverage and every API key, this one included. confirm_tenant_ref must be the
        tenant's reference (slotlock_get_tenant), or it answers 400 invalid_confirmation. Off
        unless the server allows it (403 tenant_erasure_disabled; slotlock serve does not: its
        operator runs slotlock tenant erase). A suspended tenant cannot erase itself (403
        tenant_suspended). Erasing again deletes nothing.
        """
        values: dict[str, Any] = {"confirm_tenant_ref": confirm_tenant_ref}
        return self.call("slotlock_erase_tenant", values)

    def run_maintenance(self) -> dict[str, Any]:
        """Run maintenance.

        Extend recurring events to the rolling horizon and prune what the retention window no
        longer needs, for the caller's tenant. Run it at least daily (slotlock serve does). capped
        is true when there was more than one call does: call again.
        """
        values: dict[str, Any] = {}
        return self.call("slotlock_run_maintenance", values)

    def list_changes(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """List changes.

        What changed in the tenant, oldest first, as CloudEvents: holds made, confirmed, released
        or expired; bookings made, moved or cancelled; calendar events created, changed or
        cancelled (ids, times and states, never titles or attendees). Pass next_cursor as cursor
        to read on; it is returned even when nothing is new, so poll with it. Only changes of
        transactions that have ended are listed, so following the cursor never skips one. Changes
        are kept 30 days: an older cursor answers 410 cursor_expired, so start again without one.
        """
        values: dict[str, Any] = {}
        if cursor is not None:
            values["cursor"] = cursor
        if limit is not None:
            values["limit"] = limit
        return self.call("slotlock_list_changes", values)

    def list_webhooks(self) -> dict[str, Any]:
        """List webhooks.

        The tenant's webhooks with how delivery is going: failed attempts, the last status, and
        whether and why one is disabled.
        """
        values: dict[str, Any] = {}
        return self.call("slotlock_list_webhooks", values)

    def create_webhook(self, *, url: str, event_types: list[str] | None = None) -> dict[str, Any]:
        """Add a webhook.

        Send the changes slotlock_list_changes lists from now on to an https URL, each as a
        CloudEvent signed as Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature),
        in order, until a 2xx. A failure is retried with backoff; after 24 hours of failures, or a
        410, the webhook is disabled and the feed records webhook.disabled. The secret is returned
        here only. At most 10 per tenant.
        """
        values: dict[str, Any] = {"url": url}
        if event_types is not None:
            values["event_types"] = event_types
        return self.call("slotlock_create_webhook", values)

    def delete_webhook(self, webhook_id: str) -> dict[str, Any]:
        """Delete a webhook.

        Stop sending to a webhook. deleted is false when the tenant has no such webhook.
        """
        values: dict[str, Any] = {"webhook_id": webhook_id}
        return self.call("slotlock_delete_webhook", values)

    def enable_webhook(self, webhook_id: str) -> dict[str, Any]:
        """Enable a webhook.

        Send to a disabled webhook again, from the first change it did not accept. 404
        webhook_not_found when the tenant has no such webhook; 409 changes_pruned when what it
        missed is older than the 30 days the feed keeps, since it would skip those unseen: delete
        it, add it again, and read what it missed from slotlock_list_changes.
        """
        values: dict[str, Any] = {"webhook_id": webhook_id}
        return self.call("slotlock_enable_webhook", values)
