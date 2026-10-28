package io.pylota.slotlock;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A client for Slotlock's REST API: the agent tools and the application API.
 *
 * <pre>{@code
 * SlotlockClient slotlock = SlotlockClient.builder("https://calendar.example.com", apiKey).build();
 * Map<String, Object> hold =
 *     slotlock.acquireHold(resourceId, "2027-03-29T09:00:00Z", "2027-03-29T10:00:00Z", 600);
 * }</pre>
 *
 * <p>Every operation is a method; {@link #call} runs one by name. A refusal is a {@link
 * SlotlockException} with the HTTP status and the server's code. Thread-safe.
 */
public final class SlotlockClient extends SlotlockOperations {
  /** This client's version, sent in its User-Agent. */
  public static final String VERSION = "0.4.1";

  private static final Set<String> LOOPBACK = Set.of("localhost", "127.0.0.1", "[::1]", "::1");

  /** The longest wait a Retry-After is read as. */
  private static final Duration MAX_RETRY_AFTER = Duration.ofDays(1);

  private static final Pattern SECONDS = Pattern.compile("[0-9]+(\\.[0-9]+)?");
  private static final Pattern HTTP_DATE =
      Pattern.compile("(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}) GMT");
  private static final DateTimeFormatter HTTP_DATE_TIME =
      DateTimeFormatter.ofPattern("dd MMM uuuu HH:mm:ss", Locale.US).withResolverStyle(ResolverStyle.STRICT);

  private final String baseUrl;
  private final String apiKey;
  private final Duration timeout;
  private final String userAgent;
  private final HttpClient http;

  private SlotlockClient(Builder builder, boolean loopback) {
    this.baseUrl = builder.baseUrl.replaceAll("/+$", "");
    this.apiKey = builder.apiKey;
    this.timeout = builder.timeout;
    this.userAgent = builder.userAgent;
    if (builder.http != null) {
      this.http = builder.http;
    } else {
      // Redirects are never followed (the default), so the key goes with no other request; this
      // machine is reached directly, since a proxy would carry the key off it.
      HttpClient.Builder http = HttpClient.newBuilder().connectTimeout(builder.timeout);
      if (loopback) http.proxy(HttpClient.Builder.NO_PROXY);
      this.http = http.build();
    }
  }

  /**
   * Starts a client for the server at {@code baseUrl} (its SLOTLOCK_PUBLIC_URL) with an API key
   * ({@code slk_...}) or the server token. The application API needs a key with the admin scope.
   *
   * @param baseUrl the server's public URL
   * @param apiKey the key, sent as a bearer token
   * @return a builder
   */
  public static Builder builder(String baseUrl, String apiKey) {
    return new Builder(baseUrl, apiKey);
  }

  /** How a {@link SlotlockClient} is built. */
  public static final class Builder {
    private final String baseUrl;
    private final String apiKey;
    private Duration timeout = Duration.ofSeconds(30);
    private boolean allowInsecure;
    private String userAgent = "slotlock-java/" + VERSION;
    private HttpClient http;

    private Builder(String baseUrl, String apiKey) {
      this.baseUrl = Objects.requireNonNull(baseUrl, "baseUrl");
      this.apiKey = Objects.requireNonNull(apiKey, "apiKey");
    }

    /**
     * The longest one call may take, its response body included. Default 30 seconds.
     *
     * @param timeout the limit
     * @return this builder
     */
    public Builder timeout(Duration timeout) {
      this.timeout = Objects.requireNonNull(timeout, "timeout");
      return this;
    }

    /**
     * Sends the key over plain HTTP to a host other than this machine.
     *
     * @return this builder
     */
    public Builder allowInsecure() {
      this.allowInsecure = true;
      return this;
    }

    /**
     * Replaces the User-Agent, {@code slotlock-java/<version>} by default.
     *
     * @param userAgent the User-Agent
     * @return this builder
     */
    public Builder userAgent(String userAgent) {
      this.userAgent = Objects.requireNonNull(userAgent, "userAgent");
      return this;
    }

    /**
     * Sends requests with this client (proxies, TLS, executors). It must not follow redirects, which
     * would send the key with another request: {@link #build} refuses one that does.
     *
     * @param http the client
     * @return this builder
     */
    public Builder httpClient(HttpClient http) {
      this.http = Objects.requireNonNull(http, "http");
      return this;
    }

    /**
     * Builds the client.
     *
     * @return the client
     * @throws IllegalArgumentException for a URL that is not http(s), plain HTTP to another host
     *     without {@link #allowInsecure}, a key that cannot be a credential, or an HTTP client that
     *     follows redirects
     */
    public SlotlockClient build() {
      URI uri;
      try {
        uri = new URI(baseUrl);
      } catch (URISyntaxException e) {
        throw new IllegalArgumentException("baseUrl must be an http:// or https:// URL", e);
      }
      String scheme = uri.getScheme();
      if (!("http".equals(scheme) || "https".equals(scheme)) || uri.getHost() == null) {
        throw new IllegalArgumentException("baseUrl must be an http:// or https:// URL");
      }
      if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
        throw new IllegalArgumentException("baseUrl must not have a query or a fragment");
      }
      if ("http".equals(scheme) && !LOOPBACK.contains(uri.getHost()) && !allowInsecure) {
        throw new IllegalArgumentException(
            "baseUrl is plain HTTP to another host, which would send the key unencrypted; use https:// or allowInsecure()");
      }
      if (apiKey.isEmpty() || apiKey.chars().anyMatch(c -> c < 0x21 || c > 0x7e)) {
        throw new IllegalArgumentException("apiKey must be a Slotlock API key or the server token");
      }
      if (http != null && http.followRedirects() != HttpClient.Redirect.NEVER) {
        throw new IllegalArgumentException("httpClient must not follow redirects, which would send the key elsewhere");
      }
      return new SlotlockClient(this, LOOPBACK.contains(uri.getHost()));
    }
  }

  /** Names the server, never the key. */
  @Override
  public String toString() {
    return "SlotlockClient(" + baseUrl + ")";
  }

  @Override
  public Map<String, Object> call(String operation, Map<String, ?> values) {
    Operation spec = OPERATIONS.get(operation);
    if (spec == null) throw new IllegalArgumentException("no Slotlock operation named " + operation);
    Map<String, Object> arguments = new LinkedHashMap<>();
    if (values != null) arguments.putAll(values);
    String path = spec.path();
    for (String name : spec.pathParams()) {
      // The server resolves . and .. as path segments, which would name another route.
      if (!(arguments.remove(name) instanceof String value) || value.isEmpty() || value.equals(".") || value.equals("..")) {
        throw new IllegalArgumentException(operation + " needs " + name + ", a non-empty string other than . and ..");
      }
      path = path.replace("{" + name + "}", encode(value));
    }
    HttpRequest.BodyPublisher body = HttpRequest.BodyPublishers.noBody();
    boolean hasBody = !("GET".equals(spec.method()) || "DELETE".equals(spec.method()));
    if (hasBody) {
      body = HttpRequest.BodyPublishers.ofString(Json.write(arguments), StandardCharsets.UTF_8);
    } else {
      List<String> pairs = new ArrayList<>();
      for (Map.Entry<String, Object> entry : arguments.entrySet()) {
        if (!spec.query().contains(entry.getKey())) {
          throw new IllegalArgumentException(operation + " has no argument " + entry.getKey());
        }
        Collection<?> items =
            entry.getValue() instanceof Collection<?> list ? list : java.util.Collections.singletonList(entry.getValue());
        for (Object item : items) pairs.add(encode(entry.getKey()) + "=" + encode(queryValue(entry.getKey(), item)));
      }
      if (!pairs.isEmpty()) path += "?" + String.join("&", pairs);
    }
    HttpRequest.Builder request =
        HttpRequest.newBuilder(URI.create(baseUrl + path))
            .timeout(timeout)
            .header("Authorization", "Bearer " + apiKey)
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .method(spec.method(), body);
    if (hasBody) request.header("Content-Type", "application/json");
    CompletableFuture<HttpResponse<String>> pending =
        http.sendAsync(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    HttpResponse<String> response;
    try {
      // The whole call, body included: the request's own timeout stops at the response headers.
      response = pending.get(timeout.toNanos(), TimeUnit.NANOSECONDS);
    } catch (TimeoutException e) {
      pending.cancel(true);
      throw new UncheckedIOException(new HttpTimeoutException("Slotlock did not answer within " + timeout));
    } catch (ExecutionException e) {
      if (e.getCause() instanceof IOException cause) throw new UncheckedIOException(cause);
      if (e.getCause() instanceof RuntimeException cause) throw cause;
      throw new IllegalStateException("calling Slotlock failed", e.getCause());
    } catch (InterruptedException e) {
      pending.cancel(true);
      Thread.currentThread().interrupt();
      throw new IllegalStateException("interrupted while calling Slotlock", e);
    }
    int status = response.statusCode();
    if (status < 200 || status > 299) throw refusal(status, response);
    if (response.body().isEmpty()) return new LinkedHashMap<>();
    Object decoded;
    try {
      decoded = Json.parse(response.body());
    } catch (IllegalArgumentException e) {
      throw new SlotlockException(status, "invalid_response", null);
    }
    if (!(decoded instanceof Map<?, ?>)) throw new SlotlockException(status, "invalid_response", null);
    @SuppressWarnings("unchecked")
    Map<String, Object> map = (Map<String, Object>) decoded;
    return map;
  }

  private static SlotlockException refusal(int status, HttpResponse<String> response) {
    String code = "http_" + status;
    try {
      if (Json.parse(response.body()) instanceof Map<?, ?> body
          && body.get("error") instanceof Map<?, ?> error
          && error.get("code") instanceof String found
          && !found.isEmpty()) {
        code = found;
      }
    } catch (IllegalArgumentException e) {
      // Not JSON: the status alone says what happened.
    }
    Duration retryAfter =
        response.headers().firstValue("Retry-After").map(value -> retryAfter(value, Instant.now())).orElse(null);
    return new SlotlockException(status, code, retryAfter);
  }

  /** Retry-After in seconds or as an HTTP date, at most a day; anything else is null. */
  static Duration retryAfter(String value, Instant now) {
    String trimmed = value.trim();
    if (SECONDS.matcher(trimmed).matches()) {
      BigDecimal seconds = new BigDecimal(trimmed);
      if (seconds.compareTo(BigDecimal.valueOf(MAX_RETRY_AFTER.getSeconds())) >= 0) return MAX_RETRY_AFTER;
      return Duration.ofNanos(seconds.movePointRight(9).longValue());
    }
    Matcher date = HTTP_DATE.matcher(trimmed);
    if (!date.matches()) return null;
    try {
      Instant when = LocalDateTime.parse(date.group(1), HTTP_DATE_TIME).toInstant(ZoneOffset.UTC);
      Duration wait = Duration.between(now, when);
      if (wait.isNegative()) return Duration.ZERO;
      return wait.compareTo(MAX_RETRY_AFTER) > 0 ? MAX_RETRY_AFTER : wait;
    } catch (DateTimeParseException e) {
      return null;
    }
  }

  private static String queryValue(String name, Object value) {
    if (value instanceof String || value instanceof Number || value instanceof Boolean) return String.valueOf(value);
    throw new IllegalArgumentException("query argument " + name + " must be a string, number or boolean");
  }

  /** Percent-encodes everything but RFC 3986's unreserved characters. */
  static String encode(String value) {
    StringBuilder out = new StringBuilder();
    for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
      int c = b & 0xff;
      if (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '.' || c == '_' || c == '~') {
        out.append((char) c);
      } else {
        out.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16))).append(Character.toUpperCase(Character.forDigit(c & 0xf, 16)));
      }
    }
    return out.toString();
  }
}
