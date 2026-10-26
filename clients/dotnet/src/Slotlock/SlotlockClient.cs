#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Slotlock;

/// <summary>
/// A client for Slotlock's REST API: the agent tools and the application API. Every operation is
/// an <c>...Async</c> method; <see cref="CallAsync"/> runs one by name. A refusal is a
/// <see cref="SlotlockException"/> with the HTTP status and the server's code. Thread-safe.
/// </summary>
/// <example>
/// <code>
/// using var slotlock = new SlotlockClient("https://calendar.example.com", apiKey);
/// var hold = await slotlock.AcquireHoldAsync(resourceId, "2027-03-29T09:00:00Z", "2027-03-29T10:00:00Z", 600);
/// </code>
/// </example>
public sealed partial class SlotlockClient : IDisposable
{
    /// <summary>This client's version, sent in its User-Agent.</summary>
    public const string Version = "0.2.0";

    private static readonly HashSet<string> Loopback = new(StringComparer.OrdinalIgnoreCase) { "localhost", "127.0.0.1", "[::1]", "::1" };

    /// <summary>The longest wait a Retry-After is read as.</summary>
    private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromDays(1);

    private static readonly string[] Weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    private static readonly string[] Months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    private readonly Uri _baseUrl;
    private readonly string _apiKey;
    private readonly string _userAgent;
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;

    /// <summary>
    /// A client for the server at <paramref name="baseUrl"/> (its SLOTLOCK_PUBLIC_URL) with an API
    /// key (<c>slk_...</c>) or the server token. The application API needs a key with the admin scope.
    /// </summary>
    /// <param name="baseUrl">The server's public URL.</param>
    /// <param name="apiKey">The key, sent as a bearer token.</param>
    /// <param name="options">A timeout, a User-Agent, an HttpClient, or plain HTTP to another host.</param>
    /// <exception cref="ArgumentException">The URL is not http(s), is plain HTTP to another host without
    /// <see cref="SlotlockClientOptions.AllowInsecure"/>, or the key cannot be a credential.</exception>
    public SlotlockClient(string baseUrl, string apiKey, SlotlockClientOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(baseUrl);
        ArgumentNullException.ThrowIfNull(apiKey);
        options ??= new SlotlockClientOptions();
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https") || uri.Host.Length == 0)
        {
            throw new ArgumentException("baseUrl must be an http:// or https:// URL", nameof(baseUrl));
        }
        if (uri.Query.Length > 0 || uri.Fragment.Length > 0)
        {
            throw new ArgumentException("baseUrl must not have a query or a fragment", nameof(baseUrl));
        }
        if (uri.Scheme == "http" && !Loopback.Contains(uri.Host) && !options.AllowInsecure)
        {
            throw new ArgumentException(
                "baseUrl is plain HTTP to another host, which would send the key unencrypted; use https:// or AllowInsecure",
                nameof(baseUrl));
        }
        if (apiKey.Length == 0 || apiKey.Any(c => c < 0x21 || c > 0x7e))
        {
            throw new ArgumentException("apiKey must be a Slotlock API key or the server token", nameof(apiKey));
        }
        _baseUrl = new Uri(baseUrl.TrimEnd('/'));
        _apiKey = apiKey;
        _userAgent = options.UserAgent ?? $"slotlock-dotnet/{Version}";
        _ownsHttp = options.HttpClient is null;
        // A redirect is answered as it came, so the key goes with no other request; this machine is
        // reached directly, since a proxy would carry the key off it.
        _http = options.HttpClient ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = !Loopback.Contains(uri.Host) })
        {
            Timeout = options.Timeout,
        };
    }

    /// <summary>Names the server, never the key.</summary>
    public override string ToString() => $"SlotlockClient({_baseUrl.OriginalString})";

    /// <summary>Releases the HttpClient this client created; one it was given stays open.</summary>
    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }

    /// <summary>Runs an operation by its name with its arguments, path parameters included.</summary>
    /// <param name="operation">The operation's name, <c>slotlock_...</c>.</param>
    /// <param name="values">Its arguments, by name; a null value sends null.</param>
    /// <param name="cancellationToken">Cancels the request.</param>
    /// <returns>The response body.</returns>
    /// <exception cref="SlotlockException">The server refused the call.</exception>
    /// <exception cref="ArgumentException">No such operation, a missing path parameter, or an unknown argument.</exception>
    public async Task<JsonObject> CallAsync(string operation, JsonObject? values, CancellationToken cancellationToken = default)
    {
        if (!Operations.TryGetValue(operation, out var spec))
        {
            throw new ArgumentException($"no Slotlock operation named {operation}", nameof(operation));
        }
        var arguments = new Dictionary<string, JsonNode?>();
        foreach (var (name, value) in values ?? new JsonObject()) arguments[name] = value?.DeepClone();
        var path = spec.Path;
        foreach (var name in spec.PathParams)
        {
            // The server resolves . and .. as path segments, which would name another route.
            if (!arguments.Remove(name, out var node) || node is not JsonValue text || !text.TryGetValue(out string? value) || value is "" or "." or "..")
            {
                throw new ArgumentException($"{operation} needs {name}, a non-empty string other than . and ..", nameof(values));
            }
            path = path.Replace("{" + name + "}", Uri.EscapeDataString(value));
        }
        using var request = new HttpRequestMessage(new HttpMethod(spec.Method), (Uri?)null);
        if (spec.Method is "GET" or "DELETE")
        {
            var pairs = new List<string>();
            foreach (var (name, value) in arguments)
            {
                if (!spec.Query.Contains(name))
                {
                    throw new ArgumentException($"{operation} has no argument {name}", nameof(values));
                }
                var items = value is JsonArray list ? list.ToList() : new List<JsonNode?> { value };
                foreach (var item in items) pairs.Add($"{Uri.EscapeDataString(name)}={Uri.EscapeDataString(QueryValue(name, item))}");
            }
            if (pairs.Count > 0) path += "?" + string.Join("&", pairs);
        }
        else
        {
            var body = new JsonObject();
            foreach (var (name, value) in arguments) body[name] = value;
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }
        request.RequestUri = new Uri(_baseUrl.OriginalString.TrimEnd('/') + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.TryAddWithoutValidation("User-Agent", _userAgent);
        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var status = (int)response.StatusCode;
        if (!response.IsSuccessStatusCode)
        {
            var retryAfter = response.Headers.NonValidated.TryGetValues("Retry-After", out var retryValues)
                ? RetryAfter(retryValues.FirstOrDefault(), DateTimeOffset.UtcNow)
                : null;
            throw Refusal(status, payload, retryAfter);
        }
        if (payload.Length == 0) return new JsonObject();
        try
        {
            return JsonNode.Parse(payload) as JsonObject ?? throw new SlotlockException(status, "invalid_response", null);
        }
        catch (JsonException)
        {
            throw new SlotlockException(status, "invalid_response", null);
        }
    }

    private static string QueryValue(string name, JsonNode? value)
    {
        if (value is JsonValue scalar)
        {
            if (scalar.TryGetValue(out string? text)) return text;
            if (scalar.TryGetValue(out bool flag)) return flag ? "true" : "false";
            if (scalar.TryGetValue(out long whole)) return whole.ToString(CultureInfo.InvariantCulture);
            if (scalar.TryGetValue(out double number)) return number.ToString("R", CultureInfo.InvariantCulture);
            if (scalar.GetValueKind() is JsonValueKind.Number) return scalar.ToJsonString();
        }
        throw new ArgumentException($"query argument {name} must be a string, number or boolean");
    }

    /// <summary>Retry-After in seconds or as an HTTP date, at most a day; anything else is null.</summary>
    internal static TimeSpan? RetryAfter(string? value, DateTimeOffset now)
    {
        if (value is null) return null;
        value = value.Trim();
        var dot = value.IndexOf('.');
        if (Digits(dot < 0 ? value : value[..dot]) && (dot < 0 || Digits(value[(dot + 1)..])))
        {
            // A number too long for a double parses as infinity, which the day caps.
            var seconds = double.Parse(value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
            return seconds >= MaxRetryAfter.TotalSeconds ? MaxRetryAfter : TimeSpan.FromSeconds(seconds);
        }
        // IMF-fixdate, `Sun, 06 Nov 1994 08:49:37 GMT`; the day of the week is checked for its form only.
        if (value.Length == 29 && value[3..5] == ", " && Weekdays.Contains(value[..3]) && Months.Contains(value[8..11])
            && DateTimeOffset.TryParseExact(value[5..], "dd MMM yyyy HH':'mm':'ss 'GMT'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var when))
        {
            var wait = when - now;
            return wait < TimeSpan.Zero ? TimeSpan.Zero : wait > MaxRetryAfter ? MaxRetryAfter : wait;
        }
        return null;
    }

    private static bool Digits(string text) => text.Length > 0 && text.All(c => c is >= '0' and <= '9');

    private static SlotlockException Refusal(int status, string payload, TimeSpan? retryAfter)
    {
        var code = $"http_{status}";
        try
        {
            if (JsonNode.Parse(payload)?["error"]?["code"] is JsonValue found && found.TryGetValue(out string? text) && text.Length > 0)
            {
                code = text;
            }
        }
        catch (JsonException)
        {
            // Not JSON: the status alone says what happened.
        }
        catch (InvalidOperationException)
        {
            // JSON, but not an object with an error: the status alone says what happened.
        }
        return new SlotlockException(status, code, retryAfter);
    }
}

/// <summary>How <see cref="SlotlockClient"/> sends requests.</summary>
public sealed class SlotlockClientOptions
{
    /// <summary>The longest one call may take, its response body included, when the client creates its HttpClient. Default 30 seconds.</summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Send the key over plain HTTP to a host other than this machine.</summary>
    public bool AllowInsecure { get; init; }

    /// <summary>Sent as User-Agent; <c>slotlock-dotnet/&lt;version&gt;</c> unless set.</summary>
    public string? UserAgent { get; init; }

    /// <summary>
    /// Send requests with this HttpClient (handlers, proxies, timeouts); the client never disposes it. Its handler
    /// should not follow redirects (<c>AllowAutoRedirect = false</c>), as the client's own does not.
    /// </summary>
    public HttpClient? HttpClient { get; init; }
}

/// <summary>
/// A call the server refused: <see cref="Status"/> is the HTTP status, <see cref="Code"/> says why
/// (<c>overlap</c>, <c>forbidden</c>, <c>confirmation_required</c>, ...), or <c>http_&lt;status&gt;</c>
/// when the response carried no code; a redirect is one too (<c>http_302</c>), never followed.
/// </summary>
public sealed class SlotlockException : Exception
{
    internal SlotlockException(int status, string code, TimeSpan? retryAfter)
        : base($"Slotlock answered {status} {code}")
    {
        Status = status;
        Code = code;
        RetryAfter = retryAfter;
    }

    /// <summary>The HTTP status.</summary>
    public int Status { get; }

    /// <summary>The server's error code.</summary>
    public string Code { get; }

    /// <summary>What a 429 or 503 asks the caller to wait, when its Retry-After says, in seconds or as a date (at most a day).</summary>
    public TimeSpan? RetryAfter { get; }
}

/// <summary>
/// An optional argument: <c>default</c> leaves it out, any value (null included, for an argument
/// that may be null) sends it. Arguments convert to it implicitly: <c>title: "Handover"</c>,
/// <c>description: null</c>.
/// </summary>
/// <typeparam name="T">The argument's type.</typeparam>
public readonly struct Optional<T>
{
    private readonly T _value;

    /// <summary>An argument to send.</summary>
    /// <param name="value">What to send.</param>
    public Optional(T value)
    {
        _value = value;
        HasValue = true;
    }

    /// <summary>Whether the argument is sent.</summary>
    public bool HasValue { get; }

    /// <summary>The argument.</summary>
    /// <exception cref="InvalidOperationException">It is left out.</exception>
    public T Value => HasValue ? _value : throw new InvalidOperationException("The optional argument is left out.");

    /// <summary>Sends <paramref name="value"/>.</summary>
    /// <param name="value">What to send.</param>
    public static implicit operator Optional<T>(T value) => new(value);

    /// <inheritdoc/>
    public override string ToString() => HasValue ? $"{_value}" : "(left out)";
}

/// <summary>One REST operation: its method, path, path parameters and query parameters.</summary>
internal sealed record Operation(string Method, string Path, IReadOnlyList<string> PathParams, IReadOnlyList<string> Query);

/// <summary>Arguments as JSON, without reflection.</summary>
internal static class Json
{
    public static JsonNode? ToNode(string? value) => value is null ? null : JsonValue.Create(value);

    public static JsonNode ToNode(long value) => JsonValue.Create(value);

    public static JsonNode ToNode(double value) => double.IsFinite(value)
        ? JsonValue.Create(value)
        : throw new ArgumentException("JSON has no NaN or infinity");

    public static JsonNode ToNode(bool value) => JsonValue.Create(value);

    public static JsonNode? ToNode(IEnumerable<string>? values) =>
        values is null ? null : new JsonArray(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());

    public static JsonNode? ToNode(JsonNode? value) => value?.DeepClone();
}
