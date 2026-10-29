// The trace of the page (docs/spec/performance-trace.md). An event of the trace is the event `page.trace.<event>` of the
// event contract (docs/spec/logging.md#writers): it is queued without waiting and relayed to the host in a batch through the
// call `log`. The switch is the call `performance`; its requests run in the order they were made.
import { host as bridge } from "@soksak/runtime";
import { classOf } from "./event-classes.js";
import { emitEvent, flushEvents } from "./page-log.js";

/**
 * `call` sends a request of the switch `performance`; `events` is the event writer of the document, `{emit, flush}`, or null in a page
 * without a host. The events of the trace leave through the writer of the page records, which also reports a failed relay, so the
 * document states its clock once (docs/spec/logging.md#writers).
 */
export function createTracer(call, events = null) {
  let enabled = false;
  let switching = false;
  let revision = 0;
  let pending = Promise.resolve();
  const batcher = events;
  const enqueue = (work) => {
    // The failure of an earlier request reached the caller of that request.
    // A later explicit request has its own result and runs in order.
    const result = pending.then(work, work);
    pending = result;
    return result;
  };
  const setEnabled = (on) => {
    if (typeof on !== "boolean") throw new TypeError("trace enabled must be a boolean");
    if (!call || (!switching && enabled === on)) return Promise.resolve();
    const mine = ++revision;
    enabled = false;
    switching = true;
    return enqueue(async () => {
      try {
        // The events that were accepted leave before the switch goes off.
        if (!on && batcher) await batcher.flush();
        await call({ action: on ? "on" : "off" });
        if (mine === revision) enabled = on;
      } finally {
        if (mine === revision) switching = false;
      }
    });
  };
  const trace = (event, fields = {}) => {
    if (!batcher || (!enabled && classOf(`page.trace.${event}`) !== "frame")) return;
    // The payload is built only for an event that the gate stores.
    batcher.emit("debug", `page.trace.${event}`, () => {
      const memory = globalThis.performance?.memory;
      return memory ? { ...fields, jsHeapMB: Math.round(memory.usedJSHeapSize / 1048576) } : fields;
    });
  };
  const timed = async (name, answer) => {
    if (!enabled) return answer();
    const started = performance.now();
    try {
      const result = await answer();
      trace("command", { name, us: Math.round((performance.now() - started) * 1000), ok: true });
      return result;
    } catch (error) {
      trace("command", { name, us: Math.round((performance.now() - started) * 1000), ok: false,
        // default: a thrown value that is not an Error is recorded as its own text.
        error: String(error?.message ?? error) });
      throw error;
    }
  };
  // Whether the trace is on and has a writer: a caller that builds the fields of an event asks first.
  const isEnabled = () => enabled && batcher !== null;
  // Reports the stored switch once at the start of the page, also when it is off: the switch of the host can be on from a
  // page that ended while the stored setting says off, and only this report turns a stale switch off again. The host stores
  // nothing when the switch does not change (docs/spec/performance-trace.md#the-switch).
  const reportAtStart = (on) => {
    if (!call) return Promise.resolve();
    const mine = ++revision;
    return enqueue(async () => {
      try {
        await call({ action: on ? "on" : "off" });
        if (mine === revision) enabled = on;
      } finally {
        if (mine === revision) switching = false;
      }
    });
  };
  return { setEnabled, reportAtStart, trace, timed, isEnabled };
}

const tracer = createTracer(
  bridge ? (request) => bridge.call("performance", request) : null,
  bridge ? { emit: emitEvent, flush: flushEvents } : null,
);
export const setTraceEnabled = tracer.setEnabled;
export const reportTraceAtStart = tracer.reportAtStart;
export const trace = tracer.trace;
export const timed = tracer.timed;
export const traceEnabled = tracer.isEnabled;
