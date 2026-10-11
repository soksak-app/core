// The trace of the page (docs/spec/performance-trace.md). An event of the trace is the event `page.trace.<event>` of the
// event contract (docs/spec/logging.md#writers): it is queued without waiting and relayed to the host in a batch through the
// call `log`. The switch is the call `performance`; its requests run in the order they were made.
import { host as bridge } from "@soksak/runtime";
import { createEventBatcher } from "./log-batch.js";
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
  const batcher = log ? createEventBatcher({ call: log, report }) : null;
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
    const memory = globalThis.performance?.memory;
    const payload = memory ? { ...fields, jsHeapMB: Math.round(memory.usedJSHeapSize / 1048576) } : fields;
    batcher.emit("debug", `page.trace.${event}`, payload);
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
  return { setEnabled, trace, timed, isEnabled };
}

const tracer = createTracer(
  bridge ? (request) => bridge.call("performance", request) : null,
  reportRelayError,
  bridge ? (request) => bridge.call("log", request) : null,
);
export const setTraceEnabled = tracer.setEnabled;
export const trace = tracer.trace;
export const timed = tracer.timed;
export const traceEnabled = tracer.isEnabled;
