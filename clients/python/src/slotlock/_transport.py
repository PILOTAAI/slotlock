"""The HTTP side of the Slotlock client: the key, JSON, and errors. Standard library only."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, NamedTuple

__version__ = "0.2.0"

_LOOPBACK = {"localhost", "127.0.0.1", "::1"}

#: The longest wait a Retry-After is read as: one day.
_MAX_RETRY_AFTER = 86400.0
_SECONDS = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_HTTP_DATE = re.compile(
    r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (" + "|".join(_MONTHS) + r") ([0-9]{4}) "
    r"([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT"
)


class Unset:
    """The default of an optional argument that may be null: leave it out of the request."""

    _instance: Unset | None = None

    def __new__(cls) -> Unset:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET = Unset()


class Operation(NamedTuple):
    name: str
    method: str
    path: str
    path_params: tuple[str, ...]
    query: tuple[str, ...]


class SlotlockError(Exception):
    """The server refused a call: `status` is the HTTP status, `code` says why.

    `code` is the server's error code (`overlap`, `forbidden`, `confirmation_required`, ...), or
    `http_<status>` when the response carried none; a redirect is one too (`http_302`), never
    followed. `retry_after` is the seconds a 429 or 503 asks for, when its Retry-After says, in
    seconds or as a date (at most a day).
    """

    def __init__(self, status: int, code: str, retry_after: float | None = None) -> None:
        super().__init__(f"Slotlock answered {status} {code}")
        self.status = status
        self.code = code
        self.retry_after = retry_after


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Follows no redirect: the 3xx is raised as it came, and the key goes nowhere else."""

    def redirect_request(self, *args: Any) -> None:
        return None


class Transport:
    """Calls a Slotlock server's REST API with an API key.

    Args:
        base_url: The server's public URL (SLOTLOCK_PUBLIC_URL), such as
            `https://calendar.example.com`.
        api_key: A Slotlock API key (`slk_...`) or the server token. The application API needs a
            key with the admin scope.
        timeout: Seconds a call may take, its response body included.
        allow_insecure: Send the key over plain HTTP to a host other than this machine. Never
            needed for `http://localhost`, which is reached without the environment's proxy.
        user_agent: Sent as User-Agent; `slotlock-python/<version>` unless given.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 30.0,
        allow_insecure: bool = False,
        user_agent: str | None = None,
    ) -> None:
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("base_url must be an http:// or https:// URL")
        if parsed.query or parsed.fragment:
            raise ValueError("base_url must not have a query or a fragment")
        if parsed.scheme == "http" and parsed.hostname not in _LOOPBACK and not allow_insecure:
            raise ValueError(
                "base_url is plain HTTP to another host, which would send the key unencrypted; "
                "use https://, or pass allow_insecure=True"
            )
        if not api_key or any(ord(c) < 0x21 or ord(c) > 0x7E for c in api_key):
            raise ValueError("api_key must be a Slotlock API key or the server token")
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._user_agent = user_agent or f"slotlock-python/{__version__}"
        # This machine is reached directly: a proxy from the environment would carry the key off it.
        direct = [urllib.request.ProxyHandler({})] if parsed.hostname in _LOOPBACK else []
        self._opener = urllib.request.build_opener(_NoRedirect(), *direct)

    def __repr__(self) -> str:
        # Never the key.
        return f"{type(self).__name__}({self._base_url!r})"

    def call(self, operation: str, values: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Run an operation by name (`slotlock_...`) with its arguments, path parameters included.

        Raises:
            SlotlockError: The server refused the call.
            ValueError: No such operation, or a path parameter is missing.
        """
        from ._operations import OPERATIONS

        spec = OPERATIONS.get(operation)
        if spec is None:
            raise ValueError(f"no Slotlock operation named {operation!r}")
        arguments = dict(values or {})
        path = spec.path
        for name in spec.path_params:
            value = arguments.pop(name, None)
            # The server resolves `.` and `..` as path segments, which would name another route.
            if not isinstance(value, str) or value in ("", ".", ".."):
                raise ValueError(f"{operation} needs {name}, a non-empty string other than . and ..")
            path = path.replace("{" + name + "}", urllib.parse.quote(value, safe=""))
        body: bytes | None = None
        if spec.method in ("GET", "DELETE"):
            unknown = [name for name in arguments if name not in spec.query]
            if unknown:
                raise ValueError(f"{operation} has no argument {unknown[0]}")
            pairs: list[tuple[str, str]] = []
            for name, value in arguments.items():
                for item in value if isinstance(value, (list, tuple)) else [value]:
                    pairs.append((name, _query_value(item)))
            if pairs:
                path = f"{path}?{urllib.parse.urlencode(pairs)}"
        else:
            body = json.dumps(arguments, ensure_ascii=False, allow_nan=False).encode("utf-8")
        return self._send(spec.method, path, body)

    def _send(self, method: str, path: str, body: bytes | None) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "User-Agent": self._user_agent,
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self._base_url}{path}", data=body, method=method, headers=headers
        )
        deadline = time.monotonic() + self._timeout
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                payload = _read(response, deadline)
        except urllib.error.HTTPError as error:
            with error:
                body = _read(error, deadline)
            raise _refusal(error.code, body, error.headers.get("Retry-After")) from None
        decoded = json.loads(payload) if payload else {}
        if not isinstance(decoded, dict):
            raise SlotlockError(200, "invalid_response")
        return decoded


def _read(response: Any, deadline: float) -> bytes:
    """The body, as long as it arrives before `deadline`."""
    chunks: list[bytes] = []
    while True:
        if time.monotonic() > deadline:
            raise TimeoutError("Slotlock's answer did not arrive in time")
        chunk = response.read1(65536)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def _retry_after(value: str | None) -> float | None:
    """Retry-After in seconds or as an HTTP date, at most a day; anything else is no wait."""
    if value is None:
        return None
    value = value.strip()
    if _SECONDS.fullmatch(value):
        return min(float(value), _MAX_RETRY_AFTER)
    date = _HTTP_DATE.fullmatch(value)
    if date is None:
        return None
    day, month, year, hour, minute, second = date.groups()
    try:
        when = datetime(
            int(year), _MONTHS.index(month) + 1, int(day), int(hour), int(minute), int(second),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None
    return max(0.0, min(when.timestamp() - time.time(), _MAX_RETRY_AFTER))


def _query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, str)):
        return str(value)
    raise TypeError(f"a query argument is a string, number or boolean, not {type(value).__name__}")


def _refusal(status: int, payload: bytes, retry_after: str | None) -> SlotlockError:
    code = f"http_{status}"
    try:
        decoded = json.loads(payload)
        if isinstance(decoded, dict) and isinstance(decoded.get("error"), dict):
            found = decoded["error"].get("code")
            if isinstance(found, str) and found:
                code = found
    except ValueError:
        pass
    return SlotlockError(status, code, _retry_after(retry_after))
