// The page side of the event writer (docs/spec/logging.md#writers). An event is queued without waiting; the events of
// one turn travel to the host in one call, and one call is in flight at a time so the host receives them in order.
const LEVELS = new Set(["error", "warn", "info", "debug", "trace"]);
const DEFAULT_MAX_EVENTS = 4096;

// The number of clock requests that anchor the clock of the page to the clocks of the host.
const ANCHOR_SAMPLES = 5;

// A correlation identifier is not empty and holds no quote, no backslash and no control character, as the host requires.
const CID = /^[^"\\\u0000-\u001f\u007f]+$/;

/**
 * The page has no wall clock or monotonic clock in microseconds: `Date.now()` has a resolution of a millisecond, and
 * `performance.now()` counts from the start of the document at the resolution that the engine allows. An event stores the
 * reading of `performance.now()` when it is queued. Before the first batch leaves, the page reads the clocks of the host with
 * the request `{action: "clock"}` several times, keeps the answer whose round trip was the shortest, and takes the middle of
 * that round trip as the moment of the answer. Every event then has the wall clock `ts_us` and the monotonic clock `mono_ns` of
 * the host at its own reading, so the layers of one input compare (docs/spec/logging.md#limits).
 */
export function createEventBatcher({ call, report, maxEvents = DEFAULT_MAX_EVENTS, now = () => performance.now() }) {
  let queue = [];
  let lost = 0;
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
    if (sending || (queue.length === 0 && lost === 0)) return;
    const events = queue;
    const mine = waiters;
    queue = [];
    waiters = [];
    if (lost > 0) {
      // The refused events had no place in the queue; the loss is stored in front of the events that follow it.
      events.unshift({ at: now(), level: "warn", event: "page.log.dropped",
        fields: { count: lost, reason: "the page queue was full" } });
      lost = 0;
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
    if (queue.length > 0 || lost > 0) await send();
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

  const emit = (level, event, fields = {}, cids = undefined) => {
    if (!LEVELS.has(level)) throw new TypeError(`event level ${JSON.stringify(level)} is not one of ${[...LEVELS].join(", ")}`);
    if (queue.length >= maxEvents) {
      lost += 1;
      schedule();
      return false;
    }
    const checked = checkedCids(event, cids);
    queue.push({ at: now(), level, event, fields, ...(checked === undefined ? {} : { cids: checked }) });
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
