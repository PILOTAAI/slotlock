//! A client for Slotlock's REST API: the agent tools and the application API.
//!
//! ```no_run
//! use slotlock::{AcquireHoldInput, Client};
//!
//! let client = Client::new("https://calendar.example.com", "slk_...")?;
//! let hold = client.acquire_hold(&AcquireHoldInput {
//!     resource_id: "0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b".into(),
//!     start: "2027-03-29T09:00:00Z".into(),
//!     end: "2027-03-29T10:00:00Z".into(),
//!     ttl_seconds: 600,
//!     ..Default::default()
//! })?;
//! # Ok::<(), slotlock::Error>(())
//! ```
//!
//! Every operation is a method taking its own input struct; [`Client::call`] runs one by name.
//! A refusal is [`Error::Refused`] with the HTTP status and the server's code.

// Generated from openapi.json; its layout is the generator's.
#[rustfmt::skip]
mod operations;

pub use operations::*;

use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use ureq::http;

/// This client's version, sent in its User-Agent.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) struct Operation {
    pub(crate) name: &'static str,
    pub(crate) method: &'static str,
    pub(crate) path: &'static str,
    pub(crate) path_params: &'static [&'static str],
    pub(crate) query: &'static [&'static str],
}

/// What went wrong with a call.
#[derive(Debug)]
pub enum Error {
    /// The server refused the call: the HTTP status, and its code (`overlap`, `forbidden`,
    /// `confirmation_required`, ...), or `http_<status>` when the response carried none; a
    /// redirect is one too (`http_302`), never followed. `retry_after` is what a 429 or 503 asks
    /// the caller to wait, when its Retry-After says, in seconds or as a date (at most a day).
    Refused {
        status: u16,
        code: String,
        retry_after: Option<Duration>,
    },
    /// The arguments cannot make a request: an unknown operation, a missing path parameter.
    Invalid(String),
    /// The request did not complete: connection, TLS, timeout.
    Transport(ureq::Error),
    /// The arguments or the response are not the JSON they should be.
    Json(serde_json::Error),
}

impl Error {
    /// The server's code, when it refused the call.
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Refused { code, .. } => Some(code),
            _ => None,
        }
    }

    /// The HTTP status, when the server refused the call.
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Refused { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Refused { status, code, .. } => {
                write!(f, "slotlock: the server answered {status} {code}")
            }
            Error::Invalid(message) => write!(f, "slotlock: {message}"),
            Error::Transport(error) => write!(f, "slotlock: {error}"),
            Error::Json(error) => write!(f, "slotlock: {error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Transport(error) => Some(error),
            Error::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Error::Json(error)
    }
}

impl From<ureq::Error> for Error {
    fn from(error: ureq::Error) -> Self {
        Error::Transport(error)
    }
}

/// How [`Client::with_options`] builds a client.
#[derive(Debug, Clone)]
pub struct Options {
    /// The longest one call may take, connection included. Default 30 seconds.
    pub timeout: Duration,
    /// Send the key over plain HTTP to a host other than this machine. Never needed for
    /// `http://localhost`, which is reached without the environment's proxy.
    pub allow_insecure: bool,
    /// Sent as User-Agent; `slotlock-rust/<version>` unless set.
    pub user_agent: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            timeout: Duration::from_secs(30),
            allow_insecure: false,
            user_agent: None,
        }
    }
}

/// One Slotlock server, reached with one API key. Cheap to clone; blocking.
#[derive(Clone)]
pub struct Client {
    base_url: String,
    api_key: String,
    user_agent: String,
    agent: ureq::Agent,
}

impl fmt::Debug for Client {
    // Never the key.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl Client {
    /// A client for the server at `base_url` (its SLOTLOCK_PUBLIC_URL) with an API key (`slk_...`)
    /// or the server token. The application API needs a key with the admin scope.
    pub fn new(base_url: &str, api_key: &str) -> Result<Self, Error> {
        Self::with_options(base_url, api_key, Options::default())
    }

    /// As [`Client::new`], with a timeout, a User-Agent, or plain HTTP to another host.
    pub fn with_options(base_url: &str, api_key: &str, options: Options) -> Result<Self, Error> {
        let uri: http::Uri = base_url
            .parse()
            .map_err(|_| Error::Invalid("base_url must be an http:// or https:// URL".into()))?;
        let scheme = uri.scheme_str().unwrap_or("");
        let host = uri.host().unwrap_or("");
        if (scheme != "http" && scheme != "https") || host.is_empty() {
            return Err(Error::Invalid(
                "base_url must be an http:// or https:// URL".into(),
            ));
        }
        if uri.query().is_some() || base_url.contains('#') {
            return Err(Error::Invalid(
                "base_url must not have a query or a fragment".into(),
            ));
        }
        let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
        if scheme == "http" && !loopback && !options.allow_insecure {
            return Err(Error::Invalid(
                "base_url is plain HTTP to another host, which would send the key unencrypted; use https://, or allow_insecure"
                    .into(),
            ));
        }
        if api_key.is_empty() || api_key.bytes().any(|byte| !(0x21..=0x7e).contains(&byte)) {
            return Err(Error::Invalid(
                "api_key must be a Slotlock API key or the server token".into(),
            ));
        }
        let mut config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(options.timeout))
            // A redirect is answered as it came: the key never goes with another request.
            .max_redirects(0);
        if loopback {
            // This machine is reached directly: a proxy from the environment would carry the key
            // off it.
            config = config.proxy(None);
        }
        let config = config.build();
        Ok(Client {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            user_agent: options
                .user_agent
                .unwrap_or_else(|| format!("slotlock-rust/{VERSION}")),
            agent: ureq::Agent::new_with_config(config),
        })
    }

    /// Runs an operation by its name (`slotlock_...`) with its arguments, path parameters
    /// included, and returns the response body.
    pub fn call(&self, operation: &str, values: Value) -> Result<Value, Error> {
        let spec = OPERATIONS
            .iter()
            .find(|candidate| candidate.name == operation)
            .ok_or_else(|| Error::Invalid(format!("no operation named {operation}")))?;
        let mut arguments = match values {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => {
                return Err(Error::Invalid(format!(
                    "{operation} takes its arguments as a JSON object"
                )))
            }
        };
        let mut path = spec.path.to_string();
        for name in spec.path_params {
            // The server resolves `.` and `..` as path segments, which would name another route.
            let value = match arguments.remove(*name) {
                Some(Value::String(value)) if !matches!(value.as_str(), "" | "." | "..") => value,
                _ => {
                    return Err(Error::Invalid(format!(
                        "{operation} needs {name}, a non-empty string other than . and .."
                    )))
                }
            };
            path = path.replace(&format!("{{{name}}}"), &encode(&value));
        }
        let url_and_body = if spec.method == "GET" || spec.method == "DELETE" {
            if let Some(name) = arguments
                .keys()
                .find(|name| !spec.query.contains(&name.as_str()))
            {
                return Err(Error::Invalid(format!(
                    "{operation} has no argument {name}"
                )));
            }
            let mut pairs = Vec::new();
            for (name, value) in &arguments {
                match value {
                    Value::Array(items) => {
                        for item in items {
                            pairs.push(format!(
                                "{}={}",
                                encode(name),
                                encode(&query_value(name, item)?)
                            ));
                        }
                    }
                    other => pairs.push(format!(
                        "{}={}",
                        encode(name),
                        encode(&query_value(name, other)?)
                    )),
                }
            }
            let query = if pairs.is_empty() {
                String::new()
            } else {
                format!("?{}", pairs.join("&"))
            };
            (format!("{}{path}{query}", self.base_url), None)
        } else {
            (
                format!("{}{path}", self.base_url),
                Some(serde_json::to_vec(&Value::Object(arguments))?),
            )
        };
        let (url, body) = url_and_body;
        let builder = http::Request::builder()
            .method(spec.method)
            .uri(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Accept", "application/json")
            .header("User-Agent", &self.user_agent);
        let mut response = match body {
            Some(bytes) => {
                let request = builder
                    .header("Content-Type", "application/json")
                    .body(bytes)
                    .map_err(|error| Error::Invalid(error.to_string()))?;
                self.agent.run(request)?
            }
            None => {
                let request = builder
                    .body(())
                    .map_err(|error| Error::Invalid(error.to_string()))?;
                self.agent.run(request)?
            }
        };
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| retry_after(value, SystemTime::now()));
        let text = response.body_mut().read_to_string()?;
        if !(200..300).contains(&status) {
            let code = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|body| body.get("error")?.get("code")?.as_str().map(str::to_string))
                .filter(|code| !code.is_empty())
                .unwrap_or_else(|| format!("http_{status}"));
            return Err(Error::Refused {
                status,
                code,
                retry_after,
            });
        }
        if text.is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        Ok(serde_json::from_str(&text)?)
    }
}

/// The longest wait a Retry-After is read as: one day.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(86400);

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Retry-After in seconds or as an HTTP date, at most a day; anything else is no wait.
fn retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    let seconds = match value.split_once('.') {
        Some((whole, fraction)) => digits(whole) && digits(fraction),
        None => digits(value),
    };
    if seconds {
        // A number too long for an f64 parses as infinity, which the day caps.
        let seconds = value.parse::<f64>().ok()?;
        return Some(Duration::from_secs_f64(
            seconds.min(MAX_RETRY_AFTER.as_secs_f64()),
        ));
    }
    let when = http_date(value)?;
    Some(
        when.duration_since(now)
            .unwrap_or(Duration::ZERO)
            .min(MAX_RETRY_AFTER),
    )
}

/// An HTTP date (IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`), or nothing.
fn http_date(value: &str) -> Option<SystemTime> {
    let rest = [
        "Mon, ", "Tue, ", "Wed, ", "Thu, ", "Fri, ", "Sat, ", "Sun, ",
    ]
    .iter()
    .find_map(|weekday| value.strip_prefix(weekday))?;
    let parts: Vec<&str> = rest.split(' ').collect();
    let [day, month, year, clock, "GMT"] = parts.as_slice() else {
        return None;
    };
    let number = |text: &str, width: usize| -> Option<i64> {
        let ok = text.len() == width && text.bytes().all(|byte| byte.is_ascii_digit());
        ok.then(|| text.parse().ok()).flatten()
    };
    let clock: Vec<&str> = clock.split(':').collect();
    let [hour, minute, second] = clock.as_slice() else {
        return None;
    };
    let (day, year) = (number(day, 2)?, number(year, 4)?);
    let month = MONTHS.iter().position(|name| name == month)? as i64 + 1;
    let (hour, minute, second) = (number(hour, 2)?, number(minute, 2)?, number(second, 2)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day < 1 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    // Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second;
    Some(UNIX_EPOCH + Duration::from_secs(u64::try_from(seconds).unwrap_or(0)))
}

fn query_value(name: &str, value: &Value) -> Result<String, Error> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(flag) => Ok(flag.to_string()),
        _ => Err(Error::Invalid(format!(
            "query argument {name} must be a string, number or boolean"
        ))),
    }
}

/// Percent-encodes everything but RFC 3986's unreserved characters.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_all_but_unreserved_characters() {
        assert_eq!(encode("BK/42 ü?&=#"), "BK%2F42%20%C3%BC%3F%26%3D%23");
        assert_eq!(encode("a-b.c_d~e"), "a-b.c_d~e");
    }

    #[test]
    fn reads_an_http_date() {
        let at = |seconds: u64| Some(UNIX_EPOCH + Duration::from_secs(seconds));
        assert_eq!(http_date("Sun, 06 Nov 1994 08:49:37 GMT"), at(784111777));
        assert_eq!(http_date("Thu, 01 Jan 1970 00:00:00 GMT"), at(0));
        assert_eq!(http_date("Thu, 29 Feb 2024 23:59:59 GMT"), at(1709251199));
        for value in [
            "Wed, 29 Feb 2023 00:00:00 GMT",
            "Sun, 06 Nov 1994 24:00:00 GMT",
            "Sun, 6 Nov 1994 08:49:37 GMT",
            "Sunday, 06-Nov-94 08:49:37 GMT",
            "Sun, 06 Nov 1994 08:49:37 UTC",
            "Sun, 06 Nov 1994 08:49:37 GMT ",
        ] {
            assert_eq!(http_date(value), None, "{value}");
        }
    }
}
