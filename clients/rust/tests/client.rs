//! The Rust client against a running Slotlock server, and its checks that need none. The server
//! tests run when SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY (a key with read, write and admin) are set,
//! against a server that confirms only deletes (SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event).
//! Every language client runs the same scenario.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use slotlock::*;

fn all_week() -> Vec<Value> {
    vec![
        json!({"rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", "start_minutes": 0, "duration_minutes": 1440}),
    ]
}

#[test]
fn refuses_to_send_a_key_over_plain_http_to_another_host() {
    let refused = Client::new("http://calendar.example.com", "slk_x").unwrap_err();
    assert!(refused.to_string().contains("unencrypted"), "{refused}");
    let insecure = Options {
        allow_insecure: true,
        ..Options::default()
    };
    assert!(Client::with_options("http://calendar.example.com", "slk_x", insecure).is_ok());
    assert!(Client::new("http://localhost:8080", "slk_x").is_ok());
    assert!(Client::new("https://calendar.example.com/", "slk_x").is_ok());
    for url in [
        "ftp://example.com",
        "calendar.example.com",
        "https://example.com/?a=1",
    ] {
        assert!(Client::new(url, "slk_x").is_err(), "{url}");
    }
    for key in ["", "slk_ x", "slk_\n"] {
        assert!(Client::new("https://example.com", key).is_err(), "{key:?}");
    }
}

#[test]
fn never_shows_the_key() {
    let client = Client::new("https://calendar.example.com", "slk_secret").unwrap();
    assert!(!format!("{client:?}").contains("slk_secret"));
}

#[test]
fn refuses_an_unknown_operation_or_a_missing_path_parameter() {
    let client = Client::new("https://calendar.example.com", "slk_x").unwrap();
    assert!(matches!(
        client.call("slotlock_nothing", Value::Null),
        Err(Error::Invalid(_))
    ));
    let missing = client
        .get_resource(&GetResourceInput::default())
        .unwrap_err();
    assert!(
        missing.to_string().contains("needs resource_id"),
        "{missing}"
    );
    let unknown = client
        .call("slotlock_list_resources", serde_json::json!({"limt": 5}))
        .unwrap_err();
    assert!(
        unknown.to_string().contains("has no argument limt"),
        "{unknown}"
    );
}

struct Server {
    client: Client,
    suffix: String,
    day: u64,
}

fn server() -> Option<Server> {
    let (url, key) = (
        std::env::var("SLOTLOCK_URL").ok()?,
        std::env::var("SLOTLOCK_ADMIN_KEY").ok()?,
    );
    if url.is_empty() || key.is_empty() {
        return None;
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    Some(Server {
        client: Client::new(&url, &key).unwrap(),
        suffix: format!("{:x}", now.as_nanos() % 0xffff_ffff_ffff),
        day: (now.as_secs() / 86_400 + 30) * 86_400,
    })
}

impl Server {
    /// The day 30 days from now, plus `hours`, as RFC 3339 in UTC.
    fn at(&self, hours: f64) -> String {
        let seconds = self.day + (hours * 3_600.0) as u64;
        let (days, rest) = (seconds / 86_400, seconds % 86_400);
        // Days to a civil date (Howard Hinnant's algorithm), so the test needs no date crate.
        let z = days as i64 + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
            rest / 3_600,
            rest % 3_600 / 60,
            rest % 60
        )
    }
}

/// An instant as seconds since the epoch, from the server's RFC 3339 (always UTC, `Z`).
fn instant(value: &Value) -> String {
    let text = value.as_str().unwrap();
    // The server writes milliseconds; compare to the second, as the scenario's times are.
    format!("{}Z", &text[..19])
}

fn refused(result: Result<Value, Error>, status: u16, code: &str) {
    match result {
        Err(error) => assert_eq!(
            (error.status(), error.code()),
            (Some(status), Some(code)),
            "{error}"
        ),
        Ok(value) => panic!("expected {status} {code}, got {value}"),
    }
}

#[test]
fn books_holds_and_reservations_without_double_booking() {
    let Some(s) = server() else {
        return eprintln!("set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
    };
    let c = &s.client;
    let resource = c
        .create_resource(&CreateResourceInput {
            external_ref: format!("rust-{}", s.suffix),
            timezone: Some("UTC".into()),
            ..Default::default()
        })
        .unwrap()["resource"]
        .clone();
    let id = resource["id"].as_str().unwrap().to_string();
    assert_eq!(
        c.get_resource(&GetResourceInput {
            resource_id: id.clone()
        })
        .unwrap()["resource"],
        resource
    );
    let hours = c
        .set_resource_availability(&SetResourceAvailabilityInput {
            resource_id: id.clone(),
            rules: Some(all_week()),
        })
        .unwrap();
    assert_eq!(hours["resource"]["availability"], Value::Array(all_week()));

    let window = AcquireHoldInput {
        resource_id: id.clone(),
        start: s.at(9.0),
        end: s.at(10.0),
        ttl_seconds: 600,
        source: Some("checkout".into()),
        ..Default::default()
    };
    let hold = c.acquire_hold(&window).unwrap()["hold"].clone();
    assert_eq!(hold["source"], "checkout");
    refused(
        c.acquire_hold(&AcquireHoldInput {
            ttl_seconds: 60,
            source: None,
            ..window.clone()
        }),
        409,
        "overlap",
    );
    let hold_id = hold["id"].as_str().unwrap().to_string();
    let confirmed = c
        .confirm_hold(&ConfirmHoldInput {
            hold_id: hold_id.clone(),
        })
        .unwrap()["reservation"]
        .clone();
    assert_eq!(confirmed["id"], hold["id"]);
    assert_eq!(
        c.confirm_hold(&ConfirmHoldInput { hold_id }).unwrap()["reservation"],
        confirmed
    );

    // A reference with a slash, a space and an accent travels in the path intact.
    let reference = format!("BK/{} ü", s.suffix);
    let booking = PutReservationInput {
        reservation_ref: reference.clone(),
        resource_id: id.clone(),
        start: s.at(11.0),
        end: s.at(12.0),
        revision: 1,
        buffer_after_minutes: Some(30),
        source: None,
    };
    let put = c.put_reservation(&booking).unwrap();
    assert_eq!(
        (
            put["replayed"].clone(),
            put["reservation"]["reservation_ref"].clone()
        ),
        (json!(false), json!(reference))
    );
    assert_eq!(put["reservation"]["buffer_after_minutes"], 30);
    assert_eq!(c.put_reservation(&booking).unwrap()["replayed"], true);
    refused(
        c.acquire_hold(&AcquireHoldInput {
            resource_id: id.clone(),
            start: s.at(12.25),
            end: s.at(12.5),
            ttl_seconds: 60,
            ..Default::default()
        }),
        409,
        "overlap",
    );

    let free_busy = c
        .get_free_busy(&GetFreeBusyInput {
            resource_ids: vec![id.clone()],
            start: s.at(0.0),
            end: s.at(24.0),
        })
        .unwrap();
    let busy: Vec<(String, String)> = free_busy["resources"][0]["busy"]
        .as_array()
        .unwrap()
        .iter()
        .map(|interval| (instant(&interval["start"]), instant(&interval["end"])))
        .collect();
    assert_eq!(
        busy,
        vec![(s.at(9.0), s.at(10.0)), (s.at(11.0), s.at(12.5))]
    );

    let cancelled = c
        .cancel_reservation(&CancelReservationInput {
            reservation_ref: reference,
            revision: 2,
        })
        .unwrap();
    assert_eq!(cancelled, json!({"cancelled": true, "revision": 2}));
    let coverage = c
        .record_coverage(&RecordCoverageInput {
            resource_id: id.clone(),
            source: "ics:https://calendar.example.com/fleet.ics".into(),
            start: s.at(0.0),
            end: s.at(24.0),
            revision: 1,
        })
        .unwrap();
    assert_eq!(coverage, json!({"revision": 1, "replayed": false}));
    let maintenance = c.run_maintenance(&RunMaintenanceInput::default()).unwrap();
    let mut keys: Vec<&String> = maintenance.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        ["capped", "conflicts", "extended", "pruned", "refused"]
    );

    let (mut found, mut cursor) = (false, None);
    loop {
        let page = c
            .list_resources(&ListResourcesInput {
                cursor: cursor.clone(),
                limit: Some(100),
            })
            .unwrap();
        found |= page["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == json!(id));
        match page["next_cursor"].as_str() {
            Some(next) if !found => cursor = Some(next.to_string()),
            _ => break,
        }
    }
    assert!(found);
}

#[test]
fn writes_events_and_clears_a_field_with_null() {
    let Some(s) = server() else {
        return eprintln!("set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
    };
    let c = &s.client;
    let id = c
        .create_resource(&CreateResourceInput {
            external_ref: format!("rust-events-{}", s.suffix),
            ..Default::default()
        })
        .unwrap()["resource"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    c.set_resource_availability(&SetResourceAvailabilityInput {
        resource_id: id.clone(),
        rules: Some(all_week()),
    })
    .unwrap();
    let key = |n: u8| format!("rust-{}-{n}", s.suffix);
    let created = c
        .create_event(&CreateEventInput {
            resource_id: id,
            starts_at: s.at(14.0),
            ends_at: s.at(15.0),
            timezone: "UTC".into(),
            title: Some("Handover".into()),
            description: Some("Keys at the desk".into()),
            idempotency_key: key(1),
            ..Default::default()
        })
        .unwrap()["event"]
        .clone();
    assert_eq!(
        (created["title"].clone(), created["description"].clone()),
        (json!("Handover"), json!("Keys at the desk"))
    );
    // Some(None) sends null, which clears the description; the title, left None, stays.
    let updated = c
        .update_event(&UpdateEventInput {
            event_id: created["id"].as_str().unwrap().to_string(),
            expected_revision: created["revision"].as_i64().unwrap(),
            idempotency_key: key(2),
            description: Some(None),
            ..Default::default()
        })
        .unwrap()["event"]
        .clone();
    assert_eq!(
        (updated["title"].clone(), updated["description"].clone()),
        (json!("Handover"), Value::Null)
    );
    // The server makes deletes wait for a person, which REST cannot ask: 428.
    refused(
        c.delete_event(&DeleteEventInput {
            event_id: created["id"].as_str().unwrap().to_string(),
            expected_revision: updated["revision"].as_i64().unwrap(),
            idempotency_key: key(3),
        }),
        428,
        "confirmation_required",
    );
}

#[test]
fn retries_a_keyed_hold_and_retires_a_resource() {
    let Some(s) = server() else {
        return eprintln!("set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
    };
    let c = &s.client;
    let resource = c
        .create_resource(&CreateResourceInput {
            external_ref: format!("rust-retire-{}", s.suffix),
            visibility: Some("private".into()),
            ..Default::default()
        })
        .unwrap()["resource"]
        .clone();
    assert_eq!(resource["visibility"], "private");
    let id = resource["id"].as_str().unwrap().to_string();
    c.set_resource_availability(&SetResourceAvailabilityInput {
        resource_id: id.clone(),
        rules: Some(all_week()),
    })
    .unwrap();
    // A keyed hold retried answers the hold the first request made.
    let window = AcquireHoldInput {
        resource_id: id.clone(),
        start: s.at(9.0),
        end: s.at(10.0),
        ttl_seconds: 600,
        idempotency_key: Some(format!("rust-hold-{}", s.suffix)),
        ..Default::default()
    };
    let hold = c.acquire_hold(&window).unwrap()["hold"].clone();
    assert_eq!(c.acquire_hold(&window).unwrap()["hold"], hold);
    refused(
        c.acquire_hold(&AcquireHoldInput {
            ttl_seconds: 60,
            ..window.clone()
        }),
        422,
        "idempotency_conflict",
    );
    let hold_id = hold["id"].as_str().unwrap().to_string();
    assert_eq!(
        c.get_hold(&GetHoldInput {
            hold_id: hold_id.clone()
        })
        .unwrap()["hold"],
        hold
    );
    // Confirmed, it is the reservation its id names, cancelled by that reference.
    let confirmed = c
        .confirm_hold(&ConfirmHoldInput {
            hold_id: hold_id.clone(),
        })
        .unwrap()["reservation"]
        .clone();
    assert_eq!(
        c.get_reservation(&GetReservationInput {
            reservation_ref: hold_id.clone()
        })
        .unwrap()["reservation"],
        confirmed
    );
    c.cancel_reservation(&CancelReservationInput {
        reservation_ref: hold_id.clone(),
        revision: 2,
    })
    .unwrap();
    refused(
        c.get_reservation(&GetReservationInput {
            reservation_ref: hold_id,
        }),
        404,
        "reservation_not_found",
    );

    let archived = c
        .archive_resource(&ArchiveResourceInput {
            resource_id: id.clone(),
        })
        .unwrap();
    assert!(archived["resource"]["archived_at"].is_string());
    let restored = c
        .restore_resource(&RestoreResourceInput {
            resource_id: id.clone(),
        })
        .unwrap();
    assert!(restored["resource"]["archived_at"].is_null());
    assert_eq!(
        c.delete_resource(&DeleteResourceInput {
            resource_id: id.clone()
        })
        .unwrap(),
        json!({ "deleted": true })
    );
    refused(
        c.get_resource(&GetResourceInput { resource_id: id }),
        404,
        "resource_not_found",
    );
}

#[test]
fn says_why_a_call_was_refused() {
    let Some(s) = server() else {
        return eprintln!("set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
    };
    refused(
        s.client.get_resource(&GetResourceInput {
            resource_id: "00000000-0000-4000-8000-000000000000".into(),
        }),
        404,
        "resource_not_found",
    );
    let stranger = Client::new(
        &std::env::var("SLOTLOCK_URL").unwrap(),
        &format!("slk_{}", "0".repeat(46)),
    )
    .unwrap();
    refused(
        stranger.run_maintenance(&RunMaintenanceInput::default()),
        401,
        "authentication_required",
    );
}
