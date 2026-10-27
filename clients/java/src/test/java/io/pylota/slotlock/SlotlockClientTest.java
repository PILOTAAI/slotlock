package io.pylota.slotlock;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.lang.reflect.Method;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

/**
 * The Java client against a running Slotlock server, and its checks that need none. The server
 * tests run when SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY (a key with read, write and admin) are set,
 * against a server that confirms only deletes (SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event). Every
 * language client runs the same scenario.
 */
class SlotlockClientTest {
  private static final String URL = System.getenv().getOrDefault("SLOTLOCK_URL", "");
  private static final String KEY = System.getenv().getOrDefault("SLOTLOCK_ADMIN_KEY", "");
  private static final List<Map<String, Object>> ALL_WEEK =
      List.of(Map.of("rrule", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", "start_minutes", 0L, "duration_minutes", 1440L));

  private SlotlockClient client;
  private String suffix;
  private Instant day;

  @BeforeEach
  void setUp() {
    suffix = UUID.randomUUID().toString().substring(0, 12);
    day = LocalDate.now(ZoneOffset.UTC).plusDays(30).atStartOfDay(ZoneOffset.UTC).toInstant();
    if (!URL.isEmpty() && !KEY.isEmpty()) client = SlotlockClient.builder(URL, KEY).build();
  }

  private String at(double hours) {
    return day.plusSeconds((long) (hours * 3600)).toString();
  }

  private static void refused(int status, String code, Executable call) {
    SlotlockException error = assertThrows(SlotlockException.class, call);
    assertEquals(List.of(status, code), List.of(error.status(), error.code()));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object value) {
    return (Map<String, Object>) value;
  }

  @Test
  void hasAMethodForEveryOperation() {
    List<String> methods = Arrays.stream(SlotlockOperations.class.getMethods()).map(Method::getName).toList();
    for (String name : SlotlockOperations.OPERATIONS.keySet()) {
      StringBuilder method = new StringBuilder();
      for (String part : name.substring("slotlock_".length()).split("_")) {
        method.append(method.isEmpty() ? part : Character.toUpperCase(part.charAt(0)) + part.substring(1));
      }
      assertTrue(methods.contains(method.toString()), name);
    }
  }

  @Test
  void refusesToSendAKeyOverPlainHttpToAnotherHost() {
    IllegalArgumentException refused =
        assertThrows(IllegalArgumentException.class, () -> SlotlockClient.builder("http://calendar.example.com", "slk_x").build());
    assertTrue(refused.getMessage().contains("unencrypted"));
    SlotlockClient.builder("http://calendar.example.com", "slk_x").allowInsecure().build();
    SlotlockClient.builder("http://localhost:8080", "slk_x").build();
    SlotlockClient.builder("https://calendar.example.com/", "slk_x").build();
    for (String url : List.of("ftp://example.com", "calendar.example.com", "https://example.com/?a=1")) {
      assertThrows(IllegalArgumentException.class, () -> SlotlockClient.builder(url, "slk_x").build(), url);
    }
    for (String key : List.of("", "slk_ x", "slk_\n")) {
      assertThrows(IllegalArgumentException.class, () -> SlotlockClient.builder("https://example.com", key).build());
    }
  }

  @Test
  void neverShowsTheKey() {
    assertFalse(SlotlockClient.builder("https://calendar.example.com", "slk_secret").build().toString().contains("slk_secret"));
  }

  @Test
  void refusesAnUnknownOperationOrArgument() {
    SlotlockClient offline = SlotlockClient.builder("https://calendar.example.com", "slk_x").build();
    assertThrows(IllegalArgumentException.class, () -> offline.call("slotlock_nothing", Map.of()));
    IllegalArgumentException missing = assertThrows(IllegalArgumentException.class, () -> offline.call("slotlock_get_resource", Map.of()));
    assertTrue(missing.getMessage().contains("needs resource_id"));
    IllegalArgumentException unknown =
        assertThrows(IllegalArgumentException.class, () -> offline.call("slotlock_list_resources", Map.of("limt", 5)));
    assertTrue(unknown.getMessage().contains("has no argument limt"));
    IllegalArgumentException optional =
        assertThrows(IllegalArgumentException.class, () -> offline.listResources(Map.of("limt", 5)));
    assertTrue(optional.getMessage().contains("has no optional argument limt"));
  }

  @Test
  void readsAndWritesJsonStrictly() {
    Map<String, Object> value = new java.util.LinkedHashMap<>();
    value.put("text", "a \"quote\", a \\ backslash, a\nline, é, 👩‍🔧, \u0001");
    value.put("whole", 12L);
    value.put("big", new java.math.BigInteger("123456789012345678901234567890"));
    value.put("fraction", 1.5);
    value.put("nothing", null);
    value.put("list", List.of(true, false, List.of()));
    assertEquals(value, Json.parse(Json.write(value)));
    assertEquals(Map.of("a", List.of(1L, -0.5, 2e3)), Json.parse(" {\"a\" : [1, -0.5, 2E3]} "));
    assertEquals("\uD83D\uDC69", Json.parse("\"\\ud83d\\udc69\""));
    for (String bad : List.of("", "{", "[1,]", "{\"a\":1,}", "01", "1.", "-", "\"\u0001\"", "tru", "{} x", "\"\\x\"", "[" .repeat(600))) {
      assertThrows(IllegalArgumentException.class, () -> Json.parse(bad), bad);
    }
    assertThrows(IllegalArgumentException.class, () -> Json.write(Double.NaN));
    assertThrows(IllegalArgumentException.class, () -> Json.write(new Object()));
    assertEquals("BK%2F42%20%C3%BC%3F%26%3D%23", SlotlockClient.encode("BK/42 ü?&=#"));
  }

  @Test
  void booksHoldsAndReservationsWithoutDoubleBooking() {
    assumeTrue(client != null, "set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
    Map<String, Object> resource = map(client.createResource("java-" + suffix, Map.of("timezone", "UTC")).get("resource"));
    String id = (String) resource.get("id");
    assertEquals(resource, client.getResource(id).get("resource"));
    Map<String, Object> hours = map(client.setResourceAvailability(id, ALL_WEEK).get("resource"));
    assertEquals(ALL_WEEK, hours.get("availability"));

    Map<String, Object> hold = map(client.acquireHold(id, at(9), at(10), 600, Map.of("source", "checkout")).get("hold"));
    assertEquals("checkout", hold.get("source"));
    refused(409, "overlap", () -> client.acquireHold(id, at(9), at(10), 60));
    String holdId = (String) hold.get("id");
    Object confirmed = client.confirmHold(holdId).get("reservation");
    assertEquals(holdId, map(confirmed).get("id"));
    assertEquals(confirmed, client.confirmHold(holdId).get("reservation"));

    // A reference with a slash, a space and an accent travels in the path intact.
    String reference = "BK/" + suffix + " ü";
    Map<String, Object> put = client.putReservation(reference, id, at(11), at(12), 1, Map.of("buffer_after_minutes", 30));
    assertEquals(false, put.get("replayed"));
    assertEquals(reference, map(put.get("reservation")).get("reservation_ref"));
    assertEquals(30L, map(put.get("reservation")).get("buffer_after_minutes"));
    assertEquals(true, client.putReservation(reference, id, at(11), at(12), 1, Map.of("buffer_after_minutes", 30)).get("replayed"));
    refused(409, "overlap", () -> client.acquireHold(id, at(12.25), at(12.5), 60));

    Map<String, Object> freeBusy = client.getFreeBusy(List.of(id), at(0), at(24));
    List<?> busy = (List<?>) map(((List<?>) freeBusy.get("resources")).get(0)).get("busy");
    List<List<Instant>> intervals = new ArrayList<>();
    for (Object interval : busy) {
      intervals.add(List.of(Instant.parse((String) map(interval).get("start")), Instant.parse((String) map(interval).get("end"))));
    }
    assertEquals(
        List.of(List.of(Instant.parse(at(9)), Instant.parse(at(10))), List.of(Instant.parse(at(11)), Instant.parse(at(12.5)))),
        intervals);

    assertEquals(Map.of("cancelled", true, "revision", 2L), client.cancelReservation(reference, 2));
    assertEquals(
        Map.of("revision", 1L, "replayed", false),
        client.recordCoverage(id, "ics:https://calendar.example.com/fleet.ics", at(0), at(24), 1));
    assertEquals(
        java.util.Set.of("extended", "conflicts", "refused", "pruned", "zone_shifts", "capped"), client.runMaintenance().keySet());

    boolean found = false;
    String cursor = null;
    while (!found) {
      Map<String, Object> optional = new HashMap<>();
      optional.put("limit", 100);
      if (cursor != null) optional.put("cursor", cursor);
      Map<String, Object> page = client.listResources(optional);
      for (Object listed : (List<?>) page.get("resources")) found |= id.equals(map(listed).get("id"));
      if (!(page.get("next_cursor") instanceof String next)) break;
      cursor = next;
    }
    assertTrue(found);
  }

  @Test
  void writesEventsAndClearsAFieldWithNull() {
    assumeTrue(client != null, "set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
    String id = (String) map(client.createResource("java-events-" + suffix).get("resource")).get("id");
    client.setResourceAvailability(id, ALL_WEEK);
    Map<String, Object> created =
        map(
            client
                .createEvent(
                    id, at(14), at(15), "UTC", UUID.randomUUID().toString(),
                    Map.of("title", "Handover", "description", "Keys at the desk"))
                .get("event"));
    assertEquals(List.of("Handover", "Keys at the desk"), List.of(created.get("title"), created.get("description")));
    // A null value sends null, which clears the description; the title, left out, stays.
    Map<String, Object> clear = new HashMap<>();
    clear.put("description", null);
    Map<String, Object> updated =
        map(
            client
                .updateEvent((String) created.get("id"), (Long) created.get("revision"), UUID.randomUUID().toString(), clear)
                .get("event"));
    assertEquals("Handover", updated.get("title"));
    assertNull(updated.get("description"));
    assertTrue(updated.containsKey("description"));
    // The server makes deletes wait for a person, which REST cannot ask: 428.
    refused(
        428,
        "confirmation_required",
        () -> client.deleteEvent((String) created.get("id"), (Long) updated.get("revision"), UUID.randomUUID().toString()));
  }

  @Test
  void retriesAKeyedHoldAndRetiresAResource() {
    assumeTrue(client != null, "set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
    Map<String, Object> resource = map(client.createResource("java-retire-" + suffix, Map.of("visibility", "private")).get("resource"));
    assertEquals("private", resource.get("visibility"));
    String id = (String) resource.get("id");
    client.setResourceAvailability(id, ALL_WEEK);
    // A keyed hold retried answers the hold the first request made.
    Map<String, Object> keyed = Map.of("idempotency_key", "java-hold-" + suffix);
    Map<String, Object> hold = map(client.acquireHold(id, at(9), at(10), 600, keyed).get("hold"));
    assertEquals(hold, client.acquireHold(id, at(9), at(10), 600, keyed).get("hold"));
    refused(422, "idempotency_conflict", () -> client.acquireHold(id, at(9), at(10), 60, keyed));
    String holdId = (String) hold.get("id");
    assertEquals(hold, client.getHold(holdId).get("hold"));
    // Confirmed, it is the reservation its id names, cancelled by that reference.
    Object confirmed = client.confirmHold(holdId).get("reservation");
    assertEquals(confirmed, client.getReservation(holdId).get("reservation"));
    client.cancelReservation(holdId, 2);
    refused(404, "reservation_not_found", () -> client.getReservation(holdId));

    assertTrue(map(client.archiveResource(id).get("resource")).get("archived_at") instanceof String);
    assertNull(map(client.restoreResource(id).get("resource")).get("archived_at"));
    assertEquals(Map.of("deleted", true), client.deleteResource(id));
    refused(404, "resource_not_found", () -> client.getResource(id));
  }

  @Test
  void saysWhyACallWasRefused() {
    assumeTrue(client != null, "set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY to run against a server");
    refused(404, "resource_not_found", () -> client.getResource("00000000-0000-4000-8000-000000000000"));
    SlotlockClient stranger = SlotlockClient.builder(URL, "slk_" + "0".repeat(46)).build();
    refused(401, "authentication_required", stranger::runMaintenance);
  }
}
