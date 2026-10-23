// The transport against local stub servers: what goes on the wire, and how answers are read.
#nullable enable

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Slotlock;
using Xunit;

public sealed class TransportTests : IDisposable
{
    private readonly List<TcpListener> _listeners = new();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>What a stub saw of one request.</summary>
    private sealed record Seen(string Target, string Authorization, string Body);

    public void Dispose()
    {
        foreach (var listener in _listeners) listener.Stop();
    }

    /// <summary>A local HTTP/1.1 server, one request per connection.</summary>
    private (int Port, ConcurrentQueue<Seen> Seen) Stub(Func<NetworkStream, Task>? respond = null)
    {
        respond ??= Answer(200, "{}");
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        _listeners.Add(listener);
        var seen = new ConcurrentQueue<Seen>();
        _ = Task.Run(async () =>
        {
            while (true)
            {
                TcpClient tcp;
                try { tcp = await listener.AcceptTcpClientAsync(); } catch (Exception) { return; }
                _ = Task.Run(async () =>
                {
                    using var client = tcp;
                    var stream = client.GetStream();
                    var head = new List<byte>();
                    var one = new byte[1];
                    while (!(head.Count >= 4 && head[^4] == '\r' && head[^3] == '\n' && head[^2] == '\r' && head[^1] == '\n'))
                    {
                        if (await stream.ReadAsync(one) == 0) return;
                        head.Add(one[0]);
                    }
                    var lines = Encoding.UTF8.GetString(head.ToArray()).Split("\r\n");
                    var (authorization, length) = ("", 0);
                    foreach (var line in lines.Skip(1))
                    {
                        var colon = line.IndexOf(':');
                        if (colon < 0) continue;
                        var name = line[..colon].Trim().ToLowerInvariant();
                        if (name == "authorization") authorization = line[(colon + 1)..].Trim();
                        if (name == "content-length") length = int.Parse(line[(colon + 1)..].Trim(), CultureInfo.InvariantCulture);
                    }
                    var body = new byte[length];
                    if (length > 0) await stream.ReadExactlyAsync(body);
                    seen.Enqueue(new Seen(lines[0].Split(' ')[1], authorization, Encoding.UTF8.GetString(body)));
                    try { await respond(stream); } catch (Exception) { /* the client hung up */ }
                });
            }
        });
        return (((IPEndPoint)listener.LocalEndpoint).Port, seen);
    }

    private static Func<NetworkStream, Task> Answer(int status, string body, params (string Name, string Value)[] headers) =>
        async stream =>
        {
            var bytes = Encoding.UTF8.GetBytes(body);
            var text = new StringBuilder($"HTTP/1.1 {status} X\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n");
            foreach (var (name, value) in headers) text.Append(name).Append(": ").Append(value).Append("\r\n");
            text.Append("\r\n");
            await stream.WriteAsync(Encoding.UTF8.GetBytes(text.ToString()));
            await stream.WriteAsync(bytes);
        };

    private static SlotlockClient Client(int port, SlotlockClientOptions? options = null) =>
        new($"http://127.0.0.1:{port}", "slk_secret", options);

    private async Task<SlotlockException> Refused(Func<NetworkStream, Task> respond)
    {
        var (port, _) = Stub(respond);
        using var client = Client(port);
        return await Assert.ThrowsAsync<SlotlockException>(() => client.ListResourcesAsync(cancellationToken: Ct));
    }

    [Fact]
    public async Task ARedirectIsARefusalAndTheKeyStays()
    {
        var (elsewhere, seen) = Stub();
        var error = await Refused(Answer(302, "", ("Location", $"http://localhost:{elsewhere}/v1/resources")));
        Assert.Equal((302, "http_302"), (error.Status, error.Code));
        Assert.Empty(seen);
    }

    [Fact]
    public async Task ALoopbackUrlIgnoresAProxy()
    {
        var (proxy, proxied) = Stub();
        var (server, served) = Stub();
        var saved = HttpClient.DefaultProxy;
        HttpClient.DefaultProxy = new WebProxy($"http://localhost:{proxy}");
        try
        {
            using var client = Client(server);
            await client.ListResourcesAsync(cancellationToken: Ct);
        }
        finally
        {
            HttpClient.DefaultProxy = saved;
        }
        Assert.Empty(proxied);
        Assert.Single(served);
    }

    [Fact]
    public async Task RefusesADotSegmentPathParameterBeforeAnyRequest()
    {
        var (port, seen) = Stub();
        using var client = Client(port);
        foreach (var reference in new[] { ".", ".." })
        {
            var error = await Assert.ThrowsAsync<ArgumentException>(() => client.SetResourceAvailabilityAsync(reference, null, Ct));
            Assert.Contains("needs resource_id", error.Message, StringComparison.Ordinal);
        }
        Assert.Empty(seen);
    }

    [Fact]
    public async Task EncodesPathAndQueryParameters()
    {
        var (port, seen) = Stub();
        using var client = Client(port);
        await client.GetEventAsync("BK/42 ?#%é\\x..", Ct);
        await client.ListEventsAsync(new[] { "a b", "c+d/é" }, "2027-03-29T09:00:00+01:00", "2027-03-29T10:00:00+01:00", limit: 5, cancellationToken: Ct);
        var requests = seen.ToArray();
        Assert.Equal("/v1/events/BK%2F42%20%3F%23%25%C3%A9%5Cx..", requests[0].Target);
        var query = requests[1].Target.Split('?', 2)[1].Split('&').OrderBy(pair => pair, StringComparer.Ordinal);
        Assert.Equal(
            new[] { "end=2027-03-29T10%3A00%3A00%2B01%3A00", "limit=5", "resource_ids=a%20b", "resource_ids=c%2Bd%2F%C3%A9", "start=2027-03-29T09%3A00%3A00%2B01%3A00" },
            query);
        Assert.Equal("Bearer slk_secret", requests[1].Authorization);
    }

    [Fact]
    public async Task LeavesOutDefaultSendsNullAsNull()
    {
        var (port, seen) = Stub();
        using var client = Client(port);
        await client.UpdateEventAsync("e1", 3, "k", description: null, location: "Dock 4", cancellationToken: Ct);
        Assert.Equal(
            "{\"expected_revision\":3,\"idempotency_key\":\"k\",\"description\":null,\"location\":\"Dock 4\"}",
            JsonNode.Parse(seen.Single().Body)!.ToJsonString());
    }

    [Fact]
    public async Task ReadsRetryAfterInSecondsOrAsADate()
    {
        async Task<TimeSpan?> Read(string value)
        {
            var error = await Refused(Answer(429, "{\"error\":{\"code\":\"rate_limited\"}}", ("Retry-After", value)));
            Assert.Equal((429, "rate_limited"), (error.Status, error.Code));
            return error.RetryAfter;
        }

        Assert.Equal(TimeSpan.FromSeconds(7), await Read("7"));
        Assert.Equal(TimeSpan.FromMilliseconds(1500), await Read("1.5"));
        Assert.Equal(TimeSpan.FromDays(1), await Read("99999999999999999999"));
        Assert.Equal(TimeSpan.Zero, await Read("Wed, 21 Oct 2015 07:28:00 GMT"));
        foreach (var absent in new[] { "-5", "NaN", "Infinity", "1e3", "soon", "Wed, 21 Oct 2015 07:28:00 +0000" })
        {
            Assert.True(await Read(absent) is null, absent);
        }
        var when = DateTimeOffset.UtcNow.AddSeconds(120).ToString("r", CultureInfo.InvariantCulture);
        var wait = await Read(when);
        Assert.True(wait >= TimeSpan.FromSeconds(100) && wait <= TimeSpan.FromSeconds(120), $"{when} read as {wait}");
    }

    [Fact]
    public async Task AnErrorWithoutAJsonBodyIsStillARefusal()
    {
        Assert.Equal("http_500", (await Refused(Answer(500, "<html>oops</html>"))).Code);
        Assert.Equal("http_502", (await Refused(Answer(502, ""))).Code);
        Assert.Equal("invalid_response", (await Refused(Answer(200, "<html>captive portal</html>"))).Code);
    }

    [Fact]
    public async Task TheTimeoutCoversTheBody()
    {
        var (port, _) = Stub(async stream =>
        {
            await stream.WriteAsync(Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n"));
            for (var i = 0; i < 100; i++)
            {
                await stream.WriteAsync(Encoding.UTF8.GetBytes(" "));
                await Task.Delay(200);
            }
        });
        using var client = Client(port, new SlotlockClientOptions { Timeout = TimeSpan.FromMilliseconds(500) });
        var started = DateTime.UtcNow;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.ListResourcesAsync(cancellationToken: Ct));
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(2), $"took {DateTime.UtcNow - started}");
        using var closed = new SlotlockClient("http://127.0.0.1:9", "slk_x");
        await Assert.ThrowsAsync<HttpRequestException>(() => closed.ListResourcesAsync(cancellationToken: Ct));
    }
}
