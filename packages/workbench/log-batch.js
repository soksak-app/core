// The page side of the event writer (docs/spec/logging.md#writers). An event is queued without waiting; the events of
// one turn travel to the host in one call, and one call is in flight at a time so the host receives them in order.
import { boundedJson, byteLength, cutBytes } from "./bounded-json.js";

const LEVELS = new Set(["error", "warn", "info", "debug", "trace"]);
const DEFAULT_MAX_EVENTS = 4096;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

// The fields of an event over this many bytes of JSON text are replaced by their head, which keeps the first HEAD_BYTES bytes of
// the text, and the event says `truncated` (docs/spec/logging.md#bounds).
const FIELDS_LIMIT = 65536;
const HEAD_BYTES = 4096;
// The bytes that the time, the level and the keys of an event add to its name and fields in the charge of the queue.
const EVENT_OVERHEAD_BYTES = 64;

// The page has only the wall clock, at the resolution of a millisecond (docs/spec/logging.md#limits). The clock of the
// performance timeline drifts from it, so an event of the page would be ordered after the events of the host that follow it.
function microsNow() {
  return Date.now() * 1000;
}

/**
 * The fields as the queue stores them and the bytes that they charge. The fields are serialized only up to FIELDS_LIMIT bytes, so
 * the cost does not depend on their size; fields over the bound become `{head, truncated: true}`. Fields that JSON cannot
 * serialize (a cycle, a BigInt) are an error of the caller.
 */
function boundFields(fields) {
  const { text, truncated } = boundedJson(fields, FIELDS_LIMIT);
  if (text === undefined) return { stored: {}, bytes: 2 };
  if (!truncated) return { stored: fields, bytes: byteLength(text) };
  const { text: head } = cutBytes(text, HEAD_BYTES);
  return { stored: { head, truncated: true }, bytes: HEAD_BYTES + 32 };
}

export function createEventBatcher({ call, report, maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES }) {
  let queue = [];
  let queueBytes = 0;
  // The refused events by the bound that refused them: {count, bytes} for each reason.
  let lost = new Map();
  // The functions that end the waits of the events that the next batch carries.
  let waiters = [];
  let scheduled = false;
  let sending = null;

  const send = async () => {
    scheduled = false;
    if (sending || (queue.length === 0 && lost.size === 0)) return;
    const events = queue;
    const mine = waiters;
    queue = [];
    queueBytes = 0;
    waiters = [];
    // The refused events had no place in the queue; each loss is stored in front of the events that follow it.
    for (const [reason, { count, bytes }] of [...lost].reverse()) {
      events.unshift({ ts_us: microsNow(), level: "warn", event: "page.log.dropped", fields: { count, bytes, reason } });
    }
    lost = new Map();
    sending = (async () => {
      try {
        await call({ action: "batch", events });
      } catch (error) {
        report(new Error(`page event batch of ${events.length} events failed: ${error.message}`, { cause: error }));
      }
    })();
    await sending;
    sending = null;
    for (const end of mine) end();
    if (queue.length > 0 || lost.size > 0) await send();
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(send);
  };

  const refuse = (reason, bytes) => {
    // default: the first refusal for a reason starts its count at zero.
    const held = lost.get(reason) ?? { count: 0, bytes: 0 };
    lost.set(reason, { count: held.count + 1, bytes: held.bytes + bytes });
    schedule();
    return false;
  };

  const emit = (level, event, fields = {}) => {
    if (!LEVELS.has(level)) throw new TypeError(`event level ${JSON.stringify(level)} is not one of ${[...LEVELS].join(", ")}`);
    const { stored, bytes } = boundFields(fields);
    const charge = bytes + event.length + EVENT_OVERHEAD_BYTES;
    if (queue.length >= maxEvents) return refuse("the page queue was full", charge);
    if (queueBytes + charge > maxBytes) return refuse(`the page queue reached ${maxBytes} bytes`, charge);
    queue.push({ ts_us: microsNow(), level, event, fields: stored });
    queueBytes += charge;
    schedule();
    return true;
  };

  // Queues an event like `emit`, and returns a promise that ends when the batch that carries the event was relayed, or at once
  // when the queue refused the event. The failure of the relay is reported through `report`, not through this promise.
  const emitAndWait = (level, event, fields = {}) => new Promise((resolve) => {
    if (!emit(level, event, fields)) {
      resolve();
      return;
    }
    waiters.push(resolve);
  });

  const flush = async () => {
    await send();
    while (sending) await sending;
  };

  return { emit, emitAndWait, flush };
}
