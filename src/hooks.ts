/**
 * Let a hook's promise fail unseen. `onEvent` and `onError` are typed as returning nothing, but an
 * async one returns a promise, and its rejection, left alone, is an unhandled rejection: Node ends
 * the process on one by default. A hook that throws is caught where it is called; this is the same
 * for one that rejects.
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
