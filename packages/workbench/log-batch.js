// The page side of the event writer (docs/spec/logging.md#writers). An event is queued without waiting; the events of
// one turn travel to the host in one call, and one call is in flight at a time so the host receives them in order.
const LEVELS = new Set(["error", "warn", "info", "debug", "trace"]);
const DEFAULT_MAX_EVENTS = 4096;

// The page has only the wall clock, at the resolution of a millisecond (docs/spec/logging.md#limits). The clock of the
// performance timeline drifts from it, so an event of the page would be ordered after the events of the host that follow it.
function microsNow() {
  return Date.now() * 1000;
}

export function createEventBatcher({ call, report, maxEvents = DEFAULT_MAX_EVENTS }) {
  let queue = [];
  let lost = 0;
  let scheduled = false;
  let sending = null;

  const send = async () => {
    scheduled = false;
    if (sending || (queue.length === 0 && lost === 0)) return;
    const events = queue;
    queue = [];
    if (lost > 0) {
      // The refused events had no place in the queue; the loss is stored in front of the events that follow it.
      events.unshift({ ts_us: microsNow(), level: "warn", event: "page.log.dropped",
        fields: { count: lost, reason: "the page queue was full" } });
      lost = 0;
    }
    sending = (async () => {
      try {
        await call({ action: "batch", events });
      } catch (error) {
        report(new Error(`page event batch of ${events.length} events failed: ${error.message}`, { cause: error }));
      }
    })();
    await sending;
    sending = null;
    if (queue.length > 0 || lost > 0) await send();
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(send);
  };

  const emit = (level, event, fields = {}) => {
    if (!LEVELS.has(level)) throw new TypeError(`event level ${JSON.stringify(level)} is not one of ${[...LEVELS].join(", ")}`);
    if (queue.length >= maxEvents) {
      lost += 1;
      schedule();
      return false;
    }
    queue.push({ ts_us: microsNow(), level, event, fields });
    schedule();
    return true;
  };

  const flush = async () => {
    await send();
    while (sending) await sending;
  };

  return { emit, flush };
}
