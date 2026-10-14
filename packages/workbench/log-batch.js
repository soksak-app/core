// The page side of the event writer (docs/spec/logging.md#writers). An event is queued without waiting; the events of
// one turn travel to the host in one call, and one call is in flight at a time so the host receives them in order.
import { boundedJson, byteLength, cutBytes } from "./bounded-json.js";
import { classOf } from "./event-classes.js";
import { logGate } from "./log-gate.js";

const LEVELS = new Set(["error", "warn", "info", "debug", "trace"]);
const DEFAULT_MAX_EVENTS = 4096;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
// The interval in milliseconds between two reports of the counts of the gate (docs/spec/logging.md#policy).
const GATED_REPORT_MS = 1000;

// The fields of an event over this many bytes of JSON text are replaced by their head, which keeps the first HEAD_BYTES bytes of
// the text, and the event says `truncated` (docs/spec/logging.md#bounds).
const FIELDS_LIMIT = 65536;
const HEAD_BYTES = 4096;
// The bytes that the time, the level and the keys of an event add to its name and fields in the charge of the queue.
const EVENT_OVERHEAD_BYTES = 64;

// The number of clock requests that anchor the clock of the page to the clocks of the host.
const ANCHOR_SAMPLES = 5;

// The most readings that the measurement of the resolution of the clock of the page takes. The readings of
// `performance.now()` advance in steps of the clock of the engine, and the first step that a bounded run of readings
// observes is the resolution, so a time of the page differs from the clock of the host by half the shortest round trip
// plus that step (docs/spec/logging.md#writers).
const STEP_READINGS = 100_000;

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
export function createEventBatcher({ call, report, maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES, now = () => performance.now(), gate = logGate }) {
  let queue = [];
  let queueBytes = 0;
  // The refused events by the bound that refused them: {count, bytes} for each reason.
  let lost = new Map();
  // The events that a closed gate refused, by class and level: {class, level, count}; the next batch reports them.
  let gated = new Map();
  // The counts of the gate leave when a second has passed since the earlier report, and at a flush; a report with each batch
  // stored more events than a narrow policy removed (docs/spec/logging.md#policy). No event marks the end of the second,
  // so one timer waits for it while counts are held.
  let gatedAt = now();
  let gatedTimer = false;
  const gatedDue = () => gated.size > 0 && now() - gatedAt >= GATED_REPORT_MS;
  // The functions that end the waits of the events that the next batch carries.
  let waiters = [];
  let scheduled = false;
  let sending = null;
  let anchor = null;

  // The resolution of the clock of the page in microseconds: the first step that a bounded run of readings observes,
  // and 1 when no reading of the run advanced (a floor, never zero, so the stated bound stays a bound).
  const resolutionOfClock = () => {
    const started = now();
    for (let reading = 0; reading < STEP_READINGS; reading += 1) {
      const stepped = now();
      if (stepped !== started) return Math.max(1, Math.round((stepped - started) * 1000));
    }
    return 1;
  };

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
    anchor = { ...best, resolution_us: resolutionOfClock() };
    return anchor;
  };

  const send = async (force = false) => {
    scheduled = false;
    const reportGated = gated.size > 0 && (force || gatedDue());
    if (sending || (queue.length === 0 && lost.size === 0 && !reportGated)) return;
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
      // The events that the gate refused are reported with the exact count for each class and level; the report passes every gate.
      if (reportGated) {
        for (const entry of [...gated.values()].reverse()) {
          events.unshift({ at: now(), level: "info", event: "page.log.gated", fields: { class: entry.class, level: entry.level, count: entry.count } });
        }
        gated = new Map();
        gatedAt = now();
      }
    }
    sending = (async () => {
      try {
        const base = await anchored();
        // The first batch states the round trip of the anchor: a time of the page differs from the clock of the host by at most
        // half of it, which a reader needs to order the events of the page among those of the host.
        if (!base.stated) {
          base.stated = true;
          events.unshift({ at: base.at, level: "info", event: "page.log.clock",
            fields: { trip_us: Math.round(base.trip * 1000), resolution_us: base.resolution_us } });
        }
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
    if (queue.length > 0 || lost.size > 0 || gatedDue()) await send();
  };

  const awaitGated = () => {
    if (gatedTimer || gated.size === 0) return;
    gatedTimer = true;
    setTimeout(() => {
      gatedTimer = false;
      send().then(awaitGated, report);
    }, Math.max(0, GATED_REPORT_MS - (now() - gatedAt)));
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

  // The question of a producer before it builds the fields of an event: whether an event of the class and the level is stored. A closed
  // gate counts the event, which the producer then does not build.
  const open = (klass, level) => {
    if (gate.enabled(klass, level)) return true;
    // default: the first refusal of a class and a level starts its count at zero.
    const held = gated.get(`${klass}/${level}`) ?? { class: klass, level, count: 0 };
    gated.set(`${klass}/${level}`, { ...held, count: held.count + 1 });
    awaitGated();
    return false;
  };

  // `fields` is the object of the event or a function that builds it; the function runs only for an event that the gate stores.
  const emit = (level, event, fields = {}, cids = undefined) => {
    if (!LEVELS.has(level)) throw new TypeError(`event level ${JSON.stringify(level)} is not one of ${[...LEVELS].join(", ")}`);
    const klass = classOf(event);
    if (klass !== undefined && !open(klass, level)) return false;
    const { stored, bytes } = boundFields(typeof fields === "function" ? fields() : fields);
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
    while (sending) await sending;
    await send(true);
    while (sending) await sending;
  };

  return { emit, emitAndWait, flush, gate: open };
}
