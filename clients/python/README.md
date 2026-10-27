# Slotlock for Python

A client for [Slotlock](https://slotlock.pylota.io)'s REST API: the agent tools and the application
API, one method per operation. Python 3.10+, standard library only.

```sh
pip install slotlock
```

```python
from slotlock import Client, SlotlockError

slotlock = Client("https://calendar.example.com", api_key)  # a key with the admin scope
van = slotlock.create_resource(external_ref="vehicle-42", timezone="Europe/London")["resource"]

hold = slotlock.acquire_hold(
    resource_id=van["id"], start="2027-03-29T09:00:00Z", end="2027-03-29T10:00:00Z", ttl_seconds=600
)["hold"]
try:
    slotlock.acquire_hold(
        resource_id=van["id"], start="2027-03-29T09:30:00Z", end="2027-03-29T10:30:00Z", ttl_seconds=600
    )
except SlotlockError as error:
    assert (error.status, error.code) == (409, "overlap")

reservation = slotlock.confirm_hold(hold["id"])["reservation"]
```

- Every method returns the response body as a `dict`; `client.call("slotlock_...", {...})` runs an
  operation by name.
- A refusal raises `SlotlockError` with `status`, `code` and `retry_after`.
- `update_event(..., description=None)` clears the description; leaving it out keeps it.
- `Client(url, key, timeout=30.0, allow_insecure=False, user_agent=None)`. Plain HTTP is refused
  except to `localhost`.

The [clients overview](../README.md) covers keys, errors and testing.
