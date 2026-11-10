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
        query: &["cursor", "limit", "pool", "kind", "labels", "location", "group"],
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
        query: &["resource_ids", "location", "group", "labels", "kind", "pool", "start", "end"],
    },
    Operation {
        name: "slotlock_find_next_available",
        method: "GET",
        path: "/v1/next-available",
        path_params: &[],
        query: &["resource_ids", "location", "group", "labels", "kind", "pool", "start", "end", "duration_minutes"],
    },
    Operation {
        name: "slotlock_find_available_slots",
        method: "GET",
        path: "/v1/available-slots",
        path_params: &[],
        query: &["resource_ids", "location", "group", "labels", "kind", "pool", "start", "end", "duration_minutes", "limit", "require_free"],
    },
    Operation {
        name: "slotlock_find_available_ranges",
        method: "GET",
        path: "/v1/available-ranges",
        path_params: &[],
        query: &["resource_ids", "pool", "pickup_start", "pickup_end", "days", "return_start", "return_end", "limit"],
    },
    Operation {
        name: "slotlock_hold_slots",
        method: "POST",
        path: "/v1/slot-holds",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_hold_together",
        method: "POST",
        path: "/v1/slot-holds/together",
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
        name: "slotlock_get_pool_availability",
        method: "GET",
        path: "/v1/pool-availability",
        path_params: &[],
        query: &["pool", "start", "end"],
    },
    Operation {
        name: "slotlock_release_slots",
        method: "DELETE",
        path: "/v1/slot-holds/{hold_id}",
        path_params: &["hold_id"],
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_confirm_slot",
        method: "POST",
        path: "/v1/slot-holds/{hold_id}/confirm",
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
        query: &["expected_revision", "idempotency_key", "dry_run"],
    },
    Operation {
        name: "slotlock_reschedule",
        method: "POST",
        path: "/v1/events/{event_id}/reschedule",
        path_params: &["event_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_cancel",
        method: "POST",
        path: "/v1/events/{event_id}/cancel",
        path_params: &["event_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_get_resource",
        method: "GET",
        path: "/v1/resources/{resource_id}",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_update_resource",
        method: "PATCH",
        path: "/v1/resources/{resource_id}",
        path_params: &["resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_resource",
        method: "DELETE",
        path: "/v1/resources/{resource_id}",
        path_params: &["resource_id"],
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_list_locations",
        method: "GET",
        path: "/v1/locations",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_create_location",
        method: "POST",
        path: "/v1/locations",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_update_location",
        method: "PATCH",
        path: "/v1/locations/{location_ref}",
        path_params: &["location_ref"],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_location",
        method: "DELETE",
        path: "/v1/locations/{location_ref}",
        path_params: &["location_ref"],
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_list_groups",
        method: "GET",
        path: "/v1/groups",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_create_group",
        method: "POST",
        path: "/v1/groups",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_group",
        method: "DELETE",
        path: "/v1/groups/{group_ref}",
        path_params: &["group_ref"],
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_add_group_member",
        method: "PUT",
        path: "/v1/groups/{group_ref}/members/{resource_id}",
        path_params: &["group_ref", "resource_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_remove_group_member",
        method: "DELETE",
        path: "/v1/groups/{group_ref}/members/{resource_id}",
        path_params: &["group_ref", "resource_id"],
        query: &["dry_run"],
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
        name: "slotlock_set_resource_parent",
        method: "PUT",
        path: "/v1/resources/{resource_id}/parent",
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
        name: "slotlock_set_pool_order",
        method: "PUT",
        path: "/v1/pools/{pool}/order",
        path_params: &["pool"],
        query: &[],
    },
    Operation {
        name: "slotlock_get_booking_rule_defaults",
        method: "GET",
        path: "/v1/booking-rules",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_set_tenant_booking_rules",
        method: "PUT",
        path: "/v1/booking-rules",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_set_pool_booking_rules",
        method: "PUT",
        path: "/v1/pools/{pool}/booking-rules",
        path_params: &["pool"],
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
        name: "slotlock_get_availability_defaults",
        method: "GET",
        path: "/v1/availability",
        path_params: &[],
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
        name: "slotlock_set_location_availability",
        method: "PUT",
        path: "/v1/locations/{location}/availability",
        path_params: &["location"],
        query: &[],
    },
    Operation {
        name: "slotlock_list_availability_exceptions",
        method: "GET",
        path: "/v1/availability/exceptions",
        path_params: &[],
        query: &["resource_id", "location", "from", "to", "limit", "after"],
    },
    Operation {
        name: "slotlock_create_availability_exception",
        method: "POST",
        path: "/v1/availability/exceptions",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_availability_exception",
        method: "DELETE",
        path: "/v1/availability/exceptions/{exception_id}",
        path_params: &["exception_id"],
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_import_holidays",
        method: "POST",
        path: "/v1/availability/holidays",
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
        query: &["dry_run"],
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
        name: "slotlock_mark_hold_paid",
        method: "POST",
        path: "/v1/holds/{hold_id}/paid",
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
        query: &["revision", "override_reason", "dry_run"],
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
        name: "slotlock_get_contact",
        method: "GET",
        path: "/v1/contacts/{contact_ref}",
        path_params: &["contact_ref"],
        query: &[],
    },
    Operation {
        name: "slotlock_put_contact",
        method: "PUT",
        path: "/v1/contacts/{contact_ref}",
        path_params: &["contact_ref"],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_contact",
        method: "DELETE",
        path: "/v1/contacts/{contact_ref}",
        path_params: &["contact_ref"],
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_list_contacts",
        method: "GET",
        path: "/v1/contacts",
        path_params: &[],
        query: &["limit", "cursor"],
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
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_decline_waitlist_offer",
        method: "POST",
        path: "/v1/waitlist/{entry_id}/decline",
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
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_put_source_busy",
        method: "PUT",
        path: "/v1/resources/{resource_id}/coverage/{source}/busy",
        path_params: &["resource_id", "source"],
        query: &[],
    },
    Operation {
        name: "slotlock_report_coverage_conflict",
        method: "POST",
        path: "/v1/resources/{resource_id}/coverage/{source}/conflicts",
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
        query: &["expected_revision", "expected_resource_id", "idempotency_key", "override_reason", "dry_run"],
    },
    Operation {
        name: "slotlock_export_tenant_event",
        method: "GET",
        path: "/v1/tenant/events/{event_id}/jscalendar",
        path_params: &["event_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_tenant_book_together",
        method: "POST",
        path: "/v1/tenant/bundles",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_tenant_book_pool",
        method: "POST",
        path: "/v1/tenant/pool-bookings",
        path_params: &[],
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
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_enable_webhook",
        method: "POST",
        path: "/v1/webhooks/{webhook_id}/enable",
        path_params: &["webhook_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_get_usage",
        method: "GET",
        path: "/v1/usage",
        path_params: &[],
        query: &["from", "to"],
    },
    Operation {
        name: "slotlock_list_approval_policies",
        method: "GET",
        path: "/v1/approval-policies",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_put_approval_policy",
        method: "PUT",
        path: "/v1/approval-policies/{policy_ref}",
        path_params: &["policy_ref"],
        query: &[],
    },
    Operation {
        name: "slotlock_delete_approval_policy",
        method: "DELETE",
        path: "/v1/approval-policies/{policy_ref}",
        path_params: &["policy_ref"],
        query: &["dry_run"],
    },
    Operation {
        name: "slotlock_list_approvals",
        method: "GET",
        path: "/v1/approvals",
        path_params: &[],
        query: &["status", "limit"],
    },
    Operation {
        name: "slotlock_get_approval",
        method: "GET",
        path: "/v1/approvals/{approval_id}",
        path_params: &["approval_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_decide_approval",
        method: "POST",
        path: "/v1/approvals/{approval_id}/decision",
        path_params: &["approval_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_sandbox_seed",
        method: "POST",
        path: "/v1/sandbox/seed",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_sandbox_reset",
        method: "POST",
        path: "/v1/sandbox/reset",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_sandbox_fast_forward",
        method: "POST",
        path: "/v1/sandbox/fast-forward",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_sandbox_race",
        method: "POST",
        path: "/v1/sandbox/race",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_get_account",
        method: "GET",
        path: "/v1/partner/accounts/{account}",
        path_params: &["account"],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_put_account",
        method: "PUT",
        path: "/v1/partner/accounts/{account}",
        path_params: &["account"],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_list_accounts",
        method: "GET",
        path: "/v1/partner/accounts",
        path_params: &[],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_list_keys",
        method: "GET",
        path: "/v1/partner/accounts/{account}/keys",
        path_params: &["account"],
        query: &["environment"],
    },
    Operation {
        name: "slotlock_partner_create_key",
        method: "POST",
        path: "/v1/partner/accounts/{account}/keys",
        path_params: &["account"],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_rotate_key",
        method: "POST",
        path: "/v1/partner/accounts/{account}/keys/{key_id}/rotate",
        path_params: &["account", "key_id"],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_revoke_key",
        method: "DELETE",
        path: "/v1/partner/accounts/{account}/keys/{key_id}",
        path_params: &["account", "key_id"],
        query: &["environment"],
    },
    Operation {
        name: "slotlock_partner_suspend_account",
        method: "POST",
        path: "/v1/partner/accounts/{account}/suspend",
        path_params: &["account"],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_unsuspend_account",
        method: "POST",
        path: "/v1/partner/accounts/{account}/unsuspend",
        path_params: &["account"],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_erase_account",
        method: "POST",
        path: "/v1/partner/accounts/{account}/erase",
        path_params: &["account"],
        query: &[],
    },
    Operation {
        name: "slotlock_partner_get_usage",
        method: "GET",
        path: "/v1/partner/usage",
        path_params: &[],
        query: &["from", "to", "account"],
    },
    Operation {
        name: "slotlock_partner_reconcile_usage",
        method: "POST",
        path: "/v1/partner/usage/reconcile",
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// The arguments of [`Client::create_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CreateResourceInput {
    pub external_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::get_free_busy`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetFreeBusyInput {
    pub start: String,
    pub end: String,
    /// Left out when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resource_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
}

/// The arguments of [`Client::find_next_available`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct FindNextAvailableInput {
    pub start: String,
    pub end: String,
    /// Left out when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resource_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_minutes: Option<i64>,
}

/// The arguments of [`Client::find_available_slots`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct FindAvailableSlotsInput {
    pub start: String,
    pub end: String,
    /// Left out when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resource_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_free: Option<i64>,
}

/// The arguments of [`Client::find_available_ranges`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct FindAvailableRangesInput {
    pub pickup_start: String,
    pub pickup_end: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

/// The arguments of [`Client::hold_slots`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct HoldSlotsInput {
    pub slots: Vec<Value>,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment: Option<Value>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::hold_together`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct HoldTogetherInput {
    pub resource_ids: Vec<String>,
    pub start: String,
    pub end: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<i64>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold_group_id: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::get_pool_availability`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetPoolAvailabilityInput {
    pub pool: String,
    pub start: String,
    pub end: String,
}

/// The arguments of [`Client::release_slots`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ReleaseSlotsInput {
    pub hold_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::confirm_slot`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ConfirmSlotInput {
    pub hold_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify: Option<bool>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteEventInput {
    pub event_id: String,
    pub expected_revision: i64,
    pub idempotency_key: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::reschedule`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RescheduleInput {
    pub event_id: String,
    pub expected_revision: i64,
    pub starts_at: String,
    pub ends_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::cancel`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CancelInput {
    pub event_id: String,
    pub expected_revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::get_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetResourceInput {
    pub resource_id: String,
}

/// The arguments of [`Client::update_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateResourceInput {
    pub resource_id: String,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<Value>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Option<String>>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteResourceInput {
    pub resource_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::list_locations`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListLocationsInput {
}

/// The arguments of [`Client::create_location`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CreateLocationInput {
    pub r#ref: String,
    pub name: String,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_ref: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<Option<String>>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::update_location`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateLocationInput {
    pub location_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_ref: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<Option<String>>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_location`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteLocationInput {
    pub location_ref: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::list_groups`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListGroupsInput {
}

/// The arguments of [`Client::create_group`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CreateGroupInput {
    pub r#ref: String,
    pub name: String,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Option<String>>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_group`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteGroupInput {
    pub group_ref: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::add_group_member`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct AddGroupMemberInput {
    pub group_ref: String,
    pub resource_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::remove_group_member`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RemoveGroupMemberInput {
    pub group_ref: String,
    pub resource_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::archive_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ArchiveResourceInput {
    pub resource_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::restore_resource`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RestoreResourceInput {
    pub resource_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::set_resource_booking_rules`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetResourceBookingRulesInput {
    pub resource_id: String,
    pub rules: Option<Value>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::set_resource_pool`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetResourcePoolInput {
    pub resource_id: String,
    pub pool: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::set_resource_parent`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetResourceParentInput {
    pub resource_id: String,
    pub parent_id: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::list_pools`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListPoolsInput {
}

/// The arguments of [`Client::set_pool_order`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetPoolOrderInput {
    pub pool: String,
    pub order: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::get_booking_rule_defaults`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetBookingRuleDefaultsInput {
}

/// The arguments of [`Client::set_tenant_booking_rules`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetTenantBookingRulesInput {
    pub rules: Option<Value>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::set_pool_booking_rules`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetPoolBookingRulesInput {
    pub pool: String,
    pub rules: Option<Value>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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

/// The arguments of [`Client::get_availability_defaults`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetAvailabilityDefaultsInput {
}

/// The arguments of [`Client::set_tenant_availability`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetTenantAvailabilityInput {
    pub rules: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_resources: Option<bool>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::set_location_availability`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SetLocationAvailabilityInput {
    pub location: String,
    pub rules: Option<Vec<Value>>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::list_availability_exceptions`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListAvailabilityExceptionsInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

/// The arguments of [`Client::create_availability_exception`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CreateAvailabilityExceptionInput {
    pub starts_on: String,
    pub outcome: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hours: Option<Vec<Value>>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_availability_exception`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteAvailabilityExceptionInput {
    pub exception_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::import_holidays`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportHolidaysInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icalendar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment: Option<Value>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::mark_hold_paid`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct MarkHoldPaidInput {
    pub hold_id: String,
    pub payment_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<Value>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder_minutes: Option<Vec<i64>>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::cancel_reservation`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct CancelReservationInput {
    pub reservation_ref: String,
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_reason: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::get_contact`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetContactInput {
    pub contact_ref: String,
}

/// The arguments of [`Client::put_contact`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PutContactInput {
    pub contact_ref: String,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<Option<String>>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whatsapp: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent: Option<Value>,
    /// `None` leaves it out; `Some(None)` sends null, which clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<Option<String>>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_contact`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteContactInput {
    pub contact_ref: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::list_contacts`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListContactsInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_minutes: Option<i64>,
    /// A retry identity, also accepted as the Idempotency-Key header: the same key with the same
    /// request answers what the first did; with another request, 422 idempotency_conflict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::leave_waitlist`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct LeaveWaitlistInput {
    pub entry_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::decline_waitlist_offer`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeclineWaitlistOfferInput {
    pub entry_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::record_coverage`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct RecordCoverageInput {
    pub resource_id: String,
    pub source: String,
    pub start: String,
    pub end: String,
    pub revision: i64,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_coverage`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteCoverageInput {
    pub resource_id: String,
    pub source: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::put_source_busy`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PutSourceBusyInput {
    pub resource_id: String,
    pub source: String,
    pub start: String,
    pub end: String,
    pub revision: i64,
    pub busy: Vec<Value>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::report_coverage_conflict`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ReportCoverageConflictInput {
    pub resource_id: String,
    pub source: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reservation_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar_end: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_reason: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::export_tenant_event`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ExportTenantEventInput {
    pub event_id: String,
}

/// The arguments of [`Client::tenant_book_together`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct TenantBookTogetherInput {
    pub resource_ids: Vec<String>,
    pub starts_at: String,
    pub ends_at: String,
    pub timezone: String,
    /// A retry identity, also accepted as the Idempotency-Key header: the same key with the same
    /// request answers what the first did; with another request, 422 idempotency_conflict.
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::tenant_book_pool`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct TenantBookPoolInput {
    pub pool: String,
    pub starts_at: String,
    pub ends_at: String,
    pub timezone: String,
    /// A retry identity, also accepted as the Idempotency-Key header: the same key with the same
    /// request answers what the first did; with another request, 422 idempotency_conflict.
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<String>>,
    /// A retry identity, also accepted as the Idempotency-Key header: the same key with the same
    /// request answers what the first did; with another request, 422 idempotency_conflict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_webhook`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteWebhookInput {
    pub webhook_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::enable_webhook`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct EnableWebhookInput {
    pub webhook_id: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::get_usage`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetUsageInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

/// The arguments of [`Client::list_approval_policies`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListApprovalPoliciesInput {
}

/// The arguments of [`Client::put_approval_policy`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PutApprovalPolicyInput {
    pub policy_ref: String,
    pub name: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applies_to: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditions: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_ttl_minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead_minutes: Option<i64>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::delete_approval_policy`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeleteApprovalPolicyInput {
    pub policy_ref: String,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::list_approvals`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct ListApprovalsInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

/// The arguments of [`Client::get_approval`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct GetApprovalInput {
    pub approval_id: String,
}

/// The arguments of [`Client::decide_approval`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct DecideApprovalInput {
    pub approval_id: String,
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Check the write without making it: it runs with every check, the database's included, and
    /// is then undone, so nothing is stored, recorded or sent. The answer is what it would have
    /// been, with dry_run: true (ids in it are never stored), or the refusal it would have met,
    /// alternatives included. Charged as a read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The arguments of [`Client::sandbox_seed`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SandboxSeedInput {
    pub scenario: String,
}

/// The arguments of [`Client::sandbox_reset`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SandboxResetInput {
}

/// The arguments of [`Client::sandbox_fast_forward`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SandboxFastForwardInput {
    pub minutes: i64,
}

/// The arguments of [`Client::sandbox_race`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct SandboxRaceInput {
    pub resource_id: String,
    pub starts_at: String,
    pub ends_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<i64>,
}

/// The arguments of [`Client::partner_get_account`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerGetAccountInput {
    pub account: String,
}

/// The arguments of [`Client::partner_put_account`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerPutAccountInput {
    pub account: String,
    pub plan: String,
}

/// The arguments of [`Client::partner_list_accounts`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerListAccountsInput {
}

/// The arguments of [`Client::partner_list_keys`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerListKeysInput {
    pub account: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

/// The arguments of [`Client::partner_create_key`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerCreateKeyInput {
    pub account: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_days: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<Value>,
}

/// The arguments of [`Client::partner_rotate_key`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerRotateKeyInput {
    pub account: String,
    pub key_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

/// The arguments of [`Client::partner_revoke_key`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerRevokeKeyInput {
    pub account: String,
    pub key_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

/// The arguments of [`Client::partner_suspend_account`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerSuspendAccountInput {
    pub account: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The arguments of [`Client::partner_unsuspend_account`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerUnsuspendAccountInput {
    pub account: String,
}

/// The arguments of [`Client::partner_erase_account`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerEraseAccountInput {
    pub account: String,
    pub confirm: String,
}

/// The arguments of [`Client::partner_get_usage`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerGetUsageInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// The arguments of [`Client::partner_reconcile_usage`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PartnerReconcileUsageInput {
    pub day: String,
    pub accounts: Vec<Value>,
}

impl Client {
    /// List calendar resources.
    ///
    /// List resources visible to the authenticated tenant principal, with what each says about
    /// itself: its name (show it rather than the reference), description, kind, capacity and
    /// labels, where it is (location), the groups it is in (a team, a department), and the pool
    /// it belongs to (a vehicle class, a room type). With kind, only resources of that kind; with
    /// labels, only those with every label given; with location, only those there or at a
    /// location in it; with group, only that group's. With pool, only that pool's members, in the
    /// order slotlock_book_pool tries them.
    pub fn list_resources(&self, input: &ListResourcesInput) -> Result<Value, Error> {
        self.call("slotlock_list_resources", serde_json::to_value(input)?)
    }

    /// Create or update a resource.
    ///
    /// Create the resource with this external reference, or update its time zone, and the profile
    /// fields and location given, if the tenant already has it. Without a time zone, a new
    /// resource takes the nearest one its location, or a location above it, has, else UTC; a
    /// location the tenant does not have answers 404 location_not_found. Repeating the call
    /// changes nothing more. visibility is shared (the default: agents list and book it) or
    /// private (agents never see it), fixed at creation: naming another for an existing resource
    /// answers 409 resource_visibility_conflict. Its profile is optional: a name agents and
    /// people see instead of the reference, a description, its kind (person, room, desk, space,
    /// vehicle, machine, equipment, service or other: a hint, never a rule), its capacity
    /// (informational), up to 20 labels to find it by, and attributes you want back.
    pub fn create_resource(&self, input: &CreateResourceInput) -> Result<Value, Error> {
        self.call("slotlock_create_resource", serde_json::to_value(input)?)
    }

    /// Get free-busy.
    ///
    /// When each resource is busy in a window, as busy intervals only (never whose or what), and
    /// whether that is certain (coverage: "uncertain" where a calendar feeding it has not been
    /// read lately). Name the resources with resource_ids, or select them instead by location
    /// (and every location in it), group, labels (every one), kind or pool: at most 100 (more
    /// answers selection_too_large, none selection_empty), named in selected_resource_ids.
    pub fn get_free_busy(&self, input: &GetFreeBusyInput) -> Result<Value, Error> {
        self.call("slotlock_get_free_busy", serde_json::to_value(input)?)
    }

    /// Find next available interval.
    ///
    /// Find the earliest certain interval that satisfies the requested duration (up to the
    /// 367-day search window, so a multi-month rental slot can be found). Name the resources with
    /// resource_ids, or select them as slotlock_get_free_busy does: at most 100.
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
    /// every resource's coverage is certain. Name the resources with resource_ids, or select them
    /// as slotlock_get_free_busy does: at most 20.
    pub fn find_available_slots(&self, input: &FindAvailableSlotsInput) -> Result<Value, Error> {
        self.call("slotlock_find_available_slots", serde_json::to_value(input)?)
    }

    /// Find available ranges.
    ///
    /// Find hires across days, such as a car from Friday to Monday: for each resource named, or
    /// each member of a pool, the earliest range that starts between pickup_start and pickup_end
    /// and either lasts `days` days (ending at the same local time) or ends between return_start
    /// and return_end. Each range is free throughout with its buffers, allowed by the resource's
    /// booking rules (pick-up and return times, lengths, notice, step) and starts and ends inside
    /// its bookable hours. Up to `limit` ranges, earliest first, one per resource; none unless
    /// every resource's coverage is certain. Book one with slotlock_create_event, or a pool's
    /// with slotlock_book_pool, at its start and end.
    pub fn find_available_ranges(&self, input: &FindAvailableRangesInput) -> Result<Value, Error> {
        self.call("slotlock_find_available_ranges", serde_json::to_value(input)?)
    }

    /// Hold candidate slots.
    ///
    /// Hold up to five candidate slots for a short time (30-900 seconds) while a person chooses,
    /// as alternatives in one group: each free one is held, the others are listed with why not.
    /// Book one by passing its hold_id to slotlock_create_event, which releases the rest;
    /// unbooked holds expire on their own. With payment_required, a hold is booked only once the
    /// system you book for records its payment (the person pays there): booking it before then
    /// answers payment_required, so send the person to pay and try again. A hold is yours alone,
    /// and you may have 20 live at once. A candidate refused for its time comes with alternatives
    /// (the earliest free times of its length). slotlock_confirm_slot books a held time.
    pub fn hold_slots(&self, input: &HoldSlotsInput) -> Result<Value, Error> {
        self.call("slotlock_hold_slots", serde_json::to_value(input)?)
    }

    /// Hold resources together.
    ///
    /// Hold one time on 2-20 resources at once, all or none, such as a car with its driver while
    /// a person decides: if any is taken, nothing is held and the refusal names that resource_id.
    /// The holds are one group with one time to live (ttl_seconds, the earliest of them). Book
    /// the set with slotlock_book_together and its hold_group_id; release them with
    /// slotlock_release_slots and any hold_id. A retry with the same idempotency_key answers the
    /// same holds.
    pub fn hold_together(&self, input: &HoldTogetherInput) -> Result<Value, Error> {
        self.call("slotlock_hold_together", serde_json::to_value(input)?)
    }

    /// Book resources together.
    ///
    /// Book the same time on 2-20 resources at once, all or none: a van with its driver, a room
    /// with its projector. If any of them is taken, nothing is booked, and the refusal names that
    /// resource_id. Find such a time with slotlock_find_available_slots and require_free. With
    /// hold_group_id, it books the set slotlock_hold_together held, from those holds. A retry
    /// with the same idempotency_key answers the same events.
    pub fn book_together(&self, input: &BookTogetherInput) -> Result<Value, Error> {
        self.call("slotlock_book_together", serde_json::to_value(input)?)
    }

    /// Book from a pool.
    ///
    /// Book any one member of a pool (a vehicle class, a room type) for a time: members are tried
    /// in the pool's order (by id, fewest bookings in the last 30 days first, or in turn, as the
    /// tenant sets it) and the first that is free and allows the booking is booked, in one
    /// transaction, so a class sells out exactly at its number of members. The event names the
    /// member booked. 409 pool_full when none is free; 404 pool_not_found when the pool has no
    /// member you may book. A retry with the same idempotency_key answers the same event.
    pub fn book_pool(&self, input: &BookPoolInput) -> Result<Value, Error> {
        self.call("slotlock_book_pool", serde_json::to_value(input)?)
    }

    /// Get pool availability.
    ///
    /// How many members of a pool (a vehicle class, a room type) are free across a window, each
    /// only where its booking rules let a booking start: the window split where that number
    /// changes, each part with how many are free, and coverage certainty. Book one with
    /// slotlock_book_pool. 404 pool_not_found when the pool has no member you may book.
    pub fn get_pool_availability(&self, input: &GetPoolAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_get_pool_availability", serde_json::to_value(input)?)
    }

    /// Release held slots.
    ///
    /// Release one of your holds, and the rest of its group, at once instead of letting them
    /// expire. `released` is false when it was already gone.
    pub fn release_slots(&self, input: &ReleaseSlotsInput) -> Result<Value, Error> {
        self.call("slotlock_release_slots", serde_json::to_value(input)?)
    }

    /// Confirm a held slot.
    ///
    /// Book a time you hold (a hold_id from slotlock_hold_slots): the held resource and time
    /// exactly, with the title and details you give, and the rest of its group released. 409
    /// hold_expired when the hold lapsed first; 404 hold_not_found when it was released, booked
    /// or is not yours. A retry answers the same event (replayed).
    pub fn confirm_slot(&self, input: &ConfirmSlotInput) -> Result<Value, Error> {
        self.call("slotlock_confirm_slot", serde_json::to_value(input)?)
    }

    /// List resource events.
    ///
    /// List your events that meet a time window, earliest first.
    pub fn list_events(&self, input: &ListEventsInput) -> Result<Value, Error> {
        self.call("slotlock_list_events", serde_json::to_value(input)?)
    }

    /// Create resource event.
    ///
    /// Book a resource for a time, as an event of up to 3,660 days (a booking, lease or long
    /// rental). The database refuses a time already taken: 409 overlap, with alternatives (the
    /// earliest free times of the same length) and, when the booking in the way is yours, its id.
    /// A booking rule that refuses the time answers booking_rule_… with alternatives too. To book
    /// a time you hold, pass its hold_id, or use slotlock_confirm_slot. A retry with the same
    /// idempotency_key answers the same event.
    pub fn create_event(&self, input: &CreateEventInput) -> Result<Value, Error> {
        self.call("slotlock_create_event", serde_json::to_value(input)?)
    }

    /// Get resource event.
    ///
    /// Read one of your events by its id, with its revision (pass it as expected_revision to
    /// change or cancel it).
    pub fn get_event(&self, input: &GetEventInput) -> Result<Value, Error> {
        self.call("slotlock_get_event", serde_json::to_value(input)?)
    }

    /// Update resource event.
    ///
    /// Change one of your events at the revision you last read (expected_revision): its time,
    /// resource or details, all or nothing. A time already taken is 409 overlap with
    /// alternatives; a stale revision is 409 revision_conflict (read the event again). With
    /// expected_resource_id, the resource you read it on, an event since moved elsewhere is not
    /// found. To change only the time, slotlock_reschedule is simpler.
    pub fn update_event(&self, input: &UpdateEventInput) -> Result<Value, Error> {
        self.call("slotlock_update_event", serde_json::to_value(input)?)
    }

    /// Delete resource event.
    ///
    /// Cancel one of your events at the revision you last read (expected_revision); a stale one
    /// is 409 revision_conflict. It cannot come back at that revision, so an old copy synced
    /// later does not restore it. slotlock_cancel does the same with fewer fields.
    pub fn delete_event(&self, input: &DeleteEventInput) -> Result<Value, Error> {
        self.call("slotlock_delete_event", serde_json::to_value(input)?)
    }

    /// Reschedule an event.
    ///
    /// Move one of your events to a new time, and to another resource if you give one, at the
    /// revision you last read (expected_revision). A time already taken is 409 overlap with
    /// alternatives; a stale revision 409 revision_conflict. A retry answers the same move
    /// (replayed).
    pub fn reschedule(&self, input: &RescheduleInput) -> Result<Value, Error> {
        self.call("slotlock_reschedule", serde_json::to_value(input)?)
    }

    /// Cancel an event.
    ///
    /// Cancel one of your events at the revision you last read (expected_revision); a stale one
    /// is 409 revision_conflict. Its time is free at once. A retry answers the same cancellation
    /// (replayed).
    pub fn cancel(&self, input: &CancelInput) -> Result<Value, Error> {
        self.call("slotlock_cancel", serde_json::to_value(input)?)
    }

    /// Get a resource.
    ///
    /// One resource of the tenant, archived or not, with its own weekly bookable hours and its
    /// visibility.
    pub fn get_resource(&self, input: &GetResourceInput) -> Result<Value, Error> {
        self.call("slotlock_get_resource", serde_json::to_value(input)?)
    }

    /// Change a resource's profile.
    ///
    /// Change a resource's name, description, kind, capacity, labels, attributes or location: the
    /// fields given, keeping the rest. null clears a name, description, capacity or location; []
    /// and {} clear labels and attributes. A location the tenant does not have answers 404
    /// location_not_found. The feed's resource.updated names the fields that changed
    /// (profile_changed), never their values. 400 invalid_resource_profile outside the bounds,
    /// naming the field.
    pub fn update_resource(&self, input: &UpdateResourceInput) -> Result<Value, Error> {
        self.call("slotlock_update_resource", serde_json::to_value(input)?)
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

    /// List locations.
    ///
    /// The tenant's locations, each after the one it is in (depth first), with how many resources
    /// are at each. A tree of at most 5 levels and 1000 locations: a region, a site, a building,
    /// a floor, a zone, or whatever yours are.
    pub fn list_locations(&self, input: &ListLocationsInput) -> Result<Value, Error> {
        self.call("slotlock_list_locations", serde_json::to_value(input)?)
    }

    /// Create or update a location.
    ///
    /// Create the location with this reference, or change its name, and the parent and time zone
    /// given. 404 location_not_found for a parent the tenant does not have; 409 location_too_deep
    /// past 5 levels, location_cycle under itself, location_limit_reached past 1000.
    pub fn create_location(&self, input: &CreateLocationInput) -> Result<Value, Error> {
        self.call("slotlock_create_location", serde_json::to_value(input)?)
    }

    /// Change a location.
    ///
    /// Change a location's name, parent or time zone: the fields given. Refused as creating one
    /// is.
    pub fn update_location(&self, input: &UpdateLocationInput) -> Result<Value, Error> {
        self.call("slotlock_update_location", serde_json::to_value(input)?)
    }

    /// Delete a location.
    ///
    /// Delete a location. Refused with 409 location_in_use while a resource is at it or a
    /// location is in it: move them first. deleted is false when the tenant has no such location.
    pub fn delete_location(&self, input: &DeleteLocationInput) -> Result<Value, Error> {
        self.call("slotlock_delete_location", serde_json::to_value(input)?)
    }

    /// List groups.
    ///
    /// The tenant's groups, by reference, with how many resources are in each: any sets you want
    /// (a team, a department, a contract), at most 500. A group changes nothing about how its
    /// resources are booked; a pool does that.
    pub fn list_groups(&self, input: &ListGroupsInput) -> Result<Value, Error> {
        self.call("slotlock_list_groups", serde_json::to_value(input)?)
    }

    /// Create or update a group.
    ///
    /// Create the group with this reference, or change its name, and its description when given.
    /// 409 group_limit_reached past 500.
    pub fn create_group(&self, input: &CreateGroupInput) -> Result<Value, Error> {
        self.call("slotlock_create_group", serde_json::to_value(input)?)
    }

    /// Delete a group.
    ///
    /// Delete a group; its resources stay as they are. deleted is false when the tenant has no
    /// such group.
    pub fn delete_group(&self, input: &DeleteGroupInput) -> Result<Value, Error> {
        self.call("slotlock_delete_group", serde_json::to_value(input)?)
    }

    /// Put a resource in a group.
    ///
    /// Put one of the tenant's resources in a group. added is false when it was in it already.
    /// 404 group_not_found or resource_not_found; 409 resource_group_limit_reached past 20 groups
    /// a resource.
    pub fn add_group_member(&self, input: &AddGroupMemberInput) -> Result<Value, Error> {
        self.call("slotlock_add_group_member", serde_json::to_value(input)?)
    }

    /// Take a resource out of a group.
    ///
    /// Take a resource out of a group. removed is false when it was not in it.
    pub fn remove_group_member(&self, input: &RemoveGroupMemberInput) -> Result<Value, Error> {
        self.call("slotlock_remove_group_member", serde_json::to_value(input)?)
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
    /// Give one resource its own weekly bookable hours. `null` makes it inherit: its location's
    /// hours (the nearest up the chain), else the tenant's, else the server's; `[]` makes it
    /// never bookable. Each rule is weekly with BYDAY, in the resource's time zone: start_minutes
    /// after midnight, lasting duration_minutes.
    pub fn set_resource_availability(&self, input: &SetResourceAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_set_resource_availability", serde_json::to_value(input)?)
    }

    /// Export a resource's bookable hours as iCalendar.
    ///
    /// The weekly bookable hours that apply to one resource (its own, or those it inherits) as an
    /// iCalendar VAVAILABILITY (RFC 7953) for a calendar or scheduling tool: an AVAILABLE per
    /// rule, its DTSTART's TZID the resource's IANA time zone. The closures and special hours of
    /// the next year are there too: an EXDATE takes a weekly window off a day, and an AVAILABLE
    /// with RDATEs gives a day its own hours. `null` when the resource uses the server's default.
    pub fn export_resource_availability(&self, input: &ExportResourceAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_export_resource_availability", serde_json::to_value(input)?)
    }

    /// Import a resource's bookable hours from iCalendar.
    ///
    /// Set one resource's own weekly bookable hours from an iCalendar VAVAILABILITY (RFC 7953),
    /// as slotlock_set_resource_availability does from rules: each AVAILABLE a weekly RRULE with
    /// a start time and DTEND or DURATION. EXDATE, RDATE and single AVAILABLEs become the
    /// resource's exceptions, replacing those an earlier import made: each day they name keeps
    /// the windows left on it, or is closed with none. Times must be in the resource's time zone
    /// (its TZID) or floating. 400 invalid_availability names what cannot be said: a bounded
    /// VAVAILABILITY, RECURRENCE-ID, another zone, more than four windows on a day.
    pub fn import_resource_availability(&self, input: &ImportResourceAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_import_resource_availability", serde_json::to_value(input)?)
    }

    /// Set a resource's booking rules.
    ///
    /// Set what a booking on one resource must satisfy from now on: minimum notice, how far
    /// ahead, the step starts fall on (from local midnight in the resource's time zone, offset by
    /// step_offset_minutes), the time kept free before and after each booking (turnaround up to a
    /// week), whether bookings must lie inside its hours, how long a booking may be
    /// (min_duration_minutes, max_duration_minutes, allowed_durations, and
    /// default_duration_minutes for a search that names no length), and for a booking from one
    /// local day to another, the pickup_times it starts in and the return_times it ends in.
    /// `null` clears them. A rule it does not set comes from its pool's or the tenant's defaults
    /// (slotlock_set_pool_booking_rules, slotlock_set_tenant_booking_rules). Holds, reservations,
    /// moves and agents' events are refused with the rule they break; searches offer only what
    /// they allow.
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

    /// Make a resource part of another.
    ///
    /// Make a resource a part of a composite (a room of a hall, a half of a court), or no part
    /// (`null`). A booking of the composite as a whole then conflicts with a booking of any of
    /// its parts, and two parts never conflict with each other; each part's free/busy shows the
    /// whole's bookings, and the whole's shows its parts'. One level deep, at most 50 parts;
    /// refused while either side has a booking or live hold still to come (`composite_busy`).
    pub fn set_resource_parent(&self, input: &SetResourceParentInput) -> Result<Value, Error> {
        self.call("slotlock_set_resource_parent", serde_json::to_value(input)?)
    }

    /// List pools.
    ///
    /// The tenant's pools by name, each with its capacity (how many members it has that are not
    /// archived) and the order slotlock_book_pool tries them in.
    pub fn list_pools(&self, input: &ListPoolsInput) -> Result<Value, Error> {
        self.call("slotlock_list_pools", serde_json::to_value(input)?)
    }

    /// Set a pool's order.
    ///
    /// The order slotlock_book_pool tries a pool's members in: stable (by id, the default),
    /// least_booked (fewest bookings made on each in the last 30 days first, to share them out)
    /// or round_robin (from the member after the one booked last). At most 1,000 pools have one:
    /// one more is 409 pool_order_limit_reached.
    pub fn set_pool_order(&self, input: &SetPoolOrderInput) -> Result<Value, Error> {
        self.call("slotlock_set_pool_order", serde_json::to_value(input)?)
    }

    /// Get default booking rules.
    ///
    /// The tenant's default booking rules, and each pool's that has them. A resource's rules as
    /// they apply (effective_booking_rules) are the tenant's defaults, overlaid by its pool's,
    /// overlaid by its own: a rule set at a narrower level wins.
    pub fn get_booking_rule_defaults(&self, input: &GetBookingRuleDefaultsInput) -> Result<Value, Error> {
        self.call("slotlock_get_booking_rule_defaults", serde_json::to_value(input)?)
    }

    /// Set default booking rules.
    ///
    /// Set the booking rules every resource of the tenant has unless its pool or its own rules
    /// set the same rule, from now on; `null` clears them. They take any resource rule but
    /// check_in_minutes, which only a resource sets.
    pub fn set_tenant_booking_rules(&self, input: &SetTenantBookingRulesInput) -> Result<Value, Error> {
        self.call("slotlock_set_tenant_booking_rules", serde_json::to_value(input)?)
    }

    /// Set a pool's booking rules.
    ///
    /// Set the booking rules every member of one pool has unless its own rules set the same rule,
    /// over the tenant's defaults, from now on; `null` clears them. They take any resource rule
    /// but check_in_minutes. At most 1,000 pools have them: one more is 409
    /// pool_rules_limit_reached.
    pub fn set_pool_booking_rules(&self, input: &SetPoolBookingRulesInput) -> Result<Value, Error> {
        self.call("slotlock_set_pool_booking_rules", serde_json::to_value(input)?)
    }

    /// A resource's history.
    ///
    /// What happened on one of the tenant's resources, newest first: each hold, booking and event
    /// made, moved, confirmed, released or cancelled, and each change to the resource itself
    /// (created, rules, pool or hours changed, archived, restored, coverage recorded or deleted),
    /// when, by whom (the actor and API key), from where (origin), and for a change what it was
    /// before. Kept 30 days. Pass next_before as before for older entries.
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

    /// Read stored bookable hours.
    ///
    /// The tenant's stored weekly hours (`null` when it uses the server's default) and each
    /// location's that has its own. A resource without its own uses its location's, the nearest
    /// up the chain, then the tenant's, then the server's.
    pub fn get_availability_defaults(&self, input: &GetAvailabilityDefaultsInput) -> Result<Value, Error> {
        self.call("slotlock_get_availability_defaults", serde_json::to_value(input)?)
    }

    /// Set the tenant's bookable hours.
    ///
    /// Store the tenant's weekly bookable hours: every resource without hours of its own, and
    /// with no location hours above it, uses them, resources added later too. `null` hands them
    /// back to the server's default. Nothing is copied: a resource with its own hours keeps them,
    /// unless override_resources is true, which clears them so every resource inherits.
    /// resources_updated counts the resources in use these hours now apply to;
    /// resources_with_own_hours, those that keep their own.
    pub fn set_tenant_availability(&self, input: &SetTenantAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_set_tenant_availability", serde_json::to_value(input)?)
    }

    /// Set a location's bookable hours.
    ///
    /// Store a location's weekly bookable hours, each read in a resource's own time zone:
    /// resources at it, or at a location inside it, without hours of their own use them, unless a
    /// location nearer them has its own. `null` clears them, so they inherit from further up. 404
    /// location_not_found for a location the tenant does not have.
    pub fn set_location_availability(&self, input: &SetLocationAvailabilityInput) -> Result<Value, Error> {
        self.call("slotlock_set_location_availability", serde_json::to_value(input)?)
    }

    /// List closures and special hours.
    ///
    /// The tenant's exceptions to its weekly hours, by first day: with resource_id, those that
    /// apply to that resource (the tenant's, its locations' and its own); with location, that
    /// location's own; else all of them. from and to keep those that reach the days between. At
    /// most limit (1-1,000, default 100); next is the cursor for after.
    pub fn list_availability_exceptions(&self, input: &ListAvailabilityExceptionsInput) -> Result<Value, Error> {
        self.call("slotlock_list_availability_exceptions", serde_json::to_value(input)?)
    }

    /// Add a closure or special hours.
    ///
    /// Close whole days, or give them hours of their own, for the whole tenant, one location (and
    /// every location inside it) or one resource. starts_on to ends_on (inclusive, at most 367
    /// days) are local days, read in each resource's time zone. outcome closed empties those
    /// days; open replaces their weekly hours with hours (1-4 windows of start_minutes and
    /// duration_minutes). Where several apply to a day, the nearest wins: the resource's own,
    /// then its location's from the innermost out, then the tenant's. Search leaves the days as
    /// they say; a write is refused outside_hours only under the enforce_hours booking rule. 409
    /// availability_exceptions_limit_reached past 5,000 a tenant.
    pub fn create_availability_exception(&self, input: &CreateAvailabilityExceptionInput) -> Result<Value, Error> {
        self.call("slotlock_create_availability_exception", serde_json::to_value(input)?)
    }

    /// Delete a closure or special hours.
    ///
    /// Remove an exception: its days read as the weekly hours again. 404
    /// availability_exception_not_found.
    pub fn delete_availability_exception(&self, input: &DeleteAvailabilityExceptionInput) -> Result<Value, Error> {
        self.call("slotlock_delete_availability_exception", serde_json::to_value(input)?)
    }

    /// Import a holiday calendar.
    ///
    /// Close the days an iCalendar holiday calendar names, for the whole tenant, one location or
    /// one resource: the text in icalendar, or an https url the server fetches (at most 1 MB, 10
    /// seconds; private addresses refused). Each all-day event closes the days it covers, and
    /// each occurrence of a recurring one within from to to (default today to two years on, at
    /// most three years); timed and cancelled events are skipped. Importing the same calendar
    /// again updates its closures instead of adding more. 400 invalid_holiday_calendar for text
    /// that is not one; 400 holiday_calendar_unreachable when the url cannot be read; 400
    /// holiday_url_not_served where the server fetches no urls.
    pub fn import_holidays(&self, input: &ImportHolidaysInput) -> Result<Value, Error> {
        self.call("slotlock_import_holidays", serde_json::to_value(input)?)
    }

    /// Hold time.
    ///
    /// Occupy a window without booking it, for example while a customer pays. The hold blocks
    /// every other booking until it expires (the database clock, ttl_seconds from now), is
    /// confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and
    /// a confirmed hold keeps it. With payment_required (ttl_seconds at most 1800), it cannot be
    /// confirmed until slotlock_mark_hold_paid records the payment, which must be at least
    /// payment (amount_minor in the minor unit of its currency, and the currency) when given:
    /// Slotlock records payment state and never moves money. A taken window answers 409 overlap.
    /// With an idempotency key (the Idempotency-Key header or idempotency_key), a retry answers
    /// the hold the first request made, until that hold would have expired, is released or is
    /// confirmed; the same key with another request is 422 idempotency_conflict.
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
    /// unknown one, 404 hold_not_found; one that waits for payment not yet recorded, 409
    /// payment_required.
    pub fn confirm_hold(&self, input: &ConfirmHoldInput) -> Result<Value, Error> {
        self.call("slotlock_confirm_hold", serde_json::to_value(input)?)
    }

    /// Record a hold as paid.
    ///
    /// Record that a hold made with payment_required is paid, by the payment's reference at your
    /// processor (a Stripe PaymentIntent id, say), once you have verified it: the hold may then
    /// be confirmed. Slotlock records payment state and never moves money. The same reference
    /// again answers the same hold (replayed: true); another answers 409 payment_conflict. When
    /// the hold names its payment, received must be at least that amount in that currency (409
    /// payment_amount_mismatch). The feed says so (hold.paid). A hold that does not wait for
    /// payment answers 409 payment_not_required; one that expired, 409 hold_expired (refund the
    /// payment: its time may be someone else's); a confirmed, released or unknown one, 404
    /// hold_not_found.
    pub fn mark_hold_paid(&self, input: &MarkHoldPaidInput) -> Result<Value, Error> {
        self.call("slotlock_mark_hold_paid", serde_json::to_value(input)?)
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
    /// reservation where it was. buffer_after_minutes keeps the time after it busy as well. A
    /// move past the resource's reschedule cutoff answers 409 booking_rule_reschedule_cutoff
    /// unless override_reason says why, which the feed keeps. local_start (YYYY-MM-DDTHH:MM in
    /// the resource's zone) records the wall time it is booked for: it must name start, and if
    /// time zone rules later move that wall time to another instant, maintenance says so
    /// (reservation.timezone_shifted) or follows it. 400 invalid_local_start otherwise.
    /// contact_ref names whom to tell about it (slotlock_put_contact) and notify: false says to
    /// tell no one; both are on the feed with each change, as sent with each revision.
    /// reminder_minutes (up to five, distinct) puts reminder.due on the feed that long before its
    /// start, once each, and again if it moves.
    pub fn put_reservation(&self, input: &PutReservationInput) -> Result<Value, Error> {
        self.call("slotlock_put_reservation", serde_json::to_value(input)?)
    }

    /// Cancel a reservation.
    ///
    /// Cancel the reservation with this reference at the next revision (the current one plus 1).
    /// Cancelling leaves a tombstone, so a delayed booking cannot bring it back; repeating the
    /// cancel answers cancelled: false. Use a new reference for a new reservation. Past the
    /// resource's cancel cutoff it answers 409 booking_rule_cancel_cutoff unless override_reason
    /// says why, which the tombstone and the feed keep. A late cancellation's fee (the resource's
    /// cancellation_fee) is answered in cancellation_fee and kept on the feed, for you to charge:
    /// Slotlock moves no money.
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

    /// Get a contact.
    ///
    /// The person kept under this reference, for a sender to reach. An unknown one answers 404
    /// contact_not_found.
    pub fn get_contact(&self, input: &GetContactInput) -> Result<Value, Error> {
        self.call("slotlock_get_contact", serde_json::to_value(input)?)
    }

    /// Keep a contact.
    ///
    /// Keep a person a booking may name to be told about it (contact_ref on
    /// slotlock_put_reservation), under your own reference: how to reach them (email, phone for
    /// SMS and whatsapp, both E.164) and which channels they agreed to (consent: false is an
    /// opt-out a sender must honour). Replaces what was kept under the reference. A sender reads
    /// it to send; Slotlock itself sends nothing. created says whether it is new. A tenant keeps
    /// at most 100,000 (409 contact_limit_reached).
    pub fn put_contact(&self, input: &PutContactInput) -> Result<Value, Error> {
        self.call("slotlock_put_contact", serde_json::to_value(input)?)
    }

    /// Forget a contact.
    ///
    /// Forget a person: their contact, and their reference on every booking that named it, at
    /// once (for an erasure request). deleted is false when no contact was kept; bookings counts
    /// the bookings that no longer name them. Changes already on the feed keep the reference,
    /// never the person.
    pub fn delete_contact(&self, input: &DeleteContactInput) -> Result<Value, Error> {
        self.call("slotlock_delete_contact", serde_json::to_value(input)?)
    }

    /// List contacts.
    ///
    /// The people the tenant keeps to tell about bookings, by reference, a page at a time: pass
    /// next_cursor as cursor for the next page, until it is null.
    pub fn list_contacts(&self, input: &ListContactsInput) -> Result<Value, Error> {
        self.call("slotlock_list_contacts", serde_json::to_value(input)?)
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
    /// taken now, or with duration_minutes for any slot of that length within it. When time comes
    /// free (a booking cancelled, a hold released or expired, a no-show), the entries waiting are
    /// offered in the order they joined: the first that fits gets a hold of it (the window, or
    /// the earliest slot of its length) for holder_ref, for offer_ttl_seconds (default 900), and
    /// the feed says so (waitlist.offered, with hold_id). Confirm the hold to book it
    /// (waitlist.accepted), decline it with slotlock_decline_waitlist_offer (waitlist.declined),
    /// or let it lapse (waitlist.lapsed); either way the time goes to the next. An entry no slot
    /// can be offered to before its window closes expires (waitlist.expired). Joining and leaving
    /// are on the feed too (waitlist.joined, waitlist.left). A holder may wait for 20 windows at
    /// once (409 waitlist_limit_reached); a window is at most 31 days. With an idempotency key
    /// (the Idempotency-Key header or idempotency_key), a retry answers the entry the first
    /// request made (replayed: true) for as long as it is kept; the same key with another request
    /// is 422 idempotency_conflict.
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

    /// Decline a waitlist offer.
    ///
    /// Turn down the hold a waitlist entry was offered: the hold is let go, the entry is declined
    /// (waitlist.declined), and the time is offered to the next who waits. 404
    /// waitlist_offer_not_found when the entry has no open offer.
    pub fn decline_waitlist_offer(&self, input: &DeclineWaitlistOfferInput) -> Result<Value, Error> {
        self.call("slotlock_decline_waitlist_offer", serde_json::to_value(input)?)
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

    /// Record a calendar's busy time.
    ///
    /// For a calendar that gives busy time but not its events (Google freeBusy, Microsoft
    /// getSchedule): record its coverage of a window at the source's revision, as
    /// slotlock_record_coverage does, and the busy time in it, which replaces what the source
    /// said of that window before (what it said outside the window stays). Busy time counts in
    /// free/busy and every booking Slotlock makes on the resource is refused over it (409
    /// overlap), as over an event. A confirmed booking the source newly reports busy time over is
    /// left as it is and put on the feed once as coverage.conflict, naming the booking and the
    /// source by its source_id: someone decides. At most 5000 intervals; they are clipped to the
    /// window and merged. Revisions only go forward; repeating one changes nothing (replayed:
    /// true).
    pub fn put_source_busy(&self, input: &PutSourceBusyInput) -> Result<Value, Error> {
        self.call("slotlock_put_source_busy", serde_json::to_value(input)?)
    }

    /// Report a booking changed in a calendar.
    ///
    /// For a calendar sync that writes bookings to a calendar: report that one (by
    /// reservation_ref or event_id) was changed (changed_in_calendar, with where the calendar now
    /// has it) or removed (removed_from_calendar) there. It is put on the change feed as
    /// coverage.conflict, named by the source's source_id, with the booking and the calendar's
    /// times; the booking is left as it is, for someone to decide. 404 coverage_not_found for a
    /// source that has not recorded coverage of the resource; reservation_not_found or
    /// event_not_found for a booking not on it.
    pub fn report_coverage_conflict(&self, input: &ReportCoverageConflictInput) -> Result<Value, Error> {
        self.call("slotlock_report_coverage_conflict", serde_json::to_value(input)?)
    }

    /// A resource's coverage and its health.
    ///
    /// Each external calendar (source) that records coverage of a resource: the window it covers,
    /// when it was last read, its last error, and whether it is stale (not read for a day, so the
    /// time it covers is unproven, not free). A source that goes stale is also put on the change
    /// feed once, as coverage.stale, until it is read again. The feed names a source by its
    /// source_id (random, made when the source is first recorded for the resource and kept until
    /// it is deleted), never the source itself.
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

    /// Book resources together, as the tenant.
    ///
    /// Book the same time on 2-20 resources at once, all or none, as agents'
    /// slotlock_book_together does but for the tenant's own systems (RFC 0004 B7): each is an
    /// event the key owns, held to the resources' booking rules. If any is taken, nothing is
    /// booked and the refusal names that resource_id. A retry with the same idempotency_key
    /// answers the same events. 409 bundles_unavailable where the server books no bundles.
    pub fn tenant_book_together(&self, input: &TenantBookTogetherInput) -> Result<Value, Error> {
        self.call("slotlock_tenant_book_together", serde_json::to_value(input)?)
    }

    /// Book any member of a pool, as the tenant.
    ///
    /// Book any one free member of a pool for a time, as agents' slotlock_book_pool does but for
    /// the tenant's own systems (RFC 0004 B7), in the pool's order: the event names the member.
    /// 409 pool_full when none is free; 404 pool_not_found. A retry with the same idempotency_key
    /// answers the member it booked.
    pub fn tenant_book_pool(&self, input: &TenantBookPoolInput) -> Result<Value, Error> {
        self.call("slotlock_tenant_book_pool", serde_json::to_value(input)?)
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
    /// tenant_suspended), nor can one whose hosted plan is still paid for until it is cancelled
    /// (409 billing_active). Erasing again deletes nothing.
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
    /// cancelled; resources created, changed (rules, pool, hours), archived, restored or deleted;
    /// coverage sources recorded or deleted; webhooks added, enabled or deleted; API keys
    /// created, rotated or revoked (ids, times and states, never titles, attendees, URLs or
    /// secrets). Each names where it came from (slotlockorigin) and the API key that made it
    /// (slotlockkeyid) when recorded. Pass next_cursor as cursor to read on; it is returned even
    /// when nothing is new, so poll with it. Only changes of transactions that have ended are
    /// listed, so following the cursor never skips one. Changes are kept 30 days: an older cursor
    /// answers 410 cursor_expired, so start again without one.
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
    /// here only. At most 25 per tenant, or fewer on a plan (409 webhook_limit_reached). With
    /// resource_ids, pools, locations (each with every location in it) or groups, only changes
    /// about a resource that matches one of them, as it is when the change is delivered: a change
    /// about no resource (a key, a webhook, a usage notice) is not sent. At most 100 resource ids
    /// and 20 of each other kind (400 invalid_webhook_filter). With an idempotency key (the
    /// Idempotency-Key header or idempotency_key), a retry answers the webhook and secret the
    /// first request made (replayed: true) for as long as the webhook is kept; the same key with
    /// another request is 422 idempotency_conflict.
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

    /// Read usage.
    ///
    /// How much the tenant used the service from one UTC day to another (inclusive, at most 400
    /// days apart; by default the first of this month to today): operations its keys and the
    /// dashboard assistant ran (each call that reached its operation, whatever it returned),
    /// bookings (bookings, events and confirmed holds) and holds it made, webhook deliveries its
    /// endpoints accepted, messages to the dashboard assistant, and the resources it held (each
    /// day's count, archived ones included; in totals, the last day's, not a sum). Totals, then
    /// by day, by API key (key_id null for none) and by surface (mcp, a2a, rest, application,
    /// dashboard-assistant, webhooks); resources are by day only. Counts only, never what was
    /// asked. Empty unless the server meters usage (SLOTLOCK_USAGE=on); operations, deliveries
    /// and messages appear within 15 seconds; bookings, holds and resources within the hour. 400
    /// invalid_usage_range when to is before from, the range is longer than 400 days, or to is
    /// after today.
    pub fn get_usage(&self, input: &GetUsageInput) -> Result<Value, Error> {
        self.call("slotlock_get_usage", serde_json::to_value(input)?)
    }

    /// List approval policies.
    ///
    /// The tenant's approval policies, by reference: which agent bookings wait for a person
    /// (require_approval) or are refused (refuse).
    pub fn list_approval_policies(&self, input: &ListApprovalPoliciesInput) -> Result<Value, Error> {
        self.call("slotlock_list_approval_policies", serde_json::to_value(input)?)
    }

    /// Create or replace an approval policy.
    ///
    /// Which agent bookings (slotlock_create_event, slotlock_confirm_slot, slotlock_book_pool,
    /// slotlock_book_together, and moves by slotlock_update_event or slotlock_reschedule) a
    /// person approves first, or are refused. applies_to names resources, pools, locations (with
    /// the locations in them) and groups; empty, every resource. conditions narrow it:
    /// longer_than_minutes, outside_hours (outside the resource's bookable hours), kinds (single,
    /// pool, bundle, move); a booking meets the policy when it meets every condition given.
    /// outcome require_approval holds the exact time the booking would take, under the approval,
    /// and answers the agent 409 approval_pending; refuse answers 403 approval_policy_refused. A
    /// person has approval_ttl_minutes to decide (default 1,440; at most 43,200, and the server's
    /// ceiling), and must decide lead_minutes before the booking starts: the wait is the earlier
    /// of the two. Where several apply, refuse wins, then the one that must be decided soonest.
    /// At most 50 policies: one more is 409 approval_policy_limit_reached.
    pub fn put_approval_policy(&self, input: &PutApprovalPolicyInput) -> Result<Value, Error> {
        self.call("slotlock_put_approval_policy", serde_json::to_value(input)?)
    }

    /// Delete an approval policy.
    ///
    /// Stop applying a policy to new bookings. Approvals it already asked for stay as they are,
    /// to be decided.
    pub fn delete_approval_policy(&self, input: &DeleteApprovalPolicyInput) -> Result<Value, Error> {
        self.call("slotlock_delete_approval_policy", serde_json::to_value(input)?)
    }

    /// List approvals.
    ///
    /// The tenant's approvals, newest first: bookings an agent asked for that a policy holds for
    /// a person (pending, holding their time until expires_at), and those decided (granted,
    /// declined, expired). Filter by status.
    pub fn list_approvals(&self, input: &ListApprovalsInput) -> Result<Value, Error> {
        self.call("slotlock_list_approvals", serde_json::to_value(input)?)
    }

    /// Get an approval.
    ///
    /// One approval by id, with the booking it would make. 404 approval_not_found.
    pub fn get_approval(&self, input: &GetApprovalInput) -> Result<Value, Error> {
        self.call("slotlock_get_approval", serde_json::to_value(input)?)
    }

    /// Grant or decline an approval.
    ///
    /// Decide a pending approval. grant makes the booking as the agent asked for it, as that
    /// agent, in one transaction with letting the approval's hold go, and answers it under
    /// booking; the agent's retry with its idempotency key then answers the same booking. A write
    /// refused now (a booking rule changed, say) is refused with its own code and the approval
    /// stays pending. decline frees the time; the agent's retry answers 403 approval_declined
    /// with the reason. 404 approval_not_found; 409 approval_not_pending when already decided;
    /// 409 approval_expired after its wait.
    pub fn decide_approval(&self, input: &DecideApprovalInput) -> Result<Value, Error> {
        self.call("slotlock_decide_approval", serde_json::to_value(input)?)
    }

    /// Seed the test environment.
    ///
    /// Fill an empty test environment (a key starting slk_test_) with a scenario to try an agent
    /// against: car-rental (cars and vans in pools at two branches, 30-minute turnaround), clinic
    /// (practitioners and treatment rooms, half-hour slots on weekdays) or desks (desks on two
    /// floors, and a hall that splits in two). Locations, groups, resources with profiles, hours
    /// and booking rules, and three bookings tomorrow. 409 sandbox_not_empty when it has
    /// resources: reset it first. 403 sandbox_test_only for a live key.
    pub fn sandbox_seed(&self, input: &SandboxSeedInput) -> Result<Value, Error> {
        self.call("slotlock_sandbox_seed", serde_json::to_value(input)?)
    }

    /// Empty the test environment.
    ///
    /// Empty the test environment as if new: its resources, locations, groups, bookings, events,
    /// holds, waitlist, approval policies and feed. Its API keys, webhooks, plan and usage stay.
    /// Rows removed, by table. 403 sandbox_test_only for a live key.
    pub fn sandbox_reset(&self, input: &SandboxResetInput) -> Result<Value, Error> {
        self.call("slotlock_sandbox_reset", serde_json::to_value(input)?)
    }

    /// Move the test environment's waiting forward.
    ///
    /// Make what would lapse in the test environment within minutes (1-525,600) lapse now: holds
    /// (a waitlist offer's and an approval's among them) and pending approvals; then a
    /// maintenance pass reaps them as it would have, releasing holds, passing offers on and
    /// expiring approvals, on the feed as usual. Bookings and events keep their times; no-shows
    /// and series follow the real clock. 403 sandbox_test_only for a live key.
    pub fn sandbox_fast_forward(&self, input: &SandboxFastForwardInput) -> Result<Value, Error> {
        self.call("slotlock_sandbox_fast_forward", serde_json::to_value(input)?)
    }

    /// Race agents for one slot in the test environment.
    ///
    /// Race agents (2-200, default 100), each an agent of its own, for one time on one resource
    /// of the test environment, through the same path MCP, A2A and REST use: how many booked
    /// (one), how many were refused and why (overlap, with alternatives), any server errors, and
    /// how long the answers took. 403 sandbox_test_only for a live key.
    pub fn sandbox_race(&self, input: &SandboxRaceInput) -> Result<Value, Error> {
        self.call("slotlock_sandbox_race", serde_json::to_value(input)?)
    }

    /// Read an account.
    ///
    /// One of the partner's accounts, with how many resources (archived ones included) and active
    /// API keys it holds. 404 account_not_found for an account the partner does not have.
    pub fn partner_get_account(&self, input: &PartnerGetAccountInput) -> Result<Value, Error> {
        self.call("slotlock_partner_get_account", serde_json::to_value(input)?)
    }

    /// Create or update an account.
    ///
    /// Create the partner's account with this id (your own id for your user, 1-128 letters,
    /// digits, dots, dashes or underscores), or put it on another plan: one of your contract's,
    /// whose limits and monthly quotas the account then has. Its tenant is
    /// partner:<partner>:<account>, an ordinary Slotlock tenant of its own. Repeating the call
    /// changes nothing more. 400 invalid_partner_plan for a plan your contract does not have.
    pub fn partner_put_account(&self, input: &PartnerPutAccountInput) -> Result<Value, Error> {
        self.call("slotlock_partner_put_account", serde_json::to_value(input)?)
    }

    /// List accounts.
    ///
    /// The partner's accounts, by id: plan, whether suspended, and when made and last changed.
    pub fn partner_list_accounts(&self, input: &PartnerListAccountsInput) -> Result<Value, Error> {
        self.call("slotlock_partner_list_accounts", serde_json::to_value(input)?)
    }

    /// List an account's keys.
    ///
    /// The account's API keys, revoked and expired ones included, newest first; never the keys
    /// themselves.
    pub fn partner_list_keys(&self, input: &PartnerListKeysInput) -> Result<Value, Error> {
        self.call("slotlock_partner_list_keys", serde_json::to_value(input)?)
    }

    /// Create a key for an account.
    ///
    /// An API key for the account, shown once in key and never again; only its SHA-256 is kept.
    /// Give it to your user's calls: it acts in the account's tenant, over MCP, A2A and REST, as
    /// any key. environment: test makes it in the account's test environment instead (a tenant of
    /// its own, on the same plan, never billed; its keys start slk_test_). scopes: some of the
    /// ones your contract allows (read and write unless it says), by default all of them;
    /// expires_in_days: 1-3650, or none. limits hold the key's agent below the server's limits:
    /// max_holds live at once, max_held_hours they hold together, requests_per_minute, and
    /// requires_approval to make every booking it asks for wait for a person (the account's
    /// Approvals). 403 scope_not_in_contract for another scope; 409 api_key_limit_reached past
    /// the account plan's keys.
    pub fn partner_create_key(&self, input: &PartnerCreateKeyInput) -> Result<Value, Error> {
        self.call("slotlock_partner_create_key", serde_json::to_value(input)?)
    }

    /// Rotate an account's key.
    ///
    /// A new secret for one of the account's active keys, shown once; the old one stops at once.
    /// The key keeps its id and what it booked. 404 key_not_found otherwise.
    pub fn partner_rotate_key(&self, input: &PartnerRotateKeyInput) -> Result<Value, Error> {
        self.call("slotlock_partner_rotate_key", serde_json::to_value(input)?)
    }

    /// Revoke an account's key.
    ///
    /// Revoke one of the account's keys at once; revoking it again changes nothing. 404
    /// key_not_found otherwise.
    pub fn partner_revoke_key(&self, input: &PartnerRevokeKeyInput) -> Result<Value, Error> {
        self.call("slotlock_partner_revoke_key", serde_json::to_value(input)?)
    }

    /// Suspend an account.
    ///
    /// Suspend the account, as slotlock tenant suspend: it may read, and writes nothing; its keys
    /// get no new secret. suspended says whether it was not suspended already.
    pub fn partner_suspend_account(&self, input: &PartnerSuspendAccountInput) -> Result<Value, Error> {
        self.call("slotlock_partner_suspend_account", serde_json::to_value(input)?)
    }

    /// Lift a suspension.
    ///
    /// Lift a suspension the partner made. One Pylota made stays: unsuspended is false then, as
    /// when the account was not suspended.
    pub fn partner_unsuspend_account(&self, input: &PartnerUnsuspendAccountInput) -> Result<Value, Error> {
        self.call("slotlock_partner_unsuspend_account", serde_json::to_value(input)?)
    }

    /// Erase an account.
    ///
    /// Erase the account's tenant, every row it owns, as /v1/tenant/erase, and the partner's
    /// record of it. confirm repeats the account. Cannot be undone.
    pub fn partner_erase_account(&self, input: &PartnerEraseAccountInput) -> Result<Value, Error> {
        self.call("slotlock_partner_erase_account", serde_json::to_value(input)?)
    }

    /// Read the accounts' usage.
    ///
    /// The partner's accounts' usage, the counts Pylota invoices from, by account, UTC day and
    /// metric (operations, bookings, holds, webhook_deliveries, resources: each day's count),
    /// from one UTC day to another (inclusive, at most 400 days apart; by default this month);
    /// one account, or all. 400 invalid_usage_range otherwise.
    pub fn partner_get_usage(&self, input: &PartnerGetUsageInput) -> Result<Value, Error> {
        self.call("slotlock_partner_get_usage", serde_json::to_value(input)?)
    }

    /// Compare your counts with ours.
    ///
    /// Send your count of each account's operations (and, if you keep them, bookings) on one
    /// ended UTC day, as your daily cross-check: the answer gives ours beside yours for every
    /// account either of us counted, the difference in percent, and whether every one is within
    /// 0.5%. A day outside that is recorded as a mismatch, which Pylota looks into. Sending the
    /// same day again replaces its record.
    pub fn partner_reconcile_usage(&self, input: &PartnerReconcileUsageInput) -> Result<Value, Error> {
        self.call("slotlock_partner_reconcile_usage", serde_json::to_value(input)?)
    }

}
