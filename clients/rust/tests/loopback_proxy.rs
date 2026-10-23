//! A client for this machine ignores the environment's proxy, which would carry the key off it. Its
//! own test binary, since it sets the process environment.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use slotlock::*;

/// A server that records each request head, accepting a CONNECT tunnel and reading inside it.
fn recorder() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            loop {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_string();
                log.lock().unwrap().push(head.clone());
                if head.starts_with("CONNECT ") {
                    let _ = stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
                    continue;
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                );
                break;
            }
        }
    });
    (port, seen)
}

#[test]
fn a_loopback_url_ignores_a_proxy() {
    let (proxy, proxied) = recorder();
    let (server, served) = recorder();
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");
    std::env::set_var("HTTP_PROXY", format!("http://localhost:{proxy}"));
    let client = Client::new(&format!("http://127.0.0.1:{server}"), "slk_secret").unwrap();
    client
        .list_resources(&ListResourcesInput::default())
        .unwrap();
    assert!(
        proxied.lock().unwrap().is_empty(),
        "the proxy saw {:?}",
        proxied.lock().unwrap()
    );
    assert_eq!(served.lock().unwrap().len(), 1);
}
