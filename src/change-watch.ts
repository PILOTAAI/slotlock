// Following a tenant's change feed for live updates (RFC 0002 P1-5): one reader per tenant per
// server, shared by every open subscription of that tenant, that reads the feed by cursor and tells
// each subscription which of its resources a change touched. It wakes when the source says the feed
// grew (PostgreSQL LISTEN/NOTIFY in self-host.ts) and otherwise reads on a short adaptive interval.
// A reader knows only its own tenant: it reads that tenant's feed and tells that tenant's watchers.

/** What a reader needs from a change: the calendar resource it touched, if any. */
export interface SlotlockAgentChange {
  resourceId: string | null;
}

/**
 * A tenant's change feed, as the agent server follows it (SlotlockEventFeed.listChanges, read under
 * the tenant's row-level security). Every call names one tenant, the one whose subscribers are
 * waiting, and must return that tenant's changes only.
 */
export interface SlotlockAgentChangeSource {
  /** A position at or before every change that has not ended yet: where a new reader starts. */
  head(tenantRef: string): Promise<string>;
  listChanges(params: { tenantRef: string; after: string; limit: number }): Promise<
    | { ok: true; changes: readonly SlotlockAgentChange[]; next: string }
    | { ok: false; code: string }
  >;
  /**
   * Call `wake` whenever the tenant's feed may have grown, until the returned stop function is
   * called. A wake carries nothing but itself. Optional: without it the feed is read every
   * `FEED_IDLE_MS` when quiet.
   */
  watch?(tenantRef: string, wake: () => void): Promise<() => unknown>;
}

/** One subscription's interest in its tenant's feed. */
export interface SlotlockChangeWatcher {
  readonly resourceIds: ReadonlySet<string>;
  /** Some of its resources changed (a change with no resource counts for every one). */
  touched(): void;
  /** The cursor expired: changes may have been missed, so every resource is announced once. */
  resync(): void;
}

/** Changes read per page. */
const FEED_PAGE = 500;
/** How soon the feed is read again after a read that found changes, in ms. */
const FEED_BUSY_MS = 250;
/** The longest a quiet feed goes unread without a wake-up source, in ms. */
export const FEED_IDLE_MS = 2_000;
/** The longest a quiet feed goes unread while a wake-up source is listening, in ms. */
export const FEED_LISTENING_IDLE_MS = 15_000;

interface TenantReader {
  watchers: Set<SlotlockChangeWatcher>;
  /** Watchers that joined since the last read began: told once after the next read ends. */
  joined: Set<SlotlockChangeWatcher>;
  cursor?: string;
  reading: boolean;
  again: boolean;
  closed: boolean;
  listening: boolean;
  delay: number;
  timer?: ReturnType<typeof setTimeout>;
  stopWatch?: () => unknown;
}

function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * The readers of one server process. `join` adds a watcher to its tenant's reader (starting it) and
 * returns the function that removes it (stopping the reader with its last watcher).
 */
export function createSlotlockChangeReaders(
  source: SlotlockAgentChangeSource,
  onError: (error: unknown) => void = () => {},
): {
  join(tenantRef: string, watcher: SlotlockChangeWatcher): () => void;
  /** Tenants with a reader now. */
  readonly size: number;
} {
  const readers = new Map<string, TenantReader>();

  function schedule(tenantRef: string, reader: TenantReader, delay: number): void {
    if (reader.closed) return;
    clearTimeout(reader.timer);
    reader.timer = unref(setTimeout(() => void read(tenantRef, reader), delay));
  }

  function stop(tenantRef: string, reader: TenantReader): void {
    reader.closed = true;
    clearTimeout(reader.timer);
    if (readers.get(tenantRef) === reader) readers.delete(tenantRef);
    try {
      Promise.resolve(reader.stopWatch?.()).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  async function read(tenantRef: string, reader: TenantReader): Promise<void> {
    if (reader.closed) return;
    if (reader.reading) {
      reader.again = true;
      return;
    }
    reader.reading = true;
    clearTimeout(reader.timer);
    const joined = [...reader.joined];
    reader.joined.clear();
    const idle = reader.listening ? FEED_LISTENING_IDLE_MS : FEED_IDLE_MS;
    let found = false;
    try {
      let touched: Set<string> | 'all' = new Set();
      let expired = false;
      if (reader.cursor === undefined) reader.cursor = await source.head(tenantRef);
      for (let page = 0; page < 20 && !reader.closed; page += 1) {
        const result = await source.listChanges({
          tenantRef,
          after: reader.cursor,
          limit: FEED_PAGE,
        });
        if (!result.ok) {
          // Too far behind (or a cursor no store knows): start again from now, and since changes
          // may have been missed, announce every watched resource once.
          reader.cursor = await source.head(tenantRef);
          expired = true;
          break;
        }
        reader.cursor = result.next;
        for (const change of result.changes) {
          if (touched === 'all') break;
          if (change.resourceId === null) touched = 'all';
          else touched.add(change.resourceId);
        }
        if (result.changes.length > 0) found = true;
        if (result.changes.length < FEED_PAGE) break;
      }
      if (reader.closed) return;
      const told = new Set<SlotlockChangeWatcher>();
      for (const watcher of reader.watchers) {
        if (expired) {
          watcher.resync();
          told.add(watcher);
          continue;
        }
        if (touched === 'all' || [...watcher.resourceIds].some((id) => touched.has(id))) {
          watcher.touched();
          told.add(watcher);
        }
      }
      // A watcher's first read was before this one began, so whatever committed in between is
      // below the cursor now: it reads once more to see it.
      for (const watcher of joined) {
        if (!told.has(watcher) && reader.watchers.has(watcher)) watcher.touched();
      }
      reader.delay = found ? FEED_BUSY_MS : Math.min(Math.max(reader.delay * 2, FEED_BUSY_MS), idle);
    } catch (error) {
      onError(error);
      for (const watcher of joined) reader.joined.add(watcher);
      reader.delay = idle;
    } finally {
      reader.reading = false;
    }
    if (reader.closed) return;
    if (reader.again) {
      reader.again = false;
      schedule(tenantRef, reader, 0);
    } else {
      schedule(tenantRef, reader, reader.delay);
    }
  }

  return {
    get size() {
      return readers.size;
    },
    join(tenantRef, watcher) {
      let reader = readers.get(tenantRef);
      if (!reader) {
        const created: TenantReader = {
          watchers: new Set(),
          joined: new Set(),
          reading: false,
          again: false,
          closed: false,
          listening: false,
          delay: FEED_BUSY_MS,
        };
        reader = created;
        readers.set(tenantRef, created);
        if (source.watch) {
          source
            .watch(tenantRef, () => {
              if (created.closed) return;
              // A wake while quiet reads at once; a read under way reads again when it ends.
              void read(tenantRef, created);
            })
            .then(
              (stopWatch) => {
                if (created.closed) {
                  Promise.resolve(stopWatch()).catch(onError);
                  return;
                }
                created.stopWatch = stopWatch;
                created.listening = true;
              },
              onError,
            );
        }
      }
      const current = reader;
      current.watchers.add(watcher);
      current.joined.add(watcher);
      void read(tenantRef, current);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        current.watchers.delete(watcher);
        current.joined.delete(watcher);
        if (current.watchers.size === 0) stop(tenantRef, current);
      };
    },
  };
}
