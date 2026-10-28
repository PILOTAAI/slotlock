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
        query: &["cursor", "limit", "pool"],
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
        name: "slotlock_find_available_slots",
        method: "GET",
        path: "/v1/available-slots",
        path_params: &[],
        query: &["resource_ids", "start", "end", "duration_minutes", "limit", "require_free"],
    },
    Operation {
        name: "slotlock_hold_slots",
        method: "POST",
        path: "/v1/slot-holds",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_book_together",
        method: "POST",
        path: "/v1/bundles",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_book_pool",
        method: "POST",
        path: "/v1/pool-bookings",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_release_slots",
        method: "DELETE",
        path: "/v1/slot-holds/{hold_id}",
        path_params: &["hold_id"],
        query: &[],
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
        name: "slotlock_delete_resource",
        method: "DELETE",
        path: "/v1/resources/{resource_id}",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_archive_resource",
        method: "POST",
        path: "/v1/resources/{resource_id}/archive",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_restore_resource",
        method: "POST",
        path: "/v1/resources/{resource_id}/restore",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_list_busy",
        method: "GET",
        path: "/v1/resources/{resource_id}/busy",
        path_params: &["resource_id"],
        query: &["start", "end"],
    },
    Operation {
        name: "slotlock_set_resource_availability",
        method: "PUT",
        path: "/v1/resources/{resource_id}/availability",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_export_resource_availability",
        method: "GET",
        path: "/v1/resources/{resource_id}/availability/ical",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_import_resource_availability",
        method: "PUT",
        path: "/v1/resources/{resource_id}/availability/ical",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_set_resource_booking_rules",
        method: "PUT",
        path: "/v1/resources/{resource_id}/booking-rules",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_set_resource_pool",
        method: "PUT",
        path: "/v1/resources/{resource_id}/pool",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_list_pools",
        method: "GET",
        path: "/v1/pools",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_get_resource_history",
        method: "GET",
        path: "/v1/resources/{resource_id}/history",
        path_params: &["resource_id"],
        query: &["limit", "before"],
    },
    Operation {
        name: "slotlock_get_reservation_history",
        method: "GET",
        path: "/v1/reservations/{reservation_ref}/history",
        path_params: &["reservation_ref"],
        query: &["limit", "before"],
    },
    Operation {
        name: "slotlock_get_tenant_event_history",
        method: "GET",
        path: "/v1/tenant/events/{event_id}/history",
        path_params: &["event_id"],
        query: &["limit", "before"],
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
        name: "slotlock_get_hold",
        method: "GET",
        path: "/v1/holds/{hold_id}",
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
        name: "slotlock_list_holds",
        method: "GET",
        path: "/v1/resources/{resource_id}/holds",
        path_params: &["resource_id"],
        query: &["limit", "cursor"],
    },
    Operation {
        name: "slotlock_confirm_hold",
        method: "POST",
        path: "/v1/holds/{hold_id}/confirm",
        path_params: &["hold_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_get_reservation",
        method: "GET",
        path: "/v1/reservations/{reservation_ref}",
        path_params: &["reservation_ref"],
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
        name: "slotlock_list_reservations",
        method: "GET",
        path: "/v1/resources/{resource_id}/reservations",
        path_params: &["resource_id"],
        query: &["start", "end", "limit", "cursor"],
    },
    Operation {
        name: "slotlock_check_in_reservation",
        method: "POST",
        path: "/v1/reservations/{reservation_ref}/check-in",
        path_params: &["reservation_ref"],
        query: &[],
    },
    Operation {
        name: "slotlock_list_waitlist",
        method: "GET",
        path: "/v1/waitlist",
        path_params: &[],
        query: &["resource_id", "pool", "holder_ref", "limit"],
    },
    Operation {
        name: "slotlock_join_waitlist",
        method: "POST",
        path: "/v1/waitlist",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_leave_waitlist",
        method: "DELETE",
        path: "/v1/waitlist/{entry_id}",
        path_params: &["entry_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_record_coverage",
        method: "PUT",
        path: "/v1/resources/{resource_id}/coverage/{source}",
        path_params: &["resource_id", "source"],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_coverage",
        method: "DELETE",
        path: "/v1/resources/{resource_id}/coverage/{source}",
        path_params: &["resource_id", "source"],
        query: &[],
    },
    Operation {
        name: "slotlock_get_coverage",
        method: "GET",
        path: "/v1/resources/{resource_id}/coverage",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_record_coverage_failure",
        method: "POST",
        path: "/v1/resources/{resource_id}/coverage/{source}/failure",
        path_params: &["resource_id", "source"],
        query: &[],
    },
    Operation {
        name: "slotlock_list_tenant_events",
        method: "GET",
        path: "/v1/tenant/events",
        path_params: &[],
        query: &["resource_id", "start", "end", "limit", "cursor"],
    },
    Operation {
        name: "slotlock_get_tenant_event",
        method: "GET",
        path: "/v1/tenant/events/{event_id}",
        path_params: &["event_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_cancel_tenant_event",
        method: "DELETE",
        path: "/v1/tenant/events/{event_id}",
        path_params: &["event_id"],
        query: &["expected_revision", "expected_resource_id", "idempotency_key"],
    },
    Operation {
        name: "slotlock_export_tenant_event",
        method: "GET",
        path: "/v1/tenant/events/{event_id}/jscalendar",
        path_params: &["event_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_get_tenant",
        method: "GET",
        path: "/v1/tenant",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_erase_tenant",
        method: "POST",
        path: "/v1/tenant/erase",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_run_maintenance",
        method: "POST",
        path: "/v1/maintenance",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_list_changes",
        method: "GET",
        path: "/v1/changes",
        path_params: &[],
        query: &["cursor", "limit"],
    },
    Operation {
        name: "slotlock_list_webhooks",
        method: "GET",
        path: "/v1/webhooks",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_create_webhook",
        method: "POST",
        path: "/v1/webhooks",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_webhook",
        method: "DELETE",
        path: "/v1/webhooks/{webhook_id}",
        path_params: &["webhook_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_enable_webhook",
        method: "POST",
        path: "/v1/webhooks/{webhook_id}/enable",
        path_params: &["webhook_id"],
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
}

/// The arguments of [`Client::create_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CreateResourceInput {
    pub external_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
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

/// The arguments of [`Client::find_available_slots`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct FindAvailableSlotsInput {
    pub resource_ids: Vec<String>,
    pub start: String,
    pub end: String,
    pub duration_minutes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_free: Option<i64>,
}

/// The arguments of [`Client::hold_slots`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct HoldSlotsInput {
    pub slots: Vec<Value>,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<i64>,
}

/// The arguments of [`Client::book_together`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct BookTogetherInput {
    pub resource_ids: Vec<String>,
    pub starts_at: String,
    pub ends_at: String,
    pub timezone: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// The arguments of [`Client::book_pool`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct BookPoolInput {
    pub pool: String,
    pub starts_at: String,
    pub ends_at: String,
    pub timezone: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// The arguments of [`Client::release_slots`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ReleaseSlotsInput {
    pub hold_id: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold_id: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_resource_id: Option<String>,
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

/// The arguments of [`Client::delete_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteResourceInput {
    pub resource_id: String,
}

/// The arguments of [`Client::archive_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ArchiveResourceInput {
    pub resource_id: String,
}

/// The arguments of [`Client::restore_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RestoreResourceInput {
    pub resource_id: String,
}

/// The arguments of [`Client::list_busy`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListBusyInput {
    pub resource_id: String,
    pub start: String,
    pub end: String,
}

/// The arguments of [`Client::set_resource_availability`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetResourceAvailabilityInput {
    pub resource_id: String,
    pub rules: Option<Vec<Value>>,
}

/// The arguments of [`Client::export_resource_availability`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ExportResourceAvailabilityInput {
    pub resource_id: String,
}

/// The arguments of [`Client::import_resource_availability`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportResourceAvailabilityInput {
    pub resource_id: String,
    pub icalendar: String,
}

/// The arguments of [`Client::set_resource_booking_rules`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetResourceBookingRulesInput {
    pub resource_id: String,
    pub rules: Option<Value>,
}

/// The arguments of [`Client::set_resource_pool`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetResourcePoolInput {
    pub resource_id: String,
    pub pool: Option<String>,
}

/// The arguments of [`Client::list_pools`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListPoolsInput {
}

/// The arguments of [`Client::get_resource_history`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetResourceHistoryInput {
    pub resource_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

/// The arguments of [`Client::get_reservation_history`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetReservationHistoryInput {
    pub reservation_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

/// The arguments of [`Client::get_tenant_event_history`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetTenantEventHistoryInput {
    pub event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
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
    /// A retry identity, also accepted as the Idempotency-Key header: the same key with the same
    /// request answers what the first did; with another request, 422 idempotency_conflict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer_after_minutes: Option<i64>,
}

/// The arguments of [`Client::get_hold`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetHoldInput {
    pub hold_id: String,
}

/// The arguments of [`Client::release_hold`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ReleaseHoldInput {
    pub hold_id: String,
}

/// The arguments of [`Client::list_holds`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListHoldsInput {
    pub resource_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// The arguments of [`Client::confirm_hold`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ConfirmHoldInput {
    pub hold_id: String,
}

/// The arguments of [`Client::get_reservation`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetReservationInput {
    pub reservation_ref: String,
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

/// The arguments of [`Client::list_reservations`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListReservationsInput {
    pub resource_id: String,
    pub start: String,
    pub end: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// The arguments of [`Client::check_in_reservation`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CheckInReservationInput {
    pub reservation_ref: String,
}

/// The arguments of [`Client::list_waitlist`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListWaitlistInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

/// The arguments of [`Client::join_waitlist`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct JoinWaitlistInput {
    pub start: String,
    pub end: String,
    pub holder_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offer_ttl_seconds: Option<i64>,
}

/// The arguments of [`Client::leave_waitlist`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct LeaveWaitlistInput {
    pub entry_id: String,
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

/// The arguments of [`Client::delete_coverage`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteCoverageInput {
    pub resource_id: String,
    pub source: String,
}

/// The arguments of [`Client::get_coverage`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetCoverageInput {
    pub resource_id: String,
}

/// The arguments of [`Client::record_coverage_failure`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RecordCoverageFailureInput {
    pub resource_id: String,
    pub source: String,
    pub error: String,
}

/// The arguments of [`Client::list_tenant_events`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListTenantEventsInput {
    pub resource_id: String,
    pub start: String,
    pub end: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// The arguments of [`Client::get_tenant_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetTenantEventInput {
    pub event_id: String,
}

/// The arguments of [`Client::cancel_tenant_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CancelTenantEventInput {
    pub event_id: String,
    pub expected_revision: i64,
    /// A retry identity, also accepted as the Idempotency-Key header: the same key with the same
    /// request answers what the first did; with another request, 422 idempotency_conflict.
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_resource_id: Option<String>,
}

/// The arguments of [`Client::export_tenant_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ExportTenantEventInput {
    pub event_id: String,
}

/// The arguments of [`Client::get_tenant`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetTenantInput {
}

/// The arguments of [`Client::erase_tenant`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct EraseTenantInput {
    pub confirm_tenant_ref: String,
}

/// The arguments of [`Client::run_maintenance`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RunMaintenanceInput {
}

/// The arguments of [`Client::list_changes`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListChangesInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

/// The arguments of [`Client::list_webhooks`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListWebhooksInput {
}

/// The arguments of [`Client::create_webhook`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CreateWebhookInput {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_types: Option<Vec<String>>,
}

/// The arguments of [`Client::delete_webhook`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteWebhookInput {
    pub webhook_id: String,
}

/// The arguments of [`Client::enable_webhook`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct EnableWebhookInput {
    pub webhook_id: String,
}

impl Client {
    /// List calendar resources.
    ///
    /// List resources visible to the authenticated tenant principal, with the pool each belongs
    /// to (a vehicle class, a room type). With pool, only that pool's members, in the order
    /// slotlock_book_pool tries them.
    pub fn list_resources(&self, input: &ListResourcesInput) -> Result<Value, Error> {
        self.call("slotlock_list_resources", serde_json::to_value(input)?)
    }

    /// Create or update a resource.
    ///
    /// Create the resource with this external reference, or update its time zone if the tenant
    /// already has it. Repeating the call changes nothing more. visibility is shared (the
    /// default: agents list and book it) or private (agents never see it), fixed at creation:
    /// naming another for an existing resource answers 409 resource_visibility_conflict.
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

    /// Find available slots.
    ///
    /// List up to `limit` certain slots of the requested duration, earliest first across the
    /// resources, each one free of busy time and inside the resource's hours, to offer a person a
    /// choice. With require_free, only times when at least that many of the resources are free
    /// together, each slot naming them in resource_ids: every resource for a booking that needs
    /// them all (book it with slotlock_book_together), or any n of them. No slot is listed unless
    /// every resource's coverage is certain.
    pub fn find_available_slots(&self, input: &FindAvailableSlotsInput) -> Result<Value, Error> {
        self.call("slotlock_find_available_slots", serde_json::to_value(input)?)
    }

    /// Hold candidate slots.
    ///
    /// Hold up to five candidate slots for a short time (30-900 seconds) while a person chooses,
    /// as alternatives in one group: each free one is held, the others are listed with why not.
    /// Book one by passing its hold_id to slotlock_create_event, which releases the rest;
    /// unbooked holds expire on their own. A hold is yours alone, and you may have 20 live at
    /// once.
    pub fn hold_slots(&self, input: &HoldSlotsInput) -> Result<Value, Error> {
        self.call("slotlock_hold_slots", serde_json::to_value(input)?)
    }

    /// Book resources together.
    ///
    /// Book the same time on 2-20 resources at once, all or none: a van with its driver, a room
    /// with its projector. If any of them is taken, nothing is booked, and the refusal names that
    /// resource_id. Find such a time with slotlock_find_available_slots and require_free. A retry
    /// with the same idempotency_key answers the same events.
    pub fn book_together(&self, input: &BookTogetherInput) -> Result<Value, Error> {
        self.call("slotlock_book_together", serde_json::to_value(input)?)
    }

    /// Book from a pool.
    ///
    /// Book any one member of a pool (a vehicle class, a room type) for a time: members are tried
    /// in a fixed order and the first that is free and allows the booking is booked, in one
    /// transaction, so a class sells out exactly at its number of members. The event names the
    /// member booked. 409 pool_full when none is free; 404 pool_not_found when the pool has no
    /// member you may book. A retry with the same idempotency_key answers the same event.
    pub fn book_pool(&self, input: &BookPoolInput) -> Result<Value, Error> {
        self.call("slotlock_book_pool", serde_json::to_value(input)?)
    }

    /// Release held slots.
    ///
    /// Release one of your holds, and the rest of its group, at once instead of letting them
    /// expire. `released` is false when it was already gone.
    pub fn release_slots(&self, input: &ReleaseSlotsInput) -> Result<Value, Error> {
        self.call("slotlock_release_slots", serde_json::to_value(input)?)
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
    /// Apply an expected-revision event patch and rematerialize occupancy atomically. With
    /// expected_resource_id, the resource you read the event on, an event since moved elsewhere
    /// is not found.
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
    /// One resource of the tenant, archived or not, with its own weekly bookable hours and its
    /// visibility.
    pub fn get_resource(&self, input: &GetResourceInput) -> Result<Value, Error> {
        self.call("slotlock_get_resource", serde_json::to_value(input)?)
    }

    /// Delete a resource.
    ///
    /// Delete a resource with its history (past bookings, coverage, cancelled events), freeing
    /// its place under the tenant's resource limit. Refused with 409 resource_in_use while a
    /// booking on it has not ended, a hold on it is live, or a calendar event is on it: cancel or
    /// move those first. deleted is false when the tenant has no such resource, deleted already,
    /// say.
    pub fn delete_resource(&self, input: &DeleteResourceInput) -> Result<Value, Error> {
        self.call("slotlock_delete_resource", serde_json::to_value(input)?)
    }

    /// Archive a resource.
    ///
    /// Take a resource out of use: no list shows it and it takes no new booking, hold or event
    /// (409 resource_archived), while what is on it stays and can still be cancelled or released.
    /// Archiving it again keeps the first time.
    pub fn archive_resource(&self, input: &ArchiveResourceInput) -> Result<Value, Error> {
        self.call("slotlock_archive_resource", serde_json::to_value(input)?)
    }

    /// Restore a resource.
    ///
    /// Put an archived resource back in use. Restoring one in use changes nothing.
    pub fn restore_resource(&self, input: &RestoreResourceInput) -> Result<Value, Error> {
        self.call("slotlock_restore_resource", serde_json::to_value(input)?)
    }

    /// List a resource's busy time.
    ///
    /// The time a resource of the tenant, private ones included, is occupied in a window of at
    /// most 367 days, by start: bookings with their turnaround, live holds, and calendar events.
    /// Adjacent intervals are not merged. More than 10,000 answers 400 calendar_work_limit:
    /// narrow the window. Free/busy with coverage, for the resources agents see, is
    /// slotlock_get_free_busy.
    pub fn list_busy(&self, input: &ListBusyInput) -> Result<Value, Error> {
        self.call("slotlock_list_busy", serde_json::to_value(input)?)
    }

    /// Set a resource's bookable hours.
    ///
    /// Give one resource its own weekly bookable hours. `null` makes it use the server's default;
    /// `[]` makes it never bookable. Each rule is weekly with BYDAY, in the resource's time zone:
    /// start_minutes after midnight, lasting duration_minutes.
    pub fn set_resource_availability(&self, input: &SetResourceAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_set_resource_availability", serde_json::to_value(input)?)
    }

    /// Export a resource's bookable hours as iCalendar.
    ///
    /// One resource's own weekly bookable hours as an iCalendar VAVAILABILITY (RFC 7953) for a
    /// calendar or scheduling tool: an AVAILABLE per rule, its DTSTART's TZID the resource's IANA
    /// time zone. `null` when the resource uses the server's default.
    pub fn export_resource_availability(&self, input: &ExportResourceAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_export_resource_availability", serde_json::to_value(input)?)
    }

    /// Import a resource's bookable hours from iCalendar.
    ///
    /// Set one resource's own weekly bookable hours from an iCalendar VAVAILABILITY (RFC 7953),
    /// as slotlock_set_resource_availability does from rules: each AVAILABLE a weekly RRULE with
    /// a start time and DTEND or DURATION. Times must be in the resource's time zone (its TZID)
    /// or floating. 400 invalid_availability names what weekly hours cannot say: a bounded
    /// VAVAILABILITY, RDATE, EXDATE, a single window, another zone.
    pub fn import_resource_availability(&self, input: &ImportResourceAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_import_resource_availability", serde_json::to_value(input)?)
    }

    /// Set a resource's booking rules.
    ///
    /// Set what a booking on one resource must satisfy from now on: minimum notice, how far
    /// ahead, the step starts fall on (from local midnight in the resource's time zone), the
    /// turnaround kept free after each booking, and whether bookings must lie inside its hours.
    /// `null` clears them. Holds, reservations, moves and agents' events are refused with the
    /// rule they break; searches offer only what they allow.
    pub fn set_resource_booking_rules(&self, input: &SetResourceBookingRulesInput) -> Result<Value, Error> {
        self.call("slotlock_set_resource_booking_rules", serde_json::to_value(input)?)
    }

    /// Set a resource's pool.
    ///
    /// Make a resource a member of a pool, a class of interchangeable resources such as a vehicle
    /// class or a room type, or take it out (`null`). Agents book the class with
    /// slotlock_book_pool, which takes the first member free; the class's capacity is its number
    /// of members. A resource is in one pool at most; pool names are 1-100 of a-z, 0-9, '.', '_'
    /// and '-'.
    pub fn set_resource_pool(&self, input: &SetResourcePoolInput) -> Result<Value, Error> {
        self.call("slotlock_set_resource_pool", serde_json::to_value(input)?)
    }

    /// List pools.
    ///
    /// The tenant's pools by name, each with its capacity: how many members it has that are not
    /// archived.
    pub fn list_pools(&self, input: &ListPoolsInput) -> Result<Value, Error> {
        self.call("slotlock_list_pools", serde_json::to_value(input)?)
    }

    /// A resource's history.
    ///
    /// What happened on one of the tenant's resources, newest first: each hold, booking and event
    /// made, moved, confirmed, released or cancelled, when, by whom (the API key or agent), and
    /// for a change what it was before. Kept 30 days. Pass next_before as before for older
    /// entries.
    pub fn get_resource_history(&self, input: &GetResourceHistoryInput) -> Result<Value, Error> {
        self.call("slotlock_get_resource_history", serde_json::to_value(input)?)
    }

    /// A booking's history.
    ///
    /// What happened to one booking, by its reference, newest first: made, moved, cancelled, when
    /// and by whom, as slotlock_get_resource_history.
    pub fn get_reservation_history(&self, input: &GetReservationHistoryInput) -> Result<Value, Error> {
        self.call("slotlock_get_reservation_history", serde_json::to_value(input)?)
    }

    /// An event's history.
    ///
    /// What happened to one calendar event of the tenant, by its id, newest first: created,
    /// changed, cancelled, when and by whom, as slotlock_get_resource_history.
    pub fn get_tenant_event_history(&self, input: &GetTenantEventHistoryInput) -> Result<Value, Error> {
        self.call("slotlock_get_tenant_event_history", serde_json::to_value(input)?)
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
    /// confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and
    /// a confirmed hold keeps it. A taken window answers 409 overlap. With an idempotency key
    /// (the Idempotency-Key header or idempotency_key), a retry answers the hold the first
    /// request made, until that hold would have expired, is released or is confirmed; the same
    /// key with another request is 422 idempotency_conflict.
    pub fn acquire_hold(&self, input: &AcquireHoldInput) -> Result<Value, Error> {
        self.call("slotlock_acquire_hold", serde_json::to_value(input)?)
    }

    /// Get a hold.
    ///
    /// One of the tenant's live holds. An expired, confirmed, released or unknown one answers 404
    /// hold_not_found; a confirmed one is a reservation whose reference is the hold's id.
    pub fn get_hold(&self, input: &GetHoldInput) -> Result<Value, Error> {
        self.call("slotlock_get_hold", serde_json::to_value(input)?)
    }

    /// Release a hold.
    ///
    /// Free a held window. released is false when the hold was already gone: expired, confirmed
    /// or released.
    pub fn release_hold(&self, input: &ReleaseHoldInput) -> Result<Value, Error> {
        self.call("slotlock_release_hold", serde_json::to_value(input)?)
    }

    /// List a resource's holds.
    ///
    /// The live holds on one of the tenant's resources, by start then id, a page at a time: pass
    /// next_cursor as cursor for the next page, until it is null.
    pub fn list_holds(&self, input: &ListHoldsInput) -> Result<Value, Error> {
        self.call("slotlock_list_holds", serde_json::to_value(input)?)
    }

    /// Confirm a hold.
    ///
    /// Turn an unexpired hold into a confirmed reservation, whose reference is the hold's id at
    /// revision 1: move or cancel it with the reservation routes by that reference (DELETE
    /// /v1/reservations/{hold_id}?revision=2 cancels it). Confirming it again answers the same
    /// reservation, so a retry is safe. An expired hold answers 409 hold_expired; a released or
    /// unknown one, 404 hold_not_found.
    pub fn confirm_hold(&self, input: &ConfirmHoldInput) -> Result<Value, Error> {
        self.call("slotlock_confirm_hold", serde_json::to_value(input)?)
    }

    /// Get a reservation.
    ///
    /// The tenant's booking with this reference as it now is, at its current revision: move it at
    /// that revision plus 1. A cancelled or unknown reference, or a calendar event's time,
    /// answers 404 reservation_not_found.
    pub fn get_reservation(&self, input: &GetReservationInput) -> Result<Value, Error> {
        self.call("slotlock_get_reservation", serde_json::to_value(input)?)
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

    /// List a resource's reservations.
    ///
    /// The tenant's bookings on one resource whose time, turnaround included, meets a window of
    /// at most 367 days, by start then id, a page at a time: pass next_cursor as cursor for the
    /// next page, until it is null. Calendar events are not bookings; slotlock_list_tenant_events
    /// lists them.
    pub fn list_reservations(&self, input: &ListReservationsInput) -> Result<Value, Error> {
        self.call("slotlock_list_reservations", serde_json::to_value(input)?)
    }

    /// Check in a booking.
    ///
    /// Claim a booking by its reference: the customer has arrived or picked up. On a resource
    /// whose booking rules set check_in_minutes, a booking not checked in that long after its
    /// start is released by maintenance (reservation.no_show on the feed) and offered to the
    /// waitlist. Check-in opens an hour before the start (409 check_in_not_open before then) and
    /// moving the booking to another start clears it. Checking in again keeps the first time; a
    /// booking that has ended answers 409 reservation_ended.
    pub fn check_in_reservation(&self, input: &CheckInReservationInput) -> Result<Value, Error> {
        self.call("slotlock_check_in_reservation", serde_json::to_value(input)?)
    }

    /// List the waitlist.
    ///
    /// The tenant's waitlist entries in the order they are offered (oldest first), with what each
    /// was offered: optionally only those of one resource, pool or holder.
    pub fn list_waitlist(&self, input: &ListWaitlistInput) -> Result<Value, Error> {
        self.call("slotlock_list_waitlist", serde_json::to_value(input)?)
    }

    /// Join the waitlist.
    ///
    /// Wait for a window on one resource (resource_id) or on any member of a pool (pool) that is
    /// taken now. When it comes free (a booking cancelled, a hold released or expired, a
    /// no-show), the entries waiting for it are offered in the order they joined: the first gets
    /// a hold of it for holder_ref, for offer_ttl_seconds (default 900), and the feed says so
    /// (waitlist.offered, with hold_id): confirm the hold to book it. An entry whose window
    /// starts first expires (waitlist.expired). A holder may wait for 20 windows at once (409
    /// waitlist_limit_reached); a window is at most 31 days.
    pub fn join_waitlist(&self, input: &JoinWaitlistInput) -> Result<Value, Error> {
        self.call("slotlock_join_waitlist", serde_json::to_value(input)?)
    }

    /// Leave the waitlist.
    ///
    /// Stop waiting. A hold offered and not yet confirmed is released with the entry, and the
    /// time offered to the next who waits; one confirmed is a booking and stays. left is false
    /// when there was no such entry.
    pub fn leave_waitlist(&self, input: &LeaveWaitlistInput) -> Result<Value, Error> {
        self.call("slotlock_leave_waitlist", serde_json::to_value(input)?)
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

    /// Retire a source.
    ///
    /// Forget a source's coverage of the resource, for a calendar sync that is disconnected or
    /// replaced: free/busy and a resource whose booking rules require certainty stop waiting on
    /// it. 404 coverage_not_found for a source with no coverage of the resource.
    pub fn delete_coverage(&self, input: &DeleteCoverageInput) -> Result<Value, Error> {
        self.call("slotlock_delete_coverage", serde_json::to_value(input)?)
    }

    /// A resource's coverage and its health.
    ///
    /// Each external calendar (source) that records coverage of a resource: the window it covers,
    /// when it was last read, its last error, and whether it is stale (not read for a day, so the
    /// time it covers is unproven, not free). A source that goes stale is also put on the change
    /// feed once, as coverage.stale, until it is read again.
    pub fn get_coverage(&self, input: &GetCoverageInput) -> Result<Value, Error> {
        self.call("slotlock_get_coverage", serde_json::to_value(input)?)
    }

    /// Record a failed read of a source.
    ///
    /// Record that reading an external calendar failed (it answered 500, a token expired): kept
    /// as the source's last error, shown by slotlock_get_coverage, while its coverage stays as it
    /// was. 404 coverage_not_found for a source that has never recorded coverage of the resource.
    pub fn record_coverage_failure(&self, input: &RecordCoverageFailureInput) -> Result<Value, Error> {
        self.call("slotlock_record_coverage_failure", serde_json::to_value(input)?)
    }

    /// List a resource's events, every key's.
    ///
    /// The calendar events on one of the tenant's resources with an occurrence in a window of at
    /// most 367 days, whichever key wrote them (a revoked one's included), by start then id, a
    /// page at a time: pass next_cursor as cursor for the next page, until it is null.
    pub fn list_tenant_events(&self, input: &ListTenantEventsInput) -> Result<Value, Error> {
        self.call("slotlock_list_tenant_events", serde_json::to_value(input)?)
    }

    /// Get any event of the tenant.
    ///
    /// One of the tenant's events by its id (the id slotlock_list_tenant_events gives), whichever
    /// key wrote it. A cancelled or unknown one answers 404 event_not_found.
    pub fn get_tenant_event(&self, input: &GetTenantEventInput) -> Result<Value, Error> {
        self.call("slotlock_get_tenant_event", serde_json::to_value(input)?)
    }

    /// Cancel any event of the tenant.
    ///
    /// Cancel one of the tenant's events by its id, whichever key wrote it (a revoked key's
    /// included, without charging its quota), at the revision you last read (expected_revision).
    /// Its owner cannot create it again. With expected_resource_id, an event since moved to
    /// another resource answers 404 event_not_found. Needs an idempotency key (the
    /// Idempotency-Key header or idempotency_key): a retry with it answers the first cancellation
    /// (replayed: true).
    pub fn cancel_tenant_event(&self, input: &CancelTenantEventInput) -> Result<Value, Error> {
        self.call("slotlock_cancel_tenant_event", serde_json::to_value(input)?)
    }

    /// Export an event as JSCalendar.
    ///
    /// One of the tenant's events as a JSCalendar Event (RFC 8984), the JSON form of a calendar
    /// event: uid is its id, sequence its revision, start a local time in timeZone with an exact
    /// duration, its people participants, its reminders alerts, its recurrence recurrenceRules
    /// and recurrenceOverrides (and the RRULE verbatim as slotlock.pylota.io:rrule). A cancelled
    /// or unknown one answers 404 event_not_found.
    pub fn export_tenant_event(&self, input: &ExportTenantEventInput) -> Result<Value, Error> {
        self.call("slotlock_export_tenant_event", serde_json::to_value(input)?)
    }

    /// Get the tenant.
    ///
    /// The key's tenant: its reference, and whether it is suspended. A suspended tenant may read
    /// and writes nothing (403 tenant_suspended); only the server's operator suspends a tenant or
    /// lifts a suspension (slotlock tenant suspend).
    pub fn get_tenant(&self, input: &GetTenantInput) -> Result<Value, Error> {
        self.call("slotlock_get_tenant", serde_json::to_value(input)?)
    }

    /// Erase the tenant.
    ///
    /// Delete everything the key's tenant has, at once and for good: resources, holds, bookings,
    /// events, coverage and every API key, this one included. confirm_tenant_ref must be the
    /// tenant's reference (slotlock_get_tenant), or it answers 400 invalid_confirmation. Off
    /// unless the server allows it (403 tenant_erasure_disabled; slotlock serve does not: its
    /// operator runs slotlock tenant erase). A suspended tenant cannot erase itself (403
    /// tenant_suspended). Erasing again deletes nothing.
    pub fn erase_tenant(&self, input: &EraseTenantInput) -> Result<Value, Error> {
        self.call("slotlock_erase_tenant", serde_json::to_value(input)?)
    }

    /// Run maintenance.
    ///
    /// Extend recurring events to the rolling horizon and prune what the retention window no
    /// longer needs, for the caller's tenant. Run it at least daily (slotlock serve does). capped
    /// is true when there was more than one call does: call again.
    pub fn run_maintenance(&self, input: &RunMaintenanceInput) -> Result<Value, Error> {
        self.call("slotlock_run_maintenance", serde_json::to_value(input)?)
    }

    /// List changes.
    ///
    /// What changed in the tenant, oldest first, as CloudEvents: holds made, confirmed, released
    /// or expired; bookings made, moved or cancelled; calendar events created, changed or
    /// cancelled (ids, times and states, never titles or attendees). Pass next_cursor as cursor
    /// to read on; it is returned even when nothing is new, so poll with it. Only changes of
    /// transactions that have ended are listed, so following the cursor never skips one. Changes
    /// are kept 30 days: an older cursor answers 410 cursor_expired, so start again without one.
    pub fn list_changes(&self, input: &ListChangesInput) -> Result<Value, Error> {
        self.call("slotlock_list_changes", serde_json::to_value(input)?)
    }

    /// List webhooks.
    ///
    /// The tenant's webhooks with how delivery is going: failed attempts, the last status, and
    /// whether and why one is disabled.
    pub fn list_webhooks(&self, input: &ListWebhooksInput) -> Result<Value, Error> {
        self.call("slotlock_list_webhooks", serde_json::to_value(input)?)
    }

    /// Add a webhook.
    ///
    /// Send the changes slotlock_list_changes lists from now on to an https URL, each as a
    /// CloudEvent signed as Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature),
    /// in order, until a 2xx. A failure is retried with backoff; after 24 hours of failures, or a
    /// 410, the webhook is disabled and the feed records webhook.disabled. The secret is returned
    /// here only. At most 10 per tenant.
    pub fn create_webhook(&self, input: &CreateWebhookInput) -> Result<Value, Error> {
        self.call("slotlock_create_webhook", serde_json::to_value(input)?)
    }

    /// Delete a webhook.
    ///
    /// Stop sending to a webhook. deleted is false when the tenant has no such webhook.
    pub fn delete_webhook(&self, input: &DeleteWebhookInput) -> Result<Value, Error> {
        self.call("slotlock_delete_webhook", serde_json::to_value(input)?)
    }

    /// Enable a webhook.
    ///
    /// Send to a disabled webhook again, from the first change it did not accept. 404
    /// webhook_not_found when the tenant has no such webhook; 409 changes_pruned when what it
    /// missed is older than the 30 days the feed keeps, since it would skip those unseen: delete
    /// it, add it again, and read what it missed from slotlock_list_changes.
    pub fn enable_webhook(&self, input: &EnableWebhookInput) -> Result<Value, Error> {
        self.call("slotlock_enable_webhook", serde_json::to_value(input)?)
    }

}
