/**
 * Let a hook's promise fail unseen: an async `onEvent` or `onError` returns a promise whose
 * rejection would be unhandled, which ends a Node process by default.
 */
export function ignoreRejection(result: unknown): void {
  if (
    (typeof result === 'object' || typeof result === 'function') &&
    result !== null &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    Promise.resolve(result).catch(() => undefined);
  }
}
