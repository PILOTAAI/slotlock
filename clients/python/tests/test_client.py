"""The Python client against a running Slotlock server, and its checks that need none.

The server tests run when SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY (a key with read, write and admin)
are set, against a server that confirms only deletes (SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event).
Every language client runs the same scenario.
"""

from __future__ import annotations

import email.utils
import http.server
import json
import os
import threading
import time
import unittest
import unittest.mock
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone

from slotlock import OPERATIONS, UNSET, Client, SlotlockError

URL = os.environ.get("SLOTLOCK_URL", "")
KEY = os.environ.get("SLOTLOCK_ADMIN_KEY", "")
ALL_WEEK = [
    {"rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", "start_minutes": 0, "duration_minutes": 1440}
]


def instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class WithoutAServer(unittest.TestCase):
    def test_has_a_method_for_every_operation(self) -> None:
        for name in OPERATIONS:
            self.assertTrue(callable(getattr(Client, name.removeprefix("slotlock_"), None)), name)

    def test_refuses_to_send_a_key_over_plain_http_to_another_host(self) -> None:
        with self.assertRaisesRegex(ValueError, "unencrypted"):
            Client("http://calendar.example.com", "slk_x")
        Client("http://calendar.example.com", "slk_x", allow_insecure=True)
        Client("http://localhost:8080", "slk_x")
        Client("https://calendar.example.com/", "slk_x")
        for url in ("ftp://example.com", "calendar.example.com", "https://example.com/?a=1"):
            with self.assertRaises(ValueError):
                Client(url, "slk_x")
        for key in ("", "slk_ x", "slk_\n"):
            with self.assertRaises(ValueError):
                Client("https://example.com", key)

    def test_never_shows_the_key(self) -> None:
        client = Client("https://calendar.example.com", "slk_secret")
        self.assertNotIn("slk_secret", repr(client))

    def test_refuses_an_unknown_operation_or_a_missing_path_parameter(self) -> None:
        client = Client("https://calendar.example.com", "slk_x")
        with self.assertRaisesRegex(ValueError, "no Slotlock operation"):
            client.call("slotlock_nothing")
        with self.assertRaisesRegex(ValueError, "needs resource_id"):
            client.call("slotlock_get_resource", {})
        with self.assertRaisesRegex(ValueError, "has no argument limt"):
            client.call("slotlock_list_resources", {"limt": 5})

    def test_unset_is_falsy_and_one_value(self) -> None:
        self.assertFalse(UNSET)
        self.assertIs(type(UNSET)(), UNSET)


class Stub:
    """A local HTTP server that records each request and answers with `respond(handler)`."""

    def __init__(self, respond) -> None:  # type: ignore[no-untyped-def]
        self.requests: list[dict] = []
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # type: ignore[no-untyped-def]
                pass

            def answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                stub.requests.append(
                    {
                        "path": self.path,
                        "authorization": self.headers.get("Authorization", ""),
                        "body": self.rfile.read(length) if length else b"",
                    }
                )
                respond(self)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = answer

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def answer(status: int, body: bytes = b"{}", headers: dict[str, str] | None = None):  # type: ignore[no-untyped-def]
    def respond(handler) -> None:  # type: ignore[no-untyped-def]
        handler.send_response(status)
        for name, value in (headers or {}).items():
            handler.send_header(name, value)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    return respond


class AgainstAStub(unittest.TestCase):
    """The transport, against a local stub: what goes on the wire, and how answers are read."""

    def stub(self, respond=None) -> Stub:  # type: ignore[no-untyped-def]
        stub = Stub(respond or answer(200))
        self.addCleanup(stub.close)
        return stub

    def client(self, stub: Stub, **options) -> Client:  # type: ignore[no-untyped-def]
        return Client(f"http://127.0.0.1:{stub.port}", "slk_secret", **options)

    def refusal(self, respond) -> SlotlockError:  # type: ignore[no-untyped-def]
        with self.assertRaises(SlotlockError) as caught:
            self.client(self.stub(respond)).list_resources()
        return caught.exception

    def test_a_redirect_is_a_refusal_and_the_key_stays(self) -> None:
        elsewhere = self.stub()
        location = f"http://localhost:{elsewhere.port}/v1/resources"
        error = self.refusal(answer(302, b"", {"Location": location}))
        self.assertEqual((error.status, error.code), (302, "http_302"))
        self.assertEqual(elsewhere.requests, [])

    def test_a_loopback_url_ignores_a_proxy(self) -> None:
        proxy, server = self.stub(), self.stub()
        proxied = {"http_proxy": f"http://localhost:{proxy.port}", "no_proxy": "", "NO_PROXY": ""}
        with unittest.mock.patch.dict(os.environ, proxied):
            self.client(server).list_resources()
        self.assertEqual(proxy.requests, [])
        self.assertEqual(len(server.requests), 1)

    def test_refuses_a_dot_segment_path_parameter_before_any_request(self) -> None:
        stub = self.stub()
        for reference in (".", ".."):
            with self.assertRaisesRegex(ValueError, "needs resource_id"):
                self.client(stub).set_resource_availability(reference, rules=None)
        self.assertEqual(stub.requests, [])

    def test_encodes_path_and_query_parameters(self) -> None:
        stub = self.stub()
        self.client(stub).get_event("BK/42 ?#%é\\x..")
        self.client(stub).list_events(
            resource_ids=["a b", "c+d/é"], start="2027-03-29T09:00:00+01:00", end="2027-03-29T10:00:00+01:00", limit=5
        )
        self.assertEqual(stub.requests[0]["path"], "/v1/events/BK%2F42%20%3F%23%25%C3%A9%5Cx..")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(stub.requests[1]["path"]).query)
        self.assertEqual(
            query,
            {"resource_ids": ["a b", "c+d/é"], "start": ["2027-03-29T09:00:00+01:00"],
             "end": ["2027-03-29T10:00:00+01:00"], "limit": ["5"]},
        )

    def test_leaves_out_unset_sends_none_as_null(self) -> None:
        stub = self.stub()
        self.client(stub).update_event(
            "e1", expected_revision=3, idempotency_key="k", description=None, location="Dock 4"
        )
        body = json.loads(stub.requests[0]["body"])
        self.assertEqual(body, {"expected_revision": 3, "idempotency_key": "k", "description": None, "location": "Dock 4"})

    def test_reads_retry_after_in_seconds_or_as_a_date(self) -> None:
        def retry_after(value: str) -> float | None:
            body = b'{"error":{"code":"rate_limited"}}'
            error = self.refusal(answer(429, body, {"Retry-After": value}))
            self.assertEqual((error.status, error.code), (429, "rate_limited"))
            return error.retry_after

        self.assertEqual(retry_after("7"), 7.0)
        self.assertEqual(retry_after("1.5"), 1.5)
        self.assertEqual(retry_after("99999999999999999999"), 86400.0)
        in_two_minutes = retry_after(email.utils.formatdate(time.time() + 120, usegmt=True))
        self.assertIsNotNone(in_two_minutes)
        self.assertTrue(100 <= in_two_minutes <= 120, in_two_minutes)  # type: ignore[operator]
        self.assertEqual(retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), 0.0)
        for value in ("-5", "nan", "inf", "1e3", "soon", "Wed, 21 Oct 2015 07:28:00 +0000"):
            self.assertIsNone(retry_after(value), value)

    def test_an_error_without_a_json_body_is_still_a_refusal(self) -> None:
        error = self.refusal(answer(500, b"<html>oops</html>"))
        self.assertEqual((error.status, error.code), (500, "http_500"))
        error = self.refusal(answer(502, b""))
        self.assertEqual((error.status, error.code), (502, "http_502"))
        with self.assertRaises(ValueError):
            self.client(self.stub(answer(200, b"<html>captive portal</html>"))).list_resources()

    def test_the_timeout_covers_the_body(self) -> None:
        def trickle(handler) -> None:  # type: ignore[no-untyped-def]
            handler.send_response(200)
            handler.send_header("Content-Length", "100")
            handler.end_headers()
            try:
                for _ in range(100):
                    handler.wfile.write(b" ")
                    handler.wfile.flush()
                    time.sleep(0.2)
            except OSError:
                pass  # the client gave up

        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.client(self.stub(trickle), timeout=0.5).list_resources()
        self.assertLess(time.monotonic() - started, 2.0)
        with self.assertRaises(OSError):
            Client("http://127.0.0.1:9", "slk_secret", timeout=1).list_resources()


@unittest.skipUnless(URL and KEY, "set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server")
class AgainstAServer(unittest.TestCase):
    def setUp(self) -> None:
        self.client = Client(URL, KEY)
        self.suffix = uuid.uuid4().hex[:12]
        day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        self.day = day + timedelta(days=30)

    def at(self, hours: float) -> str:
        return (self.day + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def refused(self, status: int, code: str, call) -> None:  # type: ignore[no-untyped-def]
        with self.assertRaises(SlotlockError) as caught:
            call()
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))

    def test_books_holds_and_reservations_without_double_booking(self) -> None:
        client = self.client
        resource = client.create_resource(external_ref=f"python-{self.suffix}", timezone="UTC")["resource"]
        resource_id = resource["id"]
        self.assertEqual(client.get_resource(resource_id)["resource"], resource)
        hours = client.set_resource_availability(resource_id, rules=ALL_WEEK)["resource"]
        self.assertEqual(hours["availability"], ALL_WEEK)

        window = {"resource_id": resource_id, "start": self.at(9), "end": self.at(10)}
        hold = client.acquire_hold(**window, ttl_seconds=600, source="checkout")["hold"]
        self.assertEqual(hold["source"], "checkout")
        self.refused(409, "overlap", lambda: client.acquire_hold(**window, ttl_seconds=60))
        confirmed = client.confirm_hold(hold["id"])["reservation"]
        self.assertEqual(confirmed["id"], hold["id"])
        self.assertEqual(client.confirm_hold(hold["id"])["reservation"], confirmed)

        # A reference with a slash, a space and an accent travels in the path intact.
        reference = f"BK/{self.suffix} ü"
        booking = {"resource_id": resource_id, "start": self.at(11), "end": self.at(12)}
        put = client.put_reservation(reference, **booking, buffer_after_minutes=30, revision=1)
        self.assertFalse(put["replayed"])
        self.assertEqual(put["reservation"]["reservation_ref"], reference)
        self.assertEqual(put["reservation"]["buffer_after_minutes"], 30)
        again = client.put_reservation(reference, **booking, buffer_after_minutes=30, revision=1)
        self.assertTrue(again["replayed"])
        self.refused(
            409,
            "overlap",
            lambda: client.acquire_hold(
                resource_id=resource_id, start=self.at(12.25), end=self.at(12.5), ttl_seconds=60
            ),
        )

        free_busy = client.get_free_busy(resource_ids=[resource_id], start=self.at(0), end=self.at(24))
        busy = [(instant(b["start"]), instant(b["end"])) for b in free_busy["resources"][0]["busy"]]
        self.assertEqual(
            busy,
            [
                (instant(self.at(9)), instant(self.at(10))),
                (instant(self.at(11)), instant(self.at(12.5))),
            ],
        )

        self.assertEqual(client.cancel_reservation(reference, revision=2), {"cancelled": True, "revision": 2})
        source = "ics:https://calendar.example.com/fleet.ics"
        coverage = client.record_coverage(resource_id, source, start=self.at(0), end=self.at(24), revision=1)
        self.assertEqual(coverage, {"revision": 1, "replayed": False})
        maintenance = client.run_maintenance()
        self.assertEqual(set(maintenance), {"extended", "conflicts", "refused", "pruned", "zone_shifts", "capped"})

        found, cursor = False, None
        while not found:
            page = client.list_resources(limit=100, cursor=cursor)
            found = any(r["id"] == resource_id for r in page["resources"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertTrue(found)

    def test_writes_events_and_clears_a_field_with_none(self) -> None:
        client = self.client
        resource_id = client.create_resource(external_ref=f"python-events-{self.suffix}")["resource"]["id"]
        client.set_resource_availability(resource_id, rules=ALL_WEEK)
        created = client.create_event(
            resource_id=resource_id,
            starts_at=self.at(14),
            ends_at=self.at(15),
            timezone="UTC",
            title="Handover",
            description="Keys at the desk",
            idempotency_key=str(uuid.uuid4()),
        )["event"]
        self.assertEqual((created["title"], created["description"]), ("Handover", "Keys at the desk"))
        # None sends null, which clears the description; the title, left UNSET, stays.
        updated = client.update_event(
            created["id"],
            expected_revision=created["revision"],
            idempotency_key=str(uuid.uuid4()),
            description=None,
        )["event"]
        self.assertEqual((updated["title"], updated["description"]), ("Handover", None))
        # The server makes deletes wait for a person, which REST cannot ask: 428.
        self.refused(
            428,
            "confirmation_required",
            lambda: client.delete_event(
                created["id"], expected_revision=updated["revision"], idempotency_key=str(uuid.uuid4())
            ),
        )

    def test_reads_holds_and_retires_a_resource_and_any_keys_event(self) -> None:
        client = self.client
        resource = client.create_resource(external_ref=f"python-retire-{self.suffix}", visibility="private")
        resource_id = resource["resource"]["id"]
        self.assertEqual(resource["resource"]["visibility"], "private")
        client.set_resource_availability(resource_id, rules=ALL_WEEK)
        # A keyed hold retried answers the hold the first request made.
        window = {"resource_id": resource_id, "start": self.at(9), "end": self.at(10), "ttl_seconds": 600}
        key = str(uuid.uuid4())
        hold = client.acquire_hold(**window, idempotency_key=key)["hold"]
        self.assertEqual(client.acquire_hold(**window, idempotency_key=key)["hold"], hold)
        self.refused(
            422,
            "idempotency_conflict",
            lambda: client.acquire_hold(**{**window, "ttl_seconds": 60}, idempotency_key=key),
        )
        self.assertEqual(client.get_hold(hold["id"])["hold"], hold)
        self.assertEqual(client.list_holds(resource_id), {"holds": [hold], "next_cursor": None})
        # Confirmed, it is the reservation its id names, and is cancelled by that reference.
        confirmed = client.confirm_hold(hold["id"])["reservation"]
        self.assertEqual(client.get_reservation(hold["id"])["reservation"], confirmed)
        listed = client.list_reservations(resource_id, start=self.at(0), end=self.at(24))
        self.assertEqual(listed["reservations"], [confirmed])
        self.assertEqual(client.cancel_reservation(hold["id"], revision=2), {"cancelled": True, "revision": 2})
        self.refused(404, "reservation_not_found", lambda: client.get_reservation(hold["id"]))

        shared_id = client.create_resource(external_ref=f"python-events-{self.suffix}-t")["resource"]["id"]
        created = client.create_event(
            resource_id=shared_id,
            starts_at=self.at(14),
            ends_at=self.at(15),
            timezone="UTC",
            idempotency_key=str(uuid.uuid4()),
        )["event"]
        events = client.list_tenant_events(resource_id=shared_id, start=self.at(0), end=self.at(24))["events"]
        self.assertEqual([event["event_ref"] for event in events], [created["id"]])
        busy = client.list_busy(shared_id, start=self.at(0), end=self.at(24))["busy"]
        self.assertEqual(busy, [{"start": events[0]["starts_at"], "end": events[0]["ends_at"]}])
        # The tenant cancels it without the confirmation its key's delete waits for.
        cancelled = client.cancel_tenant_event(
            events[0]["id"], expected_revision=created["revision"], idempotency_key=str(uuid.uuid4())
        )
        self.assertEqual((cancelled["cancelled"], cancelled["replayed"]), (True, False))
        self.refused(404, "event_not_found", lambda: client.get_tenant_event(events[0]["id"]))

        archived = client.archive_resource(resource_id)["resource"]
        self.assertIsNotNone(archived["archived_at"])
        self.assertIsNone(client.restore_resource(resource_id)["resource"]["archived_at"])
        self.assertEqual(client.delete_resource(resource_id), {"deleted": True})
        self.assertEqual(client.delete_resource(resource_id), {"deleted": False})
        tenant = client.get_tenant()["tenant"]
        self.assertFalse(tenant["suspended"])
        # The server leaves erasing a tenant to its operator.
        self.refused(
            403, "tenant_erasure_disabled", lambda: client.erase_tenant(confirm_tenant_ref=tenant["ref"])
        )

    def test_says_why_a_call_was_refused(self) -> None:
        self.refused(
            404,
            "resource_not_found",
            lambda: self.client.get_resource("00000000-0000-4000-8000-000000000000"),
        )
        stranger = Client(URL, "slk_" + "0" * 46)
        self.refused(401, "authentication_required", lambda: stranger.run_maintenance())


if __name__ == "__main__":
    unittest.main()
