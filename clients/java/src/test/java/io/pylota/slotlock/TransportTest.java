package io.pylota.slotlock;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** The transport against local stub servers: what goes on the wire, and how answers are read. */
class TransportTest {
  private final List<HttpServer> servers = new ArrayList<>();

  /** What a stub saw of one request. */
  record Seen(String rawPath, String rawQuery, String authorization, String body) {}

  /** A local server that records each request and answers with {@code respond}. */
  private final class Stub {
    final List<Seen> seen = Collections.synchronizedList(new ArrayList<>());
    final int port;

    Stub(Consumer<HttpExchange> respond) throws IOException {
      HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      server.createContext(
          "/",
          exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            seen.add(
                new Seen(
                    exchange.getRequestURI().getRawPath(),
                    exchange.getRequestURI().getRawQuery(),
                    exchange.getRequestHeaders().getFirst("Authorization"),
                    body));
            respond.accept(exchange);
            exchange.close();
          });
      server.setExecutor(Executors.newCachedThreadPool());
      server.start();
      servers.add(server);
      port = server.getAddress().getPort();
    }

    Stub() throws IOException {
      this(answer(200, "{}", Map.of()));
    }

    SlotlockClient client() {
      return SlotlockClient.builder("http://127.0.0.1:" + port, "slk_secret").build();
    }
  }

  @AfterEach
  void stop() {
    for (HttpServer server : servers) server.stop(0);
  }

  private static Consumer<HttpExchange> answer(int status, String body, Map<String, String> headers) {
    return exchange -> {
      try {
        headers.forEach((name, value) -> exchange.getResponseHeaders().set(name, value));
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
          out.write(bytes);
        }
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    };
  }

  private SlotlockException refused(Consumer<HttpExchange> respond) throws IOException {
    Stub stub = new Stub(respond);
    return assertThrows(SlotlockException.class, () -> stub.client().listResources());
  }

  @Test
  void aRedirectIsARefusalAndTheKeyStays() throws IOException {
    Stub elsewhere = new Stub();
    String location = "http://localhost:" + elsewhere.port + "/v1/resources";
    SlotlockException e = refused(answer(302, "", Map.of("Location", location)));
    assertEquals(List.of(302, "http_302"), List.of(e.status(), e.code()));
    assertEquals(List.of(), elsewhere.seen);
    // A client that would follow one is refused outright.
    HttpClient following = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL).build();
    assertThrows(
        IllegalArgumentException.class,
        () -> SlotlockClient.builder("https://calendar.example.com", "slk_secret").httpClient(following).build());
  }

  @Test
  void aLoopbackUrlIgnoresAProxy() throws IOException {
    Stub proxy = new Stub();
    Stub server = new Stub();
    Map<String, String> saved = new HashMap<>();
    Map<String, String> proxied =
        Map.of("http.proxyHost", "localhost", "http.proxyPort", String.valueOf(proxy.port), "http.nonProxyHosts", "");
    proxied.keySet().forEach(name -> saved.put(name, System.getProperty(name)));
    try {
      proxied.forEach(System::setProperty);
      server.client().listResources();
    } finally {
      saved.forEach((name, value) -> {
        if (value == null) System.clearProperty(name);
        else System.setProperty(name, value);
      });
    }
    assertEquals(List.of(), proxy.seen);
    assertEquals(1, server.seen.size());
  }

  @Test
  void refusesADotSegmentPathParameterBeforeAnyRequest() throws IOException {
    Stub stub = new Stub();
    for (String reference : List.of(".", "..")) {
      IllegalArgumentException e =
          assertThrows(IllegalArgumentException.class, () -> stub.client().setResourceAvailability(reference, null));
      assertTrue(e.getMessage().contains("needs resource_id"), e.getMessage());
    }
    assertEquals(List.of(), stub.seen);
  }

  @Test
  void encodesPathAndQueryParameters() throws IOException {
    Stub stub = new Stub();
    stub.client().getEvent("BK/42 ?#%é\\x..");
    stub.client()
        .listEvents(
            List.of("a b", "c+d/é"), "2027-03-29T09:00:00+01:00", "2027-03-29T10:00:00+01:00", Map.of("limit", 5));
    assertEquals("/v1/events/BK%2F42%20%3F%23%25%C3%A9%5Cx..", stub.seen.get(0).rawPath());
    assertEquals(
        "resource_ids=a%20b&resource_ids=c%2Bd%2F%C3%A9&start=2027-03-29T09%3A00%3A00%2B01%3A00"
            + "&end=2027-03-29T10%3A00%3A00%2B01%3A00&limit=5",
        stub.seen.get(1).rawQuery());
    assertEquals("Bearer slk_secret", stub.seen.get(1).authorization());
  }

  @Test
  void leavesOutWhatIsMissingAndSendsNullAsNull() throws IOException {
    Stub stub = new Stub();
    Map<String, Object> optional = new HashMap<>();
    optional.put("description", null);
    optional.put("location", "Dock 4");
    stub.client().updateEvent("e1", 3, "k", optional);
    Map<String, Object> expected = new HashMap<>();
    expected.put("expected_revision", 3L);
    expected.put("idempotency_key", "k");
    expected.put("description", null);
    expected.put("location", "Dock 4");
    assertEquals(expected, Json.parse(stub.seen.get(0).body()));
  }

  @Test
  void readsRetryAfterInSecondsOrAsADate() throws IOException {
    Map<String, Optional<Duration>> cases = new HashMap<>();
    cases.put("7", Optional.of(Duration.ofSeconds(7)));
    cases.put("1.5", Optional.of(Duration.ofMillis(1500)));
    cases.put("99999999999999999999", Optional.of(Duration.ofDays(1)));
    cases.put("Wed, 21 Oct 2015 07:28:00 GMT", Optional.of(Duration.ZERO));
    for (String absent : List.of("-5", "NaN", "Infinity", "1e3", "0x1p3", "soon", "Wed, 21 Oct 2015 07:28:00 +0000")) {
      cases.put(absent, Optional.empty());
    }
    for (Map.Entry<String, Optional<Duration>> c : cases.entrySet()) {
      SlotlockException e =
          refused(answer(429, "{\"error\":{\"code\":\"rate_limited\"}}", Map.of("Retry-After", c.getKey())));
      assertEquals(List.of(429, "rate_limited"), List.of(e.status(), e.code()));
      assertEquals(c.getValue(), e.retryAfter(), "Retry-After: " + c.getKey());
    }
    String when =
        DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US)
            .format(ZonedDateTime.now(ZoneOffset.UTC).plusSeconds(120));
    Duration wait =
        refused(answer(503, "{}", Map.of("Retry-After", when))).retryAfter().orElseThrow(() -> new AssertionError(when));
    assertTrue(wait.getSeconds() >= 100 && wait.getSeconds() <= 120, when + " read as " + wait);
  }

  @Test
  void anErrorWithoutAJsonBodyIsStillARefusal() throws IOException {
    assertEquals("http_500", refused(answer(500, "<html>oops</html>", Map.of())).code());
    assertEquals("http_502", refused(answer(502, "", Map.of())).code());
    Stub stub = new Stub(answer(200, "<html>captive portal</html>", Map.of()));
    assertThrows(SlotlockException.class, () -> stub.client().listResources());
  }

  @Test
  void theTimeoutCoversTheBody() throws IOException {
    Stub stub =
        new Stub(
            exchange -> {
              try {
                exchange.sendResponseHeaders(200, 100);
                OutputStream out = exchange.getResponseBody();
                for (int i = 0; i < 100; i++) {
                  out.write(' ');
                  out.flush();
                  Thread.sleep(200);
                }
              } catch (IOException | InterruptedException e) {
                // The client hung up.
              }
            });
    SlotlockClient client =
        SlotlockClient.builder("http://127.0.0.1:" + stub.port, "slk_secret").timeout(Duration.ofMillis(500)).build();
    long started = System.nanoTime();
    assertThrows(UncheckedIOException.class, client::listResources);
    long millis = (System.nanoTime() - started) / 1_000_000;
    assertTrue(millis < 2000, "a 500 ms timeout took " + millis + " ms");
    assertThrows(
        UncheckedIOException.class, () -> SlotlockClient.builder("http://127.0.0.1:9", "slk_x").build().listResources());
  }
}
