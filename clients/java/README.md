# Slotlock for Java

A client for [Slotlock](https://slotlock.pylota.io)'s REST API: the agent tools and the application
API, one method per operation. Java 17+, no dependencies (`java.net.http` and a strict JSON codec of
its own). It is `io.pylota:slotlock` on
[Maven Central](https://central.sonatype.com/artifact/io.pylota/slotlock), versioned with the
server:

```kotlin
implementation("io.pylota:slotlock:<version>")
```

Java: published to Maven Central by hand after each release; if a version 404s there
(`https://repo1.maven.org/maven2/io/pylota/slotlock/<version>/`), it is pending.

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
- `SlotlockClient.builder(url, key).timeout(d).userAgent(ua).httpClient(c).allowInsecure().build()`;
  `build()` refuses an `httpClient` that follows redirects.

The [clients overview](../README.md) covers keys, errors and testing.
