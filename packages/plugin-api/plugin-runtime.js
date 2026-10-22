// The recording functions of the runtime that a plugin receives, `runtime.trace` and `runtime.log` (docs/spec/plugins.md#tracing,
// docs/spec/plugins.md#logging). A surface context and the context of a state module build them with this one function, so both
// give a plugin the same calls, checks and gates.

export const LOG_LEVELS = Object.freeze(["error", "warn", "info", "debug", "trace"]);

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
// A correlation identifier is not empty and holds no quote, no backslash and no control character, as the host requires.
const CID = /^[^"\\\u0000-\u001f\u007f]+$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Builds `{trace, log}` for the plugin `pluginId`. `surfaceId` is the surface that the events belong to, or null for the state
 * module, whose events have no surface. `hooks` is what the page offers:
 *   log(level, event, fields, cids)  stores an event; the writer of the page decides whether the event is stored
 *   trace(event, fields)             writes a trace event; traceEnabled() tells whether the trace is on
 * A page without a host offers none of them, and the calls then store nothing. The function of a trace is not accepted without its
 * query, because it could not skip the building of the fields. A log call builds the fields of each record, because the page has no
 * level query: the writer of the event log decides whether the record is stored (docs/spec/logging.md#gate).
 */
export function createPluginRuntime({ pluginId, surfaceId = null, hooks }) {
  for (const [store, query] of [["trace", "traceEnabled"]]) {
    if (hooks[store] !== undefined && typeof hooks[query] !== "function") throw new TypeError(`runtime.${store} requires runtime.${query}`);
    if (hooks[query] !== undefined && typeof hooks[store] !== "function") throw new TypeError(`runtime.${query} requires runtime.${store}`);
  }
  // The fields of a call: the object, or the object that a builder returns. A builder runs only when `open` is true.
  const fieldsOf = (what, fields, open) => {
    if (typeof fields === "function") {
      if (!open()) return null;
      fields = fields();
    }
    if (!isObject(fields)) throw new TypeError(`${what} requires fields as an object`);
    return fields;
  };
  const trace = (event, fields = {}) => {
    if (typeof event !== "string" || event === "") throw new TypeError("trace requires an event name");
    if (typeof fields !== "function" && !isObject(fields)) throw new TypeError("trace requires fields as an object");
    // default: a page without a host (the browser application, a test) has no trace, as a trace that is off.
    if (!hooks.trace) return;
    const built = fieldsOf("trace", fields, hooks.traceEnabled);
    if (built === null) return;
    hooks.trace(event, { ...built, plugin: pluginId, ...(surfaceId === null ? {} : { surface: surfaceId }) });
  };
  // default: a page without a host (the browser application, a test) has no trace, as a trace that is off.
  trace.enabled = () => hooks.traceEnabled?.() ?? false;
  const cidsOf = (options) => {
    if (options === undefined) return undefined;
    if (!isObject(options) || Object.keys(options).some((key) => key !== "cids")) throw new TypeError("log options may only hold cids");
    const { cids } = options;
    if (cids === undefined) return undefined;
    if (!Array.isArray(cids) || !cids.every((cid) => typeof cid === "string" && CID.test(cid))) {
      throw new TypeError("log cids must be an array of non-empty strings without a quote, a backslash or a control character");
    }
    return cids.length === 0 ? undefined : cids;
  };
  const log = Object.fromEntries(LOG_LEVELS.map((level) => [level, (event, fields = {}, options = undefined) => {
    if (typeof event !== "string" || !EVENT_NAME.test(event)) {
      throw new TypeError("log requires an event name of lowercase words separated by dots");
    }
    const cids = cidsOf(options);
    // default: a page without a host (the browser application, a test) has no event log, so a call stores nothing.
    if (!hooks.log) return;
    const built = fieldsOf("log", fields, () => true);
    if ("surface" in built) throw new TypeError("log fields must not name the surface; the context adds it");
    hooks.log(level, `plugin.${pluginId}.${event}`, surfaceId === null ? { ...built } : { ...built, surface: surfaceId }, cids);
  }]));
  return { trace, log: Object.freeze(log) };
}
