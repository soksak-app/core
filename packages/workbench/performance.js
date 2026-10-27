// The trace of the page (docs/spec/performance-trace.md). An event of the trace is the event `page.trace.<event>` of the
// event contract (docs/spec/logging.md#writers): it is queued without waiting and relayed to the host in a batch through the
// call `log`. The switch is the call `performance`; its requests run in the order they were made.
import { host as bridge } from "@soksak/runtime";
import { createEventBatcher } from "@soksak/plugin-api/log-batch.js";
import { classOf } from "./event-classes.js";
import { logGate } from "./log-gate.js";
import { rawConsole } from "./page-log.js";

function reportRelayError(error) {
  rawConsole.error("performance trace relay failed:", error);
  if (typeof ErrorEvent === "function") {
    // default: an execution environment without dispatchEvent (the unit tests under Node) keeps only the console.error report above.
    globalThis.dispatchEvent?.(new ErrorEvent("error", { message: error.message, error }));
  }
}

export function createTracer(call, report = reportRelayError, log = null) {
  let enabled = false;
  let switching = false;
  let revision = 0;
  let pending = Promise.resolve();
  const batcher = log ? createEventBatcher({ call: log, report, classify: classOf, gate: logGate }) : null;
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
    if (!enabled || !batcher) return;
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
  reportRelayError,
  bridge ? (request) => bridge.call("log", request) : null,
);
export const setTraceEnabled = tracer.setEnabled;
export const reportTraceAtStart = tracer.reportAtStart;
export const trace = tracer.trace;
export const timed = tracer.timed;
export const traceEnabled = tracer.isEnabled;
