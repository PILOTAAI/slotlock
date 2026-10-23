# Slotlock for Java

A client for [Slotlock](https://slotlock.pylota.io)'s REST API: the agent tools and the application
API, one method per operation. Java 17+, no dependencies (`java.net.http` and a strict JSON codec of
its own). Build it with Gradle 9: `gradle jar`.

```java
SlotlockClient slotlock = SlotlockClient.builder("https://calendar.example.com", apiKey).build();
Map<String, Object> van = slotlock.createResource("vehicle-42", Map.of("timezone", "Europe/London"));
String id = (String) ((Map<?, ?>) van.get("resource")).get("id");

Map<String, Object> hold = slotlock.acquireHold(id, "2027-03-29T09:00:00Z", "2027-03-29T10:00:00Z", 600);
try {
  slotlock.acquireHold(id, "2027-03-29T09:30:00Z", "2027-03-29T10:30:00Z", 600);
} catch (SlotlockException refused) {
  // refused.status() == 409, refused.code().equals("overlap")
}
```

- Required arguments are parameters; optional ones go in a `Map` (an overload leaves it out). A key
  mapped to `null` sends null, which clears the field; an unknown key is refused.
- Every method returns the response body as `Map<String, Object>`; `call("slotlock_...", values)`
  runs an operation by name.
- A refusal throws `SlotlockException` with `status()`, `code()` and `retryAfter()`.
- `SlotlockClient.builder(url, key).timeout(d).userAgent(ua).httpClient(c).allowInsecure().build()`.

The [clients overview](../README.md) covers keys, errors and testing.
