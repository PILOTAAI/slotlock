# Slotlock for Go

A client for [Slotlock](https://slotlock.pylota.io)'s REST API: the agent tools and the application
API, one method per operation. Go 1.22+, standard library only.

```sh
go get github.com/PILOTAAI/slotlock/clients/go@main
```

```go
client, err := slotlock.New("https://calendar.example.com", apiKey) // a key with the admin scope
van, err := client.CreateResource(ctx, slotlock.CreateResourceInput{
	ExternalRef: "vehicle-42", Timezone: slotlock.Ptr("Europe/London"),
})
id := van["resource"].(map[string]any)["id"].(string)

hold, err := client.AcquireHold(ctx, slotlock.AcquireHoldInput{
	ResourceID: id, Start: "2027-03-29T09:00:00Z", End: "2027-03-29T10:00:00Z", TTLSeconds: 600,
})
_, err = client.AcquireHold(ctx, slotlock.AcquireHoldInput{
	ResourceID: id, Start: "2027-03-29T09:30:00Z", End: "2027-03-29T10:30:00Z", TTLSeconds: 600,
})
var refused *slotlock.Error
if errors.As(err, &refused) && refused.Code == "overlap" {
	// 409: the window is taken.
}
```

- Each method takes its own input struct and returns the response body as `map[string]any`;
  `client.Call(ctx, "slotlock_...", values)` runs an operation by name.
- Optional arguments are pointers (`slotlock.Ptr(v)`); one that may be null is a
  `slotlock.Nullable[T]`: the zero value leaves it out, `slotlock.Null[string]()` clears it,
  `slotlock.Value("x")` sets it.
- A refusal is a `*slotlock.Error` with `Status`, `Code` and `RetryAfter`.
- `slotlock.New(url, key, slotlock.WithHTTPClient(c), slotlock.WithUserAgent(ua), slotlock.AllowInsecure())`.

The [clients overview](../README.md) covers keys, errors and testing.
