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
        ("cursor", "limit"),
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
    "slotlock_set_resource_availability": Operation(
        "slotlock_set_resource_availability",
        "PUT",
        "/v1/resources/{resource_id}/availability",
        ("resource_id",),
        (),
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
    "slotlock_confirm_hold": Operation(
        "slotlock_confirm_hold",
        "POST",
        "/v1/holds/{hold_id}/confirm",
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
    "slotlock_record_coverage": Operation(
        "slotlock_record_coverage",
        "PUT",
        "/v1/resources/{resource_id}/coverage/{source}",
        ("resource_id", "source"),
        (),
    ),
    "slotlock_run_maintenance": Operation(
        "slotlock_run_maintenance",
        "POST",
        "/v1/maintenance",
        (),
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
    ) -> dict[str, Any]:
        """List calendar resources.

        List resources visible to the authenticated tenant principal.
        """
        values: dict[str, Any] = {}
        if cursor is not None:
            values["cursor"] = cursor
        if limit is not None:
            values["limit"] = limit
        return self.call("slotlock_list_resources", values)

    def create_resource(self, *, external_ref: str, timezone: str | None = None) -> dict[str, Any]:
        """Create or update a resource.

        Create the resource with this external reference, or update its time zone if the tenant
        already has it. Repeating the call changes nothing more.
        """
        values: dict[str, Any] = {"external_ref": external_ref}
        if timezone is not None:
            values["timezone"] = timezone
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
    ) -> dict[str, Any]:
        """Update resource event.

        Apply an expected-revision event patch and rematerialize occupancy atomically.
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

        One resource of the tenant, with its own weekly bookable hours.
        """
        values: dict[str, Any] = {"resource_id": resource_id}
        return self.call("slotlock_get_resource", values)

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
    ) -> dict[str, Any]:
        """Hold time.

        Occupy a window without booking it, for example while a customer pays. The hold blocks
        every other booking until it expires (the database clock, ttl_seconds from now), is
        confirmed, or is released. A taken window answers 409 overlap.
        """
        values: dict[str, Any] = {
            "resource_id": resource_id,
            "start": start,
            "end": end,
            "ttl_seconds": ttl_seconds,
        }
        if source is not None:
            values["source"] = source
        return self.call("slotlock_acquire_hold", values)

    def confirm_hold(self, hold_id: str) -> dict[str, Any]:
        """Confirm a hold.

        Turn an unexpired hold into a confirmed reservation. Confirming it again answers the same
        reservation, so a retry is safe. An expired hold answers 409 hold_expired; a released or
        unknown one, 404 hold_not_found.
        """
        values: dict[str, Any] = {"hold_id": hold_id}
        return self.call("slotlock_confirm_hold", values)

    def release_hold(self, hold_id: str) -> dict[str, Any]:
        """Release a hold.

        Free a held window. released is false when the hold was already gone: expired, confirmed
        or released.
        """
        values: dict[str, Any] = {"hold_id": hold_id}
        return self.call("slotlock_release_hold", values)

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

    def run_maintenance(self) -> dict[str, Any]:
        """Run maintenance.

        Extend recurring events to the rolling horizon and prune what the retention window no
        longer needs, for the caller's tenant. Run it at least daily (slotlock serve does). capped
        is true when there was more than one call does: call again.
        """
        values: dict[str, Any] = {}
        return self.call("slotlock_run_maintenance", values)
