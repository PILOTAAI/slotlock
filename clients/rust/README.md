# Slotlock for Rust

A client for [Slotlock](https://slotlock.pylota.io)'s REST API: the agent tools and the application
API, one method per operation. Blocking, on `ureq`; Rust 1.85+.

```toml
[dependencies]
slotlock = { git = "https://github.com/PILOTAAI/slotlock" }
```

```rust
use slotlock::{AcquireHoldInput, Client, CreateResourceInput};

let client = Client::new("https://calendar.example.com", &api_key)?; // a key with the admin scope
let van = client.create_resource(&CreateResourceInput {
    external_ref: "vehicle-42".into(),
    timezone: Some("Europe/London".into()),
    ..Default::default()
})?;
let id = van["resource"]["id"].as_str().unwrap().to_string();

let hold = client.acquire_hold(&AcquireHoldInput {
    resource_id: id.clone(),
    start: "2027-03-29T09:00:00Z".into(),
    end: "2027-03-29T10:00:00Z".into(),
    ttl_seconds: 600,
    ..Default::default()
})?;
```

- Each method takes its own input struct and returns the response body as a `serde_json::Value`;
  `client.call("slotlock_...", json!({...}))` runs an operation by name.
- An optional argument that may be null is `Option<Option<T>>`: `None` leaves it out, `Some(None)`
  clears it.
- A refusal is `Error::Refused { status, code, retry_after }`; `error.code()` and `error.status()`
  read it.
- `Client::with_options(url, key, Options { timeout, allow_insecure, user_agent })`.

The [clients overview](../README.md) covers keys, errors and testing.
