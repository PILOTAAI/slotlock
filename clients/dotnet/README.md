# Slotlock for .NET

A client for [Slotlock](https://slotlock.pylota.io)'s REST API: the agent tools and the application
API, one method per operation. .NET 8 or 10, no dependencies, trimmable and AOT-compatible. Build the
package with `dotnet pack src/Slotlock`.

```csharp
using var slotlock = new SlotlockClient("https://calendar.example.com", apiKey);
var van = await slotlock.CreateResourceAsync("vehicle-42", timezone: "Europe/London");
var id = van["resource"]!["id"]!.GetValue<string>();

var hold = await slotlock.AcquireHoldAsync(id, "2027-03-29T09:00:00Z", "2027-03-29T10:00:00Z", 600);
try
{
    await slotlock.AcquireHoldAsync(id, "2027-03-29T09:30:00Z", "2027-03-29T10:30:00Z", 600);
}
catch (SlotlockException refused) when (refused.Code == "overlap")
{
    // 409: the window is taken.
}
```

- Optional arguments are `Optional<T>` and convert implicitly: leave one out to omit it, pass a
  value to set it, or pass `null` (where the argument may be null) to clear it.
- Every method returns the response body as a `JsonObject`; `CallAsync("slotlock_...", values)` runs
  an operation by name.
- A refusal throws `SlotlockException` with `Status`, `Code` and `RetryAfter`.
- `new SlotlockClient(url, key, new SlotlockClientOptions { Timeout, AllowInsecure, UserAgent, HttpClient })`;
  an `HttpClient` you pass keeps its handler's settings, so give it `AllowAutoRedirect = false`.

The [clients overview](../README.md) covers keys, errors and testing.
