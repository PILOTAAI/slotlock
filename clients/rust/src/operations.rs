// Generated from openapi.json by clients/generate.ts. Do not edit: change the server, then run
// SLOTLOCK_WRITE_GENERATED=1 npx vitest run src/__tests__/generated.test.ts

use serde::Serialize;
use serde_json::Value;

use crate::{Client, Error, Operation};

/// Every operation: its name, method, path, path parameters and query parameters.
pub(crate) const OPERATIONS: &[Operation] = &[
    Operation {
        name: "slotlock_list_resources",
        method: "GET",
        path: "/v1/resources",
        path_params: &[],
        query: &["cursor", "limit"],
    },
    Operation {
        name: "slotlock_create_resource",
        method: "POST",
        path: "/v1/resources",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_get_free_busy",
        method: "GET",
        path: "/v1/free-busy",
        path_params: &[],
        query: &["resource_ids", "start", "end"],
    },
    Operation {
        name: "slotlock_find_next_available",
        method: "GET",
        path: "/v1/next-available",
        path_params: &[],
        query: &["resource_ids", "start", "end", "duration_minutes"],
    },
    Operation {
        name: "slotlock_list_events",
        method: "GET",
        path: "/v1/events",
        path_params: &[],
        query: &["resource_ids", "start", "end", "cursor", "limit"],
    },
    Operation {
        name: "slotlock_create_event",
        method: "POST",
        path: "/v1/events",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_get_event",
        method: "GET",
        path: "/v1/events/{event_id}",
        path_params: &["event_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_update_event",
        method: "PATCH",
        path: "/v1/events/{event_id}",
        path_params: &["event_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_event",
        method: "DELETE",
        path: "/v1/events/{event_id}",
        path_params: &["event_id"],
        query: &["expected_revision", "idempotency_key"],
    },
    Operation {
        name: "slotlock_get_resource",
        method: "GET",
        path: "/v1/resources/{resource_id}",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_set_resource_availability",
        method: "PUT",
        path: "/v1/resources/{resource_id}/availability",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_set_tenant_availability",
        method: "PUT",
        path: "/v1/availability",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_acquire_hold",
        method: "POST",
        path: "/v1/holds",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_confirm_hold",
        method: "POST",
        path: "/v1/holds/{hold_id}/confirm",
        path_params: &["hold_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_release_hold",
        method: "DELETE",
        path: "/v1/holds/{hold_id}",
        path_params: &["hold_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_put_reservation",
        method: "PUT",
        path: "/v1/reservations/{reservation_ref}",
        path_params: &["reservation_ref"],
        query: &[],
    },
    Operation {
        name: "slotlock_cancel_reservation",
        method: "DELETE",
        path: "/v1/reservations/{reservation_ref}",
        path_params: &["reservation_ref"],
        query: &["revision"],
    },
    Operation {
        name: "slotlock_record_coverage",
        method: "PUT",
        path: "/v1/resources/{resource_id}/coverage/{source}",
        path_params: &["resource_id", "source"],
        query: &[],
    },
    Operation {
        name: "slotlock_run_maintenance",
        method: "POST",
        path: "/v1/maintenance",
        path_params: &[],
        query: &[],
    },
];

/// The arguments of [`Client::list_resources`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListResourcesInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

/// The arguments of [`Client::create_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CreateResourceInput {
    pub external_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

/// The arguments of [`Client::get_free_busy`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetFreeBusyInput {
    pub resource_ids: Vec<String>,
    pub start: String,
    pub end: String,
}

/// The arguments of [`Client::find_next_available`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct FindNextAvailableInput {
    pub resource_ids: Vec<String>,
    pub start: String,
    pub end: String,
    pub duration_minutes: i64,
}

/// The arguments of [`Client::list_events`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListEventsInput {
    pub resource_ids: Vec<String>,
    pub start: String,
    pub end: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

/// The arguments of [`Client::create_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CreateEventInput {
    pub resource_id: String,
    pub starts_at: String,
    pub ends_at: String,
    pub timezone: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organizer: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transparency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attendees: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminders: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_exceptions: Option<Vec<Value>>,
}

/// The arguments of [`Client::get_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetEventInput {
    pub event_id: String,
}

/// The arguments of [`Client::update_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateEventInput {
    pub event_id: String,
    pub expected_revision: i64,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starts_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organizer: Option<Option<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attendees: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminders: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transparency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_rule: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_exceptions: Option<Vec<Value>>,
}

/// The arguments of [`Client::delete_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteEventInput {
    pub event_id: String,
    pub expected_revision: i64,
    pub idempotency_key: String,
}

/// The arguments of [`Client::get_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetResourceInput {
    pub resource_id: String,
}

/// The arguments of [`Client::set_resource_availability`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetResourceAvailabilityInput {
    pub resource_id: String,
    pub rules: Option<Vec<Value>>,
}

/// The arguments of [`Client::set_tenant_availability`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetTenantAvailabilityInput {
    pub rules: Option<Vec<Value>>,
}

/// The arguments of [`Client::acquire_hold`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct AcquireHoldInput {
    pub resource_id: String,
    pub start: String,
    pub end: String,
    pub ttl_seconds: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The arguments of [`Client::confirm_hold`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ConfirmHoldInput {
    pub hold_id: String,
}

/// The arguments of [`Client::release_hold`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ReleaseHoldInput {
    pub hold_id: String,
}

/// The arguments of [`Client::put_reservation`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PutReservationInput {
    pub reservation_ref: String,
    pub resource_id: String,
    pub start: String,
    pub end: String,
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer_after_minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The arguments of [`Client::cancel_reservation`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CancelReservationInput {
    pub reservation_ref: String,
    pub revision: i64,
}

/// The arguments of [`Client::record_coverage`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RecordCoverageInput {
    pub resource_id: String,
    pub source: String,
    pub start: String,
    pub end: String,
    pub revision: i64,
}

/// The arguments of [`Client::run_maintenance`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RunMaintenanceInput {
}

impl Client {
    /// List calendar resources.
    ///
    /// List resources visible to the authenticated tenant principal.
    pub fn list_resources(&self, input: &ListResourcesInput) -> Result<Value, Error> {
        self.call("slotlock_list_resources", serde_json::to_value(input)?)
    }

    /// Create or update a resource.
    ///
    /// Create the resource with this external reference, or update its time zone if the tenant
    /// already has it. Repeating the call changes nothing more.
    pub fn create_resource(&self, input: &CreateResourceInput) -> Result<Value, Error> {
        self.call("slotlock_create_resource", serde_json::to_value(input)?)
    }

    /// Get free-busy.
    ///
    /// Return privacy-minimized busy intervals and explicit coverage certainty.
    pub fn get_free_busy(&self, input: &GetFreeBusyInput) -> Result<Value, Error> {
        self.call("slotlock_get_free_busy", serde_json::to_value(input)?)
    }

    /// Find next available interval.
    ///
    /// Find the earliest certain interval that satisfies the requested duration (up to the
    /// 367-day search window, so a multi-month rental slot can be found).
    pub fn find_next_available(&self, input: &FindNextAvailableInput) -> Result<Value, Error> {
        self.call("slotlock_find_next_available", serde_json::to_value(input)?)
    }

    /// List resource events.
    ///
    /// List bounded events intersecting a time window.
    pub fn list_events(&self, input: &ListEventsInput) -> Result<Value, Error> {
        self.call("slotlock_list_events", serde_json::to_value(input)?)
    }

    /// Create resource event.
    ///
    /// Create an event of up to 3,660 days (a booking, lease or long rental); opaque occurrences
    /// use the database overlap arbiter.
    pub fn create_event(&self, input: &CreateEventInput) -> Result<Value, Error> {
        self.call("slotlock_create_event", serde_json::to_value(input)?)
    }

    /// Get resource event.
    ///
    /// Read one tenant-scoped event by stable identifier.
    pub fn get_event(&self, input: &GetEventInput) -> Result<Value, Error> {
        self.call("slotlock_get_event", serde_json::to_value(input)?)
    }

    /// Update resource event.
    ///
    /// Apply an expected-revision event patch and rematerialize occupancy atomically.
    pub fn update_event(&self, input: &UpdateEventInput) -> Result<Value, Error> {
        self.call("slotlock_update_event", serde_json::to_value(input)?)
    }

    /// Delete resource event.
    ///
    /// Tombstone an event at an expected revision so stale sync cannot resurrect it.
    pub fn delete_event(&self, input: &DeleteEventInput) -> Result<Value, Error> {
        self.call("slotlock_delete_event", serde_json::to_value(input)?)
    }

    /// Get a resource.
    ///
    /// One resource of the tenant, with its own weekly bookable hours.
    pub fn get_resource(&self, input: &GetResourceInput) -> Result<Value, Error> {
        self.call("slotlock_get_resource", serde_json::to_value(input)?)
    }

    /// Set a resource's bookable hours.
    ///
    /// Give one resource its own weekly bookable hours. `null` makes it use the server's default;
    /// `[]` makes it never bookable. Each rule is weekly with BYDAY, in the resource's time zone:
    /// start_minutes after midnight, lasting duration_minutes.
    pub fn set_resource_availability(&self, input: &SetResourceAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_set_resource_availability", serde_json::to_value(input)?)
    }

    /// Set every resource's bookable hours.
    ///
    /// Set the weekly bookable hours of every resource the tenant has, as
    /// slotlock_set_resource_availability does for one. `null` makes them all use the server's
    /// default. Returns how many resources changed.
    pub fn set_tenant_availability(&self, input: &SetTenantAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_set_tenant_availability", serde_json::to_value(input)?)
    }

    /// Hold time.
    ///
    /// Occupy a window without booking it, for example while a customer pays. The hold blocks
    /// every other booking until it expires (the database clock, ttl_seconds from now), is
    /// confirmed, or is released. A taken window answers 409 overlap.
    pub fn acquire_hold(&self, input: &AcquireHoldInput) -> Result<Value, Error> {
        self.call("slotlock_acquire_hold", serde_json::to_value(input)?)
    }

    /// Confirm a hold.
    ///
    /// Turn an unexpired hold into a confirmed reservation. Confirming it again answers the same
    /// reservation, so a retry is safe. An expired hold answers 409 hold_expired; a released or
    /// unknown one, 404 hold_not_found.
    pub fn confirm_hold(&self, input: &ConfirmHoldInput) -> Result<Value, Error> {
        self.call("slotlock_confirm_hold", serde_json::to_value(input)?)
    }

    /// Release a hold.
    ///
    /// Free a held window. released is false when the hold was already gone: expired, confirmed
    /// or released.
    pub fn release_hold(&self, input: &ReleaseHoldInput) -> Result<Value, Error> {
        self.call("slotlock_release_hold", serde_json::to_value(input)?)
    }

    /// Book or move a reservation.
    ///
    /// Book the reservation with this reference (revision 1), or move it (the next revision: the
    /// current one plus 1). Sending the same reservation at its current revision again changes
    /// nothing (replayed: true). A taken window answers 409 overlap and leaves a moved
    /// reservation where it was. buffer_after_minutes keeps the time after it busy as well.
    pub fn put_reservation(&self, input: &PutReservationInput) -> Result<Value, Error> {
        self.call("slotlock_put_reservation", serde_json::to_value(input)?)
    }

    /// Cancel a reservation.
    ///
    /// Cancel the reservation with this reference at the next revision (the current one plus 1).
    /// Cancelling leaves a tombstone, so a delayed booking cannot bring it back; repeating the
    /// cancel answers cancelled: false. Use a new reference for a new reservation.
    pub fn cancel_reservation(&self, input: &CancelReservationInput) -> Result<Value, Error> {
        self.call("slotlock_cancel_reservation", serde_json::to_value(input)?)
    }

    /// Record calendar coverage.
    ///
    /// Record that the events of an external calendar (source) are complete for a window of a
    /// resource, at that source's revision. Free/busy calls time unproven, not free, until every
    /// source a resource requires covers it. Revisions only go forward; repeating one changes
    /// nothing.
    pub fn record_coverage(&self, input: &RecordCoverageInput) -> Result<Value, Error> {
        self.call("slotlock_record_coverage", serde_json::to_value(input)?)
    }

    /// Run maintenance.
    ///
    /// Extend recurring events to the rolling horizon and prune what the retention window no
    /// longer needs, for the caller's tenant. Run it at least daily (slotlock serve does). capped
    /// is true when there was more than one call does: call again.
    pub fn run_maintenance(&self, input: &RunMaintenanceInput) -> Result<Value, Error> {
        self.call("slotlock_run_maintenance", serde_json::to_value(input)?)
    }

}
