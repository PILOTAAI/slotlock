// The .NET client against a running Slotlock server, and its checks that need none. The server tests
// run when SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY (a key with read, write and admin) are set, against a
// server that confirms only deletes (SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event). Every language
// client runs the same scenario. Run with `dotnet run --project tests/Slotlock.Tests`.
#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Slotlock;
using Xunit;

public sealed class SlotlockClientTests
{
    private static readonly string Url = Environment.GetEnvironmentVariable("SLOTLOCK_URL") ?? "";
    private static readonly string Key = Environment.GetEnvironmentVariable("SLOTLOCK_ADMIN_KEY") ?? "";

    private readonly string _suffix = Guid.NewGuid().ToString("N")[..12];
    private readonly DateTimeOffset _day = new DateTimeOffset(DateTime.UtcNow.Date, TimeSpan.Zero).AddDays(30);

    private static JsonArray AllWeek() =>
        new(new JsonObject { ["rrule"] = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", ["start_minutes"] = 0, ["duration_minutes"] = 1440 });

    private static System.Threading.CancellationToken Ct => TestContext.Current.CancellationToken;

    private string At(double hours) => _day.AddHours(hours).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");

    private static SlotlockClient Server()
    {
        Assert.SkipWhen(Url.Length == 0 || Key.Length == 0, "set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
        return new SlotlockClient(Url, Key);
    }

    private static async Task Refused(int status, string code, Func<Task> call)
    {
        var error = await Assert.ThrowsAsync<SlotlockException>(call);
        Assert.Equal((status, code), (error.Status, error.Code));
    }

    [Fact]
    public void HasAMethodForEveryOperation()
    {
        var methods = typeof(SlotlockClient).GetMethods(BindingFlags.Public | BindingFlags.Instance).Select(m => m.Name).ToHashSet();
        foreach (var name in SlotlockClient.Operations.Keys)
        {
            var method = string.Concat(name["slotlock_".Length..].Split('_').Select(part => char.ToUpperInvariant(part[0]) + part[1..])) + "Async";
            Assert.Contains(method, methods);
        }
    }

    [Fact]
    public void RefusesToSendAKeyOverPlainHttpToAnotherHost()
    {
        var refused = Assert.Throws<ArgumentException>(() => new SlotlockClient("http://calendar.example.com", "slk_x"));
        Assert.Contains("unencrypted", refused.Message);
        using var insecure = new SlotlockClient("http://calendar.example.com", "slk_x", new SlotlockClientOptions { AllowInsecure = true });
        using var local = new SlotlockClient("http://localhost:8080", "slk_x");
        using var secure = new SlotlockClient("https://calendar.example.com/", "slk_x");
        foreach (var url in new[] { "ftp://example.com", "calendar.example.com", "https://example.com/?a=1" })
        {
            Assert.Throws<ArgumentException>(() => new SlotlockClient(url, "slk_x"));
        }
        foreach (var key in new[] { "", "slk_ x", "slk_\n" })
        {
            Assert.Throws<ArgumentException>(() => new SlotlockClient("https://example.com", key));
        }
    }

    [Fact]
    public void NeverShowsTheKey()
    {
        using var client = new SlotlockClient("https://calendar.example.com", "slk_secret");
        Assert.DoesNotContain("slk_secret", client.ToString());
    }

    [Fact]
    public async Task RefusesAnUnknownOperationOrArgument()
    {
        using var client = new SlotlockClient("https://calendar.example.com", "slk_x");
        await Assert.ThrowsAsync<ArgumentException>(() => client.CallAsync("slotlock_nothing", null, cancellationToken: Ct));
        var missing = await Assert.ThrowsAsync<ArgumentException>(() => client.CallAsync("slotlock_get_resource", new JsonObject(), cancellationToken: Ct));
        Assert.Contains("needs resource_id", missing.Message);
        var unknown = await Assert.ThrowsAsync<ArgumentException>(() => client.CallAsync("slotlock_list_resources", new JsonObject { ["limt"] = 5 }, cancellationToken: Ct));
        Assert.Contains("has no argument limt", unknown.Message);
    }

    [Fact]
    public void OptionalSendsAValueOrNullOnlyWhenGiven()
    {
        Optional<string?> leftOut = default;
        Optional<string?> cleared = null;
        Optional<string?> given = "Handover";
        Assert.False(leftOut.HasValue);
        Assert.True(cleared.HasValue);
        Assert.Null(cleared.Value);
        Assert.Equal("Handover", given.Value);
        Assert.Throws<InvalidOperationException>(() => leftOut.Value);
    }

    [Fact]
    public async Task BooksHoldsAndReservationsWithoutDoubleBooking()
    {
        using var c = Server();
        var resource = (await c.CreateResourceAsync($"dotnet-{_suffix}", timezone: "UTC", cancellationToken: Ct))["resource"]!.AsObject();
        var id = resource["id"]!.GetValue<string>();
        Assert.True(JsonNode.DeepEquals(resource, (await c.GetResourceAsync(id, cancellationToken: Ct))["resource"]));
        var hours = (await c.SetResourceAvailabilityAsync(id, AllWeek(), cancellationToken: Ct))["resource"]!;
        Assert.True(JsonNode.DeepEquals(AllWeek(), hours["availability"]));

        var hold = (await c.AcquireHoldAsync(id, At(9), At(10), 600, source: "checkout", cancellationToken: Ct))["hold"]!;
        Assert.Equal("checkout", hold["source"]!.GetValue<string>());
        await Refused(409, "overlap", () => c.AcquireHoldAsync(id, At(9), At(10), 60, cancellationToken: Ct));
        var holdId = hold["id"]!.GetValue<string>();
        var confirmed = (await c.ConfirmHoldAsync(holdId, cancellationToken: Ct))["reservation"];
        Assert.Equal(holdId, confirmed!["id"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(confirmed, (await c.ConfirmHoldAsync(holdId, cancellationToken: Ct))["reservation"]));

        // A reference with a slash, a space and an accent travels in the path intact.
        var reference = $"BK/{_suffix} ü";
        var put = await c.PutReservationAsync(reference, id, At(11), At(12), 1, bufferAfterMinutes: 30, cancellationToken: Ct);
        Assert.False(put["replayed"]!.GetValue<bool>());
        Assert.Equal(reference, put["reservation"]!["reservation_ref"]!.GetValue<string>());
        Assert.Equal(30, put["reservation"]!["buffer_after_minutes"]!.GetValue<int>());
        Assert.True((await c.PutReservationAsync(reference, id, At(11), At(12), 1, bufferAfterMinutes: 30, cancellationToken: Ct))["replayed"]!.GetValue<bool>());
        await Refused(409, "overlap", () => c.AcquireHoldAsync(id, At(12.25), At(12.5), 60, cancellationToken: Ct));

        var freeBusy = await c.GetFreeBusyAsync(new[] { id }, At(0), At(24), cancellationToken: Ct);
        var busy = freeBusy["resources"]![0]!["busy"]!.AsArray()
            .Select(b => (DateTimeOffset.Parse(b!["start"]!.GetValue<string>()), DateTimeOffset.Parse(b["end"]!.GetValue<string>())))
            .ToList();
        Assert.Equal(
            new List<(DateTimeOffset, DateTimeOffset)>
            {
                (DateTimeOffset.Parse(At(9)), DateTimeOffset.Parse(At(10))),
                (DateTimeOffset.Parse(At(11)), DateTimeOffset.Parse(At(12.5))),
            },
            busy);

        Assert.True(JsonNode.DeepEquals(new JsonObject { ["cancelled"] = true, ["revision"] = 2 }, await c.CancelReservationAsync(reference, 2, cancellationToken: Ct)));
        Assert.True(JsonNode.DeepEquals(
            new JsonObject { ["revision"] = 1, ["replayed"] = false },
            await c.RecordCoverageAsync(id, "ics:https://calendar.example.com/fleet.ics", At(0), At(24), 1, cancellationToken: Ct)));
        var maintenance = await c.RunMaintenanceAsync(cancellationToken: Ct);
        Assert.Equal(new[] { "capped", "conflicts", "extended", "pruned", "refused", "zone_shifts" }, maintenance.Select(p => p.Key).Order());

        var found = false;
        string? cursor = null;
        while (!found)
        {
            var page = await c.ListResourcesAsync(cursor: cursor is null ? default(Optional<string>) : cursor, limit: 100, cancellationToken: Ct);
            found = page["resources"]!.AsArray().Any(r => r!["id"]!.GetValue<string>() == id);
            if (page["next_cursor"] is not JsonValue next) break;
            cursor = next.GetValue<string>();
        }
        Assert.True(found);
    }

    [Fact]
    public async Task WritesEventsAndClearsAFieldWithNull()
    {
        using var c = Server();
        var id = (await c.CreateResourceAsync($"dotnet-events-{_suffix}", cancellationToken: Ct))["resource"]!["id"]!.GetValue<string>();
        await c.SetResourceAvailabilityAsync(id, AllWeek(), cancellationToken: Ct);
        var created = (await c.CreateEventAsync(id, At(14), At(15), "UTC", Guid.NewGuid().ToString(),
            title: "Handover", description: "Keys at the desk", cancellationToken: Ct))["event"]!;
        Assert.Equal(("Handover", "Keys at the desk"), (created["title"]!.GetValue<string>(), created["description"]!.GetValue<string>()));
        // Null sends null, which clears the description; the title, left out, stays.
        var updated = (await c.UpdateEventAsync(created["id"]!.GetValue<string>(), created["revision"]!.GetValue<long>(),
            Guid.NewGuid().ToString(), description: null, cancellationToken: Ct))["event"]!;
        Assert.Equal("Handover", updated["title"]!.GetValue<string>());
        Assert.True(updated.AsObject().ContainsKey("description"));
        Assert.Null(updated["description"]);
        // The server makes deletes wait for a person, which REST cannot ask: 428.
        await Refused(428, "confirmation_required", () => c.DeleteEventAsync(created["id"]!.GetValue<string>(),
            updated["revision"]!.GetValue<long>(), Guid.NewGuid().ToString(), cancellationToken: Ct));
    }

    [Fact]
    public async Task SaysWhyACallWasRefused()
    {
        using var c = Server();
        await Refused(404, "resource_not_found", () => c.GetResourceAsync("00000000-0000-4000-8000-000000000000", cancellationToken: Ct));
        using var stranger = new SlotlockClient(Url, "slk_" + new string('0', 46));
        await Refused(401, "authentication_required", () => stranger.RunMaintenanceAsync(cancellationToken: Ct));
    }
}
