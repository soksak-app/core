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

// The number of clock requests that anchor the clock of the page to the clocks of the host.
const ANCHOR_SAMPLES = 5;

// A correlation identifier is not empty and holds no quote, no backslash and no control character, as the host requires.
const CID = /^[^"\\\u0000-\u001f\u007f]+$/;

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

/**
 * The page has no wall clock or monotonic clock in microseconds: `Date.now()` has a resolution of a millisecond, and
 * `performance.now()` counts from the start of the document at the resolution that the engine allows. An event stores the
 * reading of `performance.now()` when it is queued. Before the first batch leaves, the page reads the clocks of the host with
 * the request `{action: "clock"}` several times, keeps the answer whose round trip was the shortest, and takes the middle of
 * that round trip as the moment of the answer. Every event then has the wall clock `ts_us` and the monotonic clock `mono_ns` of
 * the host at its own reading, so the layers of one input compare (docs/spec/logging.md#limits).
 */
export function createEventBatcher({ call, report, maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES, now = () => performance.now() }) {
  let queue = [];
  let queueBytes = 0;
  // The refused events by the bound that refused them: {count, bytes} for each reason.
  let lost = new Map();
  // The functions that end the waits of the events that the next batch carries.
  let waiters = [];
  let scheduled = false;
  let sending = null;
  let anchor = null;

  const anchored = async () => {
    if (anchor) return anchor;
    let best = null;
    for (let sample = 0; sample < ANCHOR_SAMPLES; sample += 1) {
      const started = now();
      const answer = await call({ action: "clock" });
      const ended = now();
      if (!Number.isInteger(answer?.ts_us) || !Number.isInteger(answer?.mono_ns) || answer.ts_us <= 0 || answer.mono_ns <= 0) {
        throw new Error(`the host answered the clock request with ${JSON.stringify(answer)}`);
      }
      if (best === null || ended - started < best.trip) {
        best = { trip: ended - started, at: (started + ended) / 2, ts_us: answer.ts_us, mono_ns: answer.mono_ns };
      }
    }
    anchor = best;
    return anchor;
  };

  const send = async () => {
    scheduled = false;
    if (sending || (queue.length === 0 && lost.size === 0)) return;
    const events = queue;
    const mine = waiters;
    queue = [];
    queueBytes = 0;
    waiters = [];
    {
      // The refused events had no place in the queue; each loss is stored in front of the events that follow it.
      for (const [reason, { count, bytes }] of [...lost].reverse()) {
        events.unshift({ at: now(), level: "warn", event: "page.log.dropped", fields: { count, bytes, reason } });
      }
      lost = new Map();
    }
    sending = (async () => {
      try {
        const base = await anchored();
        const stamped = events.map(({ at, cids, ...rest }) => ({
          ts_us: Math.round(base.ts_us + (at - base.at) * 1000),
          mono_ns: Math.round(base.mono_ns + (at - base.at) * 1e6),
          ...rest,
          ...(cids === undefined ? {} : { cids }),
        }));
        await call({ action: "batch", events: stamped });
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

  // The identifiers of an event: a list that the host accepts, or none. A list that it would refuse is reported and left out
  // of the event, so one wrong identifier does not make the host refuse the whole batch.
  const checkedCids = (event, cids) => {
    if (cids === undefined) return undefined;
    if (!Array.isArray(cids) || !cids.every((cid) => typeof cid === "string" && CID.test(cid))) {
      report(new TypeError(`the cids of ${event} are not an array of non-empty strings without a quote, a backslash or a control character: ${JSON.stringify(cids)}`));
      return undefined;
    }
    return cids.length === 0 ? undefined : cids;
  };

  const refuse = (reason, bytes) => {
    // default: the first refusal for a reason starts its count at zero.
    const held = lost.get(reason) ?? { count: 0, bytes: 0 };
    lost.set(reason, { count: held.count + 1, bytes: held.bytes + bytes });
    schedule();
    return false;
  };

  const emit = (level, event, fields = {}, cids = undefined) => {
    if (!LEVELS.has(level)) throw new TypeError(`event level ${JSON.stringify(level)} is not one of ${[...LEVELS].join(", ")}`);
    const { stored, bytes } = boundFields(fields);
    const charge = bytes + event.length + EVENT_OVERHEAD_BYTES;
    if (queue.length >= maxEvents) return refuse("the page queue was full", charge);
    if (queueBytes + charge > maxBytes) return refuse(`the page queue reached ${maxBytes} bytes`, charge);
    const checked = checkedCids(event, cids);
    queue.push({ at: now(), level, event, fields: stored, ...(checked === undefined ? {} : { cids: checked }) });
    queueBytes += charge;
    schedule();
    return true;
  };

  // Queues an event like `emit`, and returns a promise that ends when the batch that carries the event was relayed, or at once
  // when the queue refused the event. The failure of the relay is reported through `report`, not through this promise.
  const emitAndWait = (level, event, fields = {}, cids = undefined) => new Promise((resolve) => {
    if (!emit(level, event, fields, cids)) {
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
