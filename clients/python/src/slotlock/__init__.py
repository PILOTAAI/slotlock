"""A client for Slotlock's REST API: the agent tools and the application API, from Python.

    from slotlock import Client

    slotlock = Client("https://calendar.example.com", api_key)
    hold = slotlock.acquire_hold(resource_id=..., start=..., end=..., ttl_seconds=600)["hold"]
"""

from ._operations import OPERATIONS, Operations
from ._transport import UNSET, SlotlockError, Unset, __version__


class Client(Operations):
    """A Slotlock server, reached with one API key. `Transport` describes the arguments."""


__all__ = ["OPERATIONS", "UNSET", "Client", "SlotlockError", "Unset", "__version__"]
