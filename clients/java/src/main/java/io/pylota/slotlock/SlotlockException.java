package io.pylota.slotlock;

import java.time.Duration;
import java.util.Optional;

/**
 * A call the server refused: {@link #status()} is the HTTP status, {@link #code()} says why
 * ({@code overlap}, {@code forbidden}, {@code confirmation_required}, ...), or {@code http_<status>}
 * when the response carried no code.
 */
public final class SlotlockException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /** The HTTP status. */
  private final int status;

  /** The server's error code. */
  private final String code;

  /** What a 429 or 503 asks the caller to wait, or null. */
  private final transient Duration retryAfter;

  SlotlockException(int status, String code, Duration retryAfter) {
    super("Slotlock answered " + status + " " + code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }

  /**
   * The HTTP status.
   *
   * @return the HTTP status
   */
  public int status() {
    return status;
  }

  /**
   * The server's error code.
   *
   * @return the code, such as {@code overlap}
   */
  public String code() {
    return code;
  }

  /**
   * What a 429 or 503 asks the caller to wait, when it says.
   *
   * @return the wait, or empty
   */
  public Optional<Duration> retryAfter() {
    return Optional.ofNullable(retryAfter);
  }
}
