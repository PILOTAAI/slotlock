"""The Python client against a running Slotlock server, and its checks that need none.

The server tests run when SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY (a key with read, write and admin)
are set, against a server that confirms only deletes (SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event).
Every language client runs the same scenario.
"""

from __future__ import annotations

import os
import unittest
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
        self.assertEqual(set(maintenance), {"extended", "conflicts", "refused", "pruned", "capped"})

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
