// Reading calendar feeds that someone else controls, off the thread that serves requests.
// #region feeds
import {
  CalendarExpansionLimitError,
  ICalendarWorkerBusyError,
  createICalendarWorkerPool,
} from 'slotlock';

// One pool for the process. Each feed is read on a worker thread; one that runs past its deadline
// or its heap is stopped, and the feed refused, while this thread carries on.
const feeds = createICalendarWorkerPool({ size: 2, deadlineMs: 3_000 });

export async function readFeed(text: string, window: { start: Date; end: Date }) {
  try {
    return {
      ok: true as const,
      changes: await feeds.parseICalendarChanges(text, undefined, window),
    };
  } catch (error) {
    // Every worker is busy and the queue is full: read this feed on the next sync.
    if (error instanceof ICalendarWorkerBusyError) return { ok: false as const, retry: true };
    // The feed takes more than Slotlock will spend reading one: tell its owner, do not retry.
    if (error instanceof CalendarExpansionLimitError) return { ok: false as const, retry: false };
    throw error;
  }
}

export function closeFeeds() {
  return feeds.close();
}
// #endregion feeds
