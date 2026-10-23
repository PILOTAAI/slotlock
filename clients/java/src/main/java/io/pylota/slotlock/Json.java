package io.pylota.slotlock;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Strict JSON (RFC 8259) for the client, so it needs no library. Parsing returns {@code
 * Map<String, Object>} (in document order), {@code List<Object>}, {@code String}, {@code Long} (an
 * integer that fits), {@code BigInteger}, {@code Double}, {@code Boolean} or {@code null}.
 */
public final class Json {
  /** Deeper nesting than this is refused rather than parsed with the stack. */
  private static final int MAX_DEPTH = 512;

  private final String text;
  private int at;

  private Json(String text) {
    this.text = text;
  }

  /**
   * Parses one JSON value.
   *
   * @param text the JSON
   * @return the value
   * @throws IllegalArgumentException when {@code text} is not exactly one JSON value
   */
  public static Object parse(String text) {
    Json parser = new Json(text);
    parser.space();
    Object value = parser.value(0);
    parser.space();
    if (parser.at != text.length()) throw parser.error("unexpected text after the value");
    return value;
  }

  /**
   * Writes a value as JSON: maps with string keys, collections, strings, numbers, booleans and null.
   *
   * @param value the value
   * @return its JSON
   * @throws IllegalArgumentException for anything else, or a number JSON cannot hold
   */
  public static String write(Object value) {
    StringBuilder out = new StringBuilder();
    write(value, out, 0);
    return out.toString();
  }

  private static void write(Object value, StringBuilder out, int depth) {
    if (depth > MAX_DEPTH) throw new IllegalArgumentException("JSON nested too deeply");
    if (value == null) {
      out.append("null");
    } else if (value instanceof String string) {
      quote(string, out);
    } else if (value instanceof Boolean flag) {
      out.append(flag.booleanValue());
    } else if (value instanceof Double || value instanceof Float) {
      double number = ((Number) value).doubleValue();
      if (Double.isNaN(number) || Double.isInfinite(number)) {
        throw new IllegalArgumentException("JSON has no NaN or infinity");
      }
      out.append(number == Math.rint(number) && Math.abs(number) < 1e15 ? Long.toString((long) number) : Double.toString(number));
    } else if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long
        || value instanceof BigInteger) {
      out.append(value);
    } else if (value instanceof BigDecimal decimal) {
      out.append(decimal.toString());
    } else if (value instanceof Map<?, ?> map) {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        if (!(entry.getKey() instanceof String key)) {
          throw new IllegalArgumentException("a JSON object's keys are strings");
        }
        if (!first) out.append(',');
        first = false;
        quote(key, out);
        out.append(':');
        write(entry.getValue(), out, depth + 1);
      }
      out.append('}');
    } else if (value instanceof Collection<?> list) {
      out.append('[');
      boolean first = true;
      for (Object item : list) {
        if (!first) out.append(',');
        first = false;
        write(item, out, depth + 1);
      }
      out.append(']');
    } else {
      throw new IllegalArgumentException("JSON cannot hold a " + value.getClass().getName());
    }
  }

  private static void quote(String value, StringBuilder out) {
    out.append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        default -> {
          if (c < 0x20 || Character.isSurrogate(c) && !wellFormedSurrogate(value, i)) {
            out.append(String.format("\\u%04x", (int) c));
          } else {
            out.append(c);
          }
        }
      }
    }
    out.append('"');
  }

  /** Whether the surrogate at {@code i} is half of a pair: an unpaired one is written escaped. */
  private static boolean wellFormedSurrogate(String value, int i) {
    char c = value.charAt(i);
    if (Character.isHighSurrogate(c)) {
      return i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1));
    }
    return i > 0 && Character.isHighSurrogate(value.charAt(i - 1));
  }

  private IllegalArgumentException error(String message) {
    return new IllegalArgumentException("Not JSON at character " + at + ": " + message);
  }

  private void space() {
    while (at < text.length()) {
      char c = text.charAt(at);
      if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return;
      at++;
    }
  }

  private Object value(int depth) {
    if (depth > MAX_DEPTH) throw error("nested too deeply");
    if (at >= text.length()) throw error("a value is missing");
    char c = text.charAt(at);
    return switch (c) {
      case '{' -> object(depth);
      case '[' -> array(depth);
      case '"' -> string();
      case 't' -> literal("true", Boolean.TRUE);
      case 'f' -> literal("false", Boolean.FALSE);
      case 'n' -> literal("null", null);
      default -> {
        if (c == '-' || c >= '0' && c <= '9') yield number();
        throw error("a value cannot start with '" + c + "'");
      }
    };
  }

  private Object literal(String word, Object value) {
    if (!text.startsWith(word, at)) throw error("expected " + word);
    at += word.length();
    return value;
  }

  private Map<String, Object> object(int depth) {
    Map<String, Object> map = new LinkedHashMap<>();
    at++;
    space();
    if (at < text.length() && text.charAt(at) == '}') {
      at++;
      return map;
    }
    while (true) {
      space();
      if (at >= text.length() || text.charAt(at) != '"') throw error("expected a key");
      String key = string();
      space();
      if (at >= text.length() || text.charAt(at) != ':') throw error("expected ':'");
      at++;
      space();
      map.put(key, value(depth + 1));
      space();
      if (at >= text.length()) throw error("unterminated object");
      char c = text.charAt(at++);
      if (c == '}') return map;
      if (c != ',') throw error("expected ',' or '}'");
    }
  }

  private List<Object> array(int depth) {
    List<Object> list = new ArrayList<>();
    at++;
    space();
    if (at < text.length() && text.charAt(at) == ']') {
      at++;
      return list;
    }
    while (true) {
      space();
      list.add(value(depth + 1));
      space();
      if (at >= text.length()) throw error("unterminated array");
      char c = text.charAt(at++);
      if (c == ']') return list;
      if (c != ',') throw error("expected ',' or ']'");
    }
  }

  private String string() {
    StringBuilder out = new StringBuilder();
    at++;
    while (true) {
      if (at >= text.length()) throw error("unterminated string");
      char c = text.charAt(at++);
      if (c == '"') return out.toString();
      if (c < 0x20) throw error("a control character in a string");
      if (c != '\\') {
        out.append(c);
        continue;
      }
      if (at >= text.length()) throw error("unterminated escape");
      char escape = text.charAt(at++);
      switch (escape) {
        case '"' -> out.append('"');
        case '\\' -> out.append('\\');
        case '/' -> out.append('/');
        case 'b' -> out.append('\b');
        case 'f' -> out.append('\f');
        case 'n' -> out.append('\n');
        case 'r' -> out.append('\r');
        case 't' -> out.append('\t');
        case 'u' -> {
          if (at + 4 > text.length()) throw error("short \\u escape");
          int code = 0;
          for (int i = 0; i < 4; i++) {
            int digit = Character.digit(text.charAt(at++), 16);
            if (digit < 0) throw error("bad \\u escape");
            code = code * 16 + digit;
          }
          out.append((char) code);
        }
        default -> throw error("bad escape \\" + escape);
      }
    }
  }

  private Object number() {
    int start = at;
    if (text.charAt(at) == '-') at++;
    if (at >= text.length()) throw error("a number is missing its digits");
    if (text.charAt(at) == '0') {
      at++;
    } else if (text.charAt(at) >= '1' && text.charAt(at) <= '9') {
      while (at < text.length() && Character.isDigit(text.charAt(at)) && text.charAt(at) < 128) at++;
    } else {
      throw error("a number is missing its digits");
    }
    boolean integer = true;
    if (at < text.length() && text.charAt(at) == '.') {
      integer = false;
      at++;
      digits();
    }
    if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
      integer = false;
      at++;
      if (at < text.length() && (text.charAt(at) == '+' || text.charAt(at) == '-')) at++;
      digits();
    }
    String literal = text.substring(start, at);
    if (!integer) return Double.valueOf(literal);
    BigInteger value = new BigInteger(literal);
    return value.bitLength() < 64 ? (Object) value.longValue() : value;
  }

  private void digits() {
    int start = at;
    while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
    if (at == start) throw error("expected a digit");
  }
}
