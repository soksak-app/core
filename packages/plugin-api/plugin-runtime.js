// The recording functions of the runtime that a plugin receives, `runtime.trace` and `runtime.log` (docs/spec/plugins.md#tracing,
// docs/spec/plugins.md#logging). A surface context builds them with this function.

export const LOG_LEVELS = Object.freeze(["error", "warn", "info", "debug", "trace"]);

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
// A correlation identifier is not empty and holds no quote, no backslash and no control character, as the host requires.
const CID = /^[^"\\\u0000-\u001f\u007f]+$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Builds `{trace, log}` for the plugin `pluginId` and its surface `surfaceId`. `hooks` is what the page offers:
 *   log(level, event, fields, cids)  stores an event; logEnabled(level) tells whether the level is stored
 *   trace(event, fields)             writes a trace event; traceEnabled() tells whether the trace is on
 * A page without a host offers none of them, and the calls then store nothing and build nothing. The function of a pair is not
 * accepted without its query, because it could not skip the building of the fields.
 */
export function createPluginRuntime({ pluginId, surfaceId, hooks }) {
  for (const [store, query] of [["log", "logEnabled"], ["trace", "traceEnabled"]]) {
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
    hooks.trace(event, { ...built, plugin: pluginId, surface: surfaceId });
  };
  // default: a page without a host (the browser application, a test) has no trace, as a trace that is off.
  trace.enabled = () => hooks.traceEnabled?.() ?? false;
  const checkLevel = (level) => {
    if (!LOG_LEVELS.includes(level)) throw new TypeError(`log level must be one of ${LOG_LEVELS.join(", ")}`);
  };
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
  const enabled = (level) => {
    checkLevel(level);
    // default: a page without a host (the browser application, a test) has no event log, as a log that is off.
    return hooks.logEnabled?.(level) ?? false;
  };
  const log = Object.fromEntries(LOG_LEVELS.map((level) => [level, (event, fields = {}, options = undefined) => {
    if (typeof event !== "string" || !EVENT_NAME.test(event)) {
      throw new TypeError("log requires an event name of lowercase words separated by dots");
    }
    const cids = cidsOf(options);
    const built = fieldsOf("log", fields, () => enabled(level));
    if (built === null) return;
    if ("surface" in built) throw new TypeError("log fields must not name the surface; the context adds it");
    if (!enabled(level)) return;
    hooks.log(level, `plugin.${pluginId}.${event}`, { ...built, surface: surfaceId }, cids);
  }]));
  log.enabled = enabled;
  return { trace, log: Object.freeze(log) };
}
