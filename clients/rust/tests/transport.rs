//! The transport against local stub servers: what goes on the wire, and how answers are read.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use slotlock::*;

/// What a stub saw of one request.
#[derive(Clone, Debug)]
struct Seen {
    target: String,
    authorization: String,
    body: Vec<u8>,
}

type Respond = Arc<dyn Fn(&mut TcpStream) + Send + Sync>;

/// A local HTTP/1.1 server, one request per connection; returns its port and what it saw.
fn stub(respond: Respond) -> (u16, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let (log, respond) = (log.clone(), respond.clone());
            thread::spawn(move || {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let mut lines = head.split("\r\n");
                let target = lines.next().unwrap_or("").split(' ').nth(1).unwrap_or("");
                let (mut authorization, mut length) = (String::new(), 0usize);
                for (name, value) in lines.filter_map(|line| line.split_once(':')) {
                    match name.trim().to_ascii_lowercase().as_str() {
                        "authorization" => authorization = value.trim().to_string(),
                        "content-length" => length = value.trim().parse().unwrap_or(0),
                        _ => {}
                    }
                }
                let mut body = vec![0u8; length];
                let _ = stream.read_exact(&mut body);
                log.lock().unwrap().push(Seen {
                    target: target.to_string(),
                    authorization,
                    body,
                });
                respond(&mut stream);
            });
        }
    });
    (port, seen)
}

fn answer(status: u16, body: &'static str, headers: Vec<(&'static str, String)>) -> Respond {
    Arc::new(move |stream: &mut TcpStream| {
        let mut out = format!(
            "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for (name, value) in &headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str("\r\n");
        out.push_str(body);
        let _ = stream.write_all(out.as_bytes());
    })
}

fn ok() -> Respond {
    answer(200, "{}", vec![])
}

fn client(port: u16) -> Client {
    Client::new(&format!("http://127.0.0.1:{port}"), "slk_secret").unwrap()
}

fn refused(respond: Respond) -> (u16, String, Option<Duration>) {
    let (port, _) = stub(respond);
    match client(port).list_resources(&ListResourcesInput::default()) {
        Err(Error::Refused {
            status,
            code,
            retry_after,
        }) => (status, code, retry_after),
        other => panic!("want a refusal, got {other:?}"),
    }
}

/// An HTTP date (IMF-fixdate) `seconds` from now, or before it.
fn http_date(seconds: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let t = now + seconds;
    let (days, rem) = (t.div_euclid(86400), t.rem_euclid(86400));
    let weekday = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][days.rem_euclid(7) as usize];
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{weekday}, {day:02} {} {year} {:02}:{:02}:{:02} GMT",
        months[(month - 1) as usize],
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[test]
fn a_redirect_is_a_refusal_and_the_key_stays() {
    let (elsewhere, seen) = stub(ok());
    let location = format!("http://localhost:{elsewhere}/v1/resources");
    let got = refused(answer(302, "", vec![("Location", location)]));
    assert_eq!((got.0, got.1.as_str()), (302, "http_302"));
    assert!(seen.lock().unwrap().is_empty(), "the redirect was followed");
}

#[test]
fn refuses_a_dot_segment_path_parameter_before_any_request() {
    let (port, seen) = stub(ok());
    for reference in [".", ".."] {
        let input = SetResourceAvailabilityInput {
            resource_id: reference.into(),
            rules: None,
        };
        let refused = client(port).set_resource_availability(&input).unwrap_err();
        assert!(
            refused.to_string().contains("needs resource_id"),
            "{refused}"
        );
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn encodes_path_and_query_parameters() {
    let (port, seen) = stub(ok());
    let client = client(port);
    client
        .get_event(&GetEventInput {
            event_id: "BK/42 ?#%é\\x..".into(),
        })
        .unwrap();
    client
        .list_events(&ListEventsInput {
            resource_ids: vec!["a b".into(), "c+d/é".into()],
            start: "2027-03-29T09:00:00+01:00".into(),
            end: "2027-03-29T10:00:00+01:00".into(),
            cursor: None,
            limit: Some(5),
        })
        .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].target, "/v1/events/BK%2F42%20%3F%23%25%C3%A9%5Cx..");
    let (path, query) = seen[1].target.split_once('?').unwrap();
    let mut pairs: Vec<&str> = query.split('&').collect();
    pairs.sort();
    assert_eq!(path, "/v1/events");
    assert_eq!(
        pairs,
        [
            "end=2027-03-29T10%3A00%3A00%2B01%3A00",
            "limit=5",
            "resource_ids=a%20b",
            "resource_ids=c%2Bd%2F%C3%A9",
            "start=2027-03-29T09%3A00%3A00%2B01%3A00"
        ]
    );
    assert_eq!(seen[1].authorization, "Bearer slk_secret");
}

#[test]
fn leaves_out_none_and_sends_some_none_as_null() {
    let (port, seen) = stub(ok());
    client(port)
        .update_event(&UpdateEventInput {
            event_id: "e1".into(),
            expected_revision: 3,
            idempotency_key: "k".into(),
            description: Some(None),
            location: Some(Some("Dock 4".into())),
            ..Default::default()
        })
        .unwrap();
    let body: Value = serde_json::from_slice(&seen.lock().unwrap()[0].body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"expected_revision": 3, "idempotency_key": "k", "description": null, "location": "Dock 4"})
    );
}

#[test]
fn reads_retry_after_in_seconds_or_as_a_date() {
    let read = |value: String| {
        let got = refused(answer(
            429,
            r#"{"error":{"code":"rate_limited"}}"#,
            vec![("Retry-After", value)],
        ));
        assert_eq!((got.0, got.1.as_str()), (429, "rate_limited"));
        got.2
    };
    let day = Duration::from_secs(86400);
    assert_eq!(read("7".into()), Some(Duration::from_secs(7)));
    assert_eq!(read("1.5".into()), Some(Duration::from_millis(1500)));
    assert_eq!(read("99999999999999999999".into()), Some(day));
    assert_eq!(read("9".repeat(400)), Some(day));
    assert_eq!(read(http_date(-600)), Some(Duration::ZERO));
    let in_two_minutes = read(http_date(120)).expect("an HTTP date");
    assert!(
        in_two_minutes >= Duration::from_secs(100) && in_two_minutes <= Duration::from_secs(120),
        "{in_two_minutes:?}"
    );
    for value in [
        "-5",
        "NaN",
        "inf",
        "1e3",
        "soon",
        "Wed, 21 Oct 2015 07:28:00 +0000",
    ] {
        assert_eq!(read(value.into()), None, "{value}");
    }
}

#[test]
fn an_error_without_a_json_body_is_still_a_refusal() {
    assert_eq!(
        refused(answer(500, "<html>oops</html>", vec![])).1,
        "http_500"
    );
    assert_eq!(refused(answer(502, "", vec![])).1, "http_502");
    let (port, _) = stub(answer(200, "<html>captive portal</html>", vec![]));
    assert!(client(port)
        .list_resources(&ListResourcesInput::default())
        .is_err());
}

#[test]
fn the_timeout_covers_the_body() {
    let (port, _) = stub(Arc::new(|stream: &mut TcpStream| {
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
        for _ in 0..100 {
            if stream.write_all(b" ").is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
    }));
    let options = Options {
        timeout: Duration::from_millis(500),
        ..Options::default()
    };
    let client = Client::with_options(&format!("http://127.0.0.1:{port}"), "slk_x", options);
    let started = Instant::now();
    assert!(client
        .unwrap()
        .list_resources(&ListResourcesInput::default())
        .is_err());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    assert!(Client::new("http://127.0.0.1:9", "slk_x")
        .unwrap()
        .list_resources(&ListResourcesInput::default())
        .is_err());
}
